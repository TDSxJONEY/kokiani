
# Kokiani

**Kokiani** is an open-source, zero-cost, 100% local-first Chrome Manifest V3 extension and real-time audio transcription engine. It captures digital audio directly from any active browser tab—even when your system speakers are muted—and streams it over WebSockets to a local Faster-Whisper inference backend with zero cloud dependencies or API keys.

---

## Key Features

- **100% Local & Private Inference:** Powered by CTranslate2-accelerated `faster-whisper` (`INT8` quantized) running locally via Python FastAPI. No API keys, usage limits, or external audio uploads.
- **Real-Time Progressive Live Captions:** Streams 16 kHz mono `Float32` PCM chunks over WebSockets (`ws://localhost:8787/ws/stream`) with a commit + tentative sliding window engine that locks completed phrases into an accumulating transcript while refining trailing speech in real time.
- **Silent Background Capture:** Captures audio directly from Chrome's tab rendering pipeline (`chrome.tabCapture` + Offscreen Document), allowing you to mute your OS volume (`0%`) while transcribing lectures, meetings, or videos at full digital fidelity.
- **Dual-Surface Apple-Inspired UI:** Works as both a compact toolbar popup and a docked **Chrome Side Panel** (`chrome.sidePanel`) that stays open alongside active tabs.
- **Multilingual & Code-Switching Support:** Supports on-the-fly switching between **Fast (`base`)** and **Accurate (`small`)** models, **Transcribe** and **Translate → EN** modes, Silero VAD filtering, and script-guided presets (`Auto-Detect`, `Hindi Devanagari`, `Hinglish Mixed`, `English`, and `Bengali`).
- **Interactive Transcript Workspace:** Includes a live elapsed timer, word count, keyword search filter, **Paragraph** vs. **Timestamped Segment** views, local session history, clipboard copy, and `.TXT` / `.SRT` subtitle exports.

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│ Chrome Extension (Manifest V3)                                   │
│  ├─ Popup / Side Panel UI (Apple-inspired dark workspace)        │
│  ├─ Background Service Worker (session state & tabCapture)       │
│  └─ Offscreen Document (16 kHz mono PCM resampling + WebSocket)  │
└────────────────────────────────┬─────────────────────────────────┘
                                 │ ws://localhost:8787/ws/stream
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ Node.js / Express Gateway (Port 8787)                            │
│  ├─ Single-lane backpressure queue & sliding PCM buffer          │
│  ├─ Commit + tentative segment merging & force-commit guard      │
│  └─ REST fallback (/api/transcribe) & health proxy (/health)     │
└────────────────────────────────┬─────────────────────────────────┘
                                 │ http://127.0.0.1:8000/transcribe-pcm
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ Python FastAPI Local Engine (Port 8000)                          │
│  └─ Faster-Whisper (CTranslate2 INT8, Silero VAD, zero-disk NumPy)│
└──────────────────────────────────────────────────────────────────┘
```

---

## Requirements

- **Node.js** 20+
- **Python** 3.9+
- **Google Chrome** (Manifest V3 with Side Panel support)
- Multi-core CPU (tested on Intel Core i5-11320H, 16 GB RAM, Windows 11)

---

## Quick Start

### 1. Start the Local Whisper Engine (Python)

Open PowerShell:

```powershell
cd local-engine
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

*On the first run, Faster-Whisper automatically downloads the `base` model weights and caches them locally.*

### 2. Start the Node.js API & WebSocket Gateway

Open a second terminal:

```powershell
cd server
npm install
npm run dev
```

Verify that the services are healthy at:

```text
http://localhost:8787/health
```

### 3. Load the Extension in Chrome

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this repository's `extension` folder.
4. Pin **Kokiani** to your Chrome toolbar.

---

## Usage

1. Open any tab playing audio or video (YouTube, lectures, podcasts, or browser meetings).
2. Click the **Kokiani** icon in the toolbar (or click **Side Panel ↗** to dock it alongside your tab).
3. Choose your **Language** preset, **Mode** (`Transcribe` or `Translate → EN`), and **Engine** (`Fast (base)` or `Accurate (small)`).
4. Click **Start Capture** to watch live progressive captions stream in real time.
5. Click **Stop & Transcribe** to finalize the trailing segment, inspect timestamps, search text, or export as `.TXT` / `.SRT`.

---

## Privacy & Responsible Use

- All audio capture, PCM resampling, and speech-to-text inference run exclusively on your local machine (`127.0.0.1`).
- Capture begins only after an explicit user click on **Start Capture**.
- Ensure you have permission to record or transcribe audio and notify participants where required by law.

---

## Tech Stack

| Component | Technology |
|---|---|
| Browser Extension | Chrome Manifest V3, JavaScript |
| Audio Capture | `chrome.tabCapture`, Offscreen Document, Web Audio API |
| Streaming | WebSockets, PCM Float32 |
| Backend Gateway | Node.js, Express |
| Local Inference API | Python, FastAPI |
| Speech Recognition | Faster-Whisper, CTranslate2 |
| Audio Processing | NumPy, Silero VAD |
| Storage | `chrome.storage.local` |

---

## License

This project is open source. See the [LICENSE](LICENSE) file for details.
