import type {
  HybridView,
  HybridViewMethods,
  HybridViewProps,
} from 'react-native-nitro-modules';

export interface NitroSvgProps extends HybridViewProps {
  color: string;
}
export interface NitroSvgMethods extends HybridViewMethods {}

export type NitroSvg = HybridView<
  NitroSvgProps,
  NitroSvgMethods
>;
