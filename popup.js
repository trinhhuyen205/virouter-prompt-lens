const fields = ["baseUrl", "apiKey", "model", "imageModel", "imageSize", "imageQuality", "autoGenerateImage", "enhancementMode", "language", "detailLevel", "saveHistory"];
const statusEl = document.getElementById("status");
const historyEl = document.getElementById("history");

init();

async function init() {
  await loadSettings();
  await renderHistory();
  document.getElementById("saveSettings")?.addEventListener("click", saveSettings);
  document.getElementById("openPanel")?.addEventListener("click", openPanel);
  document.getElementById("captureTab")?.addEventListener("click", captureTab);
  document.getElementById("clearHistory")?.addEventListener("click", clearHistory);
  document.getElementById("imageInput")?.addEventListener("change", analyzeUpload);
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function loadSettings() {
  const response = await send({ type: "VPL_GET_SETTINGS" });
  const settings = response?.data || {};
  for (const id of fields) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = settings[id] !== false;
    else el.value = settings[id] || "";
  }
}

async function saveSettings() {
  const payload = {};
  for (const id of fields) {
    const el = document.getElementById(id);
    if (!el) continue;
    payload[id] = el.type === "checkbox" ? el.checked : el.value;
  }
  const response = await send({ type: "VPL_SAVE_SETTINGS", payload });
  if (!response?.ok) return setStatus(response?.error || "Save failed.", true);
  setStatus("Settings saved.");
}

async function openPanel() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "VPL_OPEN_PANEL" }).catch(async () => {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "VPL_OPEN_PANEL" });
  });
  window.close();
}

async function captureTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "VPL_OPEN_PANEL" }).catch(async () => {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  });
  await send({ type: "VPL_CAPTURE_VISIBLE_TAB", payload: { tabId: tab.id, windowId: tab.windowId } });
  window.close();
}

async function analyzeUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setStatus("Analyzing upload...");
  const dataUrl = await fileToDataUrl(file);
  const response = await send({ type: "VPL_ANALYZE", payload: { dataUrl, pageUrl: "popup-upload" } });
  if (!response?.ok) return setStatus(response?.error || "Analysis failed.", true);
  setStatus("Analysis saved to history.");
  await renderHistory();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
}

async function renderHistory() {
  if (!historyEl) return;
  const response = await send({ type: "VPL_GET_HISTORY" });
  const items = Array.isArray(response?.data) ? response.data : [];
  if (!items.length) {
    historyEl.innerHTML = '<p class="muted">No history yet.</p>';
    return;
  }
  historyEl.innerHTML = items.map(item => `
    <article class="history-item">
      ${item.imageSrc ? `<img src="${escapeHtml(item.imageSrc)}" alt="">` : ""}
      <div><strong>${escapeHtml(item.analysis?.summary || "Prompt result")}</strong><span>${new Date(item.createdAt).toLocaleString()}</span></div>
    </article>
  `).join("");
}

async function clearHistory() {
  await send({ type: "VPL_CLEAR_HISTORY" });
  await renderHistory();
  setStatus("History cleared.");
}

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = `status ${isError ? "error" : ""}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}
