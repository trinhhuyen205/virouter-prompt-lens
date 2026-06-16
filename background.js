const DEFAULT_SETTINGS = {
  baseUrl: "https://api.virouter.com/v1",
  apiKey: "",
  model: "gpt-5.5",
  imageModel: "gpt-image-2",
  imageSize: "1024x1024",
  imageQuality: "medium",
  autoGenerateImage: false,
  enhancementMode: "enhanced",
  language: "en",
  detailLevel: "balanced",
  showOnAllSites: false,
  saveHistory: true
};

const HISTORY_KEY = "virouterPromptLensHistory";
const SETTINGS_KEY = "virouterPromptLensSettings";
const MAX_HISTORY = 12;
const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.88;

const GLOBAL_SCRIPT_ID = "vpl-global-prompt-button";
const GLOBAL_SCRIPT_EXCLUDES = [
  "https://accounts.google.com/*",
  "https://*.accounts.google.com/*",
  "https://checkout.stripe.com/*",
  "https://*.checkout.stripe.com/*",
  "https://pay.stripe.com/*",
  "https://*.pay.stripe.com/*"
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "virouter-analyze-image",
    title: "Analyze image with Virouter",
    contexts: ["image"]
  });
  chrome.contextMenus.create({
    id: "virouter-open-panel",
    title: "Open Virouter Prompt Lens",
    contexts: ["page", "selection", "image"]
  });
  void syncGlobalScript();
});

chrome.runtime.onStartup?.addListener(() => {
  void syncGlobalScript();
});

async function registerGlobalScript() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [GLOBAL_SCRIPT_ID] }).catch(() => []);
    if (Array.isArray(existing) && existing.length) return true;
    await chrome.scripting.registerContentScripts([{
      id: GLOBAL_SCRIPT_ID,
      matches: ["http://*/*", "https://*/*"],
      excludeMatches: GLOBAL_SCRIPT_EXCLUDES,
      js: ["content.js"],
      css: ["content.css"],
      runAt: "document_idle",
      allFrames: false,
      persistAcrossSessions: true
    }]);
    return true;
  } catch {
    return false;
  }
}

async function unregisterGlobalScript() {
  await chrome.scripting.unregisterContentScripts({ ids: [GLOBAL_SCRIPT_ID] }).catch(() => {});
}

async function syncGlobalScript() {
  try {
    const settings = await getSettings();
    const hasHost = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
    if (settings.showOnAllSites && hasHost) await registerGlobalScript();
    else await unregisterGlobalScript();
  } catch {}
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "virouter-open-panel") {
    await sendToTab(tab.id, { type: "VPL_OPEN_PANEL" });
    return;
  }
  if (info.menuItemId === "virouter-analyze-image" && info.srcUrl) {
    await sendToTab(tab.id, { type: "VPL_ANALYZE_IMAGE", payload: { src: info.srcUrl, pageUrl: info.pageUrl || tab.url || "" } });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      if (message?.type === "VPL_GET_SETTINGS") {
        sendResponse({ ok: true, data: await getSettings() });
        return;
      }
      if (message?.type === "VPL_SAVE_SETTINGS") {
        const settings = normalizeSettings(message.payload || {});
        await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
        await syncGlobalScript();
        sendResponse({ ok: true, data: settings });
        return;
      }
      if (message?.type === "VPL_SYNC_GLOBAL_SCRIPT") {
        await syncGlobalScript();
        const active = await chrome.scripting.getRegisteredContentScripts({ ids: [GLOBAL_SCRIPT_ID] }).catch(() => []);
        sendResponse({ ok: true, data: { registered: Array.isArray(active) && active.length > 0 } });
        return;
      }
      if (message?.type === "VPL_GET_HISTORY") {
        sendResponse({ ok: true, data: await getHistory() });
        return;
      }
      if (message?.type === "VPL_CLEAR_HISTORY") {
        await chrome.storage.local.set({ [HISTORY_KEY]: [] });
        sendResponse({ ok: true, data: [] });
        return;
      }
      if (message?.type === "VPL_ANALYZE") {
        const result = await analyzeTarget(message.payload || {});
        sendResponse({ ok: true, data: result });
        return;
      }
      if (message?.type === "VPL_GENERATE_IMAGE") {
        const result = await generateImageFromPrompt(message.payload || {});
        sendResponse({ ok: true, data: result });
        return;
      }
      if (message?.type === "VPL_CAPTURE_VISIBLE_TAB") {
        const tabId = typeof message.payload?.tabId === "number" ? message.payload.tabId : sender.tab?.id;
        const windowId = typeof message.payload?.windowId === "number" ? message.payload.windowId : sender.tab?.windowId;
        const analyze = message.payload?.analyze !== false;
        if (typeof windowId !== "number") throw new Error("Cannot capture this tab.");
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 90 });
        if (typeof tabId === "number") {
          await sendToTab(tabId, { type: "VPL_OPEN_PANEL" });
          await sendToTab(tabId, { type: "VPL_CAPTURED_VISIBLE_TAB", payload: { dataUrl, analyze } });
        }
        sendResponse({ ok: true, data: { dataUrl } });
        return;
      }
      sendResponse({ ok: false, error: "Unknown message." });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unexpected error." });
    }
  })();
  return true;
});

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tabId, message);
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY] || {});
}

