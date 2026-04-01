const ALLOWLIST = [
  { name: "onecompiler", hostIncludes: ["onecompiler.com"] },
  { name: "replit", hostIncludes: ["replit.com"] },
  { name: "leetcode", hostIncludes: ["leetcode.com"] },
  { name: "neetcode", hostIncludes: ["neetcode.io"] },
  { name: "hackerrank", hostIncludes: ["hackerrank.com"] }
];

const EDITOR_SELECTORS = [
  ".monaco-editor",
  ".CodeMirror",
  ".ace_editor",
  "textarea"
];

const INLINE_STYLE_ID = "cc-inline-style";
const INLINE_CARD_ID = "cc-inline-card";
const LOADING_INDICATOR_ID = "cc-loading-indicator";
const HIGHLIGHT_CLASS = "cc-inline-highlight";
const OVERLAY_LAYER_ID = "cc-inline-overlay-layer";
const OVERLAY_HIGHLIGHT_CLASS = "cc-inline-overlay-highlight";
const CARD_HIDE_DELAY_MS = 140;
const LOADING_INDICATOR_TIMEOUT_MS = 15000;

let latestResult = null;
let activeSuggestionByKey = new Map();
let hoverHandlersAttached = false;
let currentCardSuggestion = null;
let runtimeSettings = {
  autoAnalyze: true,
  idleTimeout: 3000,
  analysisMode: "ai"
};
let overlayRafId = 0;
let cardHideTimer = 0;
let loadingIndicatorTimer = 0;
const dismissedSuggestionKeys = new Set();

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasExtensionContext() {
  return !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
}

async function safeStorageGet(defaults) {
  if (!hasExtensionContext()) return defaults;
  try { return await chrome.storage.sync.get(defaults); } catch { return defaults; }
}

