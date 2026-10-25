// Draws the app icon (the pixel agent from the website) into build/icon.png.
// electron-builder turns that one 1024px PNG into the .ico, .icns and Linux icons.
// Run with: node apps/desktop/scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const GRID = 16;
const CELL = 64;
const SIZE = GRID * CELL;

const COLORS = {
  '.': null,
  B: '#262b44', // tile
  E: '#181425', // tile edge, eyes, shoes
  F: '#3a4466', // floor line, trousers
  H: '#3e2731', // hair
  S: '#e8b796', // skin
  O: '#feae34', // shirt
};

// Rounded tile with the agent standing on a floor line; one character per cell.
const ROWS = [
  '..EEEEEEEEEEEE..',
  '.EBBBBBBBBBBBBE.',
  'EBBBBBHHHHBBBBBE',
  'EBBBBHHHHHHBBBBE',
  'EBBBBSSSSSSBBBBE',
  'EBBBBSESSESBBBBE',
  'EBBBBSSSSSSBBBBE',
  'EBBBBOOOOOOBBBBE',
  'EBBBOOOOOOOOBBBE',
  'EBBBOOOOOOOOBBBE',
  'EBBBSOOOOOOSBBBE',
  'EBBBBFFFFFFBBBBE',
  'EBBBBFFBBFFBBBBE',
  'EFFFEEEFFEEEFFFE',
  '.EBBBBBBBBBBBBE.',
  '..EEEEEEEEEEEE..',
];

function rgba(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
}

function pixels() {
  // Each PNG row starts with a filter byte (0 = none).
  const stride = SIZE * 4 + 1;
  const data = Buffer.alloc(stride * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = ROWS[Math.floor(y / CELL)];
    for (let x = 0; x < SIZE; x++) {
      const color = COLORS[row[Math.floor(x / CELL)]];
      if (color) data.set(rgba(color), y * stride + 1 + x * 4);
    }
  }
  return data;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels(), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (ROWS.length !== GRID || ROWS.some((row) => row.length !== GRID)) throw new Error('The icon grid must be 16 × 16.');
const out = fileURLToPath(new URL('../build/icon.png', import.meta.url));
mkdirSync(fileURLToPath(new URL('../build/', import.meta.url)), { recursive: true });
writeFileSync(out, png());
console.log(`Wrote ${out}`);