function normalizeSettings(value) {
  return {
    ...DEFAULT_SETTINGS,
    ...Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null)),
    baseUrl: String(value.baseUrl || DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, ""),
    apiKey: String(value.apiKey || "").replace(/[\s\u200B-\u200D\uFEFF]/g, ""),
    model: String(value.model || DEFAULT_SETTINGS.model).trim(),
    imageModel: String(value.imageModel || DEFAULT_SETTINGS.imageModel).trim(),
    imageSize: ["1024x1024", "1024x1536", "1536x1024"].includes(value.imageSize) ? value.imageSize : DEFAULT_SETTINGS.imageSize,
    imageQuality: ["low", "medium", "high"].includes(value.imageQuality) ? value.imageQuality : DEFAULT_SETTINGS.imageQuality,
    autoGenerateImage: value.autoGenerateImage === true,
    enhancementMode: ["faithful", "enhanced", "commercial", "cinematic", "viral-social"].includes(value.enhancementMode) ? value.enhancementMode : DEFAULT_SETTINGS.enhancementMode,
    language: ["en", "vi", "ja"].includes(value.language) ? value.language : DEFAULT_SETTINGS.language,
    detailLevel: ["fast", "balanced", "deep"].includes(value.detailLevel) ? value.detailLevel : DEFAULT_SETTINGS.detailLevel,
    showOnAllSites: value.showOnAllSites === true,
    saveHistory: value.saveHistory !== false
  };
}

async function getHistory() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
}

async function saveHistory(item) {
  const history = await getHistory();
  const next = [item, ...history].slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return next;
}

async function generateImageFromPrompt(payload) {
  const settings = await getSettings();
  if (!settings.baseUrl) throw new Error("Add an OpenAI-compatible Base URL in settings.");
  if (!settings.apiKey) throw new Error("Add an API key in settings.");
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) throw new Error("No prompt is available to generate an image.");

  const response = await fetch(endpointForImagesGenerations(settings.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.imageModel || "gpt-image-2",
      prompt,
      size: settings.imageSize || "1024x1024",
      quality: settings.imageQuality || "medium",
      n: 1
    })
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { text }; }
  if (!response.ok) throw new Error(extractError(body, `Image API returned HTTP ${response.status}.`));
  const imageUrl = extractGeneratedImage(body);
  if (!imageUrl) throw new Error("The image API returned no image payload.");
  return {
    id: `vpl_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    model: settings.imageModel || "gpt-image-2",
    endpoint: "/v1/images/generations",
    prompt,
    imageUrl,
    raw: body
  };
}

function extractGeneratedImage(value) {
  const queue = [value];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (typeof current.b64_json === "string" && current.b64_json.trim()) return `data:image/png;base64,${current.b64_json}`;
    if (typeof current.base64 === "string" && current.base64.trim()) return current.base64.startsWith("data:") ? current.base64 : `data:image/png;base64,${current.base64}`;
    if (typeof current.image === "string" && current.image.trim()) return current.image.startsWith("data:") || current.image.startsWith("http") ? current.image : `data:image/png;base64,${current.image}`;
    if (typeof current.url === "string" && current.url.trim()) return current.url;
    if (typeof current.image_url === "string" && current.image_url.trim()) return current.image_url;
    for (const nested of Object.values(current)) {
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return "";
}

async function analyzeTarget(payload) {
  const settings = await getSettings();
  if (!settings.baseUrl) throw new Error("Add an OpenAI-compatible Base URL in settings.");
  if (!settings.apiKey) throw new Error("Add an API key in settings.");
  if (!settings.model) throw new Error("Add a model name in settings.");

  const imageData = payload.dataUrl ? await normalizeDataUrl(payload.dataUrl) : await fetchImageAsDataUrl(payload.src);
  const analysis = await callVisionModel(settings, imageData.dataUrl);
  const item = {
    id: `vpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    imageSrc: imageData.previewUrl || imageData.thumbnailUrl || "",
    pageUrl: payload.pageUrl || "",
    model: settings.model,
    language: settings.language,
    detailLevel: settings.detailLevel,
    analysis,
    promptDrafts: buildPromptDrafts(analysis)
  };
  if (settings.saveHistory) await saveHistory(item);
  return item;
}

