import { createAbortError } from './abort';
import {
  createSvgRepository,
  type PersistentCache,
  type SvgEnvironment,
  type SvgRepository,
} from './SvgRepository';

// Minimal typings for the browser APIs used here: the library compiles
// without `lib.dom`, and React Native's globals don't declare these.
interface HTMLImage {
  src: string;
  decoding: 'sync' | 'async' | 'auto';
  decode(): Promise<void>;
}

interface BrowserGlobals {
  Image?: new () => HTMLImage;
  caches?: { open(name: string): Promise<PersistentCache> };
  document?: { baseURI: string };
}

// Read lazily, never at import time, so server rendering stays safe.
const browser = globalThis as unknown as BrowserGlobals;

const CACHE_NAME = 'nitro-svg-v1';

function createBrowserEnvironment(): SvgEnvironment {
  const cacheStorage = browser.caches;
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    openCache: cacheStorage ? () => cacheStorage.open(CACHE_NAME) : undefined,
    readAsDataUrl: (blob) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }),
    decode: (src, signal) =>
      new Promise((resolve, reject) => {
        const ImageConstructor = browser.Image;
        if (ImageConstructor === undefined) {
          resolve();
          return;
        }
        const image = new ImageConstructor();
        // `decode()` rasterizes off the main thread, so the visible `<img>`
        // paints in one frame instead of decoding on first paint.
        image.decoding = 'async';
        const onAbort = () => {
          // Clearing `src` cancels an in-flight download.
          image.src = '';
          reject(createAbortError());
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        image.src = src;
        image.decode().then(
          () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          }
        );
      }),
  };
}

let sharedRepository: SvgRepository | undefined;

/** The process-wide repository, created on first use. */
export function getSvgRepository() {
  sharedRepository ??= createSvgRepository(createBrowserEnvironment());
  return sharedRepository;
}

/** Base for resolving relative URLs; `undefined` outside a browser. */
export function getDocumentBaseUrl() {
  return browser.document?.baseURI;
}
