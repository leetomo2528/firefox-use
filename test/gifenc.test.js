'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const {
  decodePng, resizeRgba, drawOverlays, quantize, encodeGif, textSize,
} = require('../src/gifenc');

// --- PNG builder (test side, independent of the decoder) ------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Apply the PNG row filters the decoder has to undo.
function filterRows(rows, filters, bpp) {
  const out = [];
  let prev = Buffer.alloc(rows[0].length);
  rows.forEach((row, y) => {
    const type = filters[y % filters.length];
    const enc = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let sub = 0;
      if (type === 1) sub = left;
      else if (type === 2) sub = up;
      else if (type === 3) sub = (left + up) >> 1;
      else if (type === 4) sub = paeth(left, up, upLeft);
      enc[i] = (row[i] - sub) & 0xff;
    }
    out.push(Buffer.from([type]), enc);
    prev = row;
  });
  return Buffer.concat(out);
}

function makePng({
  width, height, colorType, bitDepth = 8, rows, filters = [0], palette, trns,
  splitIdat = false, extras = [],
}) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bpp = Math.max(1, (channels * bitDepth) >> 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', Buffer.from(palette)));
  if (trns) parts.push(chunk('tRNS', Buffer.from(trns)));
  parts.push(...extras);
  const idat = zlib.deflateSync(filterRows(rows, filters, bpp));
  if (splitIdat) {
    const half = idat.length >> 1;
    parts.push(chunk('IDAT', idat.subarray(0, half)), chunk('IDAT', idat.subarray(half)));
  } else {
    parts.push(chunk('IDAT', idat));
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// Pack sub-byte samples MSB first, the way PNG stores them.
function packSamples(samples, bitDepth, width) {
  const perByte = 8 / bitDepth;
  const row = Buffer.alloc(Math.ceil(width / perByte));
  for (let i = 0; i < width; i++) {
    const shift = 8 - bitDepth * ((i % perByte) + 1);
    row[Math.floor(i / perByte)] |= (samples[i] & ((1 << bitDepth) - 1)) << shift;
  }
  return row;
}

// --- GIF parser (test side) ----------------------------------------------

// How many clear codes the last decode saw, so a test can prove the encoder
// really reset a full dictionary rather than just happening to fit.
let lastClears = 0;

function lzwDecode(bytes, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let clears = 0;
  let codeSize = minCodeSize + 1;
  let table = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < clear; i++) table.push([i]);
    table.push(null, null); // clear, eoi
    codeSize = minCodeSize + 1;
  };
  reset();
  const out = [];
  let bitPos = 0;
  let prev = null;
  for (;;) {
    if (bitPos + codeSize > bytes.length * 8) throw new Error('LZW: ran out of bits before EOI');
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const bit = (bytes[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1;
      code |= bit << i;
    }
    bitPos += codeSize;
    if (code === clear) { clears++; reset(); prev = null; continue; }
    if (code === eoi) break;
    let entry;
    if (code < table.length && table[code]) entry = table[code];
    else if (prev && code === table.length) entry = prev.concat(prev[0]);
    else throw new Error(`LZW: bad code ${code} (table holds ${table.length})`);
    out.push(...entry);
    if (prev) {
      table.push(prev.concat(entry[0]));
      if (table.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  lastClears = clears;
  return out;
}

function parseGif(buf) {
  assert.equal(buf.toString('latin1', 0, 6), 'GIF89a', 'header');
  const gif = {
    width: buf.readUInt16LE(6),
    height: buf.readUInt16LE(8),
    packed: buf[10],
    background: buf[11],
    aspect: buf[12],
    loop: null,
    frames: [],
    trailer: false,
  };
  const gctBits = (gif.packed & 0x07) + 1;
  gif.gctSize = 1 << gctBits;
  let pos = 13;
  gif.gct = buf.subarray(pos, pos + gif.gctSize * 3);
  pos += gif.gctSize * 3;
  let pendingDelay = null;
  const readBlocks = () => {
    const parts = [];
    const sizes = [];
    for (;;) {
      const size = buf[pos++];
      sizes.push(size);
      if (!size) break;
      parts.push(buf.subarray(pos, pos + size));
      pos += size;
    }
    return { data: Buffer.concat(parts), sizes };
  };
  while (pos < buf.length) {
    const marker = buf[pos++];
    if (marker === 0x3b) { gif.trailer = true; break; }
    if (marker === 0x21) {
      const label = buf[pos++];
      if (label === 0xff) {
        const size = buf[pos++];
        const name = buf.toString('latin1', pos, pos + 11);
        pos += size;
        const sub = readBlocks();
        if (name === 'NETSCAPE2.0') gif.loop = sub.data.readUInt16LE(1);
      } else if (label === 0xf9) {
        const size = buf[pos++];
        pendingDelay = { packed: buf[pos], delay: buf.readUInt16LE(pos + 1), transparent: buf[pos + 3] };
        pos += size;
        readBlocks();
      } else {
        pos++;
        readBlocks();
      }
      continue;
    }
    if (marker === 0x2c) {
      const frame = {
        left: buf.readUInt16LE(pos),
        top: buf.readUInt16LE(pos + 2),
        width: buf.readUInt16LE(pos + 4),
        height: buf.readUInt16LE(pos + 6),
        packed: buf[pos + 8],
        gce: pendingDelay,
      };
      pendingDelay = null;
      pos += 9;
      const minCodeSize = buf[pos++];
      const sub = readBlocks();
      frame.minCodeSize = minCodeSize;
      frame.blockSizes = sub.sizes;
      frame.indices = lzwDecode(sub.data, minCodeSize);
      frame.clears = lastClears;
      gif.frames.push(frame);
      continue;
    }
    throw new Error(`unexpected block marker 0x${marker.toString(16)} at ${pos - 1}`);
  }
  return gif;
}

// --- helpers --------------------------------------------------------------

function blank(width, height, color = [0, 0, 0, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = color[3];
  }
  return { width, height, data };
}

const px = (frame, x, y) => {
  const o = (y * frame.width + x) * 4;
  return [frame.data[o], frame.data[o + 1], frame.data[o + 2], frame.data[o + 3]];
};

// --- PNG ------------------------------------------------------------------

test('decodePng undoes all five row filters on an RGBA image', () => {
  const width = 5;
  const height = 5;
  const rows = [];
  const expect = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        const v = (x * 37 + y * 91 + c * 13) & 0xff;
        row[x * 4 + c] = v;
        expect[(y * width + x) * 4 + c] = v;
      }
    }
    rows.push(row);
  }
  // one filter type per row, so every branch of the unfilter runs
  const png = makePng({ width, height, colorType: 6, rows, filters: [0, 1, 2, 3, 4] });
  const out = decodePng(png);
  assert.equal(out.width, 5);
  assert.equal(out.height, 5);
  assert.deepEqual(Buffer.from(out.data), Buffer.from(expect));
});

test('decodePng expands RGB and honours the tRNS colour key', () => {
  const rows = [
    Buffer.from([10, 20, 30, 255, 0, 0]),
    Buffer.from([1, 2, 3, 40, 50, 60]),
  ];
  const png = makePng({
    width: 2, height: 2, colorType: 2, rows, filters: [4, 1],
    trns: [0, 255, 0, 0, 0, 0], // 16-bit samples: r=255, g=0, b=0
  });
  const out = decodePng(png);
  assert.deepEqual(px(out, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(px(out, 1, 0), [255, 0, 0, 0], 'the keyed colour becomes transparent');
  assert.deepEqual(px(out, 1, 1), [40, 50, 60, 255]);
});

test('decodePng reads 4-bit palette images with per-entry alpha', () => {
  const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255];
  const rows = [
    packSamples([0, 1, 2, 1, 0], 4, 5),
    packSamples([2, 2, 0, 1, 1], 4, 5),
  ];
  const png = makePng({
    width: 5, height: 2, colorType: 3, bitDepth: 4, rows, filters: [0, 2],
    palette, trns: [255, 128],
  });
  const out = decodePng(png);
  assert.deepEqual(px(out, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(out, 1, 0), [0, 255, 0, 128], 'tRNS entry 1');
  assert.deepEqual(px(out, 2, 0), [0, 0, 255, 255], 'entries past tRNS are opaque');
  assert.deepEqual(px(out, 4, 1), [0, 255, 0, 128]);
});

test('decodePng downshifts 16-bit samples and keeps grayscale alpha', () => {
  const deep = Buffer.alloc(2 * 2);
  deep.writeUInt16BE(0xabcd, 0); // -> 0xab
  deep.writeUInt16BE(0x00ff, 2); // -> 0x00
  const gray16 = decodePng(makePng({ width: 2, height: 1, colorType: 0, bitDepth: 16, rows: [deep] }));
  assert.deepEqual(px(gray16, 0, 0), [0xab, 0xab, 0xab, 255]);
  assert.deepEqual(px(gray16, 1, 0), [0x00, 0x00, 0x00, 255]);

  const ga = decodePng(makePng({
    width: 2, height: 1, colorType: 4, rows: [Buffer.from([200, 128, 50, 255])],
  }));
  assert.deepEqual(px(ga, 0, 0), [200, 200, 200, 128]);
  assert.deepEqual(px(ga, 1, 0), [50, 50, 50, 255]);
});

test('decodePng joins split IDAT chunks and skips ancillary ones', () => {
  const width = 6;
  const height = 3;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 4);
    for (let i = 0; i < row.length; i++) row[i] = (i * 5 + y * 17) & 0xff;
    rows.push(row);
  }
  const text = Buffer.concat([Buffer.from('Software', 'latin1'), Buffer.from([0]), Buffer.from('ffuse', 'latin1')]);
  const png = makePng({
    width, height, colorType: 6, rows, filters: [1, 3, 4], splitIdat: true,
    extras: [chunk('gAMA', Buffer.from([0, 0x01, 0x86, 0xa0])), chunk('tEXt', text)],
  });
  const out = decodePng(png);
  assert.equal(out.width, 6);
  assert.deepEqual(Buffer.from(out.data), Buffer.concat(rows));
});

test('decodePng scales sub-byte grayscale up to the full 0-255 range', () => {
  const png = makePng({
    width: 8, height: 1, colorType: 0, bitDepth: 1,
    rows: [packSamples([1, 0, 1, 1, 0, 0, 1, 0], 1, 8)],
  });
  const out = decodePng(png);
  assert.deepEqual([...out.data.filter((_, i) => i % 4 === 0)], [255, 0, 255, 255, 0, 0, 255, 0]);
  assert.deepEqual(px(out, 0, 0), [255, 255, 255, 255]);
});

test('decodePng rejects broken and unsupported files with a readable reason', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /bad signature/);
  assert.throws(() => decodePng(Buffer.alloc(4)), /too small/);

  const interlaced = makePng({ width: 2, height: 1, colorType: 6, rows: [Buffer.alloc(8)] });
  const ihdrStart = 8 + 8;
  interlaced[ihdrStart + 12] = 1; // interlace method Adam7
  assert.throws(() => decodePng(interlaced), /interlaced \(Adam7\)/);

  const bogusType = makePng({ width: 2, height: 1, colorType: 6, rows: [Buffer.alloc(8)] });
  bogusType[ihdrStart + 9] = 5;
  assert.throws(() => decodePng(bogusType), /unsupported color type 5/);

  const short = makePng({ width: 8, height: 8, colorType: 6, rows: [Buffer.alloc(32)] });
  assert.throws(() => decodePng(short), /image data is short/);

  const noPlte = makePng({ width: 2, height: 1, colorType: 3, rows: [Buffer.from([0, 1])] });
  assert.throws(() => decodePng(noPlte), /PLTE/);
});

// --- resize ---------------------------------------------------------------

test('resizeRgba box-filters a 4x4 image down to 2x2', () => {
  const frame = blank(4, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const o = (y * 4 + x) * 4;
      frame.data[o] = x * 10;
      frame.data[o + 1] = y * 10;
      frame.data[o + 2] = 100;
    }
  }
  const out = resizeRgba(frame, 2);
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.deepEqual(px(out, 0, 0), [5, 5, 100, 255], 'mean of the top-left 2x2 block');
  assert.deepEqual(px(out, 1, 0), [25, 5, 100, 255]);
  assert.deepEqual(px(out, 1, 1), [25, 25, 100, 255]);
});

test('resizeRgba keeps the aspect ratio and never upscales', () => {
  const wide = blank(10, 5, [1, 2, 3, 255]);
  assert.deepEqual(
    { w: resizeRgba(wide, 3).width, h: resizeRgba(wide, 3).height },
    { w: 3, h: 2 },
    '5 * 3 / 10 rounds to 2',
  );
  assert.equal(resizeRgba(wide, 1).height, 1, 'height never collapses to zero');

  const same = resizeRgba(wide, 40);
  assert.equal(same.width, 10);
  assert.equal(same.height, 5);
  same.data[0] = 99;
  assert.equal(wide.data[0], 1, 'the untouched result is a copy, not the source buffer');

  assert.throws(() => resizeRgba(wide, 0), /positive/);
  assert.throws(() => resizeRgba(wide, -4), /positive/);
  assert.throws(() => resizeRgba({ width: 0, height: 0 }, 2), /no pixels/);
});

test('resizeRgba weights colour by alpha so transparent pixels do not bleed', () => {
  const frame = blank(2, 1);
  frame.data.set([255, 0, 0, 255, 0, 255, 0, 0]);
  const out = resizeRgba(frame, 1);
  assert.deepEqual(px(out, 0, 0), [255, 0, 0, 128]);
});

// --- overlays -------------------------------------------------------------

test('drawOverlays fills rectangles and alpha-blends translucent colour', () => {
  const frame = blank(10, 10);
  drawOverlays(frame, [{ type: 'rect', x: 2, y: 3, width: 4, height: 2, color: [255, 128, 0] }]);
  assert.deepEqual(px(frame, 2, 3), [255, 128, 0, 255]);
  assert.deepEqual(px(frame, 5, 4), [255, 128, 0, 255]);
  assert.deepEqual(px(frame, 6, 3), [0, 0, 0, 255], 'right edge is exclusive');
  assert.deepEqual(px(frame, 2, 5), [0, 0, 0, 255], 'bottom edge is exclusive');

  const white = blank(4, 4, [255, 255, 255, 255]);
  drawOverlays(white, [{ type: 'rect', x: 0, y: 0, width: 2, height: 2, color: [255, 0, 0, 128] }]);
  assert.deepEqual(px(white, 0, 0), [255, 127, 127, 255], 'half-opaque red over white');
  assert.deepEqual(px(white, 3, 3), [255, 255, 255, 255]);

  // callers may pass CSS-style hex, with or without an alpha byte
  const hex = blank(2, 2, [255, 255, 255, 255]);
  drawOverlays(hex, [
    { type: 'rect', x: 0, y: 0, width: 1, height: 1, color: '#ff8c00' },
    { type: 'rect', x: 1, y: 1, width: 1, height: 1, color: '#00000080' },
  ]);
  assert.deepEqual(px(hex, 0, 0), [255, 140, 0, 255]);
  assert.deepEqual(px(hex, 1, 1), [127, 127, 127, 255]);
});

