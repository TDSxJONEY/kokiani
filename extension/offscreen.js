let recorder = null;
let capturedStream = null;
let audioContext = null;
let processorNode = null;
let streamSocket = null;
let chunks = [];
let activeOptions = {};
let latestLiveText = "";

async function setState(state) {
  await chrome.runtime.sendMessage({
    target: "background",
    type: "SET_STATE",
    state
  });
}

function downsampleTo16k(float32Buffer, inputSampleRate) {
  if (inputSampleRate === 16000) return float32Buffer;
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(float32Buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32Buffer.length; i++) {
      accum += float32Buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function connectLiveSocket(options, startedAt) {
  try {
    streamSocket = new WebSocket("ws://localhost:8787/ws/stream");
    streamSocket.binaryType = "arraybuffer";

    streamSocket.onopen = () => {
      streamSocket.send(JSON.stringify({ type: "config", options }));
    };

    streamSocket.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "partial" && msg.text && recorder?.state === "recording") {
          latestLiveText = msg.text;
          await setState({
            phase: "recording",
            status: `Live transcribing${msg.language ? ` · ${msg.language}` : ""}…`,
            startedAt,
            tabTitle: options.tabTitle,
            liveText: latestLiveText
          });
        }
      } catch {
        // ignore parse errors
      }
    };
  } catch {
    streamSocket = null;
  }
}

function cleanupStreamResources() {
  if (processorNode) {
    try {
      processorNode.disconnect();
    } catch {}
    processorNode = null;
  }
  if (streamSocket) {
    try {
      streamSocket.close();
    } catch {}
    streamSocket = null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return;

  (async () => {
    try {
      if (message.type === "START_RECORDING") {
        if (recorder?.state === "recording") throw new Error("A capture is already running.");

        activeOptions = message.options || {};
        latestLiveText = "";
        const startedAt = Date.now();

        capturedStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: message.streamId
            }
          },
          video: false
        });

        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(capturedStream);
        // Keep normal tab playback audible
        source.connect(audioContext.destination);

        // Tap audio stream for live 16 kHz PCM frames
        connectLiveSocket(activeOptions, startedAt);
        processorNode = audioContext.createScriptProcessor(4096, 1, 1);
        processorNode.onaudioprocess = (event) => {
          if (streamSocket?.readyState === WebSocket.OPEN) {
            const inputData = event.inputBuffer.getChannelData(0);
            const pcm16k = downsampleTo16k(inputData, audioContext.sampleRate);
            streamSocket.send(pcm16k.buffer);
          }
        };
        source.connect(processorNode);
        processorNode.connect(audioContext.destination);

        chunks = [];
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        recorder = new MediaRecorder(capturedStream, { mimeType });

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        };

        recorder.onstop = async () => {
          cleanupStreamResources();
          try {
            await setState({
              phase: "transcribing",
              status: `Finalizing transcript (${activeOptions.model_size || "base"})…`,
              tabTitle: activeOptions.tabTitle,
              liveText: latestLiveText
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
              transcript: result.text || latestLiveText || "(No speech detected.)",
              segments: result.segments || [],
              language: result.language || null,
              task: activeOptions.task || "transcribe",
              tabTitle: activeOptions.tabTitle,
              liveText: ""
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
          status: "Recording & streaming live…",
          startedAt,
          tabTitle: activeOptions.tabTitle,
          liveText: ""
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
      cleanupStreamResources();
      const messageText = error instanceof Error ? error.message : String(error);
      await setState({ phase: "error", status: "Capture error", error: messageText });
      sendResponse({ ok: false, error: messageText });
    }
  })();

  return true;
});