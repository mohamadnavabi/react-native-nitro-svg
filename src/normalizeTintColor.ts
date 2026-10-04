/* eslint-disable no-bitwise -- unpacking a packed ARGB integer */
import { processColor } from 'react-native';

const toHexByte = (value: number) => value.toString(16).padStart(2, '0');

/**
 * Converts any React Native color string into the `#RRGGBBAA` form the native
 * views parse. Returns `undefined` for invalid or platform colors.
 */
export function normalizeTintColor(color: string | undefined) {
  if (color == null) {
    return undefined;
  }
  const processed = processColor(color);
  if (typeof processed !== 'number') {
    return undefined;
  }
  // `processColor` returns 0xAARRGGBB (signed on Android).
  const argb = processed >>> 0;
  const alpha = (argb >>> 24) & 0xff;
  const red = (argb >>> 16) & 0xff;
  const green = (argb >>> 8) & 0xff;
  const blue = argb & 0xff;
  return `#${toHexByte(red)}${toHexByte(green)}${toHexByte(blue)}${toHexByte(alpha)}`;
}
