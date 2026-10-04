import type { StyleProp, ViewProps, ViewStyle } from 'react-native';

export interface NitroSvgViewProps extends Omit<ViewProps, 'style'> {
  /**
   * Remote `http(s)` URL of the SVG document.
   */
  url: string;
  /**
   * Explicit width in dp/pt. Shorthand for `style={{ width }}`.
   */
  width?: number;
  /**
   * Explicit height in dp/pt. Shorthand for `style={{ height }}`.
   */
  height?: number;
  style?: StyleProp<ViewStyle>;
  /**
   * How long (in seconds) a cached copy is considered fresh, for both the
   * memory and the disk cache. `0` disables caching.
   * @default 86400
   */
  cacheTime?: number;
  /**
   * Tint applied to every non-transparent pixel of the SVG.
   * Accepts any React Native color string (`'#f00'`, `'red'`, `'rgba(…)'`, …).
   */
  tintColor?: string;
  /**
   * Called once the SVG for the current `url` is on screen.
   */
  onLoad?: () => void;
  /**
   * Called when fetching, parsing or rendering the SVG fails.
   */
  onError?: (error: string) => void;
}
