'use strict';
// Image pipeline for gif_creator, with no dependencies: PNG decode, box-filter
// downscale, overlay drawing (built-in 5x7 font), median-cut quantization and a
// GIF89a encoder. Screenshots arrive as PNG and leave as one animated GIF.
//
// Frames are plain objects: { width, height, data } with data a Uint8Array of
// RGBA bytes, row-major, 4 bytes per pixel.

const zlib = require('zlib');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

// --- PNG ------------------------------------------------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilterRow(type, line, prev, bpp) {
  const n = line.length;
  switch (type) {
    case 0:
      break;
    case 1:
      for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      break;
    case 2:
      for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      break;
    case 4:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        const up = prev[i];
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
      }
      break;
    default:
      throw new Error(`PNG: unknown row filter ${type}`);
  }
}

// One sample out of an unfiltered scanline. Sub-byte depths pack MSB first.
function readSample(line, index, bitDepth) {
  if (bitDepth === 16) return (line[index * 2] << 8) | line[index * 2 + 1];
  if (bitDepth === 8) return line[index];
  const perByte = 8 / bitDepth;
  const byte = line[Math.floor(index / perByte)];
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buf.length < 8) throw new Error('PNG: buffer is too small to be an image');
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) throw new Error('PNG: bad signature (not a PNG file)');
  }

  let header = null;
  let plte = null;
  let trns = null;
  const idat = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + length;
    if (end + 4 > buf.length) throw new Error(`PNG: truncated ${type} chunk`);
    if (type === 'IHDR') header = readHeader(buf, start, length);
    else if (type === 'PLTE') plte = buf.subarray(start, end);
    else if (type === 'tRNS') trns = buf.subarray(start, end);
    else if (type === 'IDAT') idat.push(buf.subarray(start, end));
    pos = end + 4;
    if (type === 'IEND') break;
  }

  if (!header) throw new Error('PNG: missing IHDR chunk');
  if (!idat.length) throw new Error('PNG: no IDAT image data');
  const { width, height, bitDepth, colorType } = header;
  if (colorType === 3 && !plte) throw new Error('PNG: palette image has no PLTE chunk');

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (err) {
    throw new Error(`PNG: could not inflate image data (${err.message})`);
  }

  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const expected = (rowBytes + 1) * height;
  if (raw.length < expected) {
    throw new Error(`PNG: image data is short (${raw.length} of ${expected} bytes)`);
  }

  const pixels = Buffer.alloc(rowBytes * height);
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const src = y * (rowBytes + 1);
    const line = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    raw.copy(line, 0, src + 1, src + 1 + rowBytes);
    unfilterRow(raw[src], line, prev, bpp);
    prev = line;
  }

  const maxSample = bitDepth === 16 ? 65535 : (1 << bitDepth) - 1;
  const to8 = bitDepth === 16
    ? (v) => v >> 8                                    // 16-bit downshifts to 8
    : bitDepth === 8 ? (v) => v : (v) => Math.round((v * 255) / maxSample);
  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : null;
  const trnsRgb = colorType === 2 && trns && trns.length >= 6
    ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
    : null;

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const line = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const index = readSample(line, x, bitDepth);
        if ((index + 1) * 3 > plte.length) {
          throw new Error(`PNG: palette index ${index} is outside the PLTE chunk`);
        }
        data[o] = plte[index * 3];
        data[o + 1] = plte[index * 3 + 1];
        data[o + 2] = plte[index * 3 + 2];
        data[o + 3] = trns && index < trns.length ? trns[index] : 255;
      } else if (colorType === 0) {
        const sample = readSample(line, x, bitDepth);
        const gray = to8(sample);
        data[o] = gray; data[o + 1] = gray; data[o + 2] = gray;
        data[o + 3] = trnsGray !== null && sample === trnsGray ? 0 : 255;
      } else if (colorType === 4) {
        data[o] = to8(readSample(line, x * 2, bitDepth));
        data[o + 1] = data[o]; data[o + 2] = data[o];
        data[o + 3] = to8(readSample(line, x * 2 + 1, bitDepth));
      } else {
        const n = colorType === 2 ? 3 : 4;
        const r = readSample(line, x * n, bitDepth);
        const g = readSample(line, x * n + 1, bitDepth);
        const b = readSample(line, x * n + 2, bitDepth);
        data[o] = to8(r); data[o + 1] = to8(g); data[o + 2] = to8(b);
        if (colorType === 2) {
          const clear = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2];
          data[o + 3] = clear ? 0 : 255;
        } else {
          data[o + 3] = to8(readSample(line, x * n + 3, bitDepth));
        }
      }
    }
  }
  return { width, height, data };
}

