// Unit tests for assembleChunks() — the pure logic that stitches per-chunk
// transcription results into the final transcript (timestamp offsetting across
// chunks, plain-text joining, and failed-chunk placeholders/tracking).
// Extracts the real functions from index.html so we test shipping code.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  let depth = 0;
  for (let j = html.indexOf("{", start); j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}" && --depth === 0) return html.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const src = [extract("fmtTime"), extract("assembleChunks")].join("\n");
const { assembleChunks } = new Function(src + "\nreturn { assembleChunks };")();

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ✓ " + name); };

test("timestamps are offset by the cumulative duration of earlier chunks", () => {
  const results = [
    { segments: [{ start: 0, text: "אחת" }, { start: 65, text: "שתיים" }], duration: 120 },
    { segments: [{ start: 10, text: "שלוש" }], duration: 60 },
  ];
  const a = assembleChunks(results, true);
  assert.deepEqual(a.text.split("\n"), [
    "[0:00]  אחת",
    "[1:05]  שתיים",   // 65s within chunk 0
    "[2:10]  שלוש",    // 10s + 120s offset = 130s
  ]);
  assert.equal(a.duration, 180);
  assert.deepEqual(a.failures, []);
});

test("plain-text mode joins chunks with a blank line and reports no duration", () => {
  const results = [
    { text: "שלום", segments: null, duration: 0 },
    { text: "עולם", segments: null, duration: 0 },
  ];
  const a = assembleChunks(results, false);
  assert.equal(a.text, "שלום\n\nעולם");
  assert.equal(a.duration, 0);
  assert.deepEqual(a.failures, []);
});

test("a failed chunk becomes a placeholder and is tracked, others survive", () => {
  const results = [
    { text: "חלק ראשון", segments: null, duration: 0 },
    null,                                   // failed
    { text: "חלק שלישי", segments: null, duration: 0 },
  ];
  const a = assembleChunks(results, false);
  const lines = a.text.split("\n\n");
  assert.equal(lines[0], "חלק ראשון");
  assert.match(lines[1], /חלק 2 לא תומלל/);
  assert.equal(lines[2], "חלק שלישי");
  assert.deepEqual(a.failures, [1]);
});

test("failed chunk in timestamp mode still tracked and surrounding times intact", () => {
  const results = [
    { segments: [{ start: 0, text: "פתיחה" }], duration: 30 },
    null,
    { segments: [{ start: 5, text: "סיום" }], duration: 30 },
  ];
  const a = assembleChunks(results, true);
  const lines = a.text.split("\n");
  assert.equal(lines[0], "[0:00]  פתיחה");
  assert.match(lines[1], /חלק 2 לא תומלל/);
  // chunk 2 follows the failed chunk: only chunk 0's 30s counts (failed chunk
  // contributes 0 duration), so 5s offset by 30s = 35s = 0:35.
  assert.equal(lines[2], "[0:35]  סיום");
  assert.deepEqual(a.failures, [1]);
});

test("empty segment list falls back to chunk text", () => {
  const a = assembleChunks([{ text: "fallback", segments: [], duration: 12 }], true);
  assert.equal(a.text, "fallback");
  assert.equal(a.duration, 12);
});

console.log(`\n${passed} chunk-assembly tests passed.`);
