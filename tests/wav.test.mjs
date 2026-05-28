// Unit tests for the WAV-chunking helpers.
// Extracts the *real* functions out of index.html (no copies) and exercises
// them against synthetic WAV files, so we verify the shipping code.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

// Pull out a top-level `function NAME(...) { ... }` by brace-matching.
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let i = html.indexOf("{", start), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}" && --depth === 0) return html.slice(start, j + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const src = ["_wavFourCC", "_wavU32", "_wavU16", "parseWavHeader", "makeWavHeader", "planWavChunks"]
  .map(extract).join("\n");
const { parseWavHeader, makeWavHeader, planWavChunks } =
  new Function(src + "\nreturn { parseWavHeader, makeWavHeader, planWavChunks };")();

// Build a canonical 44-byte-header PCM WAV with the given format + data bytes.
function buildWav(dataBytes, { channels = 1, sampleRate = 16000, bits = 16, dataSizeOverride = null } = {}) {
  const blockAlign = channels * (bits / 8);
  const byteRate = sampleRate * blockAlign;
  const buf = new Uint8Array(44 + dataBytes.length);
  const dv = new DataView(buf.buffer);
  const put4 = (o, s) => { for (let k = 0; k < 4; k++) buf[o + k] = s.charCodeAt(k); };
  put4(0, "RIFF"); dv.setUint32(4, 36 + dataBytes.length, true); put4(8, "WAVE");
  put4(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true); dv.setUint16(34, bits, true);
  put4(36, "data"); dv.setUint32(40, dataSizeOverride ?? dataBytes.length, true);
  buf.set(dataBytes, 44);
  return buf;
}

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ✓ " + name); };

// ── parseWavHeader ───────────────────────────────────────────
test("parses a canonical mono 16k WAV header", () => {
  const data = new Uint8Array(1000);
  const wav = buildWav(data);
  const hdr = parseWavHeader(wav, wav.length);
  assert.ok(hdr);
  assert.equal(hdr.dataOffset, 44);
  assert.equal(hdr.dataSize, 1000);
  assert.equal(hdr.blockAlign, 2);
  assert.equal(hdr.byteRate, 32000);
});

test("derives data size when declared size is 0xFFFFFFFF (streamed WAV)", () => {
  const data = new Uint8Array(500);
  const wav = buildWav(data, { dataSizeOverride: 0xFFFFFFFF });
  const hdr = parseWavHeader(wav, wav.length);
  assert.equal(hdr.dataSize, 500);
});

test("derives data size when declared size overruns the file", () => {
  const data = new Uint8Array(500);
  const wav = buildWav(data, { dataSizeOverride: 9_999_999 });
  const hdr = parseWavHeader(wav, wav.length);
  assert.equal(hdr.dataSize, 500);
});

test("preserves an extended (WAVE_FORMAT_EXTENSIBLE-style) fmt chunk", () => {
  // fmt chunk of size 40 (16 base + 24 extension) plus a LIST chunk before data.
  const fmtBody = new Uint8Array(40);
  const fdv = new DataView(fmtBody.buffer);
  fdv.setUint16(0, 0xFFFE, true); fdv.setUint16(2, 2, true);      // format, channels
  fdv.setUint32(4, 48000, true);  fdv.setUint32(8, 48000 * 4, true);
  fdv.setUint16(12, 4, true);     fdv.setUint16(14, 16, true);    // blockAlign, bits
  const data = new Uint8Array(800);
  const parts = [];
  const put4 = (s) => Uint8Array.from(s, c => c.charCodeAt(0));
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  parts.push(put4("RIFF"), u32(0), put4("WAVE"));
  parts.push(put4("fmt "), u32(40), fmtBody);
  parts.push(put4("LIST"), u32(4), put4("INFO"));                 // junk chunk before data
  parts.push(put4("data"), u32(data.length), data);
  const wav = Uint8Array.from(parts.flatMap(p => [...p]));
  const hdr = parseWavHeader(wav, wav.length);
  assert.ok(hdr);
  assert.equal(hdr.fmtChunkBytes.length, 48);   // 8 header + 40 body
  assert.equal(hdr.blockAlign, 4);
  assert.equal(hdr.byteRate, 48000 * 4);
});

test("rejects non-WAV input (→ caller falls back to raw slicing)", () => {
  assert.equal(parseWavHeader(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 12), null);
  assert.equal(parseWavHeader(new Uint8Array(4), 4), null);
});

// ── planWavChunks ────────────────────────────────────────────
test("chunk ranges cover all data, are sample-aligned, and never exceed max", () => {
  const dataOffset = 44, dataSize = 1000, blockAlign = 2, max = 301; // 301 → aligned down to 300
  const ranges = planWavChunks(dataOffset, dataSize, blockAlign, max);
  let covered = 0, prevEnd = dataOffset;
  for (const r of ranges) {
    assert.equal(r.start, prevEnd, "ranges must be contiguous");
    assert.ok(r.len <= 300, "chunk must respect aligned max");
    assert.equal(r.len % blockAlign === 0 || r.start + r.len === dataOffset + dataSize, true,
      "only the final chunk may be unaligned");
    covered += r.len; prevEnd = r.start + r.len;
  }
  assert.equal(covered, dataSize);
  assert.equal(prevEnd, dataOffset + dataSize);
});

test("single chunk when data fits under the limit", () => {
  const ranges = planWavChunks(44, 500, 2, 20 * 1024 * 1024);
  assert.equal(ranges.length, 1);
  assert.deepEqual(ranges[0], { start: 44, len: 500 });
});

// ── makeWavHeader + round-trip ───────────────────────────────
test("each rebuilt chunk is a valid, self-contained, re-parseable WAV", () => {
  const blockAlign = 2;
  const data = new Uint8Array(2050);                 // odd-ish total to force a ragged last chunk
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
  const wav = buildWav(data);
  const hdr = parseWavHeader(wav, wav.length);
  const ranges = planWavChunks(hdr.dataOffset, hdr.dataSize, hdr.blockAlign, 1000);

  let reassembled = [];
  for (const r of ranges) {
    const header = makeWavHeader(hdr.fmtChunkBytes, r.len);
    const slice = wav.slice(r.start, r.start + r.len);
    const chunk = Uint8Array.from([...header, ...slice]);

    // Whisper must be able to re-read each chunk on its own.
    const reparsed = parseWavHeader(chunk, chunk.length);
    assert.ok(reparsed, "rebuilt chunk must parse");
    assert.equal(reparsed.dataSize, r.len);
    assert.equal(reparsed.blockAlign, blockAlign);
    assert.equal(reparsed.byteRate, hdr.byteRate);
    // RIFF size field must equal total bytes minus 8.
    const dv = new DataView(chunk.buffer);
    assert.equal(dv.getUint32(4, true), chunk.length - 8);

    reassembled.push(...slice);
  }
  // No audio lost or duplicated across the split.
  assert.equal(reassembled.length, data.length);
  assert.deepEqual(Uint8Array.from(reassembled), data);
});

test("computed duration matches byteRate (mono 16k 16-bit → 1s = 32000 bytes)", () => {
  const oneSecond = new Uint8Array(32000);
  const wav = buildWav(oneSecond);
  const hdr = parseWavHeader(wav, wav.length);
  assert.equal(hdr.dataSize / hdr.byteRate, 1);
});

console.log(`\n${passed} WAV tests passed.`);