function readHeader(buf, start, length) {
  if (length < 13) throw new Error('PNG: IHDR chunk is too short');
  const width = buf.readUInt32BE(start);
  const height = buf.readUInt32BE(start + 4);
  const bitDepth = buf[start + 8];
  const colorType = buf[start + 9];
  const compression = buf[start + 10];
  const filter = buf[start + 11];
  const interlace = buf[start + 12];
  if (!width || !height) throw new Error('PNG: image has zero width or height');
  if (interlace !== 0) throw new Error('PNG: interlaced (Adam7) images are not supported');
  if (compression !== 0) throw new Error(`PNG: unsupported compression method ${compression}`);
  if (filter !== 0) throw new Error(`PNG: unsupported filter method ${filter}`);
  if (!DEPTHS[colorType]) throw new Error(`PNG: unsupported color type ${colorType}`);
  if (!DEPTHS[colorType].includes(bitDepth)) {
    throw new Error(`PNG: unsupported bit depth ${bitDepth} for color type ${colorType}`);
  }
  return { width, height, bitDepth, colorType, interlace };
}

// --- resize ---------------------------------------------------------------

// Box filter, alpha weighted so translucent pixels do not bleed colour.
function resizeRgba(frame, targetWidth) {
  const { width, height, data } = frame || {};
  if (!width || !height || !data) throw new Error('resize: frame has no pixels');
  if (data.length < width * height * 4) {
    throw new Error(`resize: frame holds ${data.length} bytes, expected ${width * height * 4}`);
  }
  const target = Math.floor(targetWidth);
  if (!(target > 0)) throw new Error('resize: targetWidth must be a positive number');
  if (target >= width) return { width, height, data: Uint8Array.from(data) };

  const outW = target;
  const outH = Math.max(1, Math.round((height * target) / width));
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * height) / outH);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor(((y + 1) * height) / outH)));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * width) / outW);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor(((x + 1) * width) / outW)));
      let sr = 0; let sg = 0; let sb = 0; let sa = 0; let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * width + sx) * 4;
          const a = data[o + 3];
          sr += data[o] * a;
          sg += data[o + 1] * a;
          sb += data[o + 2] * a;
          sa += a;
          n++;
        }
      }
      const o = (y * outW + x) * 4;
      if (sa > 0) {
        out[o] = Math.round(sr / sa);
        out[o + 1] = Math.round(sg / sa);
        out[o + 2] = Math.round(sb / sa);
      }
      out[o + 3] = Math.round(sa / n);
    }
  }
  return { width: outW, height: outH, data: out };
}

// --- 5x7 font -------------------------------------------------------------

