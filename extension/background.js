const OFFSCREEN_PATH = "offscreen.html";

async function hasOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Capture audio from the tab selected by the user for transcription."
    });
  }
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function saveToHistory(entry) {
  const { transcriptoHistory = [] } = await chrome.storage.local.get("transcriptoHistory");
  const updated = [entry, ...transcriptoHistory].slice(0, 8);
  await chrome.storage.local.set({ transcriptoHistory: updated });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.target === "background" && message.type === "SET_STATE") {
        await chrome.storage.local.set({ transcriptoState: message.state });
        if (message.state?.phase === "done" && message.state?.transcript) {
          await saveToHistory({
            id: Date.now(),
            createdAt: new Date().toISOString(),
            tabTitle: message.state.tabTitle || "Browser Tab",
            language: message.state.language || "auto",
            task: message.state.task || "transcribe",
            transcript: message.state.transcript,
            segments: message.state.segments || []
          });
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "START_CAPTURE") {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) throw new Error("No active browser tab found.");

        await ensureOffscreenDocument();
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        const result = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "START_RECORDING",
          streamId,
          options: {
            ...(message.options || {}),
            tabTitle: tab.title || "Browser Tab"
          }
        });
        if (!result?.ok) throw new Error(result?.error || "Offscreen capture failed.");
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "STOP_CAPTURE") {
        const result = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "STOP_RECORDING"
        });
        sendResponse(result || { ok: true });
        return;
      }

      if (message.type === "FORCE_RESET") {
        await closeOffscreenDocument();
        await chrome.storage.local.set({
          transcriptoState: {
            phase: "idle",
            status: "Ready",
            transcript: "",
            segments: [],
            error: ""
          }
        });
        sendResponse({ ok: true });
        return;
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await chrome.storage.local.set({
        transcriptoState: { phase: "error", status: "Error", error: messageText }
      });
      sendResponse({ ok: false, error: messageText });
    }
  })();

  return true;
});