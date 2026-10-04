import { Image, StyleSheet, View } from 'react-native';
import type { NitroSvgViewProps } from './types';

// Web fallback: browsers render SVG natively, so `<img>` (via Image) suffices.
export function NitroSvgView({
  url,
  width,
  height,
  style,
  cacheTime: _cacheTime,
  tintColor,
  onLoad,
  onError,
  ...rest
}: NitroSvgViewProps) {
  return (
    <View
      {...rest}
      style={[style, width != null && { width }, height != null && { height }]}
    >
      <Image
        source={{ uri: url }}
        resizeMode="contain"
        style={[StyleSheet.absoluteFill, tintColor != null && { tintColor }]}
        onLoad={() => onLoad?.()}
        onError={(event) => onError?.(String(event.nativeEvent.error))}
      />
    </View>
  );
}
