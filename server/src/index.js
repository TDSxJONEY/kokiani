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
const WINDOW_SECONDS = 6;
const MAX_WINDOW_BYTES = SAMPLE_RATE * WINDOW_SECONDS * 4; // 4 bytes per Float32 sample

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
  let rollingBuffer = Buffer.alloc(0);
  let hasNewAudio = false;
  let isProcessing = false;

  const tickInterval = setInterval(async () => {
    if (isProcessing || !hasNewAudio || rollingBuffer.length < SAMPLE_RATE * 1 * 4) {
      return;
    }

    isProcessing = true;
    hasNewAudio = false;
    const snapshot = Buffer.from(rollingBuffer);

    try {
      const formData = new FormData();
      formData.append("pcm", new Blob([snapshot], { type: "application/octet-stream" }), "window.pcm");
      if (sessionOptions.language) formData.append("language", sessionOptions.language);
      if (sessionOptions.task) formData.append("task", sessionOptions.task);
      if (sessionOptions.model_size) formData.append("model_size", sessionOptions.model_size);
      if (sessionOptions.initial_prompt) {
        formData.append("initial_prompt", sessionOptions.initial_prompt);
      }

      const res = await fetch(`${LOCAL_ENGINE_URL}/transcribe-pcm`, {
        method: "POST",
        body: formData
      });
      if (res.ok && ws.readyState === ws.OPEN) {
        const data = await res.json();
        ws.send(
          JSON.stringify({
            type: "partial",
            text: data.text || "",
            language: data.language || null
          })
        );
      }
    } catch (err) {
      console.error("Live stream window error:", err);
    } finally {
      isProcessing = false;
    }
  }, 1800);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "config") {
          sessionOptions = { ...sessionOptions, ...(msg.options || {}) };
          rollingBuffer = Buffer.alloc(0);
        }
      } catch {
        // ignore malformed control message
      }
      return;
    }

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    rollingBuffer = Buffer.concat([rollingBuffer, chunk]);
    if (rollingBuffer.length > MAX_WINDOW_BYTES) {
      rollingBuffer = rollingBuffer.subarray(rollingBuffer.length - MAX_WINDOW_BYTES);
    }
    hasNewAudio = true;
  });

  ws.on("close", () => {
    clearInterval(tickInterval);
    rollingBuffer = Buffer.alloc(0);
  });
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`Transcripto API + WebSocket listening on http://localhost:${port}`);
  console.log(`Routing transcription to ${LOCAL_ENGINE_URL}`);
});