// test/gdelt-unzip.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { inflateSingleEntryZip } from '../lib/feeds/gdelt-unzip.js';

// Build a real single-entry ZIP so the test exercises byte offsets rather than
// a mock. GDELT publishes deflate (method 8); measured on a real file, entry
// "20260815033000.gkg.csv", 2,514,853 compressed to 7,775,282 bytes.
function makeZip(name, content, method = 8, extra = Buffer.alloc(0)) {
  const nameBuf = Buffer.from(name, 'utf8');
  const body = method === 8 ? zlib.deflateRawSync(content) : content;
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);   // local file header signature
  header.writeUInt16LE(20, 4);           // version needed
  header.writeUInt16LE(0, 6);            // flags
  header.writeUInt16LE(method, 8);       // compression method
  header.writeUInt32LE(0, 14);           // crc32, unchecked by the reader
  header.writeUInt32LE(body.length, 18); // compressed size
  header.writeUInt32LE(content.length, 22); // uncompressed size
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(extra.length, 28); // extra field length
  return Buffer.concat([header, nameBuf, extra, body]);
}

test('a deflated entry round-trips', () => {
  const content = Buffer.from('col1\tcol2\nvalue1\tvalue2\n', 'utf8');
  const { name, content: out } = inflateSingleEntryZip(makeZip('test.csv', content));
  assert.equal(name, 'test.csv');
  assert.equal(out.toString('utf8'), content.toString('utf8'));
});

test('a stored (uncompressed) entry round-trips', () => {
  const content = Buffer.from('stored bytes', 'utf8');
  const { content: out } = inflateSingleEntryZip(makeZip('plain.txt', content, 0));
  assert.equal(out.toString('utf8'), 'stored bytes');
});

test('an entry with a non-empty extra field is read from the right offset', () => {
  // makeZip writes extraLength = 0 by default and the captured real GDELT file
  // has none either, so `const start = 30 + nameLength + extraLength` was
  // indistinguishable from `30 + nameLength` to every test in this file. The
  // extra field is optional in the format, not absent from it: any writer that
  // emits one (a Zip64 or a timestamp field) moves the payload.
  const content = Buffer.from('col1\tcol2\nvalue1\tvalue2\n', 'utf8');
  const extra = Buffer.alloc(16, 0x5a);
  const { name, content: out } = inflateSingleEntryZip(makeZip('extra.csv', content, 8, extra));
  assert.equal(name, 'extra.csv');
  assert.equal(out.toString('utf8'), content.toString('utf8'));
});

test('a large entry inflates without hitting a buffer ceiling', () => {
  // The real GKG file inflates to 7.8 MB (measured 2026-08-15). This is the
  // lower bound on the ceiling: it fails if the implementation's limit is ever
  // set below the size of the file it exists to read. The upper bound — that
  // there IS a limit and it fires — is the test below.
  const content = Buffer.from('x'.repeat(9 * 1024 * 1024), 'utf8');
  const { content: out } = inflateSingleEntryZip(makeZip('big.csv', content));
  assert.equal(out.length, content.length);
});

test('an entry that inflates past the ceiling is refused instead of exhausting the heap', () => {
  // A decompression bomb in miniature: 65 MB of one repeated byte deflates to
  // about 64 KB, which is exactly the shape that makes an unbounded
  // inflateRawSync dangerous — a small download, an enormous allocation.
  //
  // 65 MB is chosen against the implementation's documented 64 MB ceiling, and
  // the two are coupled by hand because MAX_OUTPUT_BYTES is deliberately not
  // exported. Exporting it so the fixture could be sized from it would close
  // the loop this file exists to keep open, the same reason gdelt-gkg.js does
  // not export COL. The cost is that a change to the constant is a deliberate
  // edit that has to be made in two places.
  const content = Buffer.alloc(65 * 1024 * 1024, 0x78);
  const zip = makeZip('bomb.csv', content);
  // Under 1 MB on the wire for 65 MB inflated — the asymmetry is the point.
  assert.ok(zip.length < 1024 * 1024, `the fixture must be small compressed, was ${zip.length} bytes`);
  assert.throws(
    () => inflateSingleEntryZip(zip),
    // zlib reports the refusal as ERR_BUFFER_TOO_LARGE. Matched on the code
    // rather than the message so a Node wording change does not read as a
    // missing guard.
    (err) => err.code === 'ERR_BUFFER_TOO_LARGE'
  );
});

test('a non-ZIP buffer long enough to reach the signature check is rejected by name', () => {
  // 40 bytes, so `buffer.length < 30` is satisfied and the signature clause is
  // the only thing that can fire. The realistic bad input is not short: a CDN
  // error page, an HTML interstitial or a gzip served under the wrong name are
  // all well over 30 bytes and all reach inflateRawSync if this clause is lost.
  const notAZip = Buffer.alloc(40, 0x41);
  assert.throws(() => inflateSingleEntryZip(notAZip), /not a zip/i);
});

test('a truncated buffer with a valid ZIP signature is rejected by the length check', () => {
  // The other half. This one PASSES the signature clause, so only
  // `buffer.length < 30` can reject it — and without that clause the very next
  // line reads past the end of the buffer and throws something else entirely.
  const truncated = Buffer.alloc(8);
  truncated.writeUInt32LE(0x04034b50, 0);
  assert.throws(() => inflateSingleEntryZip(truncated), /not a zip/i);
});

test('something that is not a Buffer at all is rejected by name', () => {
  // The third clause of the same guard. A string of the right length has
  // `.length` but no `.readUInt32LE`, so without Buffer.isBuffer the failure
  // is a TypeError about a missing method rather than a named refusal.
  assert.throws(() => inflateSingleEntryZip('x'.repeat(40)), /not a zip/i);
});

test('an unsupported compression method is rejected by name', () => {
  const content = Buffer.from('x', 'utf8');
  const zip = makeZip('a.txt', content, 0);
  zip.writeUInt16LE(9, 8); // method 9 = deflate64, unsupported
  assert.throws(() => inflateSingleEntryZip(zip), /unsupported compression method 9/);
});
