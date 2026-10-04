import { beforeEach, describe, expect, it } from '@jest/globals';
import { createAbortError, isAbortError } from '../web/abort';
import {
  createSvgRepository,
  type PersistentCache,
  type SvgEnvironment,
} from '../web/SvgRepository';

const URL_A = 'https://cdn.example.com/a.svg';
const URL_B = 'https://cdn.example.com/b.svg';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
const DAY_MS = 86_400_000;

type Responder = (url: string, signal: AbortSignal) => Promise<Response>;

function svgResponse(contentType = 'image/svg+xml') {
  return new Response(SVG, { headers: { 'Content-Type': contentType } });
}

/** Resolves when `signal` aborts, rejects never: a request that hangs. */
function hangUntilAborted(signal: AbortSignal) {
  return new Promise<Response>((_, reject) => {
    signal.addEventListener('abort', () => reject(createAbortError()));
  });
}

const flushTasks = () => new Promise((resolve) => setTimeout(resolve, 0));

function createFakeCache(): PersistentCache {
  const entries = new Map<string, Response>();
  return {
    match: async (url) => entries.get(url)?.clone(),
    put: async (url, response) => {
      entries.delete(url);
      entries.set(url, response);
    },
    keys: async () => [...entries.keys()].map((url) => ({ url })),
    delete: async (url) => entries.delete(url),
  };
}

function createEnvironment(
  cache: PersistentCache | undefined = createFakeCache()
) {
  const state = {
    time: 1_000_000,
    responder: (async () => svgResponse()) as Responder,
    fetches: [] as { url: string; signal: AbortSignal }[],
    decoded: [] as string[],
    brokenSources: new Set<string>(),
  };
  const env: SvgEnvironment = {
    fetch: (url, init) => {
      const signal = init.signal as AbortSignal;
      state.fetches.push({ url, signal });
      return state.responder(url, signal);
    },
    now: () => state.time,
    openCache: cache ? async () => cache : undefined,
    readAsDataUrl: async (blob) => {
      const text = await (
        blob as unknown as { text(): Promise<string> }
      ).text();
      return `data:${blob.type},${encodeURIComponent(text)}`;
    },
    decode: async (src, signal) => {
      if (signal.aborted) throw createAbortError();
      if ([...state.brokenSources].some((part) => src.includes(part))) {
        throw new Error('EncodingError');
      }
      state.decoded.push(src);
    },
  };
  return { env, state };
}

