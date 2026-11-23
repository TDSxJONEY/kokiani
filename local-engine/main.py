from contextlib import asynccontextmanager
import os
import tempfile
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL_SIZE = os.getenv("WHISPER_MODEL", "base")
CPU_THREADS = int(os.getenv("WHISPER_CPU_THREADS", "4"))

ml_models = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"Loading Faster-Whisper '{MODEL_SIZE}' (CPU, INT8, threads={CPU_THREADS})...")
    ml_models["whisper"] = WhisperModel(
        MODEL_SIZE,
        device="cpu",
        compute_type="int8",
        cpu_threads=CPU_THREADS,
    )
    print("Faster-Whisper model ready.")
    yield
    ml_models.clear()


app = FastAPI(title="Transcripto Local Engine", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "transcripto-local-engine",
        "model": MODEL_SIZE,
        "compute_type": "int8",
        "cpu_threads": CPU_THREADS,
    }


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: Optional[str] = Form(default=None),
):
    model: WhisperModel = ml_models.get("whisper")
    if model is None:
        raise HTTPException(status_code=503, detail="Whisper model is not loaded yet.")

    suffix = os.path.splitext(audio.filename or "audio.webm")[1] or ".webm"
    temp_path = None

    try:
        contents = await audio.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Empty audio file.")

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(contents)
            temp_path = tmp.name

        lang_arg = language.strip() if language and language.strip() else None

        segments_gen, info = model.transcribe(
            temp_path,
            language=lang_arg,
            beam_size=5,
            vad_filter=True,
        )

        segments = []
        text_parts = []
        for seg in segments_gen:
            cleaned = seg.text.strip()
            if cleaned:
                text_parts.append(cleaned)
                segments.append(
                    {
                        "start": round(seg.start, 2),
                        "end": round(seg.end, 2),
                        "text": cleaned,
                    }
                )

        return {
            "text": " ".join(text_parts),
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 2),
            "segments": segments,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass