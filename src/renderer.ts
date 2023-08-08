import * as puppeteer from 'puppeteer';
import * as url from 'url';


import * as path from 'path';
import { exec } from 'child_process';


import { Config } from './config';

type SerializedResponse = {
  status: number; content: string;
};

type ViewportDimensions = {
  width: number; height: number;
};

const MOBILE_USERAGENT =
  'Mozilla/5.0 (Linux; Android 8.0.0; Pixel 2 XL Build/OPD1.170816.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.75 Mobile Safari/537.36';

/**
 * Wraps Puppeteer's interface to Headless Chrome to expose high level rendering
 * APIs that are able to handle web components and PWAs.
 */
export class Renderer {
  private browser: puppeteer.Browser;
  private config: Config;

  constructor(browser: puppeteer.Browser, config: Config) {
    this.browser = browser;
    this.config = config;
  }

  async serialize(requestUrl: string, isMobile: boolean):
    Promise<SerializedResponse> {
    /**
     * Executed on the page after the page has loaded. Strips script and
     * import tags to prevent further loading of resources.
     */
    function stripPage() {
      // Strip only script tags that contain JavaScript (either no type attribute or one that contains "javascript")
      const elements = document.querySelectorAll('script:not([type]), script[type*="javascript"], link[rel=import]');
      for (const e of Array.from(elements)) {
        e.remove();
      }
    }

    /**
     * Injects a <base> tag which allows other resources to load. This
     * has no effect on serialised output, but allows it to verify render
     * quality.
     */
    function injectBaseHref(origin: string) {
      const base = document.createElement('base');
      base.setAttribute('href', origin);

      const bases = document.head.querySelectorAll('base');
      if (bases.length) {
        // Patch existing <base> if it is relative.
        const existingBase = bases[0].getAttribute('href') || '';
        if (existingBase.startsWith('/')) {
          bases[0].setAttribute('href', origin + existingBase);
        }
      } else {
        // Only inject <base> if it doesn't already exist.
        document.head.insertAdjacentElement('afterbegin', base);
      }
    }

    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport({ width: this.config.width, height: this.config.height, isMobile });

    if (isMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    page.evaluateOnNewDocument('customElements.forcePolyfill = true');
    page.evaluateOnNewDocument('ShadyDOM = {force: true}');
    page.evaluateOnNewDocument('ShadyCSS = {shimcssproperties: true}');

    let response: puppeteer.Response | null = null;
    // Capture main frame response. This is used in the case that rendering
    // times out, which results in puppeteer throwing an error. This allows us
    // to return a partial response for what was able to be rendered in that
    // time frame.
    page.addListener('response', (r: puppeteer.Response) => {
      if (!response) {
        response = r;
      }
    });

    try {
      // Navigate to page. Wait until there are no oustanding network requests.
      response = await page.goto(
        requestUrl, { timeout: this.config.timeout, waitUntil: 'networkidle0' });
    } catch (e) {
      console.error(e);
    }

    if (!response) {
      console.error('response does not exist');
      // This should only occur when the page is about:blank. See
      // https://github.com/GoogleChrome/puppeteer/blob/v1.5.0/docs/api.md#pagegotourl-options.
      await page.close();
      return { status: 400, content: '' };
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response.headers()['metadata-flavor'] === 'Google') {
      await page.close();
      return { status: 403, content: '' };
    }

    // Set status to the initial server's response code. Check for a <meta
    // name="render:status_code" content="4xx" /> tag which overrides the status
    // code.
    let statusCode = response.status();
    const newStatusCode =
      await page
        .$eval(
          'meta[name="render:status_code"]',
          (element) => parseInt(element.getAttribute('content') || ''))
        .catch(() => undefined);
    // On a repeat visit to the same origin, browser cache is enabled, so we may
    // encounter a 304 Not Modified. Instead we'll treat this as a 200 OK.
    if (statusCode === 304) {
      statusCode = 200;
    }
    // Original status codes which aren't 200 always return with that status
    // code, regardless of meta tags.
    if (statusCode === 200 && newStatusCode) {
      statusCode = newStatusCode;
    }

    // Remove script & import tags.
    await page.evaluate(stripPage);
    // Inject <base> tag with the origin of the request (ie. no path).
    const parsedUrl = url.parse(requestUrl);
    await page.evaluate(
      injectBaseHref, `${parsedUrl.protocol}//${parsedUrl.host}`);

    // Serialize page.
    const result = await page.evaluate('document.firstElementChild.outerHTML');

    await page.close();
    return { status: statusCode, content: result };
  }

  async screenshot(
    url: string,
    isMobile: boolean,
    dimensions: ViewportDimensions,
    options?: object): Promise<Buffer> {
    const page = await this.browser.newPage();

    // Page may reload when setting isMobile
    // https://github.com/GoogleChrome/puppeteer/blob/v1.10.0/docs/api.md#pagesetviewportviewport
    await page.setViewport(
      { width: dimensions.width, height: dimensions.height, isMobile });

    if (isMobile) {
      page.setUserAgent(MOBILE_USERAGENT);
    }

    let response: puppeteer.Response | null = null;

    try {
      // Navigate to page. Wait until there are no oustanding network requests.
      response =
        await page.goto(url, { timeout: this.config.timeout, waitUntil: 'networkidle0' });
    } catch (e) {
      console.error(e);
    }

    if (!response) {
      throw new ScreenshotError('NoResponse');
    }

    // Disable access to compute metadata. See
    // https://cloud.google.com/compute/docs/storing-retrieving-metadata.
    if (response!.headers()['metadata-flavor'] === 'Google') {
      throw new ScreenshotError('Forbidden');
    }

    // Must be jpeg & binary format.
    const screenshotOptions =
      Object.assign({}, options, { type: 'jpeg', encoding: 'binary' });
    // Screenshot returns a buffer based on specified encoding above.
    // https://github.com/GoogleChrome/puppeteer/blob/v1.8.0/docs/api.md#pagescreenshotoptions
    // @ts-ignore
    const buffer = await page.screenshot(screenshotOptions) as Buffer;
    return buffer;
  }

  async renderAnimation(
    url: string,
    options?: AnimationOptions
  ): Promise<string> {

    const opts = Object.assign({}, {
      readyVarName: 'cxReady',
      nextFuncName: 'nextFrame',
      frames: 10,
      width: 512,
      height: 512,
    }, options)

    const page = await this.browser.newPage();
    await page.setViewport({ width: opts.width, height: opts.height });
    await page.goto(url, { timeout: this.config.timeout });


    console.log('waiting for', 'window.' + opts.readyVarName + ' === true');
    await page.waitForFunction('window.' + opts.readyVarName + ' === true');


    // TODO: uuid
    const captureId = 'abcd-1234';

    // TODO list of file names or something? 
    const images = [];


    const pathToPngs = path.join(__dirname, 'static', 'captures');


    for (let i = 0; i < opts.frames; i++) {
      const filename = captureId + "_" + i.toString().padStart(5, '0') + ".png";
      const file = path.join(pathToPngs, filename);
      console.log('capturing ' + file);
      await page.screenshot({ path: file });

      console.log('waiting for', 'window.' + opts.nextFuncName + '()');
      await page.waitForFunction('window.' + opts.nextFuncName + '()');

      images.push(file)
    }

    await page.close();

    const mp4file = await combinePngToMp4(path.join(pathToPngs, captureId + "_" + '%05d.png'), path.join(pathToPngs, captureId + ".mp4"));

    return mp4file
  }
}

interface AnimationOptions {
  readyVarName?: string;
  nextFuncName?: string;
  frames?: number;
  width?: number;
  height?: number;
}


type ErrorType = 'Forbidden' | 'NoResponse';

export class ScreenshotError extends Error {
  type: ErrorType;

  constructor(type: ErrorType) {
    super(type);

    this.name = this.constructor.name;

    this.type = type;
  }
}

function combinePngToMp4(pathToPngs: string, outputFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // FFmpeg command to combine PNG files into an MP4 file
    const command = `ffmpeg -framerate 25 -i ${pathToPngs} -c:v libx264 -r 30 -pix_fmt yuv420p ${outputFile}`;

    // Execute the command
    exec(command, (error) => {
      if (error) {
        reject(`An error occurred: ${error}`);
        return;
      }
      resolve(outputFile);
    });
  });
}
