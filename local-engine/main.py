from contextlib import asynccontextmanager
import os
import tempfile
from typing import Dict, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel
import numpy as np

DEFAULT_MODEL = os.getenv("WHISPER_MODEL", "base")
CPU_THREADS = int(os.getenv("WHISPER_CPU_THREADS", "4"))
ALLOWED_MODELS = {"base", "small"}

ml_models: Dict[str, WhisperModel] = {}


def get_or_load_model(model_name: str) -> WhisperModel:
    target = model_name if model_name in ALLOWED_MODELS else DEFAULT_MODEL
    if target not in ml_models:
        print(f"Loading Faster-Whisper '{target}' (CPU, INT8, threads={CPU_THREADS})...")
        ml_models[target] = WhisperModel(
            target,
            device="cpu",
            compute_type="int8",
            cpu_threads=CPU_THREADS,
        )
        print(f"Faster-Whisper '{target}' ready.")
    return ml_models[target]


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_or_load_model(DEFAULT_MODEL)
    yield
    ml_models.clear()


app = FastAPI(title="Kokiani Local Engine", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "kokiani-local-engine",
        "loaded_models": list(ml_models.keys()),
        "compute_type": "int8",
        "cpu_threads": CPU_THREADS,
    }


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: Optional[str] = Form(default=None),
    task: Optional[str] = Form(default="transcribe"),
    model_size: Optional[str] = Form(default="base"),
    initial_prompt: Optional[str] = Form(default=None),
):
    suffix = os.path.splitext(audio.filename or "audio.webm")[1] or ".webm"
    temp_path = None

    try:
        contents = await audio.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Empty audio file.")

        model = get_or_load_model((model_size or DEFAULT_MODEL).strip().lower())

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(contents)
            temp_path = tmp.name

        lang_arg = language.strip() if language and language.strip() else None
        task_arg = "translate" if (task and task.strip().lower() == "translate") else "transcribe"
        prompt_arg = initial_prompt.strip() if initial_prompt and initial_prompt.strip() else None

        segments_gen, info = model.transcribe(
            temp_path,
            language=lang_arg,
            task=task_arg,
            initial_prompt=prompt_arg,
            beam_size=5,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
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


@app.post("/transcribe-pcm")
async def transcribe_pcm(
    pcm: UploadFile = File(...),
    language: Optional[str] = Form(default=None),
    task: Optional[str] = Form(default="transcribe"),
    model_size: Optional[str] = Form(default="base"),
    initial_prompt: Optional[str] = Form(default=None),
):
    try:
        raw_bytes = await pcm.read()
        if not raw_bytes:
            return {"text": "", "language": None, "segments": []}

        aligned_len = len(raw_bytes) - (len(raw_bytes) % 4)
        if aligned_len == 0:
            return {"text": "", "language": None, "segments": []}

        audio_np = np.frombuffer(raw_bytes[:aligned_len], dtype=np.float32).copy()

        model = get_or_load_model((model_size or DEFAULT_MODEL).strip().lower())
        lang_arg = language.strip() if language and language.strip() else None
        task_arg = "translate" if (task and task.strip().lower() == "translate") else "transcribe"
        prompt_arg = initial_prompt.strip() if initial_prompt and initial_prompt.strip() else None

        segments_gen, info = model.transcribe(
            audio_np,
            language=lang_arg,
            task=task_arg,
            initial_prompt=prompt_arg,
            beam_size=2,
            condition_on_previous_text=False,
            no_speech_threshold=0.65,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
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
            "segments": segments,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc