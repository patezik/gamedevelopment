// Minimal PNG codec for the art pipeline (art-direction.md §7). Node built-ins only.
// Encodes 8-bit indexed (colour type 3) and RGBA images; decodes non-interlaced 8-bit greyscale,
// RGB, indexed, grey+alpha and RGBA files, which covers what painting tools export.

import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function header(width, height, colorType) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  return chunk('IHDR', ihdr); // compression, filter and interlace stay 0
}

function scanlines(width, height, bytesPerPixel, pixels) {
  const stride = width * bytesPerPixel;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none (palette images compress best unfiltered)
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return deflateSync(raw, { level: 9 });
}

/** Indexed PNG: `palette` is [[r, g, b], …] in 0–255, `indices` one byte per pixel. */
export function encodeIndexed(width, height, palette, indices) {
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach(([r, g, b], i) => plte.set([r, g, b], i * 3));
  return Buffer.concat([
    SIGNATURE,
    header(width, height, 3),
    chunk('PLTE', plte),
    chunk('IDAT', scanlines(width, height, 1, indices)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** RGBA PNG from 4 bytes per pixel. */
export function encodeRgba(width, height, rgba) {
  return Buffer.concat([
    SIGNATURE,
    header(width, height, 6),
    chunk('IDAT', scanlines(width, height, 4, rgba)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decodes a PNG into RGBA bytes. Returns the header fields too, so the checker can enforce
 * bit depth, interlacing and colour type. Throws on files the pipeline does not accept.
 */
export function decode(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let offset = 8;
  let ihdr = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!ihdr) throw new Error('missing IHDR');
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  const channels = CHANNELS[colorType];
  if (bitDepth !== 8 || interlace !== 0 || channels === undefined) {
    throw new Error(
      `unsupported PNG: bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace} (need 8-bit, non-interlaced)`,
    );
  }
  if (colorType === 3 && !palette) throw new Error('indexed PNG without PLTE');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`bad filter ${filter} in row ${y}`);
      pixels[y * stride + x] = value & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    let r, g, b, a;
    if (colorType === 3) {
      const index = pixels[p];
      if (index * 3 + 2 >= palette.length) throw new Error(`palette index ${index} out of range`);
      [r, g, b] = [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]];
      a = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = pixels[p];
      a = colorType === 4 ? pixels[p + 1] : 255;
    } else {
      [r, g, b] = [pixels[p], pixels[p + 1], pixels[p + 2]];
      a = colorType === 6 ? pixels[p + 3] : 255;
    }
    rgba.set([r, g, b, a], i * 4);
  }
  return { width, height, colorType, rgba };
}
