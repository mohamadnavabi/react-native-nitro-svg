# react-native-nitro-svg

Fast remote SVG rendering for React Native, built on [Nitro Modules](https://nitro.margelo.com/).

`NitroSvgView` downloads an SVG from a URL, rasterizes it **off the main thread** with the platform's native renderer (CoreSVG on iOS, AndroidSVG on Android), and caches the result in memory and on disk. It is designed for screens that show many SVG icons at once — lists, grids, feeds — where a JS-driven SVG tree would be too slow.

```tsx
<NitroSvgView url="https://example.com/icon.svg" width={48} height={48} />
```

## Features

- **Native rendering** – CoreSVG (the engine behind SF Symbols and asset catalogs) on iOS, [AndroidSVG](https://bigbadaboom.github.io/androidsvg/) on Android, `<img>` on web.
- **Sharp at any size** – the SVG is rasterized at the view's laid-out size × screen scale, so it stays crisp on every screen density.
- **Three-tier cache** – memory (rasterized bitmaps + parsed documents), disk (raw SVG bytes) and network, with a configurable `cacheTime`.
- **Request deduplication** – any number of views showing the same URL share a single download, parse and rasterization.
- **Automatic cancellation** – in-flight work is cancelled when the `url` changes or the view is unmounted or recycled.
- **List-friendly** – supports Fabric view recycling; a memory hit paints in the same frame, so recycled cells never flash the previous image.
- **`tintColor`** – recolor monochrome icons with any React Native color string (`'red'`, `'#f00'`, `'rgba(…)'`).
- **`onLoad` / `onError`** – with descriptive error messages (HTTP status, malformed SVG, missing size, …).
- **Memory-pressure aware** – caches shrink on memory warnings and when the app goes to the background.
- **Web support** – same API and caching behaviour on React Native Web.
- **TypeScript** – fully typed props.

## Performance

`NitroSvgView` is a single native view that displays a single bitmap. There is no JS-side SVG parsing and no tree of shape views, so the cost of an icon on screen is the same as an `<Image>`.

What happens when a view mounts:

1. **Memory (synchronous, main thread)** – an O(1) LRU lookup for an already-rasterized bitmap of this URL at this exact pixel size (and tint). On a hit the image is shown immediately, in the same frame.
2. **Parsed document (background)** – if the SVG was already parsed for another size, only rasterization is needed.
3. **Disk (background)** – raw SVG bytes are read from the app's cache directory and parsed.
4. **Network (background)** – fetched with `URLSession` on iOS and React Native's own OkHttp client on Android (so custom `OkHttpClientFactory` setups such as certificate pinning still apply). Responses are parsed _before_ they are cached, so a broken payload is never persisted.

All network, disk, parsing and rasterization work runs on background threads; the main thread only assigns finished pixels to the view. On iOS, bitmaps are produced in BGRA premultiplied format so Core Animation can upload them to the GPU without conversion.

Cache budgets:

| Tier               | iOS                         | Android                     | Web                                              |
| ------------------ | --------------------------- | --------------------------- | ------------------------------------------------ |
| Rasterized bitmaps | 48 MB                       | ⅛ of the heap, up to 48 MB  | ~24 M characters of `data:` URLs (≤ 500 entries) |
| Parsed documents   | 8 MB (≤ 256 entries)        | 8 MB                        | –                                                |
| Disk / persistent  | 64 MB, oldest evicted first | 64 MB, oldest evicted first | Cache Storage, ≤ 500 entries                     |

Freshness is controlled per view with `cacheTime` (default: 1 day). `cacheTime={0}` bypasses and doesn't populate any cache.

### When to use it

`react-native-nitro-svg` is a good fit when you **display** SVGs from a server: icons, logos, illustrations, flags, avatars. If you need to build SVGs in JSX, animate individual shapes, or handle touches on parts of a drawing, use [`react-native-svg`](https://github.com/software-mansion/react-native-svg) instead.

## Requirements

- React Native with the **New Architecture** enabled (default since 0.76)
- [`react-native-nitro-modules`](https://nitro.margelo.com/) `^0.37.1`
- iOS: the minimum version supported by your React Native version
- Android: `minSdkVersion` 24+
- Expo: works in a [development build](https://docs.expo.dev/develop/development-builds/introduction/) (not in Expo Go)

## Installation

```sh
npm install react-native-nitro-svg react-native-nitro-modules
# or
yarn add react-native-nitro-svg react-native-nitro-modules
```

Then install the iOS pods:

```sh
cd ios && pod install
```

With Expo:

```sh
npx expo install react-native-nitro-svg react-native-nitro-modules
npx expo prebuild
```

No additional native setup is required — the module is autolinked.

## Usage

```tsx
import { NitroSvgView } from 'react-native-nitro-svg';

export function Icon() {
  return (
    <NitroSvgView
      url="https://example.com/icon.svg"
      width={48}
      height={48}
      tintColor="tomato"
      onLoad={() => console.log('loaded')}
      onError={(error) => console.warn(error)}
    />
  );
}
```

The view needs a size, either through `width` / `height` or through `style` (e.g. `flex: 1`, `aspectRatio`). The SVG is drawn **aspect-fit and centered** inside that box.

### In a list

```tsx
<FlatList
  data={icons}
  keyExtractor={(item) => item.id}
  renderItem={({ item }) => (
    <NitroSvgView url={item.svgUrl} style={styles.icon} />
  )}
/>
```

Cells can be recycled freely: changing `url` cancels the previous request and clears the old image right away.

### Props

| Prop               | Type                      | Default | Description                                                                       |
| ------------------ | ------------------------- | ------- | --------------------------------------------------------------------------------- |
| `url`              | `string`                  | –       | Remote `http(s)` URL of the SVG.                                                  |
| `width` / `height` | `number`                  | –       | Explicit size in dp/pt (shorthand for `style`).                                   |
| `style`            | `ViewStyle`               | –       | Standard layout styles.                                                           |
| `cacheTime`        | `number`                  | `86400` | Seconds a cached copy stays fresh (memory + disk). `0` disables caching.          |
| `tintColor`        | `string`                  | –       | Replaces the color of every non-transparent pixel. Any React Native color string. |
| `onLoad`           | `() => void`              | –       | Called once the SVG for the current `url` is on screen.                           |
| `onError`          | `(error: string) => void` | –       | Called when fetching, parsing or rendering fails.                                 |

All other `View` props (`testID`, `accessibilityLabel`, `pointerEvents`, …) are passed through.

## Platform notes

- **iOS** – iOS has no public SVG API, so the library uses CoreSVG, the system framework UIKit uses for SVG assets, resolved at runtime. If it is ever unavailable, the view calls `onError` instead of crashing.
- **Android** – uses AndroidSVG 1.4. Support for advanced SVG features (filters, some CSS) follows that library.
- **Web** – rendered through `<img>`, which keeps the vector crisp at any zoom and sandboxes the SVG (no scripts or external requests). Servers without CORS headers still display, but are only cached in memory.
- SVGs must declare a size via `viewBox` or `width`/`height`; documents without one report an error.
- Only remote `http(s)` URLs are supported; local files and `require()` assets are not.

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)
