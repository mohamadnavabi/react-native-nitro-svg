import { createAbortError, isAbortError, throwIfAborted } from './abort';
import { LRUCache } from './LRUCache';
import { TaskCoalescer } from './TaskCoalescer';

/** The subset of the Cache Storage API the persistent tier uses. */
export interface PersistentCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  keys(): Promise<ReadonlyArray<{ readonly url: string }>>;
  delete(url: string): Promise<boolean>;
}

/** Browser capabilities, injected so the pipeline is testable and SSR-safe. */
export interface SvgEnvironment {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  /** Persistent tier; `undefined` when Cache Storage isn't available. */
  openCache?: () => Promise<PersistentCache>;
  readAsDataUrl(blob: Blob): Promise<string>;
  /**
   * Loads and decodes `src` off the main thread, resolving once it can be
   * painted without blocking. Rejects if it can't be loaded or decoded.
   */
  decode(src: string, signal: AbortSignal): Promise<void>;
}

export interface SvgRepository {
  /** Synchronous memory lookup; cheap enough to call during render. */
  peek(url: string, maxAgeMs: number): string | undefined;
  /** Resolves with an `<img>`-ready `src` for `url`. */
  load(url: string, maxAgeMs: number, signal: AbortSignal): Promise<string>;
}

const SVG_MIME = 'image/svg+xml';
const ACCEPT = 'image/svg+xml,*/*;q=0.8';
const FETCHED_AT_HEADER = 'x-nitro-svg-fetched-at';
const MEMORY_CACHE_CHARS = 24 * 1024 * 1024;
const MEMORY_CACHE_COUNT = 500;
const PERSISTENT_CACHE_COUNT = 500;

interface MemoryEntry {
  src: string;
  fetchedAt: number;
}

/**
 * Web counterpart of the native pipeline:
 *
 * 1. Memory: LRU of decoded `data:` URLs (synchronous hit during render, so
 *    recycled list cells never flash).
 * 2. Persistent: Cache Storage, which unlike the HTTP cache honors `cacheTime`.
 * 3. Network: `fetch`, deduplicated per URL and aborted with its last caller.
 *
 * Servers that don't send CORS headers can't hand their bytes to `fetch`. The
 * browser can still display them, so those fall back to a plain `<img>` load
 * (memory tier only; persistence is then up to the HTTP cache).
 */