// Rows top to bottom, one string of 7 groups of 5 bits per printable ASCII
// character starting at 0x20. Anything outside the table renders as a box.
const GLYPH_W = 5;
const GLYPH_H = 7;
const ADVANCE = GLYPH_W + 1;
const LINE_H = GLYPH_H + 1;
const MISSING = '11111' + '10001' + '10001' + '10001' + '10001' + '10001' + '11111';
const FONT = [
  /*   */ '00000' + '00000' + '00000' + '00000' + '00000' + '00000' + '00000',
  /* ! */ '00100' + '00100' + '00100' + '00100' + '00100' + '00000' + '00100',
  /* " */ '01010' + '01010' + '01010' + '00000' + '00000' + '00000' + '00000',
  /* # */ '01010' + '01010' + '11111' + '01010' + '11111' + '01010' + '01010',
  /* $ */ '00100' + '01111' + '10100' + '01110' + '00101' + '11110' + '00100',
  /* % */ '11000' + '11001' + '00010' + '00100' + '01000' + '10011' + '00011',
  /* & */ '01100' + '10010' + '10100' + '01000' + '10101' + '10010' + '01101',
  /* ' */ '00100' + '00100' + '01000' + '00000' + '00000' + '00000' + '00000',
  /* ( */ '00010' + '00100' + '01000' + '01000' + '01000' + '00100' + '00010',
  /* ) */ '01000' + '00100' + '00010' + '00010' + '00010' + '00100' + '01000',
  /* * */ '00000' + '00100' + '10101' + '01110' + '10101' + '00100' + '00000',
  /* + */ '00000' + '00100' + '00100' + '11111' + '00100' + '00100' + '00000',
  /* , */ '00000' + '00000' + '00000' + '00000' + '00110' + '00100' + '01000',
  /* - */ '00000' + '00000' + '00000' + '11111' + '00000' + '00000' + '00000',
  /* . */ '00000' + '00000' + '00000' + '00000' + '00000' + '01100' + '01100',
  /* / */ '00001' + '00001' + '00010' + '00100' + '01000' + '10000' + '10000',
  /* 0 */ '01110' + '10001' + '10011' + '10101' + '11001' + '10001' + '01110',
  /* 1 */ '00100' + '01100' + '00100' + '00100' + '00100' + '00100' + '01110',
  /* 2 */ '01110' + '10001' + '00001' + '00010' + '00100' + '01000' + '11111',
  /* 3 */ '11111' + '00010' + '00100' + '00010' + '00001' + '10001' + '01110',
  /* 4 */ '00010' + '00110' + '01010' + '10010' + '11111' + '00010' + '00010',
  /* 5 */ '11111' + '10000' + '11110' + '00001' + '00001' + '10001' + '01110',
  /* 6 */ '00110' + '01000' + '10000' + '11110' + '10001' + '10001' + '01110',
  /* 7 */ '11111' + '00001' + '00010' + '00100' + '01000' + '01000' + '01000',
  /* 8 */ '01110' + '10001' + '10001' + '01110' + '10001' + '10001' + '01110',
  /* 9 */ '01110' + '10001' + '10001' + '01111' + '00001' + '00010' + '01100',
  /* : */ '00000' + '01100' + '01100' + '00000' + '01100' + '01100' + '00000',
  /* ; */ '00000' + '01100' + '01100' + '00000' + '01100' + '00100' + '01000',
  /* < */ '00010' + '00100' + '01000' + '10000' + '01000' + '00100' + '00010',
  /* = */ '00000' + '00000' + '11111' + '00000' + '11111' + '00000' + '00000',
  /* > */ '01000' + '00100' + '00010' + '00001' + '00010' + '00100' + '01000',
  /* ? */ '01110' + '10001' + '00001' + '00010' + '00100' + '00000' + '00100',
  /* @ */ '01110' + '10001' + '00001' + '01101' + '10101' + '10101' + '01110',
  /* A */ '01110' + '10001' + '10001' + '11111' + '10001' + '10001' + '10001',
  /* B */ '11110' + '10001' + '10001' + '11110' + '10001' + '10001' + '11110',
  /* C */ '01110' + '10001' + '10000' + '10000' + '10000' + '10001' + '01110',
  /* D */ '11100' + '10010' + '10001' + '10001' + '10001' + '10010' + '11100',
  /* E */ '11111' + '10000' + '10000' + '11110' + '10000' + '10000' + '11111',
  /* F */ '11111' + '10000' + '10000' + '11110' + '10000' + '10000' + '10000',
  /* G */ '01110' + '10001' + '10000' + '10111' + '10001' + '10001' + '01111',
  /* H */ '10001' + '10001' + '10001' + '11111' + '10001' + '10001' + '10001',
  /* I */ '01110' + '00100' + '00100' + '00100' + '00100' + '00100' + '01110',
  /* J */ '00111' + '00010' + '00010' + '00010' + '00010' + '10010' + '01100',
  /* K */ '10001' + '10010' + '10100' + '11000' + '10100' + '10010' + '10001',
  /* L */ '10000' + '10000' + '10000' + '10000' + '10000' + '10000' + '11111',
  /* M */ '10001' + '11011' + '10101' + '10101' + '10001' + '10001' + '10001',
  /* N */ '10001' + '10001' + '11001' + '10101' + '10011' + '10001' + '10001',
  /* O */ '01110' + '10001' + '10001' + '10001' + '10001' + '10001' + '01110',
  /* P */ '11110' + '10001' + '10001' + '11110' + '10000' + '10000' + '10000',
  /* Q */ '01110' + '10001' + '10001' + '10001' + '10101' + '10010' + '01101',
  /* R */ '11110' + '10001' + '10001' + '11110' + '10100' + '10010' + '10001',
  /* S */ '01111' + '10000' + '10000' + '01110' + '00001' + '00001' + '11110',
  /* T */ '11111' + '00100' + '00100' + '00100' + '00100' + '00100' + '00100',
  /* U */ '10001' + '10001' + '10001' + '10001' + '10001' + '10001' + '01110',
  /* V */ '10001' + '10001' + '10001' + '10001' + '10001' + '01010' + '00100',
  /* W */ '10001' + '10001' + '10001' + '10101' + '10101' + '11011' + '10001',
  /* X */ '10001' + '10001' + '01010' + '00100' + '01010' + '10001' + '10001',
  /* Y */ '10001' + '10001' + '01010' + '00100' + '00100' + '00100' + '00100',
  /* Z */ '11111' + '00001' + '00010' + '00100' + '01000' + '10000' + '11111',
  /* [ */ '01110' + '01000' + '01000' + '01000' + '01000' + '01000' + '01110',
  /* \ */ '10000' + '10000' + '01000' + '00100' + '00010' + '00001' + '00001',
  /* ] */ '01110' + '00010' + '00010' + '00010' + '00010' + '00010' + '01110',
  /* ^ */ '00100' + '01010' + '10001' + '00000' + '00000' + '00000' + '00000',
  /* _ */ '00000' + '00000' + '00000' + '00000' + '00000' + '00000' + '11111',
  /* ` */ '01000' + '00100' + '00010' + '00000' + '00000' + '00000' + '00000',
  /* a */ '00000' + '00000' + '01110' + '00001' + '01111' + '10001' + '01111',
  /* b */ '10000' + '10000' + '11110' + '10001' + '10001' + '10001' + '11110',
  /* c */ '00000' + '00000' + '01111' + '10000' + '10000' + '10000' + '01111',
  /* d */ '00001' + '00001' + '01111' + '10001' + '10001' + '10001' + '01111',
  /* e */ '00000' + '00000' + '01110' + '10001' + '11111' + '10000' + '01110',
  /* f */ '00110' + '01001' + '01000' + '11100' + '01000' + '01000' + '01000',
  /* g */ '00000' + '01111' + '10001' + '10001' + '01111' + '00001' + '01110',
  /* h */ '10000' + '10000' + '11110' + '10001' + '10001' + '10001' + '10001',
  /* i */ '00100' + '00000' + '01100' + '00100' + '00100' + '00100' + '01110',
  /* j */ '00010' + '00000' + '00110' + '00010' + '00010' + '10010' + '01100',
  /* k */ '10000' + '10000' + '10010' + '10100' + '11000' + '10100' + '10010',
  /* l */ '01100' + '00100' + '00100' + '00100' + '00100' + '00100' + '01110',
  /* m */ '00000' + '00000' + '11010' + '10101' + '10101' + '10101' + '10101',
  /* n */ '00000' + '00000' + '11110' + '10001' + '10001' + '10001' + '10001',
  /* o */ '00000' + '00000' + '01110' + '10001' + '10001' + '10001' + '01110',
  /* p */ '00000' + '11110' + '10001' + '10001' + '11110' + '10000' + '10000',
  /* q */ '00000' + '01111' + '10001' + '10001' + '01111' + '00001' + '00001',
  /* r */ '00000' + '00000' + '10110' + '11001' + '10000' + '10000' + '10000',
  /* s */ '00000' + '00000' + '01111' + '10000' + '01110' + '00001' + '11110',
  /* t */ '00100' + '00100' + '11111' + '00100' + '00100' + '00101' + '00010',
  /* u */ '00000' + '00000' + '10001' + '10001' + '10001' + '10011' + '01101',
  /* v */ '00000' + '00000' + '10001' + '10001' + '10001' + '01010' + '00100',
  /* w */ '00000' + '00000' + '10001' + '10001' + '10101' + '10101' + '01010',
  /* x */ '00000' + '00000' + '10001' + '01010' + '00100' + '01010' + '10001',
  /* y */ '00000' + '10001' + '10001' + '10001' + '01111' + '00001' + '01110',
  /* z */ '00000' + '00000' + '11111' + '00010' + '00100' + '01000' + '11111',
  /* { */ '00110' + '01000' + '01000' + '11000' + '01000' + '01000' + '00110',
  /* | */ '00100' + '00100' + '00100' + '00100' + '00100' + '00100' + '00100',
  /* } */ '01100' + '00010' + '00010' + '00011' + '00010' + '00010' + '01100',
  /* ~ */ '00000' + '00000' + '01000' + '10101' + '00010' + '00000' + '00000',
];

