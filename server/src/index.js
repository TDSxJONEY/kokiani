import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const LOCAL_ENGINE_URL = process.env.LOCAL_ENGINE_URL || "http://127.0.0.1:8000";

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

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`Transcripto API listening on http://localhost:${port}`);
  console.log(`Routing transcription to ${LOCAL_ENGINE_URL}`);
});