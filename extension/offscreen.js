let recorder = null;
let capturedStream = null;
let audioContext = null;
let workletNode = null;
let streamSocket = null;
let chunks = [];
let activeOptions = {};
let latestLive = { committedText: "", tentativeText: "", segments: [], language: null };
let finalizeResolver = null;

async function setState(state) {
  await chrome.runtime.sendMessage({
    target: "background",
    type: "SET_STATE",
    state
  });
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
        if (msg.type === "progress" && recorder?.state === "recording") {
          latestLive = {
            committedText: msg.committedText || "",
            tentativeText: msg.tentativeText || "",
            segments: msg.segments || [],
            language: msg.language || null
          };
          await setState({
            phase: "recording",
            status: `Live${msg.language ? ` · ${msg.language}` : ""} (${options.model_size || "base"})`,
            startedAt,
            tabTitle: options.tabTitle,
            committedText: latestLive.committedText,
            tentativeText: latestLive.tentativeText,
            segments: latestLive.segments
          });
        } else if (msg.type === "final" && finalizeResolver) {
          const resolve = finalizeResolver;
          finalizeResolver = null;
          resolve(msg);
        }
      } catch {
        // ignore parse errors
      }
    };
  } catch {
    streamSocket = null;
  }
}

function requestSocketFinalization() {
  return new Promise((resolve) => {
    if (!streamSocket || streamSocket.readyState !== WebSocket.OPEN) {
      resolve(null);
      return;
    }
    const timeout = setTimeout(() => {
      finalizeResolver = null;
      resolve(null);
    }, 12000);

    finalizeResolver = (msg) => {
      clearTimeout(timeout);
      resolve(msg);
    };
    streamSocket.send(JSON.stringify({ type: "finalize" }));
  });
}

function cleanupStreamResources() {
  if (workletNode) {
    try {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    } catch {}
    workletNode = null;
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
        latestLive = { committedText: "", tentativeText: "", segments: [], language: null };
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
        source.connect(audioContext.destination);

        connectLiveSocket(activeOptions, startedAt);
        await audioContext.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
        workletNode = new AudioWorkletNode(audioContext, "pcm-16k-processor");
        workletNode.port.onmessage = (event) => {
          if (streamSocket?.readyState === WebSocket.OPEN && event.data) {
            streamSocket.send(event.data);
          }
        };
        source.connect(workletNode);

        chunks = [];
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        recorder = new MediaRecorder(capturedStream, { mimeType });

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        };

        recorder.onstop = async () => {
          if (workletNode) {
            try {
              workletNode.port.onmessage = null;
              workletNode.disconnect();
            } catch {}
            workletNode = null;
          }

          try {
            await setState({
              phase: "transcribing",
              status: "Finalizing tail segment…",
              tabTitle: activeOptions.tabTitle,
              committedText: latestLive.committedText,
              tentativeText: latestLive.tentativeText,
              segments: latestLive.segments
            });

            // Fast path: finalize the remaining ~2s tail via WebSocket
            const wsFinal = await requestSocketFinalization();
            if (wsFinal && (wsFinal.text || latestLive.committedText)) {
              const finalText = wsFinal.text || latestLive.committedText;
              await setState({
                phase: "done",
                status: `Completed · ${wsFinal.language || latestLive.language || "auto"} (${
                  activeOptions.model_size || "base"
                })`,
                transcript: finalText,
                segments: wsFinal.segments || latestLive.segments || [],
                language: wsFinal.language || latestLive.language || null,
                task: activeOptions.task || "transcribe",
                tabTitle: activeOptions.tabTitle,
                committedText: "",
                tentativeText: ""
              });
              return;
            }

            // Fallback path if WebSocket was unavailable
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
              tabTitle: activeOptions.tabTitle,
              committedText: "",
              tentativeText: ""
            });
          } catch (error) {
            await setState({
              phase: "error",
              status: "Transcription failed",
              error: error instanceof Error ? error.message : String(error)
            });
          } finally {
            cleanupStreamResources();
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
          committedText: "",
          tentativeText: "",
          segments: []
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