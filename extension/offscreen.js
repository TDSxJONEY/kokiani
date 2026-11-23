let recorder = null;
let capturedStream = null;
let audioContext = null;
let chunks = [];
let activeOptions = {};

async function setState(state) {
  await chrome.runtime.sendMessage({
    target: "background",
    type: "SET_STATE",
    state
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return;

  (async () => {
    try {
      if (message.type === "START_RECORDING") {
        if (recorder?.state === "recording") throw new Error("A capture is already running.");

        activeOptions = message.options || {};

        capturedStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: message.streamId
            }
          },
          video: false
        });

        // Keep normal tab playback audible while capturing
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(capturedStream);
        source.connect(audioContext.destination);

        chunks = [];
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        recorder = new MediaRecorder(capturedStream, { mimeType });

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        };

        recorder.onstop = async () => {
          try {
            await setState({
              phase: "transcribing",
              status: `Transcribing (${activeOptions.model_size || "base"})…`,
              tabTitle: activeOptions.tabTitle
            });

            const audioBlob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
            const formData = new FormData();
            formData.append("audio", audioBlob, "browser-audio.webm");

            if (activeOptions.language) formData.append("language", activeOptions.language);
            if (activeOptions.task) formData.append("task", activeOptions.task);
            if (activeOptions.model_size) formData.append("model_size", activeOptions.model_size);
            if (activeOptions.initial_prompt) {
              formData.append("initial_prompt", activeOptions.initial_prompt);
            }

            const response = await fetch("http://localhost:8787/api/transcribe", {
              method: "POST",
              body: formData
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Transcription request failed.");

            await setState({
              phase: "done",
              status: `Completed · ${result.language || "auto"} (${activeOptions.model_size || "base"})`,
              transcript: result.text || "(No speech detected.)",
              segments: result.segments || [],
              language: result.language || null,
              task: activeOptions.task || "transcribe",
              tabTitle: activeOptions.tabTitle
            });
          } catch (error) {
            await setState({
              phase: "error",
              status: "Transcription failed",
              error: error instanceof Error ? error.message : String(error)
            });
          } finally {
            capturedStream?.getTracks().forEach((track) => track.stop());
            capturedStream = null;
            await audioContext?.close();
            audioContext = null;
            recorder = null;
            chunks = [];
          }
        };

        recorder.start();
        await setState({
          phase: "recording",
          status: "Recording tab audio…",
          startedAt: Date.now(),
          tabTitle: activeOptions.tabTitle
        });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "STOP_RECORDING") {
        if (!recorder || recorder.state !== "recording") {
          sendResponse({ ok: false, error: "There is no active recording." });
          return;
        }
        recorder.stop();
        sendResponse({ ok: true });
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await setState({ phase: "error", status: "Capture error", error: messageText });
      sendResponse({ ok: false, error: messageText });
    }
  })();

  return true;
});