test('drawOverlays draws filled and hollow circles and clips off-frame pixels', () => {
  const filled = blank(11, 11);
  drawOverlays(filled, [{ type: 'circle', x: 5, y: 5, r: 3, color: [0, 255, 0] }]);
  assert.deepEqual(px(filled, 5, 5), [0, 255, 0, 255]);
  assert.deepEqual(px(filled, 5, 2), [0, 255, 0, 255], 'on the radius');
  assert.deepEqual(px(filled, 5, 1), [0, 0, 0, 255], 'outside the radius');

  const ring = blank(11, 11);
  drawOverlays(ring, [{ type: 'circle', x: 5, y: 5, r: 3, fill: false, lineWidth: 1, color: [0, 0, 255] }]);
  assert.deepEqual(px(ring, 5, 5), [0, 0, 0, 255], 'hollow in the middle');
  assert.deepEqual(px(ring, 5, 2), [0, 0, 255, 255]);

  const edge = blank(6, 6);
  drawOverlays(edge, [
    { type: 'circle', x: -20, y: -20, r: 5, color: [255, 0, 0] },
    { type: 'rect', x: 4, y: 4, width: 40, height: 40, color: [255, 0, 0] },
  ]);
  assert.deepEqual(px(edge, 0, 0), [0, 0, 0, 255], 'off-frame drawing is clipped, not wrapped');
  assert.deepEqual(px(edge, 5, 5), [255, 0, 0, 255]);
});

test('drawOverlays renders font glyphs, scales them and boxes unknown ones', () => {
  const frame = blank(8, 8);
  drawOverlays(frame, [{ type: 'text', x: 0, y: 0, text: 'L', color: [255, 255, 255] }]);
  for (let y = 0; y < 7; y++) assert.equal(px(frame, 0, y)[0], 255, `stem row ${y}`);
  for (let x = 0; x < 5; x++) assert.equal(px(frame, x, 6)[0], 255, `foot column ${x}`);
  assert.equal(px(frame, 1, 0)[0], 0, 'the L has no top bar');

  const big = blank(16, 16);
  drawOverlays(big, [{ type: 'text', x: 0, y: 0, text: 'L', scale: 2, color: [255, 255, 255] }]);
  assert.equal(px(big, 1, 1)[0], 255, 'scale 2 paints 2x2 blocks');
  assert.equal(px(big, 2, 0)[0], 0);

  const unknown = blank(8, 8);
  drawOverlays(unknown, [{ type: 'text', x: 0, y: 0, text: '\u00e9', color: [255, 255, 255] }]);
  assert.equal(px(unknown, 0, 0)[0], 255);
  assert.equal(px(unknown, 4, 6)[0], 255);
  assert.equal(px(unknown, 2, 3)[0], 0, 'unknown glyphs render as a hollow box');

  assert.deepEqual(textSize('ab', 1), { width: 11, height: 7 });
  assert.deepEqual(textSize('ab\nc', 2), { width: 22, height: 30 });
});