export function createSvgRepository(env: SvgEnvironment): SvgRepository {
  const memory = new LRUCache<MemoryEntry>(
    MEMORY_CACHE_CHARS,
    MEMORY_CACHE_COUNT
  );
  const loads = new TaskCoalescer<string>();
  const corsBlockedOrigins = new Set<string>();
  let persistentCache: Promise<PersistentCache | undefined> | undefined;

  function openPersistentCache() {
    if (persistentCache === undefined) {
      // Missing in insecure contexts; rejects in some private-browsing modes.
      persistentCache = env.openCache
        ? env.openCache().catch(() => undefined)
        : Promise.resolve(undefined);
    }
    return persistentCache;
  }

  function peek(url: string, maxAgeMs: number) {
    if (maxAgeMs <= 0) {
      return undefined;
    }
    const entry = memory.get(url);
    if (entry === undefined) {
      return undefined;
    }
    if (env.now() - entry.fetchedAt >= maxAgeMs) {
      memory.delete(url);
      return undefined;
    }
    return entry.src;
  }

  function load(url: string, maxAgeMs: number, signal: AbortSignal) {
    const cached = peek(url, maxAgeMs);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    const key = `${maxAgeMs > 0 ? 'cached' : 'uncached'}:${url}`;
    return loads.run(key, signal, (operationSignal) =>
      loadUncached(url, maxAgeMs, operationSignal)
    );
  }

  async function loadUncached(
    url: string,
    maxAgeMs: number,
    signal: AbortSignal
  ) {
    const useCache = maxAgeMs > 0;

    if (useCache) {
      const persisted = await readPersistent(url, maxAgeMs);
      throwIfAborted(signal);
      if (persisted !== undefined) {
        try {
          const src = await toSvgDataUrl(persisted.blob);
          return await accept(url, src, persisted.fetchedAt, useCache, signal);
        } catch (error) {
          if (isAbortError(error)) throw error;
          // Unreadable entry: drop it and fall through to the network.
          deletePersistent(url);
        }
      }
    }

    const origin = originOf(url);
    if (!corsBlockedOrigins.has(origin)) {
      const response = await fetchOrUndefined(url, signal);
      if (response !== undefined) {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} while fetching ${url}`);
        }
        const blob = await response.blob();
        const fetchedAt = env.now();
        // Decoded before anything is cached, so a broken payload never is.
        const src = await accept(
          url,
          await toSvgDataUrl(blob),
          fetchedAt,
          useCache,
          signal
        );
        if (useCache) {
          writePersistent(url, blob, fetchedAt);
        }
        return src;
      }
    }

    const src = await accept(url, url, env.now(), useCache, signal);
    corsBlockedOrigins.add(origin);
    return src;
  }

  /**
   * `fetch` fails the same way for a network error and a missing CORS header,
   * so both return `undefined` and the caller retries as a plain `<img>`.
   */
  async function fetchOrUndefined(url: string, signal: AbortSignal) {
    try {
      return await env.fetch(url, {
        signal,
        mode: 'cors',
        credentials: 'same-origin',
        headers: { Accept: ACCEPT },
        // Revalidate: `cacheTime` decides freshness, not the HTTP cache.
        cache: 'no-cache',
      } as RequestInit);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw createAbortError();
      }
      return undefined;
    }
  }

  async function accept(
    url: string,
    src: string,
    fetchedAt: number,
    useCache: boolean,
    signal: AbortSignal
  ) {
    try {
      await env.decode(src, signal);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw createAbortError();
      }
      throw new Error(`Failed to load or decode SVG from ${url}`);
    }
    if (useCache) {
      memory.set(url, { src, fetchedAt }, src.length);
    }
    return src;
  }

  /** Forces the SVG MIME type, so servers sending `text/plain` still render. */
  async function toSvgDataUrl(blob: Blob) {
    const dataUrl = await env.readAsDataUrl(blob);
    return dataUrl.replace(/^data:[^;,]*/, `data:${SVG_MIME}`);
  }

  async function readPersistent(url: string, maxAgeMs: number) {
    const cache = await openPersistentCache();
    if (cache === undefined) return undefined;
    try {
      const response = await cache.match(url);
      if (response === undefined) return undefined;
      const fetchedAt = Number(response.headers.get(FETCHED_AT_HEADER));
      if (!Number.isFinite(fetchedAt) || env.now() - fetchedAt >= maxAgeMs) {
        return undefined;
      }
      return { blob: await response.blob(), fetchedAt };
    } catch {
      return undefined;
    }
  }

  async function writePersistent(url: string, blob: Blob, fetchedAt: number) {
    const cache = await openPersistentCache();
    if (cache === undefined) return;
    try {
      await cache.put(
        url,
        new Response(blob, {
          headers: {
            'Content-Type': SVG_MIME,
            [FETCHED_AT_HEADER]: String(fetchedAt),
          },
        })
      );
      // Entries are kept in insertion order: evict the oldest.
      const keys = await cache.keys();
      const excess = keys.length - PERSISTENT_CACHE_COUNT;
      for (const request of keys.slice(0, Math.max(0, excess))) {
        await cache.delete(request.url);
      }
    } catch {
      // Quota exceeded or storage disabled: the persistent tier is best-effort.
    }
  }

  async function deletePersistent(url: string) {
    const cache = await openPersistentCache();
    await cache?.delete(url).catch(() => false);
  }

  return { peek, load };
}

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