async function fetchImageAsDataUrl(src) {
  if (!src) throw new Error("No image URL was provided.");
  if (src.startsWith("data:")) return normalizeDataUrl(src);
  const response = await fetch(src, { credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error(`Image fetch failed (${response.status}). Try screenshot mode or another image.`);
  const blob = await response.blob();
  return blobToNormalizedDataUrl(blob, src);
}

async function normalizeDataUrl(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return blobToNormalizedDataUrl(blob, dataUrl);
}

async function blobToNormalizedDataUrl(blob, previewUrl = "") {
  if (!blob.type.startsWith("image/")) throw new Error("Selected file is not an image.");
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not prepare the image.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);

  const thumbScale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
  const thumbWidth = Math.max(1, Math.round(bitmap.width * thumbScale));
  const thumbHeight = Math.max(1, Math.round(bitmap.height * thumbScale));
  const thumbCanvas = new OffscreenCanvas(thumbWidth, thumbHeight);
  const thumbCtx = thumbCanvas.getContext("2d", { alpha: false });
  if (thumbCtx) {
    thumbCtx.fillStyle = "#ffffff";
    thumbCtx.fillRect(0, 0, thumbWidth, thumbHeight);
    thumbCtx.drawImage(bitmap, 0, 0, thumbWidth, thumbHeight);
  }
  bitmap.close();

  const output = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  const thumbnail = thumbCtx ? await thumbCanvas.convertToBlob({ type: "image/jpeg", quality: 0.76 }) : output;
  const dataUrl = await blobToDataUrl(output);
  const thumbnailUrl = await blobToDataUrl(thumbnail);
  return { dataUrl, previewUrl, thumbnailUrl, width, height, bytes: output.size };
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
}

function endpointForChatCompletions(baseUrl) {
  const clean = baseUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(clean) ? clean : `${clean}/chat/completions`;
}

function endpointForImagesGenerations(baseUrl) {
  const clean = baseUrl.replace(/\/+$/, "");
  if (/\/images\/generations$/i.test(clean)) return clean;
  if (/\/chat\/completions$/i.test(clean)) return clean.replace(/\/chat\/completions$/i, "/images/generations");
  return `${clean}/images/generations`;
}

async function callVisionModel(settings, dataUrl) {
  const response = await fetch(endpointForChatCompletions(settings.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: buildAnalyzerPrompt(settings.language, settings.detailLevel, settings.enhancementMode) },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }],
      temperature: 0.2,
      max_tokens: settings.detailLevel === "deep" ? 1800 : settings.detailLevel === "fast" ? 900 : 1300
    })
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { text }; }
  if (!response.ok) throw new Error(extractError(body, `API returned HTTP ${response.status}.`));
  const content = extractAssistantText(body);
  if (!content) throw new Error("The model returned no analysis text.");
  return parseAnalysis(content);
}