test('drawOverlays draws arrows with a head and a bottom progress bar', () => {
  const frame = blank(12, 12);
  drawOverlays(frame, [{ type: 'arrow', x1: 1, y1: 6, x2: 9, y2: 6, width: 1, color: [255, 0, 0] }]);
  for (let x = 1; x <= 9; x++) assert.equal(px(frame, x, 6)[0], 255, `shaft at x=${x}`);
  assert.equal(px(frame, 5, 4)[0], 255, 'arrow head fans back from the tip');
  assert.equal(px(frame, 5, 8)[0], 255);
  assert.equal(px(frame, 1, 2)[0], 0, 'nothing painted near the tail off-axis');

  const bar = blank(10, 10);
  drawOverlays(bar, [{ type: 'progress', ratio: 0.5, color: [255, 128, 0], height: 2 }]);
  assert.deepEqual(px(bar, 0, 9), [255, 128, 0, 255]);
  assert.deepEqual(px(bar, 4, 8), [255, 128, 0, 255]);
  assert.deepEqual(px(bar, 5, 9), [0, 0, 0, 255], 'bar stops at half width');
  assert.deepEqual(px(bar, 0, 7), [0, 0, 0, 255], 'bar is only two rows tall');

  drawOverlays(bar, [{ type: 'progress', ratio: 5, color: [0, 0, 255], height: 1 }]);
  assert.deepEqual(px(bar, 9, 9), [0, 0, 255, 255], 'ratio clamps to 1');
});

test('drawOverlays rejects unknown ops and empty frames', () => {
  assert.throws(() => drawOverlays(blank(2, 2), [{ type: 'blob' }]), /unknown op type "blob"/);
  assert.throws(() => drawOverlays(null, []), /no pixels/);
  assert.throws(
    () => drawOverlays(blank(2, 2), [{ type: 'rect', x: 0, y: 0, width: 1, height: 1, color: 'nope' }]),
    /bad color/,
  );
  assert.doesNotThrow(() => drawOverlays(blank(2, 2), [null, undefined]));
});

// --- quantize -------------------------------------------------------------

test('quantize keeps exact colours when they fit in the palette', () => {
  const frame = blank(4, 1);
  frame.data.set([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ]);
  const { palette, indexed } = quantize([frame], 256);
  assert.equal(palette.length, 4 * 3, 'four distinct colours produce four entries');
  assert.equal(indexed.length, 1);
  for (let i = 0; i < 4; i++) {
    const p = indexed[0][i] * 3;
    assert.deepEqual(
      [palette[p], palette[p + 1], palette[p + 2]],
      [frame.data[i * 4], frame.data[i * 4 + 1], frame.data[i * 4 + 2]],
      `pixel ${i} maps back to its own colour`,
    );
  }
});

test('quantize honours maxColors and stays close to the original', () => {
  const frame = blank(64, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 64; x++) {
      const o = (y * 64 + x) * 4;
      frame.data.set([x * 4, 255 - x * 4, (x * 4 + y * 60) & 0xff, 255], o);
    }
  }
  const { palette, indexed } = quantize([frame], 16);
  assert.equal(palette.length, 16 * 3);
  assert.equal(indexed[0].length, 64 * 4);
  let worst = 0;
  for (let i = 0; i < indexed[0].length; i++) {
    const index = indexed[0][i];
    assert.ok(index < 16, `index ${index} inside the palette`);
    for (let c = 0; c < 3; c++) {
      worst = Math.max(worst, Math.abs(palette[index * 3 + c] - frame.data[i * 4 + c]));
    }
  }
  assert.ok(worst < 64, `worst channel error ${worst} stays modest`);
});

test('quantize is deterministic and spans every frame it is given', () => {
  const red = blank(8, 8, [200, 30, 30, 255]);
  const blue = blank(8, 8, [30, 30, 200, 255]);
  const a = quantize([red, blue], 8);
  const b = quantize([red, blue], 8);
  assert.deepEqual(Buffer.from(a.palette), Buffer.from(b.palette), 'no randomness in the palette');
  assert.deepEqual(Buffer.from(a.indexed[0]), Buffer.from(b.indexed[0]));
  assert.deepEqual(Buffer.from(a.indexed[1]), Buffer.from(b.indexed[1]));
  assert.equal(a.palette.length, 2 * 3, 'both frames contribute a colour');
  assert.notEqual(a.indexed[0][0], a.indexed[1][0]);

  const dithered = quantize([red, blue], 8, { dither: true });
  assert.equal(dithered.indexed[0].length, 64);
  assert.deepEqual(Buffer.from(dithered.palette), Buffer.from(a.palette));
});

