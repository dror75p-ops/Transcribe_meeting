// Headless harness: loads the app's <script> body, stubs DOM + fetch,
// and drives the transcription pipeline to observe real request behaviour.
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

export function loadApp({ onFetch, ffmpegAvailable = true, ffmpegCodecs = ["pcm_s16le"] }) {
  const lines = html.split("\n");
  // main script block: line 1427 is "<script>", 2830 is "</script>" (1-indexed)
  const start = lines.findIndex((l, i) => i > 1400 && l.trim() === "<script>");
  const end = lines.findIndex((l, i) => i > start && l.trim() === "</script>");
  const code = lines.slice(start + 1, end).join("\n");

  const els = new Map();
  const mkEl = (id) => ({
    id, value: "", textContent: "", innerHTML: "", disabled: false,
    style: {}, dataset: {}, files: [],
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
    scrollIntoView() {}, querySelector: () => null, querySelectorAll: () => [],
    getContext: () => null, click() {}, focus() {}, blur() {},
    setAttribute() {}, getAttribute: () => null, insertAdjacentHTML() {},
    children: [], parentNode: null, checked: false,
  });
  const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };

  const document = {
    getElementById: getEl,
    createElement: (t) => mkEl("created-" + t),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, body: mkEl("body"), head: mkEl("head"),
    documentElement: mkEl("html"), cookie: "",
  };

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const requests = [];
  const fetchImpl = async (url, opts = {}) => {
    const rec = { url, opts, body: opts.body };
    requests.push(rec);
    return onFetch(rec);
  };

  const sandbox = {
    console, document, localStorage, sessionStorage: localStorage,
    fetch: fetchImpl,
    FormData, Blob, File, URL, TextEncoder, TextDecoder, DataView,
    Uint8Array, Int16Array, Float32Array, ArrayBuffer,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, AbortSignal, Headers, Response, Request, Error, TypeError,
    Math, Date, JSON, Promise, Intl,
    navigator: { userAgent: "Mozilla/5.0 (Macintosh) Chrome/120", locks: null, clipboard: { writeText: async () => {} } },
    location: { origin: "https://example.github.io", href: "https://example.github.io/x/", search: "" },
    alert() {}, confirm: () => true, prompt: () => null,
    requestAnimationFrame: (f) => setTimeout(f, 0),
    FileReader: class {
      readAsArrayBuffer(file) {
        file.arrayBuffer().then((buf) => {
          this.result = buf;
          this.onload && this.onload();
        });
      }
    },
    FFmpegWASM: ffmpegAvailable ? { FFmpeg: makeFakeFFmpeg(ffmpegCodecs) } : undefined,
  };
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {} });
  sandbox.open = () => ({ document: { write() {}, close() {} }, close() {}, focus() {}, print() {} });
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: "app.js" });
  return { ctx, requests, getEl, els };
}

// Minimal ffmpeg.wasm stand-in. Produces silence PCM/mp3 of a chosen duration.
function makeFakeFFmpeg(codecs) {
  return class FakeFFmpeg {
    constructor() { this.fs = new Map(); this.durationSec = 60 * 60; }
    on() {}
    async load() { this.loaded = true; }
    async writeFile(name, data) { this.fs.set(name, data); }
    async readFile(name) {
      if (!this.fs.has(name)) throw new Error("ENOENT " + name);
      return this.fs.get(name);
    }
    async deleteFile(name) { this.fs.delete(name); }
    async listDir() { return [...this.fs.keys()].map((n) => ({ name: n, isDir: false })); }
    async exec(args) {
      const out = args[args.length - 1];
      if (out.endsWith(".pcm")) {
        this.fs.set(out, new Uint8Array(this.durationSec * 16000 * 2));
        return 0;
      }
      if (out.includes("%")) {
        if (!codecs.includes("libmp3lame")) return 1;
        const segTime = Number(args[args.indexOf("-segment_time") + 1] || 900);
        const n = Math.ceil(this.durationSec / segTime);
        for (let i = 0; i < n; i++) {
          const name = out.replace(/%0(\d)d/, (_, w) => String(i).padStart(Number(w), "0"));
          this.fs.set(name, new Uint8Array(Math.round(segTime * 4000))); // 32kbps
        }
        return 0;
      }
      if (out.endsWith(".mp3")) {
        if (!codecs.includes("libmp3lame")) return 1;
        this.fs.set(out, new Uint8Array(Math.round(this.durationSec * 4000)));
        return 0;
      }
      return 0;
    }
    async terminate() {}
  };
}

export function fakeFile(name, sizeBytes, type = "") {
  const buf = new Uint8Array(sizeBytes);
  return new File([buf], name, { type });
}

export function fakeWavFile(name, dataBytes) {
  const header = new Uint8Array(44);
  const dv = new DataView(header.buffer);
  const put = (o, s) => { for (let i = 0; i < 4; i++) header[o + i] = s.charCodeAt(i); };
  put(0, "RIFF"); dv.setUint32(4, 36 + dataBytes, true); put(8, "WAVE");
  put(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  put(36, "data"); dv.setUint32(40, dataBytes, true);
  return new File([header, new Uint8Array(dataBytes)], name, { type: "audio/wav" });
}