function glyph(ch) {
  const code = ch.charCodeAt(0);
  const bits = code >= 0x20 && code <= 0x7e ? FONT[code - 0x20] : undefined;
  return bits || MISSING;
}

function textSize(text, scale = 1) {
  const s = Math.max(1, Math.floor(num(scale, 1)));
  const lines = String(text).split('\n');
  const cols = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    width: cols ? cols * ADVANCE * s - s : 0,
    height: lines.length * LINE_H * s - s,
  };
}

// --- overlays -------------------------------------------------------------

// Op geometry is caller-supplied: NaN and Infinity must not reach a loop bound.
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : fallback;
}

function toColor(value, fallback = [255, 255, 255, 255]) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    const hex = value.replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) throw new Error(`overlay: bad color ${value}`);
    const n = parseInt(hex.slice(0, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6), 16) : 255;
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, a];
  }
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error('overlay: color must be [r, g, b] or [r, g, b, a]');
  }
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  return [clamp(value[0]), clamp(value[1]), clamp(value[2]), value.length > 3 ? clamp(value[3]) : 255];
}

// Source-over compositing; frames from screenshots are opaque, but overlays
// may be drawn onto anything.
function blendPixel(frame, x, y, color) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= frame.width || yi >= frame.height) return;
  const [r, g, b, a] = color;
  if (a <= 0) return;
  const d = frame.data;
  const o = (yi * frame.width + xi) * 4;
  if (a >= 255) {
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    return;
  }
  const sa = a / 255;
  const da = (d[o + 3] / 255) * (1 - sa);
  const oa = sa + da;
  if (oa <= 0) {
    d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
    return;
  }
  const dr = d[o]; const dg = d[o + 1]; const db = d[o + 2];
  d[o] = Math.round((r * sa + dr * da) / oa);
  d[o + 1] = Math.round((g * sa + dg * da) / oa);
  d[o + 2] = Math.round((b * sa + db * da) / oa);
  d[o + 3] = Math.round(oa * 255);
}

// Paints each pixel at most once so overlapping strokes do not double-blend.
function painter(frame, color) {
  const seen = new Set();
  return (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= frame.width || yi >= frame.height) return;
    const key = yi * frame.width + xi;
    if (seen.has(key)) return;
    seen.add(key);
    blendPixel(frame, xi, yi, color);
  };
}

function stampDisc(put, x, y, half) {
  if (half <= 0) { put(x, y); return; }
  const span = Math.ceil(half);
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let oy = -span; oy <= span; oy++) {
    for (let ox = -span; ox <= span; ox++) {
      if (ox * ox + oy * oy <= half * half + 0.25) put(cx + ox, cy + oy);
    }
  }
}

// The slice of t in [0, 1] where the segment can still touch the frame. A stamp
// centred further than ceil(half) + 1 outside paints nothing, so trimming the
// range leaves the picture identical while keeping a wild coordinate (a drag to
// x = 1e9) from costing a step per pixel of its length.
function visibleRange(x1, y1, dx, dy, frame, half) {
  const pad = Math.ceil(half) + 1;
  let lo = 0;
  let hi = 1;
  const axis = (p, d, max) => {
    if (d === 0) return p >= -pad && p <= max + pad;
    let t0 = (-pad - p) / d;
    let t1 = (max + pad - p) / d;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    if (t0 > lo) lo = t0;
    if (t1 < hi) hi = t1;
    return lo <= hi;
  };
  if (!axis(x1, dx, frame.width - 1)) return null;
  if (!axis(y1, dy, frame.height - 1)) return null;
  return [lo, hi];
}

function strokeLine(put, x1, y1, x2, y2, width, frame) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  const half = Math.max(0, (width - 1) / 2);
  let first = 0;
  let last = steps;
  if (frame) {
    const range = visibleRange(x1, y1, dx, dy, frame, half);
    if (!range) return;
    first = Math.max(0, Math.floor(range[0] * steps));
    last = Math.min(steps, Math.ceil(range[1] * steps));
  }
  for (let i = first; i <= last; i++) {
    const t = i / steps;
    stampDisc(put, x1 + dx * t, y1 + dy * t, half);
  }
}

function drawCircle(frame, op) {
  const cx = num(op.x);
  const cy = num(op.y);
  const r = Math.max(0, num(op.r));
  const color = toColor(op.color);
  const fill = op.fill !== false;
  const inner = fill ? -1 : r - Math.max(1, num(op.lineWidth, 2));
  const outer = r * r;
  const hole = inner > 0 ? inner * inner : -1;
  // Clamped to the frame: blendPixel drops the rest anyway, and an r of 1e6 on a
  // 20x20 frame would otherwise spin through 1e12 pixels to paint 400.
  const yEnd = Math.min(frame.height - 1, Math.ceil(cy + r));
  const xEnd = Math.min(frame.width - 1, Math.ceil(cx + r));
  for (let y = Math.max(0, Math.floor(cy - r)); y <= yEnd; y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= xEnd; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > outer || d2 < hole) continue;
      blendPixel(frame, x, y, color);
    }
  }
}

function drawArrow(frame, op) {
  const x1 = num(op.x1);
  const y1 = num(op.y1);
  const x2 = num(op.x2);
  const y2 = num(op.y2);
  const width = Math.max(1, num(op.width, 2));
  const put = painter(frame, toColor(op.color));
  strokeLine(put, x1, y1, x2, y2, width, frame);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(4, num(op.head, width * 3));
  for (const spread of [-0.45, 0.45]) {
    strokeLine(
      put, x2, y2,
      x2 - head * Math.cos(angle + spread),
      y2 - head * Math.sin(angle + spread),
      width, frame,
    );
  }
}

function drawRect(frame, op) {
  const x0 = Math.round(num(op.x));
  const y0 = Math.round(num(op.y));
  const w = Math.round(num(op.width));
  const h = Math.round(num(op.height));
  if (w <= 0 || h <= 0) return;
  const color = toColor(op.color);
  const fill = op.fill !== false;
  const lw = Math.max(1, Math.round(num(op.lineWidth, 1)));
  // Only the on-frame rows and columns are walked; the edge test still measures
  // against the full rectangle, so an outline that starts off-frame is unchanged.
  const yEnd = Math.min(frame.height, y0 + h);
  const xEnd = Math.min(frame.width, x0 + w);
  for (let y = Math.max(0, y0); y < yEnd; y++) {
    for (let x = Math.max(0, x0); x < xEnd; x++) {
      if (!fill) {
        const edge = x - x0 < lw || x0 + w - 1 - x < lw || y - y0 < lw || y0 + h - 1 - y < lw;
        if (!edge) continue;
      }
      blendPixel(frame, x, y, color);
    }
  }
}

