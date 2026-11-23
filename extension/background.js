async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });

  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture audio from the tab selected by the user for transcription."
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.target === "background" && message.type === "SET_STATE") {
        await chrome.storage.local.set({ transcriptoState: message.state });
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
          streamId
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