// --- GIF ------------------------------------------------------------------

test('encodeGif writes a GIF89a with a global table, loop block and trailer', () => {
  const palette = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 0, 0]);
  const frames = [new Uint8Array(6).fill(0), new Uint8Array(6).fill(2)];
  const gif = encodeGif({ frames, palette, width: 3, height: 2, delayMs: 120, loop: 0 });
  const parsed = parseGif(gif);

  assert.equal(parsed.width, 3);
  assert.equal(parsed.height, 2);
  assert.equal(parsed.packed & 0x80, 0x80, 'global colour table flag');
  assert.equal(parsed.gctSize, 4, 'three colours pad up to a 4-entry table');
  assert.deepEqual([...parsed.gct.subarray(0, 9)], [...palette]);
  assert.deepEqual([...parsed.gct.subarray(9, 12)], [0, 0, 0], 'padding entry is black');
  assert.equal(parsed.loop, 0, 'NETSCAPE2.0 loop forever');
  assert.equal(parsed.frames.length, 2, 'one image descriptor per frame');
  assert.ok(parsed.trailer, 'trailer byte 0x3B');

  for (const frame of parsed.frames) {
    assert.equal(frame.left, 0);
    assert.equal(frame.top, 0);
    assert.equal(frame.width, 3);
    assert.equal(frame.height, 2);
    assert.equal(frame.packed, 0, 'no local table, not interlaced');
    assert.equal(frame.gce.delay, 12, '120 ms is 12 hundredths');
    assert.equal(frame.gce.packed & 0x1c, 0x04, 'disposal method 1');
    assert.equal(frame.minCodeSize, 2, 'minimum LZW code size is 2');
  }
  assert.deepEqual(parsed.frames[0].indices, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(parsed.frames[1].indices, [2, 2, 2, 2, 2, 2]);
});

test('encodeGif LZW output decodes back to the exact indices', () => {
  const width = 40;
  const height = 30;
  const palette = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    // repetitive but not trivial: grows the dictionary past the 3-bit codes
    pixels[i] = ((i * 7 + Math.floor(i / width) * 3) >> 1) % 4;
  }
  const gif = encodeGif({ frames: [pixels], palette, width, height, delayMs: 40 });
  const parsed = parseGif(gif);
  assert.equal(parsed.frames.length, 1);
  assert.deepEqual(parsed.frames[0].indices, [...pixels], 'round-trip through the LZW stream');
  assert.equal(parsed.frames[0].gce.delay, 4);
  const sizes = parsed.frames[0].blockSizes;
  assert.equal(sizes[sizes.length - 1], 0, 'sub-block chain ends with a zero-length block');
  assert.ok(sizes.slice(0, -1).every((s) => s > 0 && s <= 255), 'sub-blocks stay within 255 bytes');
});

test('encodeGif handles a full 256-colour table and per-frame delays', () => {
  const palette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) palette.set([i, (i * 5) & 0xff, 255 - i], i * 3);
  const width = 16;
  const height = 16;
  const a = new Uint8Array(width * height);
  const b = new Uint8Array(width * height);
  for (let i = 0; i < a.length; i++) { a[i] = i; b[i] = 255 - i; }
  const gif = encodeGif({ frames: [a, b], palette, width, height, delays: [30, 500] });
  const parsed = parseGif(gif);
  assert.equal(parsed.gctSize, 256);
  assert.equal(parsed.packed, 0xf7, '8-bit colour resolution and table size');
  assert.equal(parsed.frames[0].minCodeSize, 8);
  assert.deepEqual(parsed.frames[0].indices, [...a]);
  assert.deepEqual(parsed.frames[1].indices, [...b]);
  assert.equal(parsed.frames[0].gce.delay, 3);
  assert.equal(parsed.frames[1].gce.delay, 50);
});

test('encodeGif rejects malformed input instead of writing a broken file', () => {
  const palette = new Uint8Array([0, 0, 0, 255, 255, 255]);
  assert.throws(() => encodeGif({ frames: [], palette, width: 2, height: 2 }), /no frames/);
  assert.throws(
    () => encodeGif({ frames: [new Uint8Array(4)], palette, width: 0, height: 2 }),
    /positive integers/,
  );
  assert.throws(
    () => encodeGif({ frames: [new Uint8Array(4)], palette: new Uint8Array(4), width: 2, height: 2 }),
    /1 to 256 RGB triples/,
  );
  assert.throws(
    () => encodeGif({ frames: [new Uint8Array(3)], palette, width: 2, height: 2 }),
    /frame 0 has 3 pixels, expected 4/,
  );
  assert.throws(
    () => encodeGif({ frames: [Uint8Array.from([0, 1, 9, 0])], palette, width: 2, height: 2 }),
    /colour 9 outside the 2-colour palette/,
  );
});