function drawText(frame, op) {
  const scale = Math.max(1, Math.floor(num(op.scale, 1)));
  const text = String(op.text === undefined ? '' : op.text);
  const color = toColor(op.color);
  const x0 = Math.round(num(op.x));
  const y0 = Math.round(num(op.y));
  if (op.background !== undefined && op.background !== null) {
    const pad = op.padding === undefined ? 2 * scale : Math.round(num(op.padding));
    const size = textSize(text, scale);
    drawRect(frame, {
      x: x0 - pad, y: y0 - pad,
      width: size.width + pad * 2, height: size.height + pad * 2,
      color: op.background, fill: true,
    });
  }
  let line = 0;
  let col = 0;
  for (const ch of text) {
    if (ch === '\n') { line++; col = 0; continue; }
    const bits = glyph(ch);
    const gx = x0 + col * ADVANCE * scale;
    const gy = y0 + line * LINE_H * scale;
    for (let row = 0; row < GLYPH_H; row++) {
      for (let cell = 0; cell < GLYPH_W; cell++) {
        if (bits[row * GLYPH_W + cell] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            blendPixel(frame, gx + cell * scale + sx, gy + row * scale + sy, color);
          }
        }
      }
    }
    col++;
  }
}

function drawProgress(frame, op) {
  const ratio = Math.max(0, Math.min(1, num(op.ratio)));
  const h = Math.max(1, Math.round(num(op.height, 4)));
  const y = op.y === undefined ? frame.height - h : Math.round(num(op.y));
  if (op.background !== undefined && op.background !== null) {
    drawRect(frame, { x: 0, y, width: frame.width, height: h, color: op.background, fill: true });
  }
  const w = Math.round(frame.width * ratio);
  if (w <= 0) return;
  drawRect(frame, { x: 0, y, width: w, height: h, color: op.color, fill: true });
}

function drawOverlays(frame, ops) {
  if (!frame || !frame.width || !frame.height || !frame.data) {
    throw new Error('overlay: frame has no pixels');
  }
  for (const op of ops || []) {
    if (!op || typeof op !== 'object') continue;
    switch (op.type) {
      case 'circle': drawCircle(frame, op); break;
      case 'arrow': drawArrow(frame, op); break;
      case 'rect': drawRect(frame, op); break;
      case 'text': drawText(frame, op); break;
      case 'progress': drawProgress(frame, op); break;
      default: throw new Error(`overlay: unknown op type ${JSON.stringify(op.type)}`);
    }
  }
  return frame;
}

// --- quantization ---------------------------------------------------------

const CELLS = 1 << 15; // 5 bits per channel: bounded memory, exact averages

function nearestIndex(palette, colors, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < colors; i++) {
    const dr = r - palette[i * 3];
    const dg = g - palette[i * 3 + 1];
    const db = b - palette[i * 3 + 2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
      if (d === 0) break;
    }
  }
  return best;
}

function boxOf(cells, start, end) {
  let count = 0;
  let rMin = 255; let rMax = 0; let gMin = 255; let gMax = 0; let bMin = 255; let bMax = 0;
  for (let i = start; i < end; i++) {
    const c = cells[i];
    count += c.count;
    if (c.r < rMin) rMin = c.r;
    if (c.r > rMax) rMax = c.r;
    if (c.g < gMin) gMin = c.g;
    if (c.g > gMax) gMax = c.g;
    if (c.b < bMin) bMin = c.b;
    if (c.b > bMax) bMax = c.b;
  }
  return { start, end, count, rMin, rMax, gMin, gMax, bMin, bMax };
}

function splitBox(cells, box) {
  const rangeR = box.rMax - box.rMin;
  const rangeG = box.gMax - box.gMin;
  const rangeB = box.bMax - box.bMin;
  const key = rangeR >= rangeG && rangeR >= rangeB ? 'r' : (rangeG >= rangeB ? 'g' : 'b');
  const slice = cells.slice(box.start, box.end);
  slice.sort((a, b) => (a[key] - b[key]) || (a.cell - b.cell)); // cell index keeps it deterministic
  for (let i = 0; i < slice.length; i++) cells[box.start + i] = slice[i];
  const half = box.count / 2;
  let seen = 0;
  let cut = box.start + 1;
  for (let i = box.start; i < box.end - 1; i++) {
    seen += cells[i].count;
    cut = i + 1;
    if (seen >= half) break;
  }
  return [boxOf(cells, box.start, cut), boxOf(cells, cut, box.end)];
}

