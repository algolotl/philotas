// lib/feeds/gdelt-unzip.js
//
// Inflate a single-entry ZIP without a dependency.
//
// GDELT publishes its bulk files as ZIP, and Node has gzip but not ZIP. The
// format's local file header is fixed-width and the payload is raw deflate, so
// reading one entry is about twenty lines — cheaper than adding a package to
// the dependency tree for one call site.
//
// Verified against a real file on 2026-08-15: entry "20260815033000.gkg.csv",
// method 8, 2,514,853 compressed, 7,775,282 uncompressed, 599 rows of 27
// tab-separated fields.

import zlib from 'node:zlib';

const LOCAL_FILE_HEADER = 0x04034b50;
// The GKG file inflates to about 7.8 MB. 64 MB leaves room for growth while
// still refusing a decompression bomb rather than exhausting the heap.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function inflateSingleEntryZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 30 || buffer.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    throw new Error('not a zip: missing local file header signature');
  }

  const method = buffer.readUInt16LE(8);
  const compressedSize = buffer.readUInt32LE(18);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);

  const name = buffer.slice(30, 30 + nameLength).toString('utf8');
  const start = 30 + nameLength + extraLength;
  const body = compressedSize > 0 ? buffer.slice(start, start + compressedSize) : buffer.slice(start);

  if (method === 0) return { name, content: body };
  if (method !== 8) throw new Error(`unsupported compression method ${method} in ${name}`);

  return { name, content: zlib.inflateRawSync(body, { maxOutputLength: MAX_OUTPUT_BYTES }) };
}
