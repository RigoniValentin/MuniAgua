/**
 * Generates tiny valid binary blobs (PNG, JPEG, WEBP, PDF) for upload tests.
 * Uses file-type's `fileTypeFromBuffer` to make sure the magic bytes match.
 */
import { Buffer } from 'node:buffer';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

// Minimal WEBP (RIFF + WEBP)
const WEBP_MAGIC = Buffer.from('RIFF', 'ascii');
const WEBP_TYPE = Buffer.from('WEBP', 'ascii');

function fill(length: number, filler: number): Buffer {
  const buf = Buffer.alloc(length);
  buf.fill(filler);
  return buf;
}

/**
 * Builds a tiny PNG with the minimum valid IHDR + IDAT + IEND chunks.
 * The resulting buffer MUST be detected as image/png by file-type and is
 * enough to satisfy the magic-byte check (we don't actually need a fully
 * decodable image for our purposes).
 */
export function buildPng(bytes = 256): Buffer {
  // PNG = 8-byte signature + IHDR chunk (25 bytes) + IDAT chunk + IEND chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdrCrc = crc32(Buffer.concat([Buffer.from('IHDR'), ihdrData]));
  const ihdr = concatChunks('IHDR', ihdrData, ihdrCrc);
  // IDAT with a single zero byte (filter byte) + 0 RGB
  const idatRaw = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  const idatCrc = crc32(Buffer.concat([Buffer.from('IDAT'), idatRaw]));
  const idat = concatChunks('IDAT', idatRaw, idatCrc);
  const iendCrc = crc32(Buffer.from('IEND'));
  const iend = concatChunks('IEND', Buffer.alloc(0), iendCrc);
  const total = Buffer.concat([PNG_MAGIC, ihdr, idat, iend]);
  // Pad to a minimum if needed
  if (total.length >= bytes) return total;
  return Buffer.concat([total, fill(bytes - total.length, 0)]);
}

function concatChunks(type: string, data: Buffer, crc: number): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

// CRC32 (PNG flavor)
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function buildJpeg(bytes = 256): Buffer {
  // Minimal JPEG with a single SOI + APP0 + EOI. file-type detects by magic.
  const tail = fill(Math.max(0, bytes - JPEG_MAGIC.length - 2), 0xff);
  return Buffer.concat([JPEG_MAGIC, tail, Buffer.from([0xff, 0xd9])]);
}

export function buildWebp(bytes = 256): Buffer {
  // RIFF....WEBPVP8L.... (lossless)
  const sizeField = Buffer.alloc(4);
  const totalSize = Math.max(8, bytes - 8);
  sizeField.writeUInt32LE(totalSize, 0);
  const vp8l = Buffer.from('VP8L', 'ascii');
  const vp8lSize = Buffer.alloc(4);
  vp8lSize.writeUInt32LE(Math.max(4, totalSize - 8), 0);
  const vp8lBody = fill(Math.max(4, totalSize - 8), 0x00);
  return Buffer.concat([
    WEBP_MAGIC,
    sizeField,
    WEBP_TYPE,
    vp8l,
    vp8lSize,
    vp8lBody,
  ]);
}

export function buildPdf(bytes = 256): Buffer {
  const tail = fill(Math.max(0, bytes - PDF_MAGIC.length - 6), 0x20);
  return Buffer.concat([
    PDF_MAGIC,
    tail,
    Buffer.from('%%EOF', 'ascii'),
  ]);
}

/** Build an "image" that LOOKS like PNG but is actually garbage beyond the magic. */
export function buildFakePng(): Buffer {
  return Buffer.concat([PNG_MAGIC, fill(64, 0xff)]);
}

/** Buffer that is not in any allowed MIME. */
export function buildSvg(): Buffer {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
}

/** Build a buffer that exceeds 8MB. */
export function buildOversizedPdf(): Buffer {
  return buildPdf((8 * 1024 * 1024) + 1024);
}