function safeSendMessage(payload) {
  if (!hasExtensionContext()) return;
  try {
    const p = chrome.runtime.sendMessage(payload);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch { /* stale context */ }
}

function detectSite() {
  const host = window.location.hostname;
  const matched = ALLOWLIST.find((s) => s.hostIncludes.some((f) => host.includes(f)));
  return matched ? matched.name : null;
}

function detectLanguageByUrl() {
  const url = window.location.href.toLowerCase();
  if (url.includes("python") || url.includes("py")) return "python";
  if (url.includes("javascript") || url.includes("js")) return "javascript";
  return "python";
}

// ── Code extraction ──────────────────────────────────────────────────────────

function getMonacoFocusedEditor() {
  const api = window.monaco?.editor;
  if (!api || typeof api.getEditors !== "function") return null;
  try {
    const editors = api.getEditors() || [];
    if (!editors.length) return null;
    const focused = editors.find((e) => { try { return e.hasTextFocus(); } catch { return false; } });
    return focused || editors[0] || null;
  } catch { return null; }
}

function extractFromMonaco() {
  const editor = getMonacoFocusedEditor();
  if (editor) {
    try {
      if (typeof editor.getValue === "function") return editor.getValue() || "";
      const model = typeof editor.getModel === "function" ? editor.getModel() : null;
      if (model && typeof model.getValue === "function") return model.getValue() || "";
    } catch { /* fall through */ }
  }
  const el = document.querySelector(".monaco-editor");
  if (!el) return "";
  const lines = el.querySelectorAll(".view-lines .view-line");
  return lines.length ? Array.from(lines).map((n) => n.textContent || "").join("\n") : "";
}

function extractFromCodeMirror() {
  const cm6 = document.querySelector(".cm-editor");
  if (cm6) {
    try {
      const view = cm6.cmView?.view || cm6.cmView || cm6.view;
      if (view?.state?.doc) return view.state.doc.toString() || "";
    } catch { /* fall through */ }
  }
  const cm5 = document.querySelector(".CodeMirror");
  if (cm5?.CodeMirror && typeof cm5.CodeMirror.getValue === "function") {
    try { return cm5.CodeMirror.getValue() || ""; } catch { return ""; }
  }
  const lines = document.querySelectorAll(".cm-editor .cm-content .cm-line, .CodeMirror .CodeMirror-code pre");
  return lines.length ? Array.from(lines).map((l) => l.textContent || "").join("\n") : "";
}

function extractFromAce() {
  const root = document.querySelector(".ace_editor");
  if (root && window.ace && typeof window.ace.edit === "function") {
    try {
      const editor = window.ace.edit(root);
      if (typeof editor.getValue === "function") return editor.getValue() || "";
    } catch { /* fall through */ }
  }
  const lines = document.querySelectorAll(".ace_editor .ace_text-layer .ace_line");
  return lines.length ? Array.from(lines).map((l) => l.textContent || "").join("\n") : "";
}

function extractFromTextarea() {
  const textareas = Array.from(document.querySelectorAll("textarea"));
  const ranked = textareas.map((t) => ({ el: t, len: (t.value || "").length })).sort((a, b) => b.len - a.len);
  return ranked[0]?.el?.value?.trim() || "";
}

function extractCode() {
  return extractFromMonaco() || extractFromCodeMirror() || extractFromAce() || extractFromTextarea();
}

// ── Code writing ─────────────────────────────────────────────────────────────

function getPrimaryTextarea() {
  const textareas = Array.from(document.querySelectorAll("textarea"));
  if (!textareas.length) return null;
  return textareas.sort((a, b) => (b.value || "").length - (a.value || "").length)[0] || null;
}

function setCodeInMonaco(code) {
  const editor = getMonacoFocusedEditor();
  if (!editor) return false;
  try {
    if (typeof editor.setValue === "function") { editor.setValue(code); return true; }
    const model = typeof editor.getModel === "function" ? editor.getModel() : null;
    if (model && typeof model.setValue === "function") { model.setValue(code); return true; }
  } catch { /* fall through */ }
  return false;
}

function setCodeInCodeMirror6(code) {
  const cm = document.querySelector(".cm-editor");
  if (!cm) return false;
  const view = cm.cmView?.view || cm.cmView || cm.view;
  if (!view || !view.state || typeof view.dispatch !== "function") return false;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
  return true;
}

function setCodeInCodeMirror5(code) {
  const cm = document.querySelector(".CodeMirror");
  if (!cm?.CodeMirror || typeof cm.CodeMirror.setValue !== "function") return false;
  cm.CodeMirror.setValue(code);
  return true;
}

function setCodeInAce(code) {
  const root = document.querySelector(".ace_editor");
  if (!root || !window.ace || typeof window.ace.edit !== "function") return false;
  try { window.ace.edit(root).setValue(code, -1); return true; } catch { return false; }
}

function setCodeInTextarea(code) {
  const ta = getPrimaryTextarea();
  if (!ta) return false;
  ta.value = code;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

async function setCodeViaMainWorld(code) {
  try {
    const result = await chrome.runtime.sendMessage({ type: "WRITE_CODE_MAIN_WORLD", code });
    return !!result?.ok;
  } catch {
    return false;
  }
}

async function setCodeInEditor(code) {
  if (await setCodeViaMainWorld(code)) return true;
  return setCodeInMonaco(code) || setCodeInCodeMirror6(code) || setCodeInCodeMirror5(code) || setCodeInAce(code) || setCodeInTextarea(code);
}

// ── Apply fix (line-range replacement using fix.replacement) ─────────────────

function applyFixToCode(code, suggestion) {
  const replacement = String(suggestion?.fix?.replacement || "").trim();
  if (!replacement) return null;

  const range = suggestion?.fix?.range || {};
  let startLine = Number(suggestion?.line || range.startLine || 1);
  let endLine = Number(suggestion?.end_line || range.endLine || startLine);

  if (!Number.isInteger(startLine) || startLine < 1) return null;

  const lines = code.split("\n");


  // Expand range to cover the full contiguous block of identical lines
  if (startLine >= 1 && startLine <= lines.length) {
    const targetLine = lines[startLine - 1];
    while (startLine > 1 && lines[startLine - 2] === targetLine) startLine--;
    while (endLine < lines.length && lines[endLine] === targetLine) endLine++;
  }

  const boundedEnd = Math.min(endLine, lines.length);
  if (boundedEnd < startLine) return null;

  const replacementLines = replacement.split("\n");
  const result = [
    ...lines.slice(0, startLine - 1),
    ...replacementLines,
    ...lines.slice(boundedEnd)
  ].join("\n");

  return result !== code ? result : null;
}

async function applyQuickFix(suggestion) {
  const original = extractCode();
  if (!original) return { ok: false, error: "No code found in active editor." };

  const fixed = applyFixToCode(original, suggestion);
  if (!fixed) return { ok: false, error: "No replacement available for this suggestion." };

  const wrote = await setCodeInEditor(fixed);
  if (!wrote) return { ok: false, error: "Unable to write fix into this editor." };

  // Trigger re-analysis after applying the fix.
  lastCode = "";
  const site = detectSite() || "broad-detection";
  publishSnapshot(site);
  safeSendMessage({ type: "FORCE_REANALYZE" });
  return { ok: true, source: "inline-replacement" };
}

// ── Inline highlights + hover card UI ────────────────────────────────────────

function ensureInlineStyles() {
  if (document.getElementById(INLINE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = INLINE_STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      text-decoration: underline wavy #ef4444;
      text-decoration-thickness: 1.5px;
      text-underline-offset: 2px;
      background: rgba(239, 68, 68, 0.08);
      border-radius: 3px;
    }
    .${HIGHLIGHT_CLASS}.cc-low {
      text-decoration-color: #f59e0b;
      background: rgba(245, 158, 11, 0.09);
    }
    #${OVERLAY_LAYER_ID} {
      position: fixed; inset: 0; z-index: 2147483638; pointer-events: none;
    }
    .${OVERLAY_HIGHLIGHT_CLASS} {
      position: fixed; pointer-events: auto; border-radius: 3px;
      border-bottom: 2px wavy #ef4444; background: rgba(239, 68, 68, 0.08);
    }
    .${OVERLAY_HIGHLIGHT_CLASS}.cc-medium {
      border-bottom-color: #f97316; background: rgba(249, 115, 22, 0.1);
    }
    .${OVERLAY_HIGHLIGHT_CLASS}.cc-low {
      border-bottom-color: #f59e0b; background: rgba(245, 158, 11, 0.09);
    }
    #${INLINE_CARD_ID} {
      position: fixed; z-index: 2147483640; max-width: 320px; padding: 10px;
      border-radius: 10px; border: 1px solid #fca5a5; background: #fff7f7;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16); color: #111827;
      font-size: 12px; line-height: 1.35; display: none; pointer-events: auto;
    }
    #${INLINE_CARD_ID}.cc-medium { border-color: #fdba74; background: #fff7ed; }
    #${INLINE_CARD_ID}.cc-low { border-color: #fde68a; background: #fffbeb; }
    #${INLINE_CARD_ID} strong { display: block; margin-bottom: 5px; font-size: 12px; }
    #${INLINE_CARD_ID} .cc-rationale { color: #334155; }
    #${INLINE_CARD_ID} .cc-fix-preview {
      margin-top: 8px; border: 1px solid rgba(15, 23, 42, 0.14); background: #f8fafc;
      border-radius: 6px; padding: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px; white-space: pre-wrap; max-height: 120px; overflow: auto;
    }
    #${INLINE_CARD_ID} .cc-actions { margin-top: 8px; }
    #${INLINE_CARD_ID} button {
      border: 1px solid #0f766e; background: #0f766e; color: #fff;
      border-radius: 6px; padding: 4px 8px; font-size: 11px; cursor: pointer;
      margin-right: 4px;
    }
    #${LOADING_INDICATOR_ID} {
      position: fixed; right: 12px; bottom: 12px; z-index: 2147483641;
      display: none; align-items: center; gap: 8px; padding: 8px 10px;
      border: 1px solid rgba(15, 23, 42, 0.15); border-radius: 999px;
      background: rgba(255, 255, 255, 0.98); color: #0f172a; font-size: 12px;
      box-shadow: 0 6px 20px rgba(15, 23, 42, 0.14); pointer-events: none;
    }
    #${LOADING_INDICATOR_ID} .cc-spinner {
      width: 12px; height: 12px;
      border: 2px solid rgba(15, 118, 110, 0.25); border-top-color: #0f766e;
      border-radius: 50%; animation: cc-spin 0.85s linear infinite;
    }
    @keyframes cc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
}

