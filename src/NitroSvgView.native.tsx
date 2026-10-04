import { getHostComponent } from 'react-native-nitro-modules';
const NitroSvgConfig = require('../nitrogen/generated/shared/json/NitroSvgConfig.json');
import type {
  NitroSvgMethods,
  NitroSvgProps,
} from './NitroSvg.nitro';

export const NitroSvgView = getHostComponent<
  NitroSvgProps,
  NitroSvgMethods
>('NitroSvg', () => NitroSvgConfig);
