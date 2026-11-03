// Valid-but-empty media files, used by --copyright to avoid copying media.
// Audio/video stubs are ~0.25 s of digital silence in a real container; image stubs
// are fully transparent and keep the original's pixel size (read from its header),
// so layouts and texture atlases don't collapse.
import zlib from 'node:zlib';

export const CATEGORIES = {
  audio: ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'weba'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'ogv'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'],
};
CATEGORIES.media = [...CATEGORIES.audio, ...CATEGORIES.video, ...CATEGORIES.image];
const STUBBABLE = new Set(CATEGORIES.media);
const IMAGE = new Set(CATEGORIES.image);

// "-c audio,png -c .webm" → Set{mp3, ogg, ..., png, webm}
export function parseStubSpec(values) {
  const out = new Set();
  for (const tok of values.flatMap((v) => String(v).split(/[\s,;]+/)).filter(Boolean)) {
    const t = tok.toLowerCase().replace(/^\*?\./, '');
    if (CATEGORIES[t]) CATEGORIES[t].forEach((e) => out.add(e));
    else if (STUBBABLE.has(t)) out.add(t);
    else throw new Error(`can't make a stub for "${tok}". Use a category (${Object.keys(CATEGORIES).join(', ')}) or one of: ${[...STUBBABLE].join(', ')}`);
  }
  return out;
}
export const isImageExt = (ext) => IMAGE.has(ext);

// ---------- checksums ----------
const CRC32 = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC32[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const OGG_CRC = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});
function oggCrc(buf) {
  let c = 0;
  for (const b of buf) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ b) & 0xff]) >>> 0;
  return c;
}
function crc8(buf) {
  let c = 0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}
function crc16(buf) {
  let c = 0;
  for (const b of buf) {
    c ^= b << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}
const u16be = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32be = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

// ---------- audio ----------
function wav() {
  const rate = 22050;
  const samples = Math.round(rate / 4);
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono; all-zero side info decodes to silence.
function mp3() {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0xc4]);
  return Buffer.concat(Array.from({ length: 10 }, () => frame));
}

const OPUS_SILENCE = Buffer.from([0xf8, 0xff, 0xfe]); // CELT FB 20 ms mono silence frame
const OPUS_FRAMES = 13;
function opusHead() {
  const h = Buffer.alloc(19);
  h.write('OpusHead', 0);
  h[8] = 1; // version
  h[9] = 1; // channels
  h.writeUInt16LE(312, 10); // pre-skip
  h.writeUInt32LE(48000, 12);
  return h;
}
function oggPage(type, granule, seq, packets) {
  const segs = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      segs.push(255);
      n -= 255;
    }
    segs.push(n);
  }
  const head = Buffer.alloc(27);
  head.write('OggS', 0);
  head[5] = type;
  head.writeBigInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(0x5354_5542, 14); // serial
  head.writeUInt32LE(seq, 18);
  head[26] = segs.length;
  const page = Buffer.concat([head, Buffer.from(segs), ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}
function oggOpus() {
  const vendor = Buffer.from('stub');
  const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.from([vendor.length, 0, 0, 0]), vendor, Buffer.alloc(4)]);
  const packets = Array.from({ length: OPUS_FRAMES }, () => OPUS_SILENCE);
  return Buffer.concat([oggPage(2, 0, 0, [opusHead()]), oggPage(0, 0, 1, [tags]), oggPage(4, OPUS_FRAMES * 960, 2, packets)]);
}

// FLAC: STREAMINFO + CONSTANT(0) frames of 4096 samples.
function flac() {
  const frames = 3;
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0);
  info.writeUInt16BE(4096, 2);
  // 20 bits rate | 3 bits channels-1 | 5 bits bps-1 | 36 bits total samples
  info.writeBigUInt64BE((44100n << 44n) | (15n << 36n) | BigInt(4096 * frames), 10);
  const frameOf = (n) => {
    const head = Buffer.from([0xff, 0xf8, 0xc9, 0x08, n]); // 4096 blk, 44.1k, mono, 16-bit, frame# n
    const body = Buffer.concat([head, Buffer.from([crc8(head)]), Buffer.from([0x00, 0x00, 0x00])]);
    return Buffer.concat([body, u16be(crc16(body))]);
  };
  return Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), info, ...Array.from({ length: frames }, (_, i) => frameOf(i))]);
}

