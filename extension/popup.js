const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const errorEl = document.getElementById("error");

function render(state = {}) {
  statusEl.textContent = state.status || "Ready";
  transcriptEl.textContent = state.transcript || "Your transcript will appear here.";
  errorEl.textContent = state.error || "";
  const recording = state.phase === "recording";
  startButton.disabled = recording || state.phase === "transcribing";
  stopButton.disabled = !recording;
}

startButton.addEventListener("click", async () => {
  errorEl.textContent = "";
  statusEl.textContent = "Starting capture…";
  const response = await chrome.runtime.sendMessage({ type: "START_CAPTURE" });
  if (!response?.ok) {
    statusEl.textContent = "Could not start";
    errorEl.textContent = response?.error || "Unknown extension error";
  }
});

stopButton.addEventListener("click", async () => {
  errorEl.textContent = "";
  statusEl.textContent = "Stopping capture…";
  const response = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  if (!response?.ok) errorEl.textContent = response?.error || "Could not stop capture";
});

chrome.storage.local.get("transcriptoState", ({ transcriptoState }) => render(transcriptoState));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.transcriptoState) render(changes.transcriptoState.newValue);
});