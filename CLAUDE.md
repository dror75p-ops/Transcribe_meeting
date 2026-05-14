# CLAUDE.md — DoryAngel Meeting Transcription

## Project Overview

**DoryAngel** is a single-page Hebrew RTL web app for transcribing meeting recordings via the OpenAI Whisper API. It runs entirely in the browser — no backend, no build system, no dependencies beyond a Google Fonts CDN import.

- **Repo**: `dror75p-ops/Transcribe_meeting`
- **Single source file**: `index.html` (~37KB, self-contained)
- **Language**: Hebrew (RTL), audience is internal Hebrew-speaking teams
- **External API**: OpenAI Whisper (`whisper-1` model) at `https://api.openai.com/v1/audio/transcriptions`

---

## Architecture

Everything lives in `index.html` in three sections:

| Section | Lines | Purpose |
|---|---|---|
| `<style>` | CSS custom properties + component styles | All visual styling, RTL layout |
| `<body>` | HTML markup | UI cards: API key, settings, upload, result, history |
| `<script>` | Vanilla JS | All logic — file handling, Whisper calls, export, history |

There is no framework, bundler, or package manager. To "run" the app: open `index.html` in a browser.

---

## Key JavaScript Functions

### File Handling

**`analyzeFileType(file)`** — classifies the uploaded file:
- `needsChunking`: file > 24MB (Whisper's 25MB limit)
- `needsConversion`: large file in a container format (MP4, M4A, OGG, FLAC) that cannot be byte-split safely

**Three transcription paths** (chosen in `startTranscription()`):

| Path | Trigger | Function |
|---|---|---|
| Direct | file ≤ 24MB | `transcribeSingle()` — sends file as-is, gets `verbose_json` with timestamps |
| Byte-split | large MP3/WAV/WebM | `transcribeLarge()` — splits at 20MB byte boundaries, sends chunks as `text` |
| Web Audio pipeline | large MP4/M4A/OGG/FLAC | `transcribeWithConversion()` — decodes via `AudioContext`, resamples to 16kHz mono via `OfflineAudioContext`, encodes 10-min WAV chunks via `encodeWav()` |

**`encodeWav(buffer)`** — pure-JS 16-bit PCM WAV encoder, no external library. Writes a standard RIFF/WAVE header then interleaved samples.

### Whisper Prompt Construction

**`buildPrompt()`** — combines participant names and free-text instructions into a single string sent as the `prompt` parameter to Whisper. This improves name recognition and domain-specific vocabulary accuracy.

### Persistence

All state is in `localStorage`:
- `"da_api_key"` — OpenAI API key (password-masked input, never sent to any server other than OpenAI)
- `"da_transcripts"` — JSON array of last 20 transcript objects `{ name, words, dur, text, date, ts }`

### Output Formats

- **Copy**: `navigator.clipboard.writeText()`
- **TXT**: Blob download
- **Word (.doc)**: HTML-in-DOC via `application/msword` MIME type — uses `David` / `Arial` fonts with RTL paragraph styles, includes BOM (`﻿`)

### Security

- `escHtml(s)` sanitizes all user-supplied strings before inserting into innerHTML (history item rendering, Word export). Do not add new innerHTML insertions without calling this.
- External links use `rel="noopener noreferrer"`.
- API key is stored only in the user's own `localStorage`; it is sent only to `api.openai.com`.

---

## UI / Style Conventions

- **CSS custom properties** defined in `:root` — always use these variables (`--navy`, `--cobalt`, `--border`, etc.), never hardcode hex colors.
- **RTL throughout**: `direction: rtl` on `body`, `text-align: right` on content. LTF exceptions (API key input, file name) are explicitly marked `direction: ltr`.
- **Font**: Heebo (Google Fonts) for all UI text; `David` / `Arial` only in Word export.
- **Component pattern**: `.card` wrapper → `.card-title` (uppercase label) → content. Follow this for any new sections.
- **Toasts** replace all `alert()` calls — use `showToast(msg, type)` where `type` is `""`, `"success"`, or `"error"`.

---

## Development Workflow

### Making Changes

1. Edit `index.html` directly — there is no build step.
2. Open the file in a browser to test.
3. Test all three transcription paths if touching audio handling:
   - Small file (any format, < 25MB)
   - Large MP3/WAV (> 25MB) — byte-split path
   - Large M4A/MP4 (> 25MB) — Web Audio conversion path
4. Verify RTL layout is intact after any CSS changes.

### No Linter / No Test Suite

There is no automated test runner. Manual browser testing is the verification method. For JS syntax errors, the browser console is the primary diagnostic tool.

### Git Conventions

- Branch naming follows the pattern: `claude/<description>-<ID>`
- Commit messages describe *what changed and why*, not just *what the file is*
- All commits so far were authored by Claude (`noreply@anthropic.com`)

---

## Known Constraints & Gotchas

- **Whisper 25MB limit**: The app splits files at 20MB to stay safely under the limit with metadata overhead.
- **Container formats must not be byte-split**: MP4/M4A/OGG have internal structure that makes arbitrary byte-splits produce invalid audio. The Web Audio pipeline is mandatory for these when large.
- **Web Audio memory**: `arrayBuffer = await currentFile.arrayBuffer()` loads the entire file into memory. Files over ~300MB may cause browser OOM. The error message tells users to try smaller files.
- **Word export via `.doc`**: This uses the legacy HTML-in-DOC trick, not OOXML. It works in Word and LibreOffice but is not a proper `.docx`.
- **Email via `mailto:`**: Only the first 4000 characters of the transcript are included in the mailto body (URL length limits). Long transcripts show a toast suggesting the Word file attachment.
- **History limit**: Capped at 20 entries; oldest entry is dropped when limit is exceeded.
- **Cost stat**: Estimated at $0.006/minute (Whisper pricing at time of writing). Update the divisor in `finish()` if pricing changes.

---

## File Structure

```
index.html        # Entire application — styles, markup, and script
CLAUDE.md         # This file
```