test('the pipeline runs end to end: PNG in, GIF out', () => {
  const width = 24;
  const height = 12;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 3);
    for (let x = 0; x < width; x++) {
      row[x * 3] = x * 10;
      row[x * 3 + 1] = y * 20;
      row[x * 3 + 2] = 90;
    }
    rows.push(row);
  }
  const png = makePng({ width, height, colorType: 2, rows, filters: [0, 1, 2, 3, 4] });
  const frames = [0, 1, 2].map((i) => {
    const frame = resizeRgba(decodePng(png), 12);
    return drawOverlays(frame, [
      { type: 'circle', x: 6, y: 3, r: 2, color: [255, 140, 0, 200] },
      { type: 'arrow', x1: 1, y1: 1, x2: 10, y2: 5, color: [255, 0, 0] },
      { type: 'text', x: 1, y: 5, text: `step ${i}`, color: [255, 255, 255], background: [0, 0, 0, 180] },
      { type: 'progress', ratio: (i + 1) / 3, color: [255, 140, 0] },
    ]);
  });
  const { palette, indexed } = quantize(frames, 64);
  const gif = encodeGif({
    frames: indexed, palette, width: frames[0].width, height: frames[0].height, delayMs: 100,
  });
  const parsed = parseGif(gif);
  assert.equal(parsed.width, 12);
  assert.equal(parsed.height, 6);
  assert.equal(parsed.frames.length, 3);
  assert.ok(parsed.trailer);
  parsed.frames.forEach((frame, i) => {
    assert.deepEqual(frame.indices, [...indexed[i]], `frame ${i} survives encoding`);
  });
});

test('encodeGif survives a full 4096-code LZW dictionary and clears it', () => {
  // Noise fills the dictionary every few thousand pixels, so this walks the
  // table-full branch repeatedly - the one place an off-by-one in the code-size
  // rule corrupts the stream rather than just wasting bytes.
  const width = 256;
  const height = 180;
  const palette = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) palette.set([i, (i * 7) & 0xff, 255 - i], i * 3);
  let seed = 20260908;
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = (seed >> 11) & 0xff;
  }
  const parsed = parseGif(encodeGif({ frames: [pixels], palette, width, height, delayMs: 50 }));
  const frame = parsed.frames[0];
  assert.ok(frame.clears > 1, `the stream resets a full table (saw ${frame.clears} clear codes)`);
  assert.deepEqual(frame.indices, [...pixels], 'every pixel survives the clear/reset cycles');
});

test('encodeGif keeps the code width in step for a 2-colour stream', () => {
  // minCodeSize 2 with only two symbols: the width grows late and slowly, so a
  // decoder reading one bit too soon would desync within the first few hundred
  // pixels rather than at the 4096-code boundary.
  const width = 97;
  const height = 41;
  const palette = new Uint8Array([0, 0, 0, 255, 255, 255]);
  const pixels = new Uint8Array(width * height);
  let seed = 7;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = (seed >> 16) & 1;
  }
  const parsed = parseGif(encodeGif({ frames: [pixels], palette, width, height }));
  assert.equal(parsed.frames[0].minCodeSize, 2);
  assert.deepEqual(parsed.frames[0].indices, [...pixels]);
});

test('encodeGif rejects a canvas larger than the GIF header can address', () => {
  const palette = new Uint8Array([0, 0, 0]);
  assert.throws(
    () => encodeGif({ frames: [new Uint8Array(1)], palette, width: 70000, height: 1 }),
    /65535/,
    'a 16-bit field cannot hold 70000',
  );
  assert.throws(
    () => encodeGif({ frames: [new Uint8Array(1)], palette, width: 1, height: 70000 }),
    /65535/,
  );
});

// --- guards on malformed frames -------------------------------------------

test('resizeRgba and quantize reject frames whose buffer is short', () => {
  const short = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4 - 4) };
  assert.throws(() => resizeRgba(short, 4), /252 bytes, expected 256/);
  assert.throws(() => quantize([short], 16), /252 bytes, expected 256/);
  assert.throws(() => quantize([{ width: 0, height: 4, data: new Uint8Array(0) }], 16), /no pixels/);
  // a longer buffer is fine: only width x height pixels are read
  const padded = { width: 2, height: 1, data: new Uint8Array(64) };
  padded.data.set([10, 20, 30, 255, 40, 50, 60, 255]);
  const { indexed } = quantize([padded], 16);
  assert.equal(indexed[0].length, 2, 'width x height, not the buffer length');
});

