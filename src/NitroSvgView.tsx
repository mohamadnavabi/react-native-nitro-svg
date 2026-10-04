import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { View, type ViewStyle } from 'react-native';
import type { NitroSvgViewProps } from './types';
import { isAbortError } from './web/abort';
import { getDocumentBaseUrl, getSvgRepository } from './web/browser';

const DEFAULT_CACHE_TIME_SECONDS = 86_400;

const IMAGE_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  pointerEvents: 'none',
  userSelect: 'none',
};

// Not `display: none`: filters defined inside a hidden <svg> don't apply.
const FILTER_SVG_STYLE: CSSProperties = {
  position: 'absolute',
  width: 0,
  height: 0,
  overflow: 'hidden',
};

type ResolvedUrl = { href: string } | { error: string } | undefined;

/** Relative URLs resolve against the document, as they would in `<img>`. */
function resolveUrl(url: string): ResolvedUrl {
  if (url === '') {
    return undefined;
  }
  try {
    const resolved = new URL(url, getDocumentBaseUrl());
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      return { href: resolved.href };
    }
  } catch {
    // Reported below.
  }
  return {
    error: `Invalid SVG URL "${url}" (only http and https are supported)`,
  };
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Web implementation, with the same contract as the native views:
 *
 * - Memory, Cache Storage (honoring `cacheTime`) and network tiers, with
 *   identical in-flight requests shared and aborted with their last view.
 * - The SVG is decoded off the main thread before it's shown, and a memory
 *   hit renders in the first frame, so recycled list cells never flash.
 * - It renders through `<img>`, which keeps the vector crisp at any zoom and
 *   sandboxes the SVG (no scripts, no external requests), unlike inlining it.
 * - `tintColor` uses an SVG filter, which also works for cross-origin
 *   images that a CSS mask couldn't read without CORS.
 */
export function NitroSvgView({
  url,
  width,
  height,
  style,
  cacheTime = DEFAULT_CACHE_TIME_SECONDS,
  tintColor,
  onLoad,
  onError,
  ...rest
}: NitroSvgViewProps) {
  const repository = getSvgRepository();
  const maxAgeMs = cacheTime > 0 ? cacheTime * 1000 : 0;
  const resolved = useMemo(() => resolveUrl(url), [url]);
  const href =
    resolved !== undefined && 'href' in resolved ? resolved.href : undefined;
  const urlError =
    resolved !== undefined && 'error' in resolved ? resolved.error : undefined;
  const onLoadRef = useLatest(onLoad);
  const onErrorRef = useLatest(onError);

  // The source is derived per URL; a memory hit is available synchronously.
  const [source, setSource] = useState(() => ({
    href,
    src: href !== undefined ? repository.peek(href, maxAgeMs) : undefined,
  }));
  let src = source.src;
  if (source.href !== href) {
    // Cleared right away so a recycled view never shows the previous URL.
    src = href !== undefined ? repository.peek(href, maxAgeMs) : undefined;
    setSource({ href, src });
  }

  const hasSource = src !== undefined;
  useEffect(() => {
    if (href === undefined || hasSource) {
      return;
    }
    const controller = new AbortController();
    repository.load(href, maxAgeMs, controller.signal).then(
      (loaded) => {
        setSource((current) =>
          current.href === href ? { href, src: loaded } : current
        );
      },
      (error: unknown) => {
        if (!isAbortError(error)) {
          onErrorRef.current?.(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    );
    // Aborts the request on URL change and unmount (shared requests are
    // only aborted once no other view is waiting for them).
    return () => controller.abort();
  }, [repository, href, maxAgeMs, hasSource, onErrorRef]);

  useEffect(() => {
    if (urlError !== undefined) {
      onErrorRef.current?.(urlError);
    }
  }, [urlError, onErrorRef]);

  const loadedHrefRef = useRef<string | undefined>(undefined);
  const handleLoad = () => {
    // Once per URL: re-renders and tint changes don't fire it again.
    if (loadedHrefRef.current !== href) {
      loadedHrefRef.current = href;
      onLoadRef.current?.();
    }
  };
  const handleError = () => {
    onErrorRef.current?.(`Failed to render SVG from ${href}`);
  };

  const reactId = useId();
  const filterId = `nitro-svg-tint-${reactId.replace(/[^\w-]/g, '')}`;
  const sizeStyle = useMemo<ViewStyle | undefined>(() => {
    if (width == null && height == null) {
      return undefined;
    }
    return {
      ...(width != null ? { width } : null),
      ...(height != null ? { height } : null),
    };
  }, [width, height]);

  return (
    <View
      {...rest}
      style={sizeStyle !== undefined ? [style, sizeStyle] : style}
    >
      {tintColor ? (
        <svg aria-hidden="true" focusable="false" style={FILTER_SVG_STYLE}>
          <filter id={filterId} colorInterpolationFilters="sRGB">
            <feFlood floodColor={tintColor} />
            <feComposite in2="SourceAlpha" operator="in" />
          </filter>
        </svg>
      ) : null}
      {src !== undefined ? (
        <img
          src={src}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={handleLoad}
          onError={handleError}
          style={
            tintColor
              ? { ...IMAGE_STYLE, filter: `url(#${filterId})` }
              : IMAGE_STYLE
          }
        />
      ) : null}
    </View>
  );
}
