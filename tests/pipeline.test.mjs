/* End-to-end tests for the transcription pipeline.
 *
 * These drive the real functions out of index.html against a stubbed DOM and a
 * stubbed fetch, so they assert on what actually reaches the network: which
 * route a file takes, how large each upload is, whether the converter is pulled
 * from the CDN at all, and how failures are reported.
 *
 * Run: node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp, fakeFile, fakeWavFile } from "./harness.mjs";

const CDN = "unpkg";
const WHISPER = "audio/transcriptions";
const MODELS = "v1/models";

/* Drives one file through startTranscription() and reports what happened. */
async function drive(file, opts = {}) {
  const { fail = null, ffmpegAvailable = true, ffmpegCodecs = ["pcm_s16le"], settleMs = 300 } = opts;
  const uploads = [];
  const cdnHits = [];
  const preflights = [];

  const onFetch = async (rec) => {
    if (rec.url.includes(MODELS)) {
      preflights.push(rec);
      if (fail === "network") throw new TypeError("Failed to fetch");
      if (fail === "safari") throw new TypeError("Load failed");
      if (fail === "badkey") return { ok: false, status: 401, json: async () => ({}), headers: { get: () => null } };
      return { ok: true, status: 200, json: async () => ({ data: [] }), headers: { get: () => null } };
    }
    if (rec.url.includes(CDN)) {
      cdnHits.push(rec.url);
      return {
        ok: true, status: 200, headers: { get: () => "100" },
        body: { getReader() { let d = false; return { read: async () => (d ? { done: true } : (d = true, { done: false, value: new Uint8Array(100) })) }; } }
      };
    }
    let bytes = 0, name = "";
    for (const v of rec.body.getAll("file")) { bytes += v.size || 0; name = v.name; }
    uploads.push({ bytes, name });
    if (fail === "whisper-network") throw new TypeError("Failed to fetch");
    if (fail === "whisper-safari") throw new TypeError("Load failed");
    if (fail === "toobig") return { ok: false, status: 413, json: async () => ({}), headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => ({ text: "טקסט", duration: 60, segments: [] }), text: async () => "טקסט" };
  };

  const { ctx, getEl } = loadApp({ onFetch, ffmpegAvailable, ffmpegCodecs });
  getEl("apiKey").value = "sk-test";
  getEl("instructions").value = "";
  ctx.currentFile = file;
  ctx.onFileSelect(file);

  let error = null;
  ctx.showError = (m) => { error = m; };
  await ctx.startTranscription();
  await new Promise((r) => setTimeout(r, settleMs));

  return {
    uploads, cdnHits, preflights, error,
    badge: getEl("fileTypeBadge").innerHTML.replace(/<[^>]+>/g, "").trim(),
    maxUploadMB: uploads.length ? Math.max(...uploads.map((u) => u.bytes)) / 1048576 : 0,
    totalUploadMB: uploads.reduce((n, u) => n + u.bytes, 0) / 1048576,
    duration: getEl("s2").textContent,
  };
}

/* ---- Routing: never convert a file the API already accepts ---- */

test("a small m4a uploads directly — no converter, no CDN", async () => {
  const r = await drive(fakeFile("meeting.m4a", 8 * 1048576));
  assert.equal(r.cdnHits.length, 0, "must not download the ffmpeg core");
  assert.equal(r.uploads.length, 1);
  assert.equal(r.error, null);
});

test("small mp4, ogg and flac also upload directly", async () => {
  for (const ext of ["mp4", "ogg", "flac"]) {
    const r = await drive(fakeFile(`meeting.${ext}`, 6 * 1048576));
    assert.equal(r.cdnHits.length, 0, `${ext} must not need the converter`);
    assert.equal(r.uploads.length, 1, `${ext} should be one request`);
  }
});

test("a small m4a still works when the ffmpeg library never loaded", async () => {
  const r = await drive(fakeFile("meeting.m4a", 8 * 1048576), { ffmpegAvailable: false });
  assert.equal(r.error, null, "a natively supported file must not depend on ffmpeg");
  assert.equal(r.uploads.length, 1);
});

test("large wav and mp3 are split locally, without the converter", async () => {
  for (const file of [fakeWavFile("m.wav", 120 * 1048576), fakeFile("m.mp3", 90 * 1048576)]) {
    const r = await drive(file);
    assert.equal(r.cdnHits.length, 0, `${file.name} is locally splittable`);
    assert.ok(r.uploads.length > 1, "should be chunked");
  }
});

test("a large m4a does use the converter — it cannot be split locally", async () => {
  const r = await drive(fakeFile("meeting.m4a", 90 * 1048576));
  assert.ok(r.cdnHits.length > 0);
  assert.equal(r.error, null);
});

/* ---- Upload sizing: stay well under the 25MB API limit ---- */

test("no single upload approaches Whisper's 25MB limit", async () => {
  const cases = [
    fakeWavFile("m.wav", 120 * 1048576),
    fakeFile("m.mp3", 90 * 1048576),
    fakeFile("m.m4a", 90 * 1048576),
  ];
  for (const f of cases) {
    const r = await drive(f);
    assert.ok(r.maxUploadMB < 24, `${f.name}: largest upload was ${r.maxUploadMB.toFixed(1)}MB`);
  }
});

/* ---- Compression ---- */

test("compresses to mp3 segments when the encoder is available", async () => {
  const r = await drive(fakeFile("meeting.m4a", 90 * 1048576), {
    ffmpegCodecs: ["pcm_s16le", "libmp3lame"],
  });
  assert.ok(r.uploads.every((u) => u.name.endsWith(".mp3")), "parts should be mp3");
  assert.ok(r.totalUploadMB < 20,
    `compressed upload should be small, was ${r.totalUploadMB.toFixed(1)}MB`);
  assert.notEqual(r.duration, "—", "a duration should still be reported");
});

test("falls back to the wav/pcm path when no mp3 encoder exists", async () => {
  const r = await drive(fakeFile("meeting.m4a", 90 * 1048576), { ffmpegCodecs: ["pcm_s16le"] });
  assert.ok(r.uploads.every((u) => u.name.endsWith(".wav")), "parts should fall back to wav");
  assert.equal(r.error, null);
  assert.notEqual(r.duration, "—", "a duration should still be reported");
});

test("compression cuts total upload by several times versus raw pcm", async () => {
  const withMp3 = await drive(fakeFile("m.m4a", 90 * 1048576), { ffmpegCodecs: ["pcm_s16le", "libmp3lame"] });
  const withPcm = await drive(fakeFile("m.m4a", 90 * 1048576), { ffmpegCodecs: ["pcm_s16le"] });
  assert.ok(withMp3.totalUploadMB * 4 < withPcm.totalUploadMB,
    `expected a large saving, got ${withMp3.totalUploadMB.toFixed(1)}MB vs ${withPcm.totalUploadMB.toFixed(1)}MB`);
});

/* ---- Failure reporting ---- */

test("an unreachable API is caught before any upload or CDN download", async () => {
  const r = await drive(fakeFile("meeting.m4a", 90 * 1048576), { fail: "network" });
  assert.equal(r.uploads.length, 0, "must not upload audio");
  assert.equal(r.cdnHits.length, 0, "must not download a 25MB converter first");
  assert.match(r.error, /api\.openai\.com/, "error should name the blocked host");
  assert.match(r.error, /חוסם פרסומות/, "error should suggest concrete causes");
});

test("Safari's 'Load failed' is recognised as a network error, not shown raw", async () => {
  const r = await drive(fakeFile("m.mp3", 8 * 1048576), { fail: "safari" });
  assert.ok(!/^שגיאה: Load failed$/.test(r.error), "must not surface the raw browser string");
  assert.match(r.error, /OpenAI/);
});

test("a rejected key is reported as a key problem, not a network problem", async () => {
  const r = await drive(fakeFile("m.mp3", 8 * 1048576), { fail: "badkey" });
  assert.match(r.error, /מפתח|key was rejected/i);
  assert.equal(r.uploads.length, 0);
});

test("network failures during upload are retried before giving up", async () => {
  const r = await drive(fakeFile("m.mp3", 8 * 1048576), { fail: "whisper-network", settleMs: 20000, ffmpegAvailable: false });
  assert.ok(r.uploads.length >= 3, `expected retries, saw ${r.uploads.length} attempts`);
  assert.match(r.error, /OpenAI/);
});

test("Safari network failures during upload are retried too", async () => {
  const r = await drive(fakeFile("m.mp3", 8 * 1048576), { fail: "whisper-safari", settleMs: 20000, ffmpegAvailable: false });
  assert.ok(r.uploads.length >= 3, `expected retries, saw ${r.uploads.length} attempts`);
});

test("a 413 is explained in plain language and not retried forever", async () => {
  const r = await drive(fakeFile("m.mp3", 8 * 1048576), { fail: "toobig", settleMs: 2000 });
  assert.match(r.error, /25MB/);
  assert.equal(r.uploads.length, 1, "413 is terminal — retrying the same body cannot help");
});

test("an oversized file is refused with actionable advice", async () => {
  const r = await drive(fakeFile("huge.m4a", 400 * 1048576));
  assert.match(r.error, /גדול מדי|too large/i);
});

/* ---- Upload envelope ----
   The recorder produces files named in Hebrew and typed video/webm. Those
   values were previously forwarded straight into the multipart part. */

