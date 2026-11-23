let recorder = null;
let capturedStream = null;
let audioContext = null;
let chunks = [];

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

        capturedStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: message.streamId
            }
          },
          video: false
        });

        // tabCapture mutes the tab's normal audio output unless we route it back.
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
            await setState({ phase: "transcribing", status: "Uploading audio for transcription…" });
            const audioBlob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
            const formData = new FormData();
            formData.append("audio", audioBlob, "browser-audio.webm");

            const response = await fetch("http://localhost:8787/api/transcribe", {
              method: "POST",
              body: formData
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Transcription request failed.");

            await setState({
              phase: "done",
              status: `Transcription complete${result.language ? ` · ${result.language}` : ""}`,
              transcript: result.text || "(No speech detected.)"
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
        await setState({ phase: "recording", status: "Recording tab audio…" });
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