describe('SvgRepository (web)', () => {
  let env: SvgEnvironment;
  let state: ReturnType<typeof createEnvironment>['state'];

  beforeEach(() => {
    ({ env, state } = createEnvironment());
  });

  it('loads an SVG as a decoded data URL and serves it from memory', async () => {
    const repository = createSvgRepository(env);
    expect(repository.peek(URL_A, DAY_MS)).toBeUndefined();

    const src = await repository.load(
      URL_A,
      DAY_MS,
      new AbortController().signal
    );

    expect(src.startsWith('data:image/svg+xml,')).toBe(true);
    expect(state.decoded).toEqual([src]);
    expect(repository.peek(URL_A, DAY_MS)).toBe(src);
    await repository.load(URL_A, DAY_MS, new AbortController().signal);
    expect(state.fetches).toHaveLength(1);
  });

  it('forces the SVG MIME type when the server sends the wrong one', async () => {
    state.responder = async () => svgResponse('text/plain; charset=utf-8');
    const repository = createSvgRepository(env);

    const src = await repository.load(
      URL_A,
      DAY_MS,
      new AbortController().signal
    );

    expect(src.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
  });

  it('expires memory entries after cacheTime', async () => {
    const repository = createSvgRepository(env);
    await repository.load(URL_A, DAY_MS, new AbortController().signal);

    state.time += DAY_MS;

    expect(repository.peek(URL_A, DAY_MS)).toBeUndefined();
  });

  it('restores from the persistent cache, honoring cacheTime', async () => {
    const cache = createFakeCache();
    const first = createEnvironment(cache);
    await createSvgRepository(first.env).load(
      URL_A,
      DAY_MS,
      new AbortController().signal
    );
    await flushTasks();

    // A fresh repository (e.g. after a reload) has an empty memory tier.
    const second = createEnvironment(cache);
    const src = await createSvgRepository(second.env).load(
      URL_A,
      DAY_MS,
      new AbortController().signal
    );
    expect(src.startsWith('data:image/svg+xml')).toBe(true);
    expect(second.state.fetches).toHaveLength(0);

    const third = createEnvironment(cache);
    third.state.time += DAY_MS;
    await createSvgRepository(third.env).load(
      URL_A,
      DAY_MS,
      new AbortController().signal
    );
    expect(third.state.fetches).toHaveLength(1);
  });

  it('bypasses both cache tiers when cacheTime is 0', async () => {
    const cache = createFakeCache();
    ({ env, state } = createEnvironment(cache));
    const repository = createSvgRepository(env);

    await repository.load(URL_A, 0, new AbortController().signal);
    await repository.load(URL_A, 0, new AbortController().signal);
    await flushTasks();

    expect(state.fetches).toHaveLength(2);
    expect(repository.peek(URL_A, DAY_MS)).toBeUndefined();
    expect(await cache.keys()).toHaveLength(0);
  });

  it('shares one request between concurrent callers', async () => {
    const repository = createSvgRepository(env);

    const [a, b] = await Promise.all([
      repository.load(URL_A, DAY_MS, new AbortController().signal),
      repository.load(URL_A, DAY_MS, new AbortController().signal),
    ]);

    expect(a).toBe(b);
    expect(state.fetches).toHaveLength(1);
  });

  it('aborts the request once its last caller is gone', async () => {
    state.responder = (_, signal) => hangUntilAborted(signal);
    const repository = createSvgRepository(env);
    const controller = new AbortController();

    const pending = repository.load(URL_A, DAY_MS, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await flushTasks();
    expect(state.fetches[0]?.signal.aborted).toBe(true);
  });

  it('keeps a shared request alive while another caller waits', async () => {
    let release: () => void = () => {};
    state.responder = () =>
      new Promise((resolve) => {
        release = () => resolve(svgResponse());
      });
    const repository = createSvgRepository(env);
    const leaving = new AbortController();

    const abandoned = repository.load(URL_A, DAY_MS, leaving.signal);
    const kept = repository.load(URL_A, DAY_MS, new AbortController().signal);
    leaving.abort();
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    await flushTasks();
    release();

    await expect(kept).resolves.toMatch(/^data:image\/svg\+xml/);
    expect(state.fetches).toHaveLength(1);
    expect(state.fetches[0]?.signal.aborted).toBe(false);
  });

  it('reuses a request when a caller re-subscribes immediately', async () => {
    let release: () => void = () => {};
    state.responder = () =>
      new Promise((resolve) => {
        release = () => resolve(svgResponse());
      });
    const repository = createSvgRepository(env);
    const first = new AbortController();

    // React StrictMode: effect, cleanup, effect again in the same task.
    repository.load(URL_A, DAY_MS, first.signal).catch(() => {});
    first.abort();
    const second = repository.load(URL_A, DAY_MS, new AbortController().signal);
    await flushTasks();
    release();

    await expect(second).resolves.toMatch(/^data:/);
    expect(state.fetches).toHaveLength(1);
  });

  it('reports HTTP errors', async () => {
    state.responder = async () => new Response('Not found', { status: 404 });
    const repository = createSvgRepository(env);

    await expect(
      repository.load(URL_A, DAY_MS, new AbortController().signal)
    ).rejects.toThrow(`HTTP 404 while fetching ${URL_A}`);
  });

  it('reports undecodable payloads and caches nothing', async () => {
    const cache = createFakeCache();
    ({ env, state } = createEnvironment(cache));
    state.responder = async () => new Response('<html>oops</html>');
    const repository = createSvgRepository(env);
    state.brokenSources.add(encodeURIComponent('<html>oops</html>'));

    await expect(
      repository.load(URL_A, DAY_MS, new AbortController().signal)
    ).rejects.toThrow(`Failed to load or decode SVG from ${URL_A}`);
    await flushTasks();
    expect(repository.peek(URL_A, DAY_MS)).toBeUndefined();
    expect(await cache.keys()).toHaveLength(0);
  });

  it('falls back to a plain <img> load when the server refuses CORS', async () => {
    state.responder = async () => {
      throw new TypeError('Failed to fetch');
    };
    const repository = createSvgRepository(env);

    const src = await repository.load(
      URL_A,
      DAY_MS,
      new AbortController().signal
    );

    expect(src).toBe(URL_A);
    expect(repository.peek(URL_A, DAY_MS)).toBe(URL_A);
    // The origin is remembered: no doomed fetch for the next URL on it.
    await repository.load(URL_B, DAY_MS, new AbortController().signal);
    expect(state.fetches.map((call) => call.url)).toEqual([URL_A]);
    expect(state.decoded).toEqual([URL_A, URL_B]);
  });

  it('reports unreachable URLs', async () => {
    state.responder = async () => {
      throw new TypeError('Failed to fetch');
    };
    state.brokenSources.add(URL_A);
    const repository = createSvgRepository(env);

    const error = await repository
      .load(URL_A, DAY_MS, new AbortController().signal)
      .catch((reason: unknown) => reason);

    expect(isAbortError(error)).toBe(false);
    expect(error).toMatchObject({
      message: `Failed to load or decode SVG from ${URL_A}`,
    });
  });

  it('works without Cache Storage', async () => {
    ({ env, state } = createEnvironment(undefined));
    const repository = createSvgRepository(env);

    await expect(
      repository.load(URL_A, DAY_MS, new AbortController().signal)
    ).resolves.toMatch(/^data:image\/svg\+xml/);
  });
});
