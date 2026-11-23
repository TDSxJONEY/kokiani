# Transcripto MVP

A Chrome Manifest V3 extension that captures audio from the current tab and sends the recording to a Node.js API for multilingual transcription.

## Current MVP scope

- User-initiated tab audio capture
- Keeps tab audio audible while capturing
- Records the full session
- Uploads WebM audio to the backend
- Uses OpenAI `gpt-transcribe` with automatic language detection
- Displays the completed transcript in the extension popup

This is the first end-to-end slice. Near-live transcription, local Faster-Whisper inference, provider switching, timestamps, and export are the next milestones.

## Requirements

- Node.js 20+
- Google Chrome
- An OpenAI API key for cloud transcription

## 1. Start the backend (PowerShell)

```powershell
cd server
Copy-Item .env.example .env
# Edit .env and add your OPENAI_API_KEY
npm install
npm run dev
```

Check `http://localhost:8787/health`.

## 2. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this project's `extension` folder.
5. Pin Transcripto to the Chrome toolbar.

## 3. Test

1. Open a video or audio page in a tab.
2. Start playing the video.
3. Click the Transcripto extension icon.
4. Click **Start capture**.
5. Let it record for at least a few seconds.
6. Open the extension popup again and click **Stop & transcribe**.
7. Wait for the transcript to appear.

## Notes and limitations

- This first slice transcribes after you stop recording; it is not yet live.
- The backend currently uses cloud transcription. Keep the API key only on the backend, never in extension files.
- The upload is capped at 25 MB in this MVP. Long recordings need chunked upload/segmented processing.
- Capture is initiated only after an explicit user action.
- `tabCapture` can interrupt normal tab audio output unless the captured stream is routed back to an audio destination; this MVP does that.
- Do not capture or upload audio unless you have the right to do so and have informed relevant participants where appropriate.

## Next milestones

1. Add segmented near-live transcription and transcript reconciliation.
2. Add a provider interface and local Faster-Whisper service.
3. Add a hybrid provider router with explicit user preference and fallback.
4. Add transcript timestamps, TXT/SRT export, and persistent session history.
5. Add React/Vite UI and automated tests.
