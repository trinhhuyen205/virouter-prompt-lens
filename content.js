(() => {
  if (window.__virouterPromptLensLoaded) return;
  window.__virouterPromptLensLoaded = true;

  const tabs = ["prompt", "analysis", "midjourney", "sdxl", "flux", "json"];
  let root = null;
  let hoverButton = null;
  let selectionOverlay = null;
  let lastCaptureDataUrl = "";
  let hoverRepositionQueued = false;
  let progressTimer = null;
  const PANEL_BOX_KEY = "virouterPromptLensPanelBox";
  const PANEL_VISIBLE_KEY = "virouterPromptLensPanelVisible";
  let panelBox = { left: null, top: null, width: 440, height: null };
  let panelBoxLoaded = false;
  let dragActive = false;
  let state = {
    visible: false,
    mode: "idle",
    activeTab: "prompt",
    targetImage: null,
    result: null,
    history: [],
    settings: null,
    error: "",
    generatedImage: null,
    generationLoading: false,
    generationError: "",
    progress: 0,
    copied: false,
    collapsed: false
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "VPL_OPEN_PANEL") {
      void openPanel();
      sendResponse?.({ ok: true });
      return false;
    }
    if (message?.type === "VPL_ANALYZE_IMAGE") {
      void openPanel().then(() => analyze({ src: message.payload?.src, pageUrl: message.payload?.pageUrl || location.href }));
      sendResponse?.({ ok: true });
      return false;
    }
    if (message?.type === "VPL_CAPTURED_VISIBLE_TAB") {
      lastCaptureDataUrl = message.payload?.dataUrl || "";
      if (message.payload?.analyze === false) beginCropSelection(lastCaptureDataUrl);
      else void openPanel().then(() => analyze({ dataUrl: lastCaptureDataUrl, pageUrl: location.href }));
      sendResponse?.({ ok: true });
      return false;
    }
    return false;
  });

  document.addEventListener("contextmenu", (event) => {
    const image = imageFromEvent(event);
    if (image) state.targetImage = image;
  }, true);

  document.addEventListener("pointermove", (event) => {
    const image = imageFromEvent(event);
    if (!image || !image.src || image.getBoundingClientRect().width < 90 || image.getBoundingClientRect().height < 90) return;
    state.targetImage = image;
    showHoverButton(image);
  }, true);

  window.addEventListener("scroll", scheduleHoverReposition, true);
  window.addEventListener("resize", scheduleHoverReposition);

  function imageFromEvent(event) {
    return event.target instanceof Element ? event.target.closest("img") : null;
  }

  async function openPanel() {
    state.visible = true;
    try { sessionStorage.setItem(PANEL_VISIBLE_KEY, "1"); } catch {}
    await loadPanelBox();
    state.settings = await getSettings();
    state.history = await getHistory();
    if (!state.settings?.apiKey) state.mode = "setup";
    else if (state.mode === "setup") state.mode = "idle";
    render();
  }

  async function loadPanelBox() {
    if (panelBoxLoaded) return;
    try {
      const stored = await chrome.storage.local.get(PANEL_BOX_KEY);
      const saved = stored?.[PANEL_BOX_KEY];
      if (saved && typeof saved === "object") {
        panelBox = {
          left: typeof saved.left === "number" ? saved.left : null,
          top: typeof saved.top === "number" ? saved.top : null,
          width: typeof saved.width === "number" ? saved.width : 440,
          height: typeof saved.height === "number" ? saved.height : null
        };
      }
    } catch {}
    panelBoxLoaded = true;
  }

  function persistPanelBox() {
    try { chrome.storage.local.set({ [PANEL_BOX_KEY]: panelBox }); } catch {}
  }

  function ensureRoot() {
    if (root) return root;
    root = document.createElement("div");
    root.id = "virouter-prompt-lens-root";
    document.documentElement.appendChild(root);
    root.addEventListener("click", handleRootClick);
    root.addEventListener("input", handleRootInput);
    return root;
  }

  function showHoverButton(image) {
    if (!hoverButton) {
      hoverButton = document.createElement("button");
      hoverButton.id = "virouter-prompt-lens-hover";
      hoverButton.type = "button";
      hoverButton.innerHTML = '<span>✦</span> Prompt';
      hoverButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const target = state.targetImage;
        if (target?.src) void openPanel().then(() => analyze({ src: target.currentSrc || target.src, pageUrl: location.href }));
      });
      document.documentElement.appendChild(hoverButton);
    }
    state.targetImage = image;
    repositionHoverButton();
    hoverButton.style.display = "inline-flex";
  }

  function scheduleHoverReposition() {
    if (!hoverButton || hoverButton.style.display === "none" || !state.targetImage) return;
    if (hoverRepositionQueued) return;
    hoverRepositionQueued = true;
    requestAnimationFrame(() => {
      hoverRepositionQueued = false;
      repositionHoverButton();
    });
  }

  function repositionHoverButton() {
    const image = state.targetImage;
    if (!hoverButton || !image?.isConnected) return;
    const rect = image.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
      hoverButton.style.display = "none";
      return;
    }
    hoverButton.style.left = `${Math.max(10, Math.min(window.innerWidth - 112, rect.right - 98))}px`;
    hoverButton.style.top = `${Math.max(10, Math.min(window.innerHeight - 44, rect.top + 10))}px`;
  }

  async function getSettings() {
    const response = await chrome.runtime.sendMessage({ type: "VPL_GET_SETTINGS" });
    return response?.data || null;
  }

  async function getHistory() {
    const response = await chrome.runtime.sendMessage({ type: "VPL_GET_HISTORY" });
    return Array.isArray(response?.data) ? response.data : [];
  }

  async function analyze(payload) {
    state.settings = await getSettings();
    if (!state.settings?.apiKey) {
      state.visible = true;
      state.mode = "setup";
      render();
      return;
    }
    state.visible = true;
    state.mode = "loading";
    state.error = "";
    state.result = null;
    state.progress = 0;
    startFakeProgress();
    render();
    const response = await chrome.runtime.sendMessage({ type: "VPL_ANALYZE", payload });
    if (!response?.ok) {
      stopFakeProgress();
      state.mode = "error";
      state.error = response?.error || "Analysis failed.";
      state.progress = 0;
      render();
      return;
    }
    stopFakeProgress();
    state.progress = 100;
    render();
    await wait(200);
    state.result = response.data;
    state.generatedImage = null;
    state.generationError = "";
    state.generationLoading = false;
    state.history = await getHistory();
    state.mode = "result";
    state.activeTab = "prompt";
    state.progress = 0;
    render();
    if (state.settings?.autoGenerateImage === true) {
      void generateImage();
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function startFakeProgress() {
    stopFakeProgress();
    state.progress = 0;
    progressTimer = setInterval(() => {
      const current = state.progress;
      if (current < 50) state.progress = Math.min(50, current + 8 + Math.floor(Math.random() * 7));
      else if (current < 90) state.progress = Math.min(90, current + 1 + Math.floor(Math.random() * 4));
      render();
    }, 260);
  }

  function stopFakeProgress() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
  }

  function handleRootInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (!state.settings) state.settings = {};
    const key = target.getAttribute("data-setting");
    if (!key) return;
    state.settings[key] = target.type === "checkbox" ? target.checked : target.value;
  }

  function handleRootClick(event) {
    const target = event.target instanceof Element ? event.target.closest("[data-action],[data-tab],[data-history-id]") : null;
    if (!target) return;
    event.preventDefault();
    const tab = target.getAttribute("data-tab");
    if (tab) {
      state.activeTab = tab;
      render();
      return;
    }
    const historyId = target.getAttribute("data-history-id");
    if (historyId) {
      const item = state.history.find((entry) => entry.id === historyId);
      if (item) {
        state.result = item;
        state.mode = "result";
        state.activeTab = "prompt";
        render();
      }
      return;
    }
    const action = target.getAttribute("data-action");
    if (action === "close") closePanel();
    if (action === "collapse") toggleCollapse();
    if (action === "settings") chrome.runtime.openOptionsPage();
    if (action === "save-settings") void saveInlineSettings();
    if (action === "analyze-hover") analyzeHoveredImage();
    if (action === "capture-area") void requestCaptureForCrop();
    if (action === "capture-tab") void requestCaptureForAnalyze();
    if (action === "copy") void copyPrompt();
    if (action === "generate-image") void generateImage();
    if (action === "copy-image-prompt") void copyImagePrompt();
    if (action === "video-coming-soon") showVideoStub();
    if (action === "clear-history") void clearHistory();
    if (action === "retry") analyzeHoveredImage();
  }

  function closePanel() {
    stopFakeProgress();
    state.visible = false;
    try { sessionStorage.removeItem(PANEL_VISIBLE_KEY); } catch {}
    render();
  }

  function restorePanelIfNeeded() {
    if (state.visible) return;
    let wasOpen = false;
    try { wasOpen = sessionStorage.getItem(PANEL_VISIBLE_KEY) === "1"; } catch {}
    if (wasOpen) void openPanel();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") restorePanelIfNeeded();
  });
  window.addEventListener("pageshow", restorePanelIfNeeded);
  window.addEventListener("focus", restorePanelIfNeeded);
  window.addEventListener("resize", () => {
    if (!state.visible) return;
    const card = root?.querySelector(".vpl-card");
    if (card) applyPanelBox(card);
  });
  restorePanelIfNeeded();

  async function saveInlineSettings() {
    const response = await chrome.runtime.sendMessage({ type: "VPL_SAVE_SETTINGS", payload: state.settings || {} });
    state.settings = response?.data || await getSettings();
    state.mode = state.settings?.apiKey ? "idle" : "setup";
    render();
  }

  function analyzeHoveredImage() {
    const image = state.targetImage;
    if (!image?.src) {
      state.mode = "error";
      state.error = "Hover an image first, then click Analyze.";
      render();
      return;
    }
    void analyze({ src: image.currentSrc || image.src, pageUrl: location.href });
  }

  async function requestCaptureForAnalyze() {
    await chrome.runtime.sendMessage({ type: "VPL_CAPTURE_VISIBLE_TAB", payload: { analyze: true } });
  }

  async function requestCaptureForCrop() {
    await chrome.runtime.sendMessage({ type: "VPL_CAPTURE_VISIBLE_TAB", payload: { analyze: false } });
  }

  function beginCropSelection(dataUrl) {
    if (!dataUrl) return;
    if (selectionOverlay) selectionOverlay.remove();
    selectionOverlay = document.createElement("div");
    selectionOverlay.id = "virouter-prompt-lens-crop";
    selectionOverlay.innerHTML = '<div class="vpl-crop-help">Drag to select an area · Esc to cancel</div><div class="vpl-crop-box"></div>';
    document.documentElement.appendChild(selectionOverlay);
    const box = selectionOverlay.querySelector(".vpl-crop-box");
    let startX = 0;
    let startY = 0;
    let active = false;
    const cleanup = () => {
      selectionOverlay?.remove();
      selectionOverlay = null;
      document.removeEventListener("keydown", keyHandler, true);
    };
    const keyHandler = (event) => {
      if (event.key === "Escape") cleanup();
    };
    document.addEventListener("keydown", keyHandler, true);
    selectionOverlay.addEventListener("pointerdown", (event) => {
      active = true;
      startX = event.clientX;
      startY = event.clientY;
      updateBox(box, startX, startY, startX, startY);
      selectionOverlay.setPointerCapture(event.pointerId);
    });
    selectionOverlay.addEventListener("pointermove", (event) => {
      if (!active) return;
      updateBox(box, startX, startY, event.clientX, event.clientY);
    });
    selectionOverlay.addEventListener("pointerup", async (event) => {
      if (!active) return;
      active = false;
      const rect = normalizedRect(startX, startY, event.clientX, event.clientY);
      cleanup();
      if (rect.width < 20 || rect.height < 20) return;
      const cropped = await cropDataUrl(dataUrl, rect);
      await openPanel();
      await analyze({ dataUrl: cropped, pageUrl: location.href });
    });
  }

  function updateBox(box, x1, y1, x2, y2) {
    const rect = normalizedRect(x1, y1, x2, y2);
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  function normalizedRect(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    return { left, top, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  }

  async function cropDataUrl(dataUrl, rect) {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const scaleX = image.naturalWidth / window.innerWidth;
    const scaleY = image.naturalHeight / window.innerHeight;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.width * scaleX);
    canvas.height = Math.round(rect.height * scaleY);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, Math.round(rect.left * scaleX), Math.round(rect.top * scaleY), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.92);
  }

  async function copyPrompt() {
    const text = currentText();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    state.copied = true;
    render();
    setTimeout(() => {
      state.copied = false;
      render();
    }, 1400);
  }

  async function copyImagePrompt() {
    const prompt = state.generatedImage?.prompt;
    if (!prompt) return;
    await navigator.clipboard.writeText(prompt);
  }

  async function generateImage() {
    const prompt = state.result?.promptDrafts?.general || currentText();
    if (!prompt) return;
    state.generationLoading = true;
    state.generationError = "";
    state.generatedImage = null;
    render();
    const response = await chrome.runtime.sendMessage({ type: "VPL_GENERATE_IMAGE", payload: { prompt } });
    state.generationLoading = false;
    if (!response?.ok) {
      state.generationError = response?.error || "Image generation failed.";
      render();
      return;
    }
    state.generatedImage = response.data;
    render();
  }

  function showVideoStub() {
    state.generationError = "Video generation is not configured yet. Add a Virouter video endpoint/model first, then this button can call it from the prompt.";
    render();
  }

  async function clearHistory() {
    await chrome.runtime.sendMessage({ type: "VPL_CLEAR_HISTORY" });
    state.history = [];
    render();
  }

  function currentText() {
    const result = state.result;
    if (!result) return "";
    if (state.activeTab === "json") return JSON.stringify(result.analysis || {}, null, 2);
    if (state.activeTab === "analysis") return formatAnalysis(result.analysis);
    if (state.activeTab === "prompt") return result.promptDrafts?.general || result.analysis?.summary || "";
    return result.promptDrafts?.[state.activeTab] || result.promptDrafts?.general || "";
  }

  function formatAnalysis(analysis) {
    if (!analysis) return "";
    return [
      ["Summary", analysis.summary],
      ["Subject", analysis.subject],
      ["Composition", analysis.composition],
      ["Lighting", analysis.lighting],
      ["Colors", Array.isArray(analysis.colors) ? analysis.colors.join(", ") : ""],
      ["Style", Array.isArray(analysis.styleTags) ? analysis.styleTags.join(", ") : ""],
      ["Camera", analysis.camera],
      ["Mood", analysis.mood],
      ["Materials", Array.isArray(analysis.materials) ? analysis.materials.join(", ") : ""],
      ["Negative", analysis.negativePrompt]
    ].filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join("\n");
  }

  function render() {
    const host = ensureRoot();
    if (!state.visible) {
      host.innerHTML = "";
      return;
    }
    const collapsed = state.collapsed ? " vpl-collapsed" : "";
    host.innerHTML = `
      <section class="vpl-card vpl-${state.mode}${collapsed}" role="dialog" aria-label="Virouter Prompt Lens">
        ${renderHeader()}
        ${state.collapsed ? "" : `
        ${state.mode === "setup" ? renderSetup() : ""}
        ${state.mode === "idle" ? renderIdle() : ""}
        ${state.mode === "loading" ? renderLoading() : ""}
        ${state.mode === "error" ? renderError() : ""}
        ${state.mode === "result" ? renderResult() : ""}
        ${renderHistory()}
        <div class="vpl-resize-handle" data-resize="1" title="Drag to resize"></div>`}
      </section>`;
    setupPanelInteractions(host);
  }

  function setupPanelInteractions(host) {
    const card = host.querySelector(".vpl-card");
    if (!card) return;
    applyPanelBox(card);
    const header = card.querySelector(".vpl-card-header");
    if (header) header.addEventListener("pointerdown", startDrag);
    const handle = card.querySelector(".vpl-resize-handle");
    if (handle) handle.addEventListener("pointerdown", startResize);
  }

  function applyPanelBox(card) {
    const margin = 12;
    const maxW = Math.max(280, window.innerWidth - margin * 2);
    const width = Math.min(panelBox.width || 440, maxW);
    card.style.width = `${width}px`;
    if (typeof panelBox.height === "number" && !state.collapsed) {
      const maxH = Math.max(200, window.innerHeight - margin * 2);
      card.style.height = `${Math.min(panelBox.height, maxH)}px`;
    } else {
      card.style.height = "";
    }
    if (typeof panelBox.left === "number" && typeof panelBox.top === "number") {
      const left = Math.max(margin - width + 80, Math.min(panelBox.left, window.innerWidth - 80));
      const top = Math.max(0, Math.min(panelBox.top, window.innerHeight - 48));
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      card.style.right = "auto";
    }
  }

  function startDrag(event) {
    if (event.target instanceof Element && event.target.closest(".vpl-close,.vpl-collapse")) return;
    const card = root?.querySelector(".vpl-card");
    if (!card) return;
    event.preventDefault();
    const rect = card.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    dragActive = true;
    card.classList.add("vpl-dragging");
    const move = (e) => {
      if (!dragActive) return;
      const left = Math.max(-rect.width + 80, Math.min(e.clientX - offsetX, window.innerWidth - 80));
      const top = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - 48));
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      card.style.right = "auto";
      panelBox.left = left;
      panelBox.top = top;
    };
    const up = () => {
      dragActive = false;
      card.classList.remove("vpl-dragging");
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      persistPanelBox();
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
  }

  function startResize(event) {
    const card = root?.querySelector(".vpl-card");
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = card.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startW = rect.width;
    const startH = rect.height;
    card.classList.add("vpl-resizing");
    const move = (e) => {
      const width = Math.max(320, Math.min(startW + (e.clientX - startX), window.innerWidth - 24));
      const height = Math.max(260, Math.min(startH + (e.clientY - startY), window.innerHeight - 24));
      card.style.width = `${width}px`;
      card.style.height = `${height}px`;
      panelBox.width = width;
      panelBox.height = height;
    };
    const up = () => {
      card.classList.remove("vpl-resizing");
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      persistPanelBox();
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
  }

  function toggleCollapse() {
    state.collapsed = !state.collapsed;
    render();
  }

  function renderHeader() {
    return `<header class="vpl-card-header"><div class="vpl-mark">V</div><div><div class="vpl-eyebrow">Virouter</div><h2>Prompt Lens</h2></div><button class="vpl-collapse" data-action="collapse" title="${state.collapsed ? "Expand" : "Collapse"}">${state.collapsed ? "▢" : "—"}</button><button class="vpl-close" data-action="close">×</button></header>`;
  }

  function renderSetup() {
    const settings = state.settings || {};
    return `<div class="vpl-section"><div class="vpl-setup-icon">✦</div><h3>Connect your Virouter API</h3><p>Base URL is prefilled for Virouter OpenAI-compatible API. Paste your API key to start analyzing images.</p><label>Base URL<input data-setting="baseUrl" value="${escapeAttr(settings.baseUrl || "https://api.virouter.com/v1")}"></label><label>API Key<input data-setting="apiKey" type="password" placeholder="vr_sk_..." value="${escapeAttr(settings.apiKey || "")}"></label><label>Prompt analysis model<input data-setting="model" value="${escapeAttr(settings.model || "gpt-5.4-mini")}"></label><label>Image generation model<input data-setting="imageModel" value="${escapeAttr(settings.imageModel || "gpt-image-2")}"></label><div class="vpl-inline"><label>Image size<select data-setting="imageSize"><option value="1024x1024" ${settings.imageSize !== "1024x1536" && settings.imageSize !== "1536x1024" ? "selected" : ""}>1024×1024</option><option value="1024x1536" ${settings.imageSize === "1024x1536" ? "selected" : ""}>1024×1536</option><option value="1536x1024" ${settings.imageSize === "1536x1024" ? "selected" : ""}>1536×1024</option></select></label><label>Image quality<select data-setting="imageQuality"><option value="low" ${settings.imageQuality === "low" ? "selected" : ""}>Low</option><option value="medium" ${settings.imageQuality !== "low" && settings.imageQuality !== "high" ? "selected" : ""}>Medium</option><option value="high" ${settings.imageQuality === "high" ? "selected" : ""}>High</option></select></label></div><div class="vpl-inline"><label>Language<select data-setting="language"><option value="en" ${settings.language === "en" ? "selected" : ""}>English</option><option value="vi" ${settings.language === "vi" ? "selected" : ""}>Vietnamese</option><option value="ja" ${settings.language === "ja" ? "selected" : ""}>Japanese</option></select></label><label>Detail<select data-setting="detailLevel"><option value="fast" ${settings.detailLevel === "fast" ? "selected" : ""}>Fast</option><option value="balanced" ${settings.detailLevel !== "fast" && settings.detailLevel !== "deep" ? "selected" : ""}>Balanced</option><option value="deep" ${settings.detailLevel === "deep" ? "selected" : ""}>Deep</option></select></label></div><label class="vpl-check"><input data-setting="autoGenerateImage" type="checkbox" ${settings.autoGenerateImage === true ? "checked" : ""}> Auto-generate image after prompt</label><button class="vpl-primary" data-action="save-settings">Save and Start</button></div>`;
  }

  function renderIdle() {
    return `<div class="vpl-section"><h3>Choose an image</h3><p>Hover any image and click Prompt, right-click an image, or capture an area of the page.</p><div class="vpl-action-grid"><button data-action="analyze-hover">Analyze hovered image</button><button data-action="capture-area">Capture area</button><button data-action="capture-tab">Analyze visible tab</button><button data-action="settings">Settings</button></div></div>`;
  }

  function renderLoading() {
    const progress = Math.max(0, Math.min(100, Math.round(state.progress || 0)));
    return `<div class="vpl-section vpl-loading-wrap"><div class="vpl-spinner"></div><h3>Analyzing visual details…</h3><p>Reading subject, composition, lighting, colors, style, and prompt structure.</p><div class="vpl-progress"><div class="vpl-progress-meta"><span>AI vision processing</span><strong>${progress}%</strong></div><div class="vpl-progress-track"><div style="width:${progress}%"></div></div></div><div class="vpl-skeleton"></div><div class="vpl-skeleton short"></div></div>`;
  }

  function renderError() {
    return `<div class="vpl-section vpl-error-box"><h3>Analysis failed</h3><p>${escapeHtml(state.error)}</p><div class="vpl-action-grid"><button data-action="retry">Retry hovered image</button><button data-action="settings">Settings</button></div></div>`;
  }

  function renderResult() {
    const result = state.result;
    const text = currentText();
    return `<div class="vpl-result"><div class="vpl-preview-row">${result.imageSrc ? `<img src="${escapeAttr(result.imageSrc)}" alt="Analyzed image">` : ""}<div><h3>${escapeHtml(result.analysis?.summary || "Prompt ready")}</h3><p>${escapeHtml(result.model || "Virouter model")} · ${new Date(result.createdAt).toLocaleTimeString()}</p></div></div><div class="vpl-tabs">${tabs.map((tab) => `<button class="${state.activeTab === tab ? "active" : ""}" data-tab="${tab}">${tab}</button>`).join("")}</div><textarea readonly>${escapeHtml(text)}</textarea><div class="vpl-result-actions"><button class="vpl-primary" data-action="copy">${state.copied ? "Copied" : "Copy prompt"}</button><button data-action="capture-area">Capture another</button></div>${renderCreationTools()}</div>`;
  }

  function renderCreationTools() {
    const image = state.generatedImage;
    return `<div class="vpl-tools"><div class="vpl-tools-head"><div><strong>Create from prompt</strong><span>API Endpoint: /v1/images/generations · Model: gpt-image-2</span></div></div><div class="vpl-tool-buttons"><button class="vpl-primary" data-action="generate-image">${state.generationLoading ? "Generating…" : "Create image"}</button><button data-action="video-coming-soon">Create video</button></div>${state.generationError ? `<div class="vpl-tool-error">${escapeHtml(state.generationError)}</div>` : ""}${image ? `<div class="vpl-generated"><img src="${escapeAttr(image.imageUrl)}" alt="Generated image"><div><strong>${escapeHtml(image.model || "gpt-image-2")}</strong><span>${escapeHtml(image.endpoint || "/v1/images/generations")}</span><button data-action="copy-image-prompt">Copy image prompt</button></div></div>` : ""}</div>`;
  }

  function renderHistory() {
    if (!state.history.length) return "";
    return `<aside class="vpl-history"><div class="vpl-history-head"><span>History</span><button data-action="clear-history">Clear</button></div><div class="vpl-history-list">${state.history.slice(0, 12).map((item) => `<button data-history-id="${escapeAttr(item.id)}" class="${state.result?.id === item.id ? "active" : ""}">${item.imageSrc ? `<img src="${escapeAttr(item.imageSrc)}" alt="">` : ""}<span>${escapeHtml(item.analysis?.summary || "Prompt")}</span></button>`).join("")}</div></aside>`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, "&#39;");
  }
})();
