import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import multer from "multer";
import { WebSocketServer } from "ws";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const LOCAL_ENGINE_URL = process.env.LOCAL_ENGINE_URL || "http://127.0.0.1:8000";
const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 4; // Float32 mono
const MAX_WINDOW_BYTES = BYTES_PER_SEC * 25; // Generous 25s cap so fast speech is never dropped
const COMMIT_LAG_SEC = 1.8; // Lock segments ending >1.8s behind live edge
const FORCE_COMMIT_WINDOW_SEC = 6.5; // Force-commit continuous speech if no pause occurs within 6.5s

app.use(cors({ origin: true }));

app.get("/health", async (_req, res) => {
  try {
    const engineRes = await fetch(`${LOCAL_ENGINE_URL}/health`);
    const engineData = engineRes.ok ? await engineRes.json() : null;
    res.json({
      ok: Boolean(engineData?.ok),
      service: "transcripto-api",
      localEngine: engineData || { ok: false }
    });
  } catch {
    res.status(503).json({
      ok: false,
      service: "transcripto-api",
      localEngine: { ok: false, error: "Local engine unreachable" }
    });
  }
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file was uploaded." });
    }

    const formData = new FormData();
    const audioBlob = new Blob([req.file.buffer], {
      type: req.file.mimetype || "audio/webm"
    });
    formData.append("audio", audioBlob, req.file.originalname || "browser-audio.webm");

    const optionalFields = ["language", "task", "model_size", "initial_prompt"];
    for (const field of optionalFields) {
      if (req.body?.[field]) {
        formData.append(field, String(req.body[field]));
      }
    }

    const engineResponse = await fetch(`${LOCAL_ENGINE_URL}/transcribe`, {
      method: "POST",
      body: formData
    });

    const result = await engineResponse.json();
    if (!engineResponse.ok) {
      throw new Error(result.detail || result.error || "Local transcription engine failed.");
    }

    res.json({
      text: result.text,
      language: result.language || null,
      duration: result.duration || 0,
      segments: result.segments || []
    });
  } catch (error) {
    console.error("Transcription error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Transcription failed."
    });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/stream" });

wss.on("connection", (ws) => {
  let sessionOptions = {
    language: "",
    task: "transcribe",
    model_size: "base",
    initial_prompt: ""
  };

  let uncommittedBuffer = Buffer.alloc(0);
  let bufferStartSec = 0;
  let committedSegments = [];
  let detectedLanguage = null;
  let hasNewAudio = false;
  let isProcessing = false;

  async function processWindow(isFinal = false) {
    if (uncommittedBuffer.length < SAMPLE_RATE * 0.4 * 4) {
      if (isFinal && ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            type: "final",
            text: committedSegments.map((s) => s.text).join(" "),
            segments: committedSegments,
            language: detectedLanguage
          })
        );
      }
      return;
    }

    const snapshot = Buffer.from(uncommittedBuffer);
    const snapshotStartSec = bufferStartSec;
    const snapshotDurationSec = snapshot.length / BYTES_PER_SEC;

    const formData = new FormData();
    formData.append("pcm", new Blob([snapshot], { type: "application/octet-stream" }), "window.pcm");
    if (sessionOptions.language) formData.append("language", sessionOptions.language);
    if (sessionOptions.task) formData.append("task", sessionOptions.task);
    if (sessionOptions.model_size) formData.append("model_size", sessionOptions.model_size);

    const recentContext = committedSegments
      .slice(-2)
      .map((s) => s.text)
      .join(" ");
    const combinedPrompt = [sessionOptions.initial_prompt, recentContext]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (combinedPrompt) {
      formData.append("initial_prompt", combinedPrompt);
    }

    const res = await fetch(`${LOCAL_ENGINE_URL}/transcribe-pcm`, {
      method: "POST",
      body: formData
    });

    if (!res.ok) return;
    const data = await res.json();
    if (data.language) detectedLanguage = data.language;

    const segments = Array.isArray(data.segments) ? data.segments : [];
    const tentativeParts = [];
    let advanceSec = 0;

    // If speaker talks continuously for >= 6.5s without a pause, relax commit lag to 0.6s
    const effectiveLag = snapshotDurationSec >= FORCE_COMMIT_WINDOW_SEC ? 0.6 : COMMIT_LAG_SEC;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const absStart = Number((snapshotStartSec + seg.start).toFixed(2));
      const absEnd = Number((snapshotStartSec + seg.end).toFixed(2));
      const isTrailingUnfinished =
        !isFinal &&
        i === segments.length - 1 &&
        snapshotDurationSec - seg.end < effectiveLag &&
        snapshotDurationSec < FORCE_COMMIT_WINDOW_SEC;

      if (!isTrailingUnfinished) {
        committedSegments.push({
          start: absStart,
          end: absEnd,
          text: seg.text
        });
        if (seg.end > advanceSec) {
          advanceSec = seg.end;
        }
      } else {
        tentativeParts.push(seg.text);
      }
    }

    // Trim only up to the exact audio that was actually committed
    if (advanceSec > 0) {
      const trimBytes = Math.min(
        uncommittedBuffer.length,
        Math.floor(advanceSec * SAMPLE_RATE) * 4
      );
      uncommittedBuffer = uncommittedBuffer.subarray(trimBytes);
      bufferStartSec = Number((bufferStartSec + trimBytes / BYTES_PER_SEC).toFixed(2));
    }

    const committedText = committedSegments.map((s) => s.text).join(" ");
    const tentativeText = tentativeParts.join(" ");

    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: isFinal ? "final" : "progress",
          committedText,
          tentativeText,
          text: [committedText, tentativeText].filter(Boolean).join(" "),
          segments: committedSegments,
          language: detectedLanguage
        })
      );
    }
  }

  const tickInterval = setInterval(async () => {
    if (isProcessing || !hasNewAudio) return;
    isProcessing = true;
    hasNewAudio = false;
    try {
      await processWindow(false);
    } catch (err) {
      console.error("Progressive stream tick error:", err);
    } finally {
      isProcessing = false;
    }
  }, 1600);

  ws.on("message", async (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "config") {
          sessionOptions = { ...sessionOptions, ...(msg.options || {}) };
          uncommittedBuffer = Buffer.alloc(0);
          bufferStartSec = 0;
          committedSegments = [];
          detectedLanguage = null;
        } else if (msg.type === "finalize") {
          clearInterval(tickInterval);
          while (isProcessing) {
            await new Promise((r) => setTimeout(r, 80));
          }
          isProcessing = true;
          try {
            await processWindow(true);
          } finally {
            isProcessing = false;
          }
        }
      } catch (err) {
        console.error("Control message error:", err);
      }
      return;
    }

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    uncommittedBuffer = Buffer.concat([uncommittedBuffer, chunk]);

    if (uncommittedBuffer.length > MAX_WINDOW_BYTES) {
      const overflow = uncommittedBuffer.length - MAX_WINDOW_BYTES;
      const alignedOverflow = overflow - (overflow % 4);
      uncommittedBuffer = uncommittedBuffer.subarray(alignedOverflow);
      bufferStartSec = Number((bufferStartSec + alignedOverflow / BYTES_PER_SEC).toFixed(2));
    }
    hasNewAudio = true;
  });

  ws.on("close", () => {
    clearInterval(tickInterval);
    uncommittedBuffer = Buffer.alloc(0);
  });
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`Transcripto API + Progressive WebSocket listening on http://localhost:${port}`);
  console.log(`Routing transcription to ${LOCAL_ENGINE_URL}`);
});