function getOrCreateLoadingIndicator() {
  let el = document.getElementById(LOADING_INDICATOR_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = LOADING_INDICATOR_ID;
  el.innerHTML = '<span class="cc-spinner"></span><span class="cc-label">Analyzing...</span>';
  document.body.appendChild(el);
  return el;
}

function showLoadingIndicator(label = "Analyzing...") {
  ensureInlineStyles();
  const el = getOrCreateLoadingIndicator();
  const lbl = el.querySelector(".cc-label");
  if (lbl) lbl.textContent = label;
  el.style.display = "inline-flex";
  if (loadingIndicatorTimer) clearTimeout(loadingIndicatorTimer);
  loadingIndicatorTimer = setTimeout(() => { loadingIndicatorTimer = 0; hideLoadingIndicator(); }, LOADING_INDICATOR_TIMEOUT_MS);
}

function hideLoadingIndicator() {
  if (loadingIndicatorTimer) { clearTimeout(loadingIndicatorTimer); loadingIndicatorTimer = 0; }
  const el = document.getElementById(LOADING_INDICATOR_ID);
  if (el) el.style.display = "none";
}

function getOrCreateInlineCard() {
  let card = document.getElementById(INLINE_CARD_ID);
  if (card) return card;
  card = document.createElement("div");
  card.id = INLINE_CARD_ID;
  document.body.appendChild(card);
  return card;
}

function escapeHtml(val) {
  return String(val || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getSuggestionKey(suggestion) {
  const start = Number(suggestion?.line || suggestion?.anchor?.line || 1);
  const end = Number(suggestion?.end_line || start);
  const msg = String(suggestion?.message || "").trim().toLowerCase();
  return `${start}:${end}:${msg}`;
}

function getSeverityClass(suggestion) {
  const s = String(suggestion?.severity || suggestion?.legacySeverity || "info").toLowerCase();
  if (s === "error" || s === "high") return "cc-high";
  if (s === "warning" || s === "medium") return "cc-medium";
  return "cc-low";
}

function hasReplacement(suggestion) {
  return !!String(suggestion?.fix?.replacement || "").trim();
}

function showInlineCard(suggestion, rect) {
  const card = getOrCreateInlineCard();
  if (cardHideTimer) { clearTimeout(cardHideTimer); cardHideTimer = 0; }
  currentCardSuggestion = suggestion;

  const sevClass = getSeverityClass(suggestion);
  const fixText = String(suggestion?.fix?.replacement || "").trim();
  const canApply = !!fixText;

  card.className = sevClass;
  card.innerHTML = `
    <strong>${escapeHtml(suggestion.message)}</strong>
    <div><em>${escapeHtml(suggestion.category || "issue")} | ${escapeHtml(suggestion.severity || "info")}</em></div>
    <div class="cc-rationale">${escapeHtml(suggestion.rationale || suggestion.message)}</div>
    ${fixText ? `<div class="cc-fix-preview">${escapeHtml(fixText)}</div>` : ""}
    <div class="cc-actions">
      ${canApply ? '<button type="button" data-cc-action="apply-fix">Apply Fix</button>' : ""}
      <button type="button" data-cc-action="dismiss">Dismiss</button>
      ${fixText ? '<button type="button" data-cc-action="copy-fix">Copy Fix</button>' : ""}
    </div>
  `;

  card.style.left = `${Math.max(8, Math.min(window.innerWidth - 340, rect.left + 8))}px`;
  card.style.top = `${Math.max(8, Math.min(window.innerHeight - 150, rect.bottom + 8))}px`;
  card.style.display = "block";
}

function hideInlineCard() {
  if (cardHideTimer) { clearTimeout(cardHideTimer); cardHideTimer = 0; }
  const card = document.getElementById(INLINE_CARD_ID);
  if (card) card.style.display = "none";
  currentCardSuggestion = null;
}

function scheduleHideInlineCard() {
  if (cardHideTimer) clearTimeout(cardHideTimer);
  cardHideTimer = setTimeout(() => { cardHideTimer = 0; hideInlineCard(); }, CARD_HIDE_DELAY_MS);
}

// ── Overlay rendering ────────────────────────────────────────────────────────

function getOrCreateOverlayLayer() {
  let layer = document.getElementById(OVERLAY_LAYER_ID);
  if (layer) return layer;
  layer = document.createElement("div");
  layer.id = OVERLAY_LAYER_ID;
  document.body.appendChild(layer);
  return layer;
}

function clearInlineHighlights() {
  const layer = document.getElementById(OVERLAY_LAYER_ID);
  if (layer) layer.innerHTML = "";
  activeSuggestionByKey = new Map();
  hideInlineCard();
}

function renderHighlightBox(layer, rect, key, severityClass) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  const hl = document.createElement("div");
  hl.className = `${OVERLAY_HIGHLIGHT_CLASS} ${severityClass}`;
  hl.dataset.ccKey = key;
  hl.style.left = `${Math.max(0, rect.left)}px`;
  hl.style.top = `${Math.max(0, rect.top)}px`;
  hl.style.width = `${Math.max(10, rect.width)}px`;
  hl.style.height = `${Math.max(6, rect.height)}px`;
  layer.appendChild(hl);
}

function renderOverlaysFromLineNodes(lineNodes, suggestions) {
  const layer = getOrCreateOverlayLayer();
  for (const s of suggestions) {
    const startLine = Number(s?.line || 1);
    const endLine = Number(s?.end_line || startLine);
    if (startLine < 1) continue;

    const key = getSuggestionKey(s);
    if (dismissedSuggestionKeys.has(key)) continue;
    activeSuggestionByKey.set(key, s);
    const sevClass = getSeverityClass(s);

    for (let ln = startLine; ln <= endLine; ln++) {
      const node = lineNodes[ln - 1];
      if (!node) continue;
      renderHighlightBox(layer, node.getBoundingClientRect(), key, sevClass);
    }
  }
}

function renderInlineSuggestions(result) {
  ensureInlineStyles();
  attachHoverHandlers();
  clearInlineHighlights();

  const suggestions = (result?.suggestions || []).filter((s) => hasReplacement(s));
  if (!suggestions.length) return;

  const monacoLines = Array.from(document.querySelectorAll(".monaco-editor .view-lines .view-line, .view-lines .view-line"));
  if (monacoLines.length) { renderOverlaysFromLineNodes(monacoLines, suggestions); return; }

  const cmLines = Array.from(document.querySelectorAll(".cm-editor .cm-line, .cm-content .cm-line, .CodeMirror-code pre"));
  if (cmLines.length) { renderOverlaysFromLineNodes(cmLines, suggestions); return; }

  const aceLines = Array.from(document.querySelectorAll(".ace_line"));
  if (aceLines.length) { renderOverlaysFromLineNodes(aceLines, suggestions); return; }

  // Fallback: highlight the entire editor container for the first suggestion.
  const container = document.querySelector(".monaco-editor, .cm-editor, .CodeMirror, .ace_editor, textarea");
  if (container && suggestions.length) {
    const s = suggestions[0];
    const key = getSuggestionKey(s);
    if (!dismissedSuggestionKeys.has(key)) {
      activeSuggestionByKey.set(key, s);
      const layer = getOrCreateOverlayLayer();
      renderHighlightBox(layer, container.getBoundingClientRect(), key, getSeverityClass(s));
    }
  }
}

// ── Hover + click handlers ───────────────────────────────────────────────────

function attachHoverHandlers() {
  if (hoverHandlersAttached) return;
  hoverHandlersAttached = true;

  document.addEventListener("mousemove", (event) => {
    if (event.target?.closest?.(`#${INLINE_CARD_ID}`)) {
      if (cardHideTimer) { clearTimeout(cardHideTimer); cardHideTimer = 0; }
      return;
    }
    const target = event.target?.closest?.(`.${OVERLAY_HIGHLIGHT_CLASS}`);
    if (!target) { scheduleHideInlineCard(); return; }
    if (cardHideTimer) { clearTimeout(cardHideTimer); cardHideTimer = 0; }
    const key = target.dataset.ccKey;
    const suggestion = key ? activeSuggestionByKey.get(key) : null;
    if (!suggestion) { scheduleHideInlineCard(); return; }
    showInlineCard(suggestion, target.getBoundingClientRect());
  });

  document.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("#cc-inline-card [data-cc-action]");
    if (!button || !currentCardSuggestion) return;
    const action = button.dataset.ccAction;

    if (action === "dismiss") {
      dismissedSuggestionKeys.add(getSuggestionKey(currentCardSuggestion));
      renderInlineSuggestions(latestResult || { suggestions: [] });
      return;
    }

    if (action === "apply-fix") {
      const result = await applyQuickFix(currentCardSuggestion);
      if (result?.ok) {
        const key = getSuggestionKey(currentCardSuggestion);
        dismissedSuggestionKeys.add(key);
        latestResult = {
          ...(latestResult || {}),
          suggestions: (latestResult?.suggestions || []).filter((s) => getSuggestionKey(s) !== key)
        };
        renderInlineSuggestions(latestResult);
      }
      button.textContent = result?.ok ? "Applied" : "Failed";
      setTimeout(() => { button.textContent = "Apply Fix"; }, 1200);
      return;
    }

    if (action === "copy-fix") {
      const text = String(currentCardSuggestion?.fix?.replacement || currentCardSuggestion?.message || "");
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch { button.textContent = "Failed"; }
      setTimeout(() => { button.textContent = "Copy Fix"; }, 1000);
    }
  });
}