// Median cut over the combined histogram of every frame, then nearest-colour
// mapping (optionally with Floyd-Steinberg diffusion). Alpha is ignored: GIF
// frames here are opaque screenshots.
function quantize(frames, maxColors = 256, opts = {}) {
  const list = Array.isArray(frames) ? frames : [frames];
  const limit = Math.max(2, Math.min(256, Math.floor(maxColors) || 256));
  const counts = new Uint32Array(CELLS);
  const sumR = new Float64Array(CELLS);
  const sumG = new Float64Array(CELLS);
  const sumB = new Float64Array(CELLS);

  for (const frame of list) {
    if (!frame || !frame.data) throw new Error('quantize: frame has no pixels');
    const { width, height, data } = frame;
    // width x height is what gets indexed below, so a short buffer has to fail
    // here rather than silently histogram fewer pixels than it maps.
    if (!(width > 0) || !(height > 0)) throw new Error('quantize: frame has no pixels');
    if (data.length < width * height * 4) {
      throw new Error(`quantize: frame holds ${data.length} bytes, expected ${width * height * 4}`);
    }
    const bytes = width * height * 4;
    for (let o = 0; o < bytes; o += 4) {
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const cell = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      counts[cell]++;
      sumR[cell] += r;
      sumG[cell] += g;
      sumB[cell] += b;
    }
  }

  const cells = [];
  for (let cell = 0; cell < CELLS; cell++) {
    if (!counts[cell]) continue;
    cells.push({
      cell,
      count: counts[cell],
      r: sumR[cell] / counts[cell],
      g: sumG[cell] / counts[cell],
      b: sumB[cell] / counts[cell],
    });
  }
  if (!cells.length) {
    return { palette: new Uint8Array([0, 0, 0]), indexed: list.map((f) => new Uint8Array(f.width * f.height)) };
  }

  let boxes = [boxOf(cells, 0, cells.length)];
  while (boxes.length < limit) {
    let pick = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.end - box.start < 2) continue;
      if (box.rMax === box.rMin && box.gMax === box.gMin && box.bMax === box.bMin) continue;
      if (pick < 0 || box.count > boxes[pick].count) pick = i;
    }
    if (pick < 0) break;
    const parts = splitBox(cells, boxes[pick]);
    boxes = boxes.slice(0, pick).concat(parts, boxes.slice(pick + 1));
  }

  const colors = boxes.length;
  const palette = new Uint8Array(colors * 3);
  boxes.forEach((box, i) => {
    let n = 0; let r = 0; let g = 0; let b = 0;
    for (let c = box.start; c < box.end; c++) {
      const cell = cells[c];
      n += cell.count;
      r += cell.r * cell.count;
      g += cell.g * cell.count;
      b += cell.b * cell.count;
    }
    palette[i * 3] = Math.round(r / n);
    palette[i * 3 + 1] = Math.round(g / n);
    palette[i * 3 + 2] = Math.round(b / n);
  });

  // Histogram cells are the quantizer's atoms, so map through them: one
  // nearest-colour search per occupied cell instead of one per pixel.
  const lut = new Int16Array(CELLS).fill(-1);
  const lookup = (r, g, b) => {
    const cell = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let index = lut[cell];
    if (index < 0) {
      const n = counts[cell];
      index = n
        ? nearestIndex(palette, colors, Math.round(sumR[cell] / n), Math.round(sumG[cell] / n), Math.round(sumB[cell] / n))
        : nearestIndex(palette, colors, ((cell >> 10) & 31) * 8 + 4, ((cell >> 5) & 31) * 8 + 4, (cell & 31) * 8 + 4);
      lut[cell] = index;
    }
    return index;
  };

  const dither = opts.dither === true;
  const indexed = list.map((frame) => {
    const { width, height, data } = frame;
    const out = new Uint8Array(width * height);
    if (!dither) {
      for (let i = 0; i < out.length; i++) {
        const o = i * 4;
        out[i] = lookup(data[o], data[o + 1], data[o + 2]);
      }
      return out;
    }
    let curErr = new Float32Array((width + 2) * 3);
    let nextErr = new Float32Array((width + 2) * 3);
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const e = (x + 1) * 3;
        const r = clamp(data[o] + curErr[e]);
        const g = clamp(data[o + 1] + curErr[e + 1]);
        const b = clamp(data[o + 2] + curErr[e + 2]);
        const index = lookup(r, g, b);
        out[y * width + x] = index;
        const er = r - palette[index * 3];
        const eg = g - palette[index * 3 + 1];
        const eb = b - palette[index * 3 + 2];
        curErr[e + 3] += (er * 7) / 16; curErr[e + 4] += (eg * 7) / 16; curErr[e + 5] += (eb * 7) / 16;
        nextErr[e - 3] += (er * 3) / 16; nextErr[e - 2] += (eg * 3) / 16; nextErr[e - 1] += (eb * 3) / 16;
        nextErr[e] += (er * 5) / 16; nextErr[e + 1] += (eg * 5) / 16; nextErr[e + 2] += (eb * 5) / 16;
        nextErr[e + 3] += er / 16; nextErr[e + 4] += eg / 16; nextErr[e + 5] += eb / 16;
      }
      const swap = curErr;
      curErr = nextErr;
      nextErr = swap;
      nextErr.fill(0);
    }
    return out;
  });

  return { palette, indexed };
}