test("a recorder file is sent under an ASCII name and an audio/* type", async () => {
  const names = [];
  const types = [];
  const onFetch = async (rec) => {
    if (rec.url.includes(MODELS)) return { ok: true, status: 200, json: async () => ({}), headers: { get: () => null } };
    for (const v of rec.body.getAll("file")) { names.push(v.name); types.push(v.type); }
    return { ok: true, status: 200, json: async () => ({ text: "x", duration: 1 }), text: async () => "x" };
  };
  const { ctx, getEl } = loadApp({ onFetch });
  getEl("apiKey").value = "sk-test";
  const f = new File([new Uint8Array(2 * 1048576)], "הקלטה_28.7.2026.webm", { type: "video/webm" });
  ctx.currentFile = f;
  ctx.onFileSelect(f);
  await ctx.startTranscription();
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(names.length, 1);
  assert.ok(/^[\x20-\x7e]+$/.test(names[0]), `name must be ASCII, got "${names[0]}"`);
  assert.ok(names[0].endsWith(".webm"), "extension must be preserved");
  assert.ok(types[0].startsWith("audio/"), `type must be audio/*, got "${types[0]}"`);
});

test("an unreadable file is reported plainly, not as a fetch failure", async () => {
  const onFetch = async (rec) => {
    if (rec.url.includes(MODELS)) return { ok: true, status: 200, json: async () => ({}), headers: { get: () => null } };
    throw new Error("should never upload an unreadable file");
  };
  const { ctx, getEl } = loadApp({ onFetch });
  getEl("apiKey").value = "sk-test";
  const f = new File([new Uint8Array(1024)], "gone.webm", { type: "video/webm" });
  f.arrayBuffer = async () => { const e = new Error("The requested file could not be read"); e.name = "NotReadableError"; throw e; };
  ctx.currentFile = f;
  ctx.onFileSelect(f);
  let error = null;
  ctx.showError = (m) => { error = m; };
  await ctx.startTranscription();
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(error, "an error should be shown");
  assert.ok(!/failed to fetch/i.test(error), `must not blame the network, got "${error}"`);
  assert.match(error, /לא ניתן לקרוא|could not be read/i);
});

/* ---- Last-resort compressed retry ----
   A direct upload the connection will not carry is retried via compress+split
   rather than simply failing. */

async function driveWithDirectUploadFailure(file, opts = {}) {
  const { ffmpegCodecs = ["pcm_s16le", "libmp3lame"], ffmpegAvailable = true } = opts;
  const uploads = [];
  let directAttempts = 0;
  const onFetch = async (rec) => {
    if (rec.url.includes(MODELS)) return { ok: true, status: 200, json: async () => ({}), headers: { get: () => null } };
    if (rec.url.includes(CDN)) return {
      ok: true, status: 200, headers: { get: () => "100" },
      body: { getReader() { let d = false; return { read: async () => (d ? { done: true } : (d = true, { done: false, value: new Uint8Array(100) })) }; } }
    };
    let bytes = 0, name = "";
    for (const v of rec.body.getAll("file")) { bytes += v.size || 0; name = v.name; }
    // The single whole-file upload fails; compressed parts go through.
    if (name === "audio.webm") { directAttempts++; throw new TypeError("Failed to fetch"); }
    uploads.push({ bytes, name });
    return { ok: true, status: 200, json: async () => ({ text: "טקסט", duration: 30 }), text: async () => "טקסט" };
  };
  const { ctx, getEl } = loadApp({ onFetch, ffmpegCodecs, ffmpegAvailable });
  getEl("apiKey").value = "sk-test";
  getEl("instructions").value = "";
  ctx.currentFile = file; ctx.onFileSelect(file);
  let error = null;
  ctx.showError = (m) => { error = m; };
  await ctx.startTranscription();
  await new Promise((r) => setTimeout(r, 20000));
  return { uploads, directAttempts, error, transcript: ctx.transcriptText };
}

const bigRec = () => new File([new Uint8Array(7 * 1048576)], "הקלטה.webm", { type: "audio/webm;codecs=opus" });

test("a stalling direct upload falls back to compress+split and succeeds", async () => {
  const r = await driveWithDirectUploadFailure(bigRec());
  assert.ok(r.directAttempts >= 3, `direct upload should retry first, saw ${r.directAttempts}`);
  assert.ok(r.uploads.length > 0, "should fall back to compressed parts");
  assert.ok(r.uploads.every((u) => u.name.endsWith(".mp3")), "fallback parts should be compressed mp3");
  assert.equal(r.error, null, `should recover, got "${r.error}"`);
});

test("without a converter available the network error is still reported honestly", async () => {
  const r = await driveWithDirectUploadFailure(bigRec(), { ffmpegAvailable: false });
  assert.ok(r.error, "must not silently swallow the failure");
  assert.match(r.error, /OpenAI/);
});

test("a tiny file does not trigger the compressed retry — size is not its problem", async () => {
  const tiny = new File([new Uint8Array(100 * 1024)], "הקלטה.webm", { type: "audio/webm;codecs=opus" });
  const r = await driveWithDirectUploadFailure(tiny);
  assert.equal(r.uploads.length, 0, "should not bother compressing a 0.1MB file");
  assert.ok(r.error, "should report the network failure");
});