// --- off-frame work stays bounded -----------------------------------------

test('overlay ops clip their loops, not just their pixels', () => {
  // Sized so a regression is unmistakable: unclipped, these two shapes walk
  // ~2e9 candidate pixels (about 13s here) to paint a 24x16 frame.
  const started = Date.now();
  const frame = blank(24, 16);
  drawOverlays(frame, [
    { type: 'circle', x: 12, y: 8, r: 20000, color: [0, 128, 255] },
    { type: 'rect', x: -20000, y: -20000, width: 40000, height: 40000, color: [255, 0, 0] },
  ]);
  assert.ok(Date.now() - started < 2000, 'a huge off-frame shape must not stall the export');

  // and the picture is exactly what the unclipped loops would have produced
  const disc = blank(24, 16);
  drawOverlays(disc, [{ type: 'circle', x: 12, y: 8, r: 20000, color: [0, 128, 255] }]);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 24; x++) assert.deepEqual(px(disc, x, y), [0, 128, 255, 255], `${x},${y}`);
  }

  const bar = blank(24, 16);
  drawOverlays(bar, [{ type: 'rect', x: -1000, y: 4, width: 100000, height: 2, color: [255, 0, 0] }]);
  assert.deepEqual(px(bar, 0, 4), [255, 0, 0, 255], 'the on-frame slice is still painted');
  assert.deepEqual(px(bar, 23, 5), [255, 0, 0, 255]);
  assert.deepEqual(px(bar, 0, 6), [0, 0, 0, 255], 'and nothing outside it');

  const hollow = blank(24, 16);
  drawOverlays(hollow, [{ type: 'rect', x: -4, y: -4, width: 32, height: 24, fill: false, lineWidth: 6, color: [0, 255, 0] }]);
  assert.deepEqual(px(hollow, 1, 8), [0, 255, 0, 255], 'an outline starting off-frame keeps its edges');
  assert.deepEqual(px(hollow, 12, 8), [0, 0, 0, 255], 'and its hole');

  const line = blank(24, 16);
  drawOverlays(line, [{ type: 'arrow', x1: -1e8, y1: 8, x2: 1e8, y2: 8, width: 1, color: [255, 255, 255] }]);
  for (let x = 0; x < 24; x++) assert.equal(px(line, x, 8)[0], 255, `shaft crosses at x=${x}`);
  assert.equal(px(line, 12, 6)[0], 0, 'a one-pixel shaft stays one pixel wide');
});

test('overlay ops treat non-finite geometry as absent, not as a loop bound', () => {
  // Number(x) || fallback let Infinity through, and a text scale of Infinity
  // spun the glyph loop forever. Every op coordinate now falls back the way a
  // missing one does.
  assert.deepEqual(textSize('A', Infinity), textSize('A', 1), 'a non-finite scale renders at 1');
  assert.deepEqual(textSize('A', NaN), textSize('A', 1));
  assert.deepEqual(textSize('ab', 3), { width: 33, height: 21 }, 'a real scale still counts');

  const frame = blank(8, 8, [9, 9, 9, 255]);
  drawOverlays(frame, [
    { type: 'rect', x: 0, y: 0, width: Infinity, height: 2, color: [255, 0, 0] },
    { type: 'progress', ratio: NaN, height: Infinity, color: [255, 0, 0] },
  ]);
  assert.deepEqual(px(frame, 0, 0), [9, 9, 9, 255], 'an Infinity width draws nothing, like a missing one');
  assert.deepEqual(px(frame, 4, 7), [9, 9, 9, 255], 'a NaN ratio fills nothing');

  const wild = blank(8, 8);
  const plain = blank(8, 8);
  drawOverlays(wild, [{ type: 'circle', x: Infinity, y: 4, r: 3, color: [255, 0, 0] }]);
  drawOverlays(plain, [{ type: 'circle', x: 0, y: 4, r: 3, color: [255, 0, 0] }]);
  assert.deepEqual(Buffer.from(wild.data), Buffer.from(plain.data), 'Infinity falls back to 0');

  const scaled = blank(8, 8);
  const one = blank(8, 8);
  drawOverlays(scaled, [{ type: 'text', x: 0, y: 0, text: 'A', scale: NaN, color: [255, 0, 0] }]);
  drawOverlays(one, [{ type: 'text', x: 0, y: 0, text: 'A', color: [255, 0, 0] }]);
  assert.deepEqual(Buffer.from(scaled.data), Buffer.from(one.data), 'and so does a bad scale');
});
