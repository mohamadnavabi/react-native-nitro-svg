import { describe, expect, it } from '@jest/globals';
import { normalizeTintColor } from '../normalizeTintColor';

describe('normalizeTintColor', () => {
  it('returns undefined when no color is given', () => {
    expect(normalizeTintColor(undefined)).toBeUndefined();
  });

  it('converts hex colors to #RRGGBBAA', () => {
    expect(normalizeTintColor('#32a852')).toBe('#32a852ff');
    expect(normalizeTintColor('#f00')).toBe('#ff0000ff');
    expect(normalizeTintColor('#11223380')).toBe('#11223380');
  });

  it('converts named and functional colors', () => {
    expect(normalizeTintColor('red')).toBe('#ff0000ff');
    expect(normalizeTintColor('rgba(0, 0, 255, 0.5)')).toBe('#0000ff80');
    expect(normalizeTintColor('transparent')).toBe('#00000000');
  });

  it('returns undefined for invalid colors', () => {
    expect(normalizeTintColor('not-a-color')).toBeUndefined();
  });
});
