/* Tests for the on-screen self-test.
 *
 * The whole point of the panel is to tell apart failures that look identical to
 * the user ("Failed to fetch"), so each test forces one specific failure and
 * asserts the panel reaches the right conclusion — and, just as importantly,
 * that it stops there instead of running probes that cannot succeed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp, fakeFile } from "./harness.mjs";

const MODELS = "v1/models";
const WHISPER = "audio/transcriptions";

async function diagnose({ reach = "ok", upload = "ok", bigUpload = null, file = null } = {}) {
  const calls = [];
  const uploadMB = [];

  const onFetch = async (rec) => {
    if (rec.url.includes(MODELS)) {
      calls.push("models");
      if (reach === "network") throw new TypeError("Failed to fetch");
      if (reach === "401") return { ok: false, status: 401, text: async () => "", headers: { get: () => null } };
      return { ok: true, status: 200, text: async () => "{}", headers: { get: () => null } };
    }
    if (rec.url.includes(WHISPER)) {
      let bytes = 0;
      for (const v of rec.body.getAll("file")) bytes += v.size || 0;
      const mb = bytes / 1048576;
      uploadMB.push(mb);
      calls.push("upload:" + mb.toFixed(2));
      const mode = mb > 1 && bigUpload ? bigUpload : upload;
      if (mode === "network") throw new TypeError("Failed to fetch");
      if (mode === "403") return { ok: false, status: 403, text: async () => "no access", headers: { get: () => null } };
      return { ok: true, status: 200, text: async () => "", headers: { get: () => null } };
    }
    throw new Error("unexpected url " + rec.url);
  };

  const { ctx, getEl } = loadApp({ onFetch });
  getEl("apiKey").value = "sk-test";
  if (file) { ctx.currentFile = file; ctx.onFileSelect(file); }
  await ctx.runDiagnostics();
  return { report: getEl("diagOut").textContent, calls, uploadMB };
}

test("an unreachable API is diagnosed as network, and stops before uploading", async () => {
  const r = await diagnose({ reach: "network" });
  assert.match(r.report, /unreachable/i);
  assert.match(r.report, /ad blocker|VPN|DNS/i, "should name plausible causes");
  assert.match(r.report, /Not a file-size problem/i, "must rule size out explicitly");
  assert.ok(!r.calls.some((c) => c.startsWith("upload")), "no point uploading when the host is unreachable");
});

test("a rejected key is diagnosed as a key problem, not a network one", async () => {
  const r = await diagnose({ reach: "401" });
  assert.match(r.report, /key was rejected/i);
  assert.ok(!r.calls.some((c) => c.startsWith("upload")));
});

test("an endpoint that rejects even a tiny body is separated from a size problem", async () => {
  const r = await diagnose({ upload: "403" });
  assert.match(r.report, /even a tiny upload fails/i);
  assert.match(r.report, /not at your file size/i);
  assert.equal(r.uploadMB.length, 1, "should not escalate to the larger probe");
});

test("small-ok / large-fail is diagnosed as the size-and-connection problem", async () => {
  const r = await diagnose({ upload: "ok", bigUpload: "network" });
  assert.match(r.report, /Small uploads work, larger ones do not/i);
  assert.match(r.report, /size\/connection problem/i);
  assert.equal(r.uploadMB.length, 2, "needs both probes to draw this conclusion");
  assert.ok(r.uploadMB[0] < 1 && r.uploadMB[1] > 3, "probes must differ meaningfully in size");
});

test("a healthy network reports success and measures throughput", async () => {
  const r = await diagnose({});
  assert.match(r.report, /All network probes passed/i);
  assert.match(r.report, /measured upload speed/i);
});

test("with a file selected it reports the route and estimates upload time", async () => {
  const r = await diagnose({ file: fakeFile("meeting.m4a", 90 * 1048576) });
  assert.match(r.report, /route: convert\+compress/);
  assert.match(r.report, /min of uploading/);
});

test("a directly-uploadable file is reported as such", async () => {
  const r = await diagnose({ file: fakeFile("meeting.m4a", 8 * 1048576) });
  assert.match(r.report, /route: direct upload/);
});

test("without a key it says so instead of failing silently", async () => {
  const onFetch = async () => { throw new Error("should not be called"); };
  const { ctx, getEl } = loadApp({ onFetch });
  getEl("apiKey").value = "";
  await ctx.runDiagnostics();
  assert.match(getEl("diagOut").textContent, /no API key/i);
});

test("the report always records device and link context", async () => {
  const r = await diagnose({});
  assert.match(r.report, /UA:/);
  assert.match(r.report, /online:/);
});

test("the report is explicitly terminated so a partial copy is recognisable", async () => {
  const r = await diagnose({});
  assert.match(r.report, /END OF REPORT/, "a finished run must be marked");
  assert.match(r.report, /running — wait/, "a run in progress must say so");
});

test("every early exit still terminates the report", async () => {
  for (const opts of [{ reach: "network" }, { reach: "401" }, { upload: "403" }, { upload: "ok", bigUpload: "network" }]) {
    const r = await diagnose(opts);
    assert.match(r.report, /END OF REPORT/, `unterminated for ${JSON.stringify(opts)}`);
  }
});
