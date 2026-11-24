const LANGUAGE_PRESETS = {
  auto: { label: "Auto-Detect", language: "", initial_prompt: "" },
  hi_devanagari: {
    label: "Hindi (Devanagari)",
    language: "hi",
    initial_prompt: "यह एक स्पष्ट हिंदी बातचीत है।"
  },
  hinglish: {
    label: "Hinglish (Mixed)",
    language: "hi",
    initial_prompt:
      "यह एक हिंदी और English बातचीत है, जैसे college, student, university, court, legally, video."
  },
  en: {
    label: "English",
    language: "en",
    initial_prompt: "Clear English speech with proper punctuation."
  },
  bn: {
    label: "Bengali",
    language: "bn",
    initial_prompt: "এটি একটি স্পষ্ট বাংলা কথোপকথন।"
  }
};

let currentState = {};
let historyItems = [];
let activeView = "paragraph"; // "paragraph" | "segments"
let searchQuery = "";
let historyOpen = false;
let timerInterval = null;
let engineOnline = null;

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatSegTime(seconds) {
  const mins = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secs = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatSrtTime(seconds) {
  const hrs = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const secs = String(Math.floor(seconds % 60)).padStart(2, "0");
  const ms = String(Math.round((seconds % 1) * 1000)).padStart(3, "0");
  return `${hrs}:${mins}:${secs},${ms}`;
}

function buildSrtContent(segments, fallbackText) {
  if (!segments || segments.length === 0) {
    return `1\n00:00:00,000 --> 00:00:10,000\n${fallbackText || ""}\n`;
  }
  return segments
    .map(
      (seg, idx) =>
        `${idx + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}\n`
    )
    .join("\n");
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function checkEngineHealth() {
  try {
    const res = await fetch("http://localhost:8787/health");
    const data = await res.json();
    engineOnline = Boolean(res.ok && data?.ok);
  } catch {
    engineOnline = false;
  }
  updateHealthBadge();
}

function updateHealthBadge() {
  const pill = document.getElementById("health-pill");
  if (!pill) return;
  pill.className = `health-pill ${
    engineOnline === null ? "" : engineOnline ? "online" : "offline"
  }`;
  pill.innerHTML = `<span class="dot"></span>${
    engineOnline === null ? "Checking…" : engineOnline ? "Local Ready" : "Engine Offline"
  }`;
}

function syncTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  const timerEl = document.getElementById("timer");
  if (!timerEl) return;

  if (currentState.phase === "recording" && currentState.startedAt) {
    const tick = () => {
      timerEl.textContent = formatElapsed(Date.now() - currentState.startedAt);
    };
    tick();
    timerInterval = setInterval(tick, 500);
  } else {
    timerEl.textContent = "00:00";
  }
}

function initShell() {
  const isSidePanel = document.body.classList.contains("is-sidepanel");
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="brand">
          <h1>Transcripto</h1>
          <span id="health-pill" class="health-pill"><span class="dot"></span>Checking…</span>
        </div>
        <div style="display:flex;gap:6px;">
          ${
            !isSidePanel
              ? `<button id="dock-btn" class="icon-btn" title="Open persistent Side Panel">Dock ↗</button>`
              : ""
          }
          <button id="reset-btn" class="icon-btn" title="Force reset stuck tab stream">Reset ↻</button>
        </div>
      </div>

      <div class="card">
        <div class="action-row">
          <button id="start-btn" class="btn btn-primary">Start Capture</button>
          <button id="stop-btn" class="btn btn-danger" disabled>Stop & Transcribe</button>
        </div>
        <div class="status-bar">
          <div class="status-left">
            <span id="rec-dot" class="rec-dot" style="display:none;"></span>
            <span id="status-text">Ready</span>
          </div>
          <span id="timer" class="timer">00:00</span>
        </div>
      </div>

      <div class="card">
        <div class="options-grid">
          <div class="field">
            <label for="preset-select">Language / Script</label>
            <select id="preset-select">
              ${Object.entries(LANGUAGE_PRESETS)
                .map(([key, cfg]) => `<option value="${key}">${cfg.label}</option>`)
                .join("")}
            </select>
          </div>
          <div class="field">
            <label for="task-select">Mode</label>
            <select id="task-select">
              <option value="transcribe">Transcribe</option>
              <option value="translate">Translate → EN</option>
            </select>
          </div>
          <div class="field">
            <label for="model-select">Model</label>
            <select id="model-select">
              <option value="base">Fast (base)</option>
              <option value="small">Accurate (small)</option>
            </select>
          </div>
        </div>
      </div>

      <div id="error-box" class="error-box" style="display:none;"></div>

      <div class="card">
        <div class="workspace-header">
          <div class="tabs">
            <button id="tab-paragraph" class="tab-btn active">Paragraph</button>
            <button id="tab-segments" class="tab-btn">Timestamps</button>
          </div>
          <input id="search-input" class="search-input" type="text" placeholder="Filter text…" />
        </div>
        <div id="transcript-body" class="transcript-body">
          <span class="placeholder">Your transcript will appear here.</span>
        </div>
        <div class="export-bar">
          <button id="copy-btn" class="icon-btn">Copy</button>
          <button id="txt-btn" class="icon-btn">Export .TXT</button>
          <button id="srt-btn" class="icon-btn">Export .SRT</button>
        </div>
      </div>

      <div class="card">
        <div id="history-toggle" class="history-header">
          <span>Recent Sessions (<span id="history-count">0</span>)</span>
          <span id="history-arrow">▸</span>
        </div>
        <div id="history-list" class="history-list" style="display:none;"></div>
      </div>
    </div>
  `;

  // Restore saved preferences
  chrome.storage.local.get("transcriptoPrefs", ({ transcriptoPrefs }) => {
    if (transcriptoPrefs?.preset) {
      document.getElementById("preset-select").value = transcriptoPrefs.preset;
    }
    if (transcriptoPrefs?.task) {
      document.getElementById("task-select").value = transcriptoPrefs.task;
    }
    if (transcriptoPrefs?.model) {
      document.getElementById("model-select").value = transcriptoPrefs.model;
    }
  });

  const savePrefs = () => {
    chrome.storage.local.set({
      transcriptoPrefs: {
        preset: document.getElementById("preset-select").value,
        task: document.getElementById("task-select").value,
        model: document.getElementById("model-select").value
      }
    });
  };

  document.getElementById("preset-select").addEventListener("change", savePrefs);
  document.getElementById("task-select").addEventListener("change", savePrefs);
  document.getElementById("model-select").addEventListener("change", savePrefs);

  const dockBtn = document.getElementById("dock-btn");
  if (dockBtn) {
    dockBtn.addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.windowId && chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        window.close();
      }
    });
  }

  document.getElementById("reset-btn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "FORCE_RESET" });
  });

  document.getElementById("start-btn").addEventListener("click", async () => {
    const presetKey = document.getElementById("preset-select").value;
    const preset = LANGUAGE_PRESETS[presetKey] || LANGUAGE_PRESETS.auto;
    const task = document.getElementById("task-select").value;
    const model_size = document.getElementById("model-select").value;

    document.getElementById("error-box").style.display = "none";
    document.getElementById("status-text").textContent = "Starting capture…";

    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      options: {
        language: preset.language,
        initial_prompt: preset.initial_prompt,
        task,
        model_size
      }
    });

    if (!response?.ok) {
      document.getElementById("status-text").textContent = "Could not start";
      const errBox = document.getElementById("error-box");
      errBox.textContent = response?.error || "Unknown extension error";
      errBox.style.display = "block";
    }
  });

  document.getElementById("stop-btn").addEventListener("click", async () => {
    document.getElementById("status-text").textContent = "Stopping capture…";
    const response = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    if (!response?.ok) {
      const errBox = document.getElementById("error-box");
      errBox.textContent = response?.error || "Could not stop capture";
      errBox.style.display = "block";
    }
  });

  document.getElementById("tab-paragraph").addEventListener("click", () => {
    activeView = "paragraph";
    document.getElementById("tab-paragraph").classList.add("active");
    document.getElementById("tab-segments").classList.remove("active");
    renderTranscript();
  });

  document.getElementById("tab-segments").addEventListener("click", () => {
    activeView = "segments";
    document.getElementById("tab-segments").classList.add("active");
    document.getElementById("tab-paragraph").classList.remove("active");
    renderTranscript();
  });

  document.getElementById("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderTranscript();
  });

  document.getElementById("copy-btn").addEventListener("click", async () => {
    if (!currentState.transcript) return;
    await navigator.clipboard.writeText(currentState.transcript);
    const btn = document.getElementById("copy-btn");
    btn.textContent = "Copied ✓";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });

  document.getElementById("txt-btn").addEventListener("click", () => {
    if (!currentState.transcript) return;
    downloadFile(`transcripto-${Date.now()}.txt`, currentState.transcript, "text/plain");
  });

  document.getElementById("srt-btn").addEventListener("click", () => {
    if (!currentState.transcript) return;
    const srt = buildSrtContent(currentState.segments, currentState.transcript);
    downloadFile(`transcripto-${Date.now()}.srt`, srt, "application/x-subrip");
  });

  document.getElementById("history-toggle").addEventListener("click", () => {
    historyOpen = !historyOpen;
    document.getElementById("history-list").style.display = historyOpen ? "flex" : "none";
    document.getElementById("history-arrow").textContent = historyOpen ? "▾" : "▸";
  });
}

function renderTranscript() {
  const container = document.getElementById("transcript-body");
  if (!container) return;

  const phase = currentState.phase || "idle";
  const text = currentState.transcript || "";
  const liveText = currentState.liveText || "";
  const segments = currentState.segments || [];

  if ((phase === "recording" || phase === "transcribing") && !text) {
    if (liveText) {
      container.innerHTML = `<div style="margin-bottom:6px;"><span class="seg-time">LIVE WINDOW</span></div><div>${liveText}</div>`;
    } else {
      container.innerHTML = `<span class="placeholder">Listening for speech… live subtitles will appear here in ~2s.</span>`;
    }
    return;
  }

  if (!text) {
    container.innerHTML = `<span class="placeholder">Your transcript will appear here.</span>`;
    return;
  }

  if (activeView === "segments" && segments.length > 0) {
    const filtered = searchQuery
      ? segments.filter((s) => s.text.toLowerCase().includes(searchQuery))
      : segments;

    if (filtered.length === 0) {
      container.innerHTML = `<span class="placeholder">No matching segments.</span>`;
      return;
    }

    container.innerHTML = filtered
      .map(
        (seg) => `
        <div class="segment-row">
          <span class="seg-time">${formatSegTime(seg.start)}</span>
          <span>${seg.text}</span>
        </div>`
      )
      .join("");
    return;
  }

  if (searchQuery && !text.toLowerCase().includes(searchQuery)) {
    container.innerHTML = `<span class="placeholder">No matching text found.</span>`;
    return;
  }

  container.textContent = text;
}

function renderHistory() {
  const countEl = document.getElementById("history-count");
  const listEl = document.getElementById("history-list");
  if (!countEl || !listEl) return;

  countEl.textContent = String(historyItems.length);
  if (historyItems.length === 0) {
    listEl.innerHTML = `<span class="placeholder" style="font-size:11px;">No saved sessions yet.</span>`;
    return;
  }

  listEl.innerHTML = historyItems
    .map(
      (item, idx) => `
      <div class="history-item" data-idx="${idx}">
        <div class="history-meta">
          <span>${item.tabTitle.slice(0, 32)}</span>
          <span>${item.language.toUpperCase()}</span>
        </div>
        <div class="history-snippet">${item.transcript}</div>
      </div>`
    )
    .join("");

  listEl.querySelectorAll(".history-item").forEach((el) => {
    el.addEventListener("click", () => {
      const item = historyItems[Number(el.dataset.idx)];
      if (!item) return;
      currentState = {
        phase: "done",
        status: `Loaded from history · ${item.language}`,
        transcript: item.transcript,
        segments: item.segments || []
      };
      renderState();
    });
  });
}

function renderState() {
  const phase = currentState.phase || "idle";
  const isRecording = phase === "recording";
  const isTranscribing = phase === "transcribing";

  document.getElementById("start-btn").disabled = isRecording || isTranscribing;
  document.getElementById("stop-btn").disabled = !isRecording;
  document.getElementById("rec-dot").style.display = isRecording ? "inline-block" : "none";
  document.getElementById("status-text").textContent = currentState.status || "Ready";

  const errBox = document.getElementById("error-box");
  if (currentState.error) {
    errBox.textContent = currentState.error;
    errBox.style.display = "block";
  } else {
    errBox.style.display = "none";
  }

  syncTimer();
  renderTranscript();
}

initShell();
checkEngineHealth();

chrome.storage.local.get(["transcriptoState", "transcriptoHistory"], (data) => {
  currentState = data.transcriptoState || {};
  historyItems = data.transcriptoHistory || [];
  renderState();
  renderHistory();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.transcriptoState) {
    currentState = changes.transcriptoState.newValue || {};
    renderState();
  }
  if (changes.transcriptoHistory) {
    historyItems = changes.transcriptoHistory.newValue || [];
    renderHistory();
  }
});