function buildAnalyzerPrompt(language, detailLevel, enhancementMode = "enhanced") {
  const languageName = language === "vi" ? "Vietnamese" : language === "ja" ? "Japanese" : "English";
  const depth = detailLevel === "deep" ? "highly detailed" : detailLevel === "fast" ? "concise but complete" : "balanced and useful";
  return `You are Virouter Prompt Lens, a senior AI image prompt engineer and visual analysis expert.

Your job is to analyze the provided image and transform it into production-ready prompts for AI image generation.

Perform four tasks:
1. Accurately analyze the image.
2. Classify the visual use case and recommend a prompt preset.
3. Improve the prompt according to the requested enhancement mode.
4. Return engine-specific prompts for multiple image generators.

Rules:
- Return valid JSON only. Do not use markdown fences.
- Do not identify real private persons. Describe visible visual attributes only.
- Preserve the original subject and visual direction unless enhancement mode asks for improvement.
- Avoid copyrighted character names, living artist names, and brand names unless clearly user-provided.
- Prefer concrete professional art-direction language over vague adjectives.
- Include camera angle, lens feel, lighting direction, material texture, color palette, composition, and mood.

Requested language: ${languageName}
Detail level: ${depth}
Enhancement mode: ${enhancementMode}
Primary target engine: Virouter Image / gpt-image-2 via /v1/images/generations

Enhancement modes:
- faithful: preserve the source as closely as possible.
- enhanced: improve clarity, lighting, composition, and visual polish.
- commercial: make it premium, clean, advertising-ready, and conversion-oriented.
- cinematic: make it dramatic, atmospheric, lens-aware, and filmic.
- viral-social: make it bold, high-contrast, readable, and scroll-stopping.

Preset families:
portrait, fashion-editorial, product-photo, packaging, poster, logo-branding, character-sheet, toy-figurine, macro-photo, food-photo, architecture, interior, landscape, cinematic-scene, storyboard-grid, infographic, ui-mockup, social-post, anime-cartoon, 3d-illustration, paper-craft, clay-felt, vehicle, fantasy-sci-fi, generic-creative.

Return this JSON schema exactly:
{
  "schemaVersion": "virouter-prompt-lens-v1",
  "language": "${language}",
  "visualAnalysis": {
    "subject": "string",
    "subjectDetails": "string",
    "actionPose": "string",
    "environment": "string",
    "composition": "string",
    "camera": "string",
    "lighting": "string",
    "colorPalette": ["string"],
    "materials": ["string"],
    "textures": ["string"],
    "mood": "string",
    "styleTags": ["string"],
    "qualitySignals": ["string"],
    "weaknesses": ["string"]
  },
  "intent": {
    "detectedUseCase": "string",
    "recommendedPreset": "string",
    "confidence": 0.0,
    "enhancementMode": "${enhancementMode}",
    "targetAspectRatio": "string",
    "recommendedImageSize": "string"
  },
  "prompts": {
    "general": "string",
    "virouterImage": "string optimized for gpt-image-2 image generation",
    "midjourney": "string",
    "sdxl": "string",
    "flux": "string",
    "dalle": "string"
  },
  "negativePrompt": "string",
  "generationSettings": {
    "aspectRatio": "string",
    "imageSize": "string",
    "quality": "string",
    "styleStrength": "string"
  },
  "promptTags": ["string"],
  "safetyNotes": ["string"]
}`;
}

function extractAssistantText(body) {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map(part => typeof part?.text === "string" ? part.text : "").join("\n").trim();
  return "";
}

function parseAnalysis(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === "object") return normalizePromptEngineOutput(parsed);
  } catch {}
  return normalizePromptEngineOutput({ summary: text, prompts: { general: text, virouterImage: text } });
}

