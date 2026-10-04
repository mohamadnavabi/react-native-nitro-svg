import type {
  HybridView,
  HybridViewMethods,
  HybridViewProps,
} from 'react-native-nitro-modules';

/**
 * Native props of the `NitroSvg` Hybrid View.
 *
 * Layout props (`width`, `height`, `style`) are intentionally not part of the
 * native spec: Yoga owns the frame, and the native view rasterizes the SVG at
 * its laid-out pixel size. See `NitroSvgViewProps` for the public React API.
 */
export interface NitroSvgProps extends HybridViewProps {
  /**
   * Remote `http(s)` URL of the SVG document.
   */
  url: string;
  /**
   * How long (in seconds) a cached copy is considered fresh, for both the
   * memory and the disk cache. `0` disables caching. Defaults to `86400`.
   */
  cacheTime?: number;
  /**
   * Tint applied to every non-transparent pixel, as `#RRGGBB` or `#RRGGBBAA`.
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

export interface NitroSvgMethods extends HybridViewMethods {}

export type NitroSvg = HybridView<NitroSvgProps, NitroSvgMethods>;
