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
let activePage = "studio"; // "studio" | "history"
let activeView = "paragraph"; // "paragraph" | "segments"
let searchQuery = "";
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
    engineOnline === null ? "Checking" : engineOnline ? "Ready" : "Offline"
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

function switchPage(page) {
  activePage = page;
  document.getElementById("nav-studio").classList.toggle("active", page === "studio");
  document.getElementById("nav-history").classList.toggle("active", page === "history");
  document.getElementById("view-studio").classList.toggle("hidden", page !== "studio");
  document.getElementById("view-history").classList.toggle("hidden", page !== "history");
}

function initShell() {
  const isSidePanel = document.body.classList.contains("is-sidepanel");
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="app-shell">
      <div class="topbar">
        <div class="brand-group">
          <div class="app-icon">T</div>
          <span class="brand-title">Transcripto</span>
          <span id="health-pill" class="health-pill"><span class="dot"></span>Checking</span>
        </div>
        <div class="nav-actions">
          ${
            !isSidePanel
              ? `<button id="dock-btn" class="ghost-btn" title="Open in Side Panel">Side Panel ↗</button>`
              : ""
          }
          <button id="reset-btn" class="ghost-btn" title="Reset stuck capture">Reset</button>
        </div>
      </div>

      <div class="segmented-control">
        <button id="nav-studio" class="seg-option active">Live Studio</button>
        <button id="nav-history" class="seg-option">Saved (<span id="history-count">0</span>)</button>
      </div>

      <!-- VIEW 1: LIVE STUDIO -->
      <div id="view-studio" class="view-panel">
        <div class="surface-card">
          <div class="transport-row">
            <button id="start-btn" class="btn btn-primary">Start Capture</button>
            <button id="stop-btn" class="btn btn-danger" disabled>Stop & Transcribe</button>
            <span id="timer" class="timer-pill">00:00</span>
          </div>

          <div class="config-row">
            <div class="param-chip">
              <label for="preset-select">Language</label>
              <select id="preset-select">
                ${Object.entries(LANGUAGE_PRESETS)
                  .map(([key, cfg]) => `<option value="${key}">${cfg.label}</option>`)
                  .join("")}
              </select>
            </div>
            <div class="param-chip">
              <label for="task-select">Mode</label>
              <select id="task-select">
                <option value="transcribe">Transcribe</option>
                <option value="translate">Translate → EN</option>
              </select>
            </div>
            <div class="param-chip">
              <label for="model-select">Engine</label>
              <select id="model-select">
                <option value="base">Fast (base)</option>
                <option value="small">Accurate (small)</option>
              </select>
            </div>
          </div>

          <div class="status-footer">
            <div class="status-left">
              <span id="rec-dot" class="rec-dot" style="display:none;"></span>
              <span id="status-text">Ready</span>
            </div>
            <span id="word-badge" class="word-count">0 words</span>
          </div>
        </div>

        <div id="error-box" class="error-box" style="display:none;"></div>

        <div class="workspace-card">
          <div class="workspace-toolbar">
            <div class="mini-segment">
              <button id="tab-paragraph" class="mini-seg-btn active">Paragraph</button>
              <button id="tab-segments" class="mini-seg-btn">Timestamps</button>
            </div>
            <input id="search-input" class="search-input" type="text" placeholder="Search…" />
          </div>

          <div id="transcript-body" class="transcript-scroll paragraph-mode">
            <span class="placeholder">Your transcript will appear here.</span>
          </div>

          <div class="export-row">
            <button id="copy-btn" class="action-chip">Copy</button>
            <button id="txt-btn" class="action-chip">Export .TXT</button>
            <button id="srt-btn" class="action-chip">Export .SRT</button>
          </div>
        </div>
      </div>

      <!-- VIEW 2: SAVED TRANSCRIPTS -->
      <div id="view-history" class="view-panel hidden">
        <div id="history-list" class="history-scroll"></div>
      </div>
    </div>
  `;

  document.getElementById("nav-studio").addEventListener("click", () => switchPage("studio"));
  document.getElementById("nav-history").addEventListener("click", () => switchPage("history"));

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
}

function renderTranscript() {
  const container = document.getElementById("transcript-body");
  const wordBadge = document.getElementById("word-badge");
  if (!container) return;

  const phase = currentState.phase || "idle";
  const text = currentState.transcript || "";
  const liveText = currentState.liveText || "";
  const segments = currentState.segments || [];

  const activeText = text || liveText;
  const wordCount = activeText.trim() ? activeText.trim().split(/\s+/).length : 0;
  if (wordBadge) wordBadge.textContent = `${wordCount} word${wordCount === 1 ? "" : "s"}`;

  if ((phase === "recording" || phase === "transcribing") && !text) {
    container.classList.add("paragraph-mode");
    if (liveText) {
      container.innerHTML = `<div style="margin-bottom:6px;"><span class="seg-time">LIVE</span></div><div>${liveText}</div>`;
    } else {
      container.innerHTML = `<span class="placeholder">Listening for speech… live subtitles will appear in ~2s.</span>`;
    }
    return;
  }

  if (!text) {
    container.classList.add("paragraph-mode");
    container.innerHTML = `<span class="placeholder">Your transcript will appear here.</span>`;
    return;
  }

  if (activeView === "segments" && segments.length > 0) {
    container.classList.remove("paragraph-mode");
    const filtered = searchQuery
      ? segments.filter((s) => s.text.toLowerCase().includes(searchQuery))
      : segments;

    if (filtered.length === 0) {
      container.innerHTML = `<span class="placeholder">No matching segments.</span>`;
      return;
    }

    container.innerHTML = filtered
      .map(
        (seg) =>
          `<div class="segment-row"><span class="seg-time">${formatSegTime(
            seg.start
          )}</span><span class="seg-text">${seg.text}</span></div>`
      )
      .join("");
    return;
  }

  container.classList.add("paragraph-mode");
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
    listEl.innerHTML = `<div class="workspace-card" style="align-items:center;justify-content:center;"><span class="placeholder">No saved transcripts yet. Record a tab to save it here.</span></div>`;
    return;
  }

  listEl.innerHTML = historyItems
    .map((item, idx) => {
      const dateStr = item.createdAt
        ? new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
      return `<div class="history-card" data-idx="${idx}"><div class="history-card-top"><span class="history-title">${
        item.tabTitle
      }</span><div class="history-badges"><span class="badge">${item.language.toUpperCase()}</span>${
        dateStr ? `<span class="badge">${dateStr}</span>` : ""
      }</div></div><div class="history-preview">${item.transcript}</div></div>`;
    })
    .join("");

  listEl.querySelectorAll(".history-card").forEach((el) => {
    el.addEventListener("click", () => {
      const item = historyItems[Number(el.dataset.idx)];
      if (!item) return;
      currentState = {
        phase: "done",
        status: `Loaded · ${item.tabTitle.slice(0, 26)}`,
        transcript: item.transcript,
        segments: item.segments || []
      };
      renderState();
      switchPage("studio");
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