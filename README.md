# react-native-nitro-svg

CoreSVG and AndroidSVG for react native

## Installation


```sh
npm install react-native-nitro-svg react-native-nitro-modules

> `react-native-nitro-modules` is required as this library relies on [Nitro Modules](https://nitro.margelo.com/).
```


## Usage


```js
import { NitroSvgView } from "react-native-nitro-svg";

// ...

<NitroSvgView
  url="https://example.com/icon.svg"
  width={48}
  height={48}
  tintColor="tomato"
  onLoad={() => console.log('loaded')}
  onError={(error) => console.warn(error)}
/>
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | – | Remote `http(s)` URL of the SVG. |
| `width` / `height` | `number` | – | Explicit size in dp/pt (shorthand for `style`). |
| `style` | `ViewStyle` | – | Standard layout styles. |
| `cacheTime` | `number` | `86400` | Seconds a cached copy stays fresh (memory + disk). `0` disables caching. |
| `tintColor` | `string` | – | Replaces the color of every non-transparent pixel. |
| `onLoad` | `() => void` | – | Called once the SVG for the current `url` is on screen. |
| `onError` | `(error: string) => void` | – | Called when fetching, parsing or rendering fails. |

The SVG is rasterized off the main thread at the view's laid-out pixel size (CoreSVG on iOS, AndroidSVG on Android) and cached in a shared memory LRU and on disk. In-flight requests are cancelled when the `url` changes or the view is recycled/unmounted, and identical concurrent requests share one download.


## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)
