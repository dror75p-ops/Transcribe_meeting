// Tests for recorder-related pure logic extracted from index.html:
//  - analyzeFileType routing (esp. that large webm/opus from the recorder is
//    sent to the decode path, not the byte-slicer that would corrupt it)
//  - recExtForMime (recording mime → file extension)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  let depth = 0;
  for (let j = html.indexOf("{", start); j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}" && --depth === 0) return html.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function extractConst(name) {
  const m = html.match(new RegExp(`const ${name} = \\[[^\\]]*\\];`));
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

const src = [
  extractConst("WHISPER_NATIVE"),
  extractConst("SLICE_SAFE"),
  "const MAX_UPLOAD_MB = 24;",
  extractFn("analyzeFileType"),
  extractFn("recExtForMime"),
].join("\n");
const { analyzeFileType, recExtForMime } =
  new Function(src + "\nreturn { analyzeFileType, recExtForMime };")();

const f = (name, mb) => ({ name, size: mb * 1024 * 1024 });
let passed = 0;
const test = (n, fn) => { fn(); passed++; console.log("  ✓ " + n); };

// ── routing ──────────────────────────────────────────────────
test("small recording (webm < 24MB) → direct, no conversion/chunking", () => {
  const r = analyzeFileType(f("הקלטה.webm", 10));
  assert.equal(r.needsConversion, false);
  assert.equal(r.needsChunking, false);
});

test("LARGE recording (webm > 24MB) → decode path, NOT raw byte-slicing", () => {
  const r = analyzeFileType(f("הקלטה.webm", 60));
  assert.equal(r.needsChunking, true);
  assert.equal(r.needsConversion, true); // the bug fix: webm must be decoded
});

test("large mp3 stays on the fast byte-slice path (slice-safe)", () => {
  const r = analyzeFileType(f("meeting.mp3", 60));
  assert.equal(r.needsChunking, true);
  assert.equal(r.needsConversion, false);
});

test("large wav stays on the byte-slice path (rebuilt into valid chunks)", () => {
  const r = analyzeFileType(f("meeting.wav", 60));
  assert.equal(r.needsConversion, false);
});

// Whisper decodes mp4/m4a/ogg/flac server-side, so a small one needs no
// converter at all — requiring the ffmpeg CDN for them was the "Failed to
// fetch" bug. Only a large one, which has to be split, needs decoding.
test("small containers upload directly — no converter", () => {
  assert.equal(analyzeFileType(f("clip.mp4", 5)).needsConversion, false);
  assert.equal(analyzeFileType(f("voice.m4a", 8)).needsConversion, false);
  assert.equal(analyzeFileType(f("a.ogg", 2)).needsConversion, false);
  assert.equal(analyzeFileType(f("a.flac", 12)).needsConversion, false);
});

test("large containers convert — they cannot be byte-sliced", () => {
  assert.equal(analyzeFileType(f("voice.m4a", 100)).needsConversion, true);
  assert.equal(analyzeFileType(f("clip.mp4", 60)).needsConversion, true);
});

test("iOS recording (mp4) converts via the container path", () => {
  assert.equal(analyzeFileType(f("הקלטה.mp4", 30)).needsConversion, true);
});

// ── mime → extension ─────────────────────────────────────────
test("recExtForMime maps recorder mimes correctly", () => {
  assert.equal(recExtForMime("audio/webm;codecs=opus"), "webm");
  assert.equal(recExtForMime("audio/webm"), "webm");
  assert.equal(recExtForMime("audio/mp4"), "mp4");
  assert.equal(recExtForMime("audio/ogg;codecs=opus"), "ogg");
  assert.equal(recExtForMime(""), "webm"); // safe default
});

console.log(`\n${passed} recorder tests passed.`);
