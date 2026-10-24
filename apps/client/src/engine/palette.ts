import { DataTexture, NearestFilter, RGBAFormat, UnsignedByteType } from 'three';

/** Endesga-32 by Endesga — https://lospec.com/palette-list/endesga-32 */
export const ENDESGA_32 = [
  '#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633',
  '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e',
  '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466',
  '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569',
] as const;

/**
 * Packs the palette into an N×1 texture. Values stay raw sRGB bytes (no color-space
 * conversion) because the post shader quantizes in sRGB space.
 */
export function createPaletteTexture(colors: readonly string[]): DataTexture {
  const data = new Uint8Array(colors.length * 4);
  colors.forEach((hex, i) => {
    const value = parseInt(hex.slice(1), 16);
    data.set([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 0xff], i * 4);
  });
  const texture = new DataTexture(data, colors.length, 1, RGBAFormat, UnsignedByteType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}
