import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ViewStyle } from 'react-native';
import { callback, getHostComponent } from 'react-native-nitro-modules';
const NitroSvgConfig = require('react-native-nitro-svg/nitrogen/generated/shared/json/NitroSvgConfig.json');
import type { NitroSvgMethods, NitroSvgProps } from './NitroSvg.nitro';
import { normalizeTintColor } from './normalizeTintColor';
import type { NitroSvgViewProps } from './types';

const NitroSvgHostView = getHostComponent<NitroSvgProps, NitroSvgMethods>(
  'NitroSvg',
  () => NitroSvgConfig
);

/**
 * Keeps a native callback prop referentially stable across renders, so
 * re-rendering a parent (e.g. a list cell) doesn't push a new function to
 * native every time. Only adding or removing the handler updates the prop.
 */
function useStableCallback<Args extends unknown[]>(
  handler: ((...args: Args) => void) | undefined
) {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  const hasHandler = handler != null;
  return useMemo(
    () =>
      hasHandler
        ? callback((...args: Args) => handlerRef.current?.(...args))
        : undefined,
    [hasHandler]
  );
}

export function NitroSvgView({
  width,
  height,
  style,
  tintColor,
  onLoad,
  onError,
  ...rest
}: NitroSvgViewProps) {
  // Explicit `width`/`height` feed Yoga, so they must live in the style.
  // Only defined keys are set, so `undefined` never overrides `style`.
  const sizeStyle = useMemo<ViewStyle | undefined>(() => {
    if (width == null && height == null) {
      return undefined;
    }
    return {
      ...(width != null ? { width } : null),
      ...(height != null ? { height } : null),
    };
  }, [width, height]);
  const nativeTintColor = useMemo(
    () => normalizeTintColor(tintColor),
    [tintColor]
  );
  const nativeOnLoad = useStableCallback(onLoad);
  const nativeOnError = useStableCallback(onError);

  return (
    <NitroSvgHostView
      {...rest}
      style={sizeStyle != null ? [style, sizeStyle] : style}
      tintColor={nativeTintColor}
      onLoad={nativeOnLoad}
      onError={nativeOnError}
    />
  );
}