// ── Snapshot publishing + idle detection ─────────────────────────────────────

let lastCode = "";
let timer = null;

function publishSnapshot(site, force = false) {
  const code = extractCode();
  if (!code) return;
  if (!force && code === lastCode) return;
  lastCode = code;
  showLoadingIndicator("Analyzing with backend...");
  safeSendMessage({
    type: "CODE_SNAPSHOT",
    payload: { code, language: detectLanguageByUrl(), site, url: window.location.href }
  });
}

function scheduleOverlayRerender() {
  if (overlayRafId) cancelAnimationFrame(overlayRafId);
  overlayRafId = requestAnimationFrame(() => {
    overlayRafId = 0;
    if (latestResult?.suggestions?.length) renderInlineSuggestions(latestResult);
  });
}

function scheduleSnapshot(site) {
  if (!runtimeSettings.autoAnalyze) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => publishSnapshot(site), runtimeSettings.idleTimeout);
}

function triggerManualAnalyze(site) {
  publishSnapshot(site, true);
  safeSendMessage({ type: "FORCE_REANALYZE" });
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function loadRuntimeSettings() {
  const settings = await safeStorageGet({ autoAnalyze: true, idleTimeout: 3000, analysisMode: "ai" });
  const idle = Number(settings?.idleTimeout);
  runtimeSettings = {
    autoAnalyze: settings?.autoAnalyze !== false,
    idleTimeout: Number.isInteger(idle) && idle >= 500 ? idle : 3000,
    analysisMode: "ai"
  };
}

async function isSupportedContext() {
  const site = detectSite();
  if (site) return { supported: true, site };
  const broad = await safeStorageGet({ broadDetection: false });
  if (!broad.broadDetection) return { supported: false, site: "unsupported" };
  const found = EDITOR_SELECTORS.some((sel) => document.querySelector(sel));
  return { supported: found, site: found ? "broad-detection" : "unsupported" };
}

async function requestLatestResultAndRender() {
  if (!hasExtensionContext()) return;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_LATEST_RESULT" });
    if (resp?.result) { latestResult = resp.result; renderInlineSuggestions(latestResult); }
  } catch { /* stale context */ }
}