function normalizePromptEngineOutput(parsed) {
  const prompts = parsed?.prompts && typeof parsed.prompts === "object" ? parsed.prompts : {};
  const visual = parsed?.visualAnalysis && typeof parsed.visualAnalysis === "object" ? parsed.visualAnalysis : {};
  const fallbackSummary = parsed?.summary || visual.subject || prompts.general || "Prompt ready";
  const styleTags = Array.isArray(visual.styleTags) ? visual.styleTags : Array.isArray(parsed?.styleTags) ? parsed.styleTags : [];
  const colorPalette = Array.isArray(visual.colorPalette) ? visual.colorPalette : Array.isArray(parsed?.colors) ? parsed.colors : [];
  const materials = Array.isArray(visual.materials) ? visual.materials : Array.isArray(parsed?.materials) ? parsed.materials : [];
  const normalized = {
    schemaVersion: parsed?.schemaVersion || "virouter-prompt-lens-v1",
    language: parsed?.language || "en",
    summary: fallbackSummary,
    subject: visual.subject || parsed?.subject || "",
    composition: visual.composition || parsed?.composition || "",
    lighting: visual.lighting || parsed?.lighting || "",
    colors: colorPalette,
    styleTags,
    camera: visual.camera || parsed?.camera || "",
    mood: visual.mood || parsed?.mood || "",
    materials,
    negativePrompt: parsed?.negativePrompt || "low quality, blurry, distorted details, watermark, unreadable text",
    visualAnalysis: {
      subject: visual.subject || parsed?.subject || "",
      subjectDetails: visual.subjectDetails || "",
      actionPose: visual.actionPose || "",
      environment: visual.environment || "",
      composition: visual.composition || parsed?.composition || "",
      camera: visual.camera || parsed?.camera || "",
      lighting: visual.lighting || parsed?.lighting || "",
      colorPalette,
      materials,
      textures: Array.isArray(visual.textures) ? visual.textures : [],
      mood: visual.mood || parsed?.mood || "",
      styleTags,
      qualitySignals: Array.isArray(visual.qualitySignals) ? visual.qualitySignals : [],
      weaknesses: Array.isArray(visual.weaknesses) ? visual.weaknesses : []
    },
    intent: parsed?.intent && typeof parsed.intent === "object" ? parsed.intent : {
      detectedUseCase: inferUseCase(styleTags, fallbackSummary),
      recommendedPreset: inferPreset(styleTags, fallbackSummary),
      confidence: 0.5,
      enhancementMode: "enhanced",
      targetAspectRatio: "1:1",
      recommendedImageSize: "1024x1024"
    },
    prompts: {
      general: String(prompts.general || fallbackSummary || ""),
      virouterImage: String(prompts.virouterImage || prompts.general || fallbackSummary || ""),
      midjourney: String(prompts.midjourney || prompts.general || fallbackSummary || ""),
      sdxl: String(prompts.sdxl || prompts.general || fallbackSummary || ""),
      flux: String(prompts.flux || prompts.general || fallbackSummary || ""),
      dalle: String(prompts.dalle || prompts.general || fallbackSummary || "")
    },
    generationSettings: parsed?.generationSettings && typeof parsed.generationSettings === "object" ? parsed.generationSettings : {},
    promptTags: Array.isArray(parsed?.promptTags) ? parsed.promptTags : styleTags,
    safetyNotes: Array.isArray(parsed?.safetyNotes) ? parsed.safetyNotes : []
  };
  return normalized;
}

function inferUseCase(tags, text) {
  const haystack = `${tags.join(" ")} ${text}`.toLowerCase();
  if (/product|packaging|商品|产品|包装/.test(haystack)) return "product-photo";
  if (/fashion|editorial|服装|穿搭/.test(haystack)) return "fashion-editorial";
  if (/portrait|人物|肖像/.test(haystack)) return "portrait";
  if (/poster|海报|social/.test(haystack)) return "poster";
  if (/character|角色/.test(haystack)) return "character-sheet";
  if (/infographic|diagram|信息图/.test(haystack)) return "infographic";
  if (/macro|微距/.test(haystack)) return "macro-photo";
  if (/toy|figurine|手办|玩具/.test(haystack)) return "toy-figurine";
  return "generic-creative";
}

function inferPreset(tags, text) {
  const useCase = inferUseCase(tags, text);
  const map = {
    "product-photo": "product-commercial",
    "fashion-editorial": "fashion-editorial",
    "portrait": "portrait-cinematic",
    "poster": "poster-social",
    "character-sheet": "character-sheet",
    "infographic": "infographic-museum",
    "macro-photo": "macro-photo",
    "toy-figurine": "toy-figurine"
  };
  return map[useCase] || "generic-creative";
}

function extractError(body, fallback) {
  if (typeof body?.message === "string") return body.message;
  if (typeof body?.error === "string") return body.error;
  if (typeof body?.error?.message === "string") return body.error.message;
  return fallback;
}

function buildPromptDrafts(analysis) {
  const prompts = analysis?.prompts && typeof analysis.prompts === "object" ? analysis.prompts : {};
  return {
    general: String(prompts.general || analysis?.summary || ""),
    virouterImage: String(prompts.virouterImage || prompts.general || analysis?.summary || ""),
    midjourney: String(prompts.midjourney || prompts.general || analysis?.summary || ""),
    sdxl: String(prompts.sdxl || prompts.general || analysis?.summary || ""),
    flux: String(prompts.flux || prompts.general || analysis?.summary || ""),
    dalle: String(prompts.dalle || prompts.general || analysis?.summary || ""),
    json: JSON.stringify(analysis || {}, null, 2)
  };
}