// --- GIF ------------------------------------------------------------------

function subBlocks(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const slice = bytes.subarray(i, Math.min(i + 255, bytes.length));
    parts.push(Buffer.from([slice.length]), Buffer.from(slice));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

// GIF variable-width LZW, LSB first. The decoder's table is exactly one entry
// behind the encoder's, so the width grows on the pre-assignment code count.
function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const dict = new Map();
  const bytes = [];
  let acc = 0;
  let accBits = 0;
  const emit = (code) => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      bytes.push(acc & 0xff);
      acc >>= 8;
      accBits -= 8;
    }
  };
  const grow = () => {
    if (next >= (1 << codeSize) && codeSize < 12) codeSize++;
  };

  emit(clear);
  if (indices.length) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const known = dict.get(key);
      if (known !== undefined) {
        prefix = known;
        continue;
      }
      emit(prefix);
      grow();
      if (next < 4096) {
        dict.set(key, next++);
      } else {
        emit(clear);
        dict.clear();
        next = eoi + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = k;
    }
    emit(prefix);
    grow();
  }
  emit(eoi);
  if (accBits > 0) bytes.push(acc & 0xff);
  return Buffer.concat([Buffer.from([minCodeSize]), subBlocks(Uint8Array.from(bytes))]);
}

function encodeGif({ frames, palette, width, height, delayMs = 100, delays = null, loop = 0 }) {
  if (!Array.isArray(frames) || !frames.length) throw new Error('GIF: no frames to encode');
  // 0xffff is all the logical screen descriptor and image descriptor can hold.
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width <= 0 || height <= 0 || width > 0xffff || height > 0xffff) {
    throw new Error('GIF: width and height must be positive integers no larger than 65535');
  }
  if (!palette || palette.length % 3 !== 0 || palette.length < 3 || palette.length > 768) {
    throw new Error('GIF: palette must hold 1 to 256 RGB triples');
  }
  const colors = palette.length / 3;
  let bits = 1;
  while (1 << bits < colors) bits++;
  const tableSize = 1 << bits;

  const out = [];
  out.push(Buffer.from('GIF89a', 'latin1'));

  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80 | ((bits - 1) << 4) | (bits - 1); // GCT present, size 2^bits
  lsd[5] = 0; // background colour index
  lsd[6] = 0; // pixel aspect ratio
  out.push(lsd);

  const gct = Buffer.alloc(tableSize * 3); // padding entries stay black
  Buffer.from(Uint8Array.from(palette)).copy(gct);
  out.push(gct);

  const netscape = Buffer.alloc(19);
  netscape[0] = 0x21;
  netscape[1] = 0xff;
  netscape[2] = 0x0b;
  netscape.write('NETSCAPE2.0', 3, 'latin1');
  netscape[14] = 0x03;
  netscape[15] = 0x01;
  netscape.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(Number(loop) || 0))), 16);
  netscape[18] = 0x00;
  out.push(netscape);

  const minCodeSize = Math.max(2, bits);
  const pixels = width * height;
  frames.forEach((frame, i) => {
    if (!frame || frame.length !== pixels) {
      throw new Error(`GIF: frame ${i} has ${frame ? frame.length : 0} pixels, expected ${pixels}`);
    }
    const ms = Array.isArray(delays) && delays[i] !== undefined ? delays[i] : delayMs;
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    gce[3] = 0x04; // disposal method 1 (leave in place), no transparency
    gce.writeUInt16LE(Math.max(2, Math.min(65535, Math.round((Number(ms) || 0) / 10))), 4);
    gce[6] = 0; // transparent colour index
    gce[7] = 0;
    out.push(gce);

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0; // no local colour table, not interlaced
    out.push(descriptor);

    for (let p = 0; p < pixels; p++) {
      if (frame[p] >= colors) {
        throw new Error(`GIF: frame ${i} uses colour ${frame[p]} outside the ${colors}-colour palette`);
      }
    }
    out.push(lzwEncode(frame, minCodeSize));
  });

  out.push(Buffer.from([0x3b]));
  return Buffer.concat(out);
}

module.exports = {
  decodePng, resizeRgba, drawOverlays, quantize, encodeGif,
  blendPixel, textSize, lzwEncode, toColor, FONT, GLYPH_W, GLYPH_H, ADVANCE, LINE_H,
};