async function start() {
  await loadRuntimeSettings();
  const status = await isSupportedContext();

  if (status.supported || window.top === window) {
    safeSendMessage({ type: "SITE_STATUS", site: status.site, supported: status.supported });
  }
  if (!status.supported) return;

  publishSnapshot(status.site);
  requestLatestResultAndRender();

  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.shiftKey && (event.key || "").toLowerCase() === "a") {
      event.preventDefault();
      triggerManualAnalyze(status.site);
      return;
    }
    scheduleSnapshot(status.site);
  });
  window.addEventListener("input", () => scheduleSnapshot(status.site), true);
  window.addEventListener("paste", () => scheduleSnapshot(status.site));
  window.addEventListener("scroll", () => scheduleOverlayRerender(), true);
  window.addEventListener("resize", () => scheduleOverlayRerender());

  if (hasExtensionContext()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (!changes.autoAnalyze && !changes.idleTimeout) return;
      loadRuntimeSettings().catch(() => {});
    });
  }
}

if (hasExtensionContext()) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ANALYSIS_RESULT") {
      latestResult = message.payload;
      dismissedSuggestionKeys.clear();
      renderInlineSuggestions(latestResult);
      hideLoadingIndicator();
      return;
    }
    if (message?.type === "ANALYSIS_ERROR") {
      clearInlineHighlights();
      hideLoadingIndicator();
      return;
    }
    if (message?.type === "APPLY_QUICK_FIX") {
      const suggestion = message?.payload?.suggestion;
      if (!suggestion) { sendResponse({ ok: false, error: "Missing suggestion." }); return true; }
      applyQuickFix(suggestion)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === "REQUEST_SNAPSHOT_AND_ANALYZE") {
      publishSnapshot(detectSite() || "broad-detection", true);
      sendResponse({ ok: true });
      return true;
    }
  });
}

start();