// ---------- containers ----------
function ebml(idHex, ...kids) {
  const data = Buffer.concat(kids.map((k) => (Buffer.isBuffer(k) ? k : Buffer.from(k))));
  let len = 1;
  while (data.length >= 2 ** (7 * len) - 1) len++;
  const size = Buffer.alloc(len);
  let v = data.length;
  for (let i = len - 1; i >= 0; i--) {
    size[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  size[0] |= 1 << (8 - len);
  return Buffer.concat([Buffer.from(idHex, 'hex'), size, data]);
}
const ebmlUint = (n) => {
  const bytes = [];
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  return Buffer.from(bytes);
};
const ebmlFloat = (n) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b;
};
function webmOpus() {
  const blocks = Array.from({ length: OPUS_FRAMES }, (_, i) =>
    ebml('A3', Buffer.from([0x81, ((i * 20) >> 8) & 0xff, (i * 20) & 0xff, 0x80]), OPUS_SILENCE)
  );
  return Buffer.concat([
    ebml('1A45DFA3', ebml('4286', ebmlUint(1)), ebml('42F7', ebmlUint(1)), ebml('42F2', ebmlUint(4)), ebml('42F3', ebmlUint(8)), ebml('4282', 'webm'), ebml('4287', ebmlUint(4)), ebml('4285', ebmlUint(2))),
    ebml(
      '18538067',
      ebml('1549A966', ebml('2AD7B1', ebmlUint(1_000_000)), ebml('4D80', 'stub'), ebml('5741', 'stub'), ebml('4489', ebmlFloat(OPUS_FRAMES * 20))),
      ebml(
        '1654AE6B',
        ebml('AE', ebml('D7', ebmlUint(1)), ebml('73C5', ebmlUint(1)), ebml('83', ebmlUint(2)), ebml('86', 'A_OPUS'), ebml('63A2', opusHead()), ebml('E1', ebml('B5', ebmlFloat(48000)), ebml('9F', ebmlUint(1))))
      ),
      ebml('1F43B675', ebml('E7', ebmlUint(0)), ...blocks)
    ),
  ]);
}

function box(type, ...parts) {
  const data = Buffer.concat(parts);
  return Buffer.concat([u32be(8 + data.length), Buffer.from(type), data]);
}
const fullBox = (type, version, flags, ...parts) => box(type, Buffer.from([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...parts);
const MATRIX = Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32be));
// Silent AAC-LC raw_data_block (mono): SCE, global_gain 0, long window, max_sfb 0, no
// pulse/TNS/gain-control, then END. Exactly 32 bits.
const AAC_SILENT = Buffer.from([0x00, 0x00, 0x00, 0x07]);
const AAC_FRAMES = 12; // 12 × 1024 samples @ 44.1 kHz ≈ 0.28 s

function adts() {
  // MPEG-4 AAC-LC, 44.1 kHz, mono, no CRC; frame_length = 7 + 4 = 11
  const header = Buffer.from([0xff, 0xf1, 0x50, 0x40, 0x01, 0x7f, 0xfc]);
  return Buffer.concat(Array.from({ length: AAC_FRAMES }, () => Buffer.concat([header, AAC_SILENT])));
}

// MP4 with one AAC-LC audio track of AAC_FRAMES silent frames (moov first, then mdat).
function mp4() {
  const n = AAC_FRAMES;
  const samples = n * 1024;
  const ms = Math.round((samples / 44100) * 1000);
  const desc = (tag, body) => Buffer.concat([Buffer.from([tag, body.length]), body]);
  const esds = fullBox(
    'esds', 0, 0,
    desc(0x03, Buffer.concat([u16be(1), Buffer.from([0]),
      desc(0x04, Buffer.concat([Buffer.from([0x40, 0x15, 0, 0, 0]), u32be(0), u32be(0), desc(0x05, Buffer.from([0x12, 0x08]))])),
      desc(0x06, Buffer.from([0x02]))]))
  );
  const mp4a = box('mp4a', Buffer.alloc(6), u16be(1), Buffer.alloc(8), u16be(1), u16be(16), Buffer.alloc(4), u32be(44100 * 65536), esds);
  const tkhd = fullBox('tkhd', 0, 3, u32be(0), u32be(0), u32be(1), u32be(0), u32be(ms), Buffer.alloc(8), u16be(0), u16be(0), u16be(0x0100), u16be(0), MATRIX, u32be(0), u32be(0));
  const mvhd = fullBox('mvhd', 0, 0, u32be(0), u32be(0), u32be(1000), u32be(ms), u32be(0x00010000), u16be(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32be(2));
  const ftyp = box('ftyp', Buffer.from('isom'), u32be(512), Buffer.from('isomiso2mp41'));
  const moov = (chunkOffset) => {
    const stbl = box(
      'stbl',
      fullBox('stsd', 0, 0, u32be(1), mp4a),
      fullBox('stts', 0, 0, u32be(1), u32be(n), u32be(1024)),
      fullBox('stsc', 0, 0, u32be(1), u32be(1), u32be(n), u32be(1)),
      fullBox('stsz', 0, 0, u32be(AAC_SILENT.length), u32be(n)),
      fullBox('stco', 0, 0, u32be(1), u32be(chunkOffset))
    );
    const minf = box('minf', fullBox('smhd', 0, 0, Buffer.alloc(4)), box('dinf', fullBox('dref', 0, 0, u32be(1), fullBox('url ', 0, 1))), stbl);
    const mdia = box(
      'mdia',
      fullBox('mdhd', 0, 0, u32be(0), u32be(0), u32be(44100), u32be(samples), u16be(0x55c4), u16be(0)),
      fullBox('hdlr', 0, 0, u32be(0), Buffer.from('soun'), Buffer.alloc(12), Buffer.from('SoundHandler\0')),
      minf
    );
    return box('moov', mvhd, box('trak', tkhd, mdia));
  };
  const dataStart = ftyp.length + moov(0).length + 8; // stco is fixed-width, so sizes don't depend on the offset
  return Buffer.concat([ftyp, moov(dataStart), box('mdat', ...Array(n).fill(AAC_SILENT))]);
}

// ---------- images ----------
// Transparent 1-bit palette PNG: tiny even at 8k×8k.
function png(w, h) {
  const chunk = (type, data) => Buffer.concat([u32be(data.length), Buffer.from(type), data, u32be(crc32(Buffer.concat([Buffer.from(type), data])))]);
  const ihdr = Buffer.concat([u32be(w), u32be(h), Buffer.from([1, 3, 0, 0, 0])]);
  const raw = Buffer.alloc(h * (1 + Math.ceil(w / 8)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', Buffer.from([0, 0, 0])),
    chunk('tRNS', Buffer.from([0])),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// GIF whose logical screen is w×h but only one transparent pixel is ever drawn.
function gif(w, h) {
  const le16 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
  return Buffer.concat([
    Buffer.from('GIF89a'), le16(w), le16(h), Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0x21, 0xf9, 0x04, 0x01, 0, 0, 0, 0]), // GCE: index 0 transparent
    Buffer.from([0x2c]), le16(0), le16(0), le16(1), le16(1), Buffer.from([0]),
    Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]),
  ]);
}

// Width/height from the first bytes of an image, or null.
export function imageSize(buf, ext) {
  try {
    if (buf.length >= 24 && buf.toString('latin1', 1, 4) === 'PNG') return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    if (buf.toString('latin1', 0, 3) === 'GIF') return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
    if (buf[0] === 0x42 && buf[1] === 0x4d) return [Math.abs(buf.readInt32LE(18)), Math.abs(buf.readInt32LE(22))];
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i + 9 < buf.length; ) {
        if (buf[i] !== 0xff) return null;
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const kind = buf.toString('latin1', 12, 16);
      if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)];
      }
      if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
    }
    const ispe = buf.indexOf('ispe');
    if (ispe > 0 && ispe + 16 <= buf.length) return [buf.readUInt32BE(ispe + 8), buf.readUInt32BE(ispe + 12)];
    if (ext === 'ico' && buf.readUInt16LE(2) === 1) return [buf[6] || 256, buf[7] || 256];
    if (ext === 'svg') {
      const s = buf.toString('utf8');
      const w = s.match(/<svg[^>]*\swidth\s*=\s*["']?([\d.]+)/i)?.[1];
      const h = s.match(/<svg[^>]*\sheight\s*=\s*["']?([\d.]+)/i)?.[1];
      if (w && h) return [Math.round(+w), Math.round(+h)];
      const vb = s.match(/viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      if (vb) return [Math.round(+vb[1]), Math.round(+vb[2])];
    }
  } catch {
    /* truncated header */
  }
  return null;
}

// `header` is the start of the original (images only); may be null.
export function makeStub(ext, header) {
  if (IMAGE.has(ext)) {
    let [w, h] = (header && imageSize(header, ext)) || [1, 1];
    w = Math.min(Math.max(w | 0, 1), 16384);
    h = Math.min(Math.max(h | 0, 1), 16384);
    // Browsers sniff image bytes, so a PNG body works for every raster extension.
    if (ext === 'gif') return gif(Math.min(w, 65535), Math.min(h, 65535));
    if (ext === 'svg') return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"/>`);
    return png(w, h);
  }
  switch (ext) {
    case 'mp3':
      return mp3();
    case 'wav':
      return wav();
    case 'flac':
      return flac();
    case 'ogg':
    case 'oga':
    case 'opus':
    case 'ogv':
      return oggOpus();
    case 'webm':
    case 'weba':
      return webmOpus();
    case 'aac':
      return adts();
    default: // mp4, m4a, m4v, mov
      return mp4();
  }
}
