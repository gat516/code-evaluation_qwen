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
  analysisMode: "local"
};
let overlayRafId = 0;
let cardHideTimer = 0;
let loadingIndicatorTimer = 0;
const dismissedSuggestionKeys = new Set();

function hasExtensionContext() {
  return !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
}

async function safeStorageGet(defaults) {
  if (!hasExtensionContext()) {
    return defaults;
  }
  try {
    return await chrome.storage.sync.get(defaults);
  } catch {
    return defaults;
  }
}

function safeSendMessage(payload) {
  if (!hasExtensionContext()) {
    return;
  }
  try {
    const maybePromise = chrome.runtime.sendMessage(payload);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch {
    // Ignore stale content script after extension reload.
  }
}

function detectSite() {
  const host = window.location.hostname;
  const matched = ALLOWLIST.find((site) => site.hostIncludes.some((frag) => host.includes(frag)));
  return matched ? matched.name : null;
}

async function requestLatestResultAndRender() {
  if (!hasExtensionContext()) {
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_LATEST_RESULT" });
    if (response?.result) {
      latestResult = response.result;
      renderInlineSuggestions(latestResult);
    }
  } catch {
    // Ignore invalidated extension context for stale content scripts.
  }
}

function detectLanguageByUrl() {
  const url = window.location.href.toLowerCase();
  if (url.includes("python") || url.includes("py")) {
    return "python";
  }
  if (url.includes("javascript") || url.includes("js")) {
    return "javascript";
  }
  return "python";
}

function getMonacoFocusedEditor() {
  const monacoApi = window.monaco?.editor;
  if (!monacoApi || typeof monacoApi.getEditors !== "function") {
    return null;
  }

  try {
    const editors = monacoApi.getEditors() || [];
    if (!editors.length) {
      return null;
    }

    const focused = editors.find((editor) => {
      try {
        return typeof editor.hasTextFocus === "function" && editor.hasTextFocus();
      } catch {
        return false;
      }
    });

    return focused || editors[0] || null;
  } catch {
    return null;
  }
}

function extractFromMonacoApi() {
  const editor = getMonacoFocusedEditor();
  if (!editor) {
    return "";
  }

  try {
    if (typeof editor.getValue === "function") {
      return editor.getValue() || "";
    }
    const model = typeof editor.getModel === "function" ? editor.getModel() : null;
    if (model && typeof model.getValue === "function") {
      return model.getValue() || "";
    }
  } catch {
    return "";
  }

  return "";
}

function extractFromCodeMirrorApi() {
  const cm6Root = document.querySelector(".cm-editor");
  if (cm6Root) {
    try {
      const view = cm6Root.cmView?.view || cm6Root.cmView || cm6Root.view;
      if (view?.state?.doc && typeof view.state.doc.toString === "function") {
        return view.state.doc.toString() || "";
      }
    } catch {
      // Fall through.
    }
  }

  const cm5Root = document.querySelector(".CodeMirror");
  if (cm5Root?.CodeMirror && typeof cm5Root.CodeMirror.getValue === "function") {
    try {
      return cm5Root.CodeMirror.getValue() || "";
    } catch {
      return "";
    }
  }

  return "";
}

function extractFromAceApi() {
  const aceRoot = document.querySelector(".ace_editor");
  if (!aceRoot || !window.ace || typeof window.ace.edit !== "function") {
    return "";
  }

  try {
    const editor = window.ace.edit(aceRoot);
    if (editor && typeof editor.getValue === "function") {
      return editor.getValue() || "";
    }
  } catch {
    return "";
  }

  return "";
}

function extractFromMonaco() {
  const apiValue = extractFromMonacoApi();
  if (apiValue) {
    return apiValue;
  }

  const primaryMonaco = document.querySelector(".monaco-editor");
  if (!primaryMonaco) {
    return "";
  }
  const lineNodes = primaryMonaco.querySelectorAll(".view-lines .view-line");
  if (!lineNodes.length) {
    return "";
  }
  return Array.from(lineNodes)
    .map((node) => node.textContent || "")
    .join("\n");
}

function extractFromCodeMirror() {
  const apiValue = extractFromCodeMirrorApi();
  if (apiValue) {
    return apiValue;
  }

  const cmLines = document.querySelectorAll(".cm-editor .cm-content .cm-line, .CodeMirror .CodeMirror-code pre");
  if (!cmLines.length) {
    return "";
  }
  return Array.from(cmLines)
    .map((line) => line.textContent || "")
    .join("\n");
}

function extractFromAce() {
  const apiValue = extractFromAceApi();
  if (apiValue) {
    return apiValue;
  }

  const aceLines = document.querySelectorAll(".ace_editor .ace_text-layer .ace_line");
  if (!aceLines.length) {
    return "";
  }
  return Array.from(aceLines)
    .map((line) => line.textContent || "")
    .join("\n");
}

function extractFromTextarea() {
  const textareas = Array.from(document.querySelectorAll("textarea"));
  const ranked = textareas
    .map((ta) => ({ el: ta, len: (ta.value || "").length }))
    .sort((a, b) => b.len - a.len);

  return ranked[0]?.el?.value?.trim() || "";
}

function getPrimaryTextarea() {
  const textareas = Array.from(document.querySelectorAll("textarea"));
  if (!textareas.length) {
    return null;
  }

  const ranked = textareas
    .map((ta) => ({ el: ta, len: (ta.value || "").length }))
    .sort((a, b) => b.len - a.len);

  return ranked[0]?.el || null;
}

function extractCode() {
  return extractFromMonaco() || extractFromCodeMirror() || extractFromAce() || extractFromTextarea();
}

function getClampedLineIndex(lines, lineNumber) {
  const idx = Number(lineNumber) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) {
    return -1;
  }
  return idx;
}

function applyBeforeAfterSnippet(code, suggestion) {
  const before = String(suggestion?.before || "").trim();
  const after = String(suggestion?.after || "").trim();
  if (!before || !after) {
    return code;
  }

  const lines = code.split("\n");
  const beforeLines = before.split("\n").map((line) => line.trim());
  const beforeCount = beforeLines.length;
  if (!beforeCount) {
    return code;
  }

  for (let i = 0; i <= lines.length - beforeCount; i += 1) {
    let matches = true;
    for (let j = 0; j < beforeCount; j += 1) {
      if (String(lines[i + j] || "").trim() !== beforeLines[j]) {
        matches = false;
        break;
      }
    }

    if (!matches) {
      continue;
    }

    const parsedInts = beforeLines
      .map((line) => line.match(/\(\s*(-?\d+)\s*\)/))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    const isSequential = parsedInts.length === beforeCount
      && parsedInts.every((v, idx) => idx === 0 || v === parsedInts[idx - 1] + 1);

    if (!isSequential) {
      continue;
    }

    const startValue = parsedInts[0];
    const endExclusive = parsedInts[parsedInts.length - 1] + 1;
    const replacement = [`for i in range(${startValue}, ${endExclusive}):`, `    ${after}`];

    return [
      ...lines.slice(0, i),
      ...replacement,
      ...lines.slice(i + beforeCount)
    ].join("\n");
  }

  return code;
}

function applyPythonLoopRefactor(code, lineNumber) {
  // Keep a robust fallback path for legacy suggestions without before/after payloads.
  const lines = code.split("\n");
  const idx = getClampedLineIndex(lines, lineNumber);

  // Normalize hidden editor glyphs so pattern checks stay reliable.
  const normalizeLine = (val) => String(val || "").replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/\u00a0/g, " ");
  const numericPrintValue = (val) => {
    const match = normalizeLine(val).match(/^\s*print\s*\(\s*(-?\d+)\s*\)\s*;?\s*$/);
    return match ? Number(match[1]) : null;
  };
  const isNumericPrintLine = (val) => numericPrintValue(val) !== null;

  const runs = [];
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isNumericPrintLine(lines[i])) {
      if (start === -1) {
        start = i;
      }
    } else if (start !== -1) {
      runs.push({ start, end: i - 1, count: i - start });
      start = -1;
    }
  }
  if (start !== -1) {
    runs.push({ start, end: lines.length - 1, count: lines.length - start });
  }

  const eligibleRuns = runs.filter((run) => run.count >= 2);
  if (!eligibleRuns.length) {
    return code;
  }

  const anchoredRun = Number.isInteger(idx)
    ? eligibleRuns.find((run) => idx >= run.start && idx <= run.end)
    : null;

  const targetRun = anchoredRun || eligibleRuns.sort((a, b) => b.count - a.count)[0];
  if (!targetRun) {
    return code;
  }

  const values = lines.slice(targetRun.start, targetRun.end + 1).map((line) => numericPrintValue(line));
  if (values.some((v) => v === null)) {
    return code;
  }

  // Only refactor clean +1 numeric sequences (e.g. print(1)..print(6)).
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] !== values[i - 1] + 1) {
      return code;
    }
  }

  const startValue = values[0];
  const endExclusive = values[values.length - 1] + 1;

  const before = lines.slice(0, targetRun.start);
  const after = lines.slice(targetRun.end + 1);
  const replacement = [`for i in range(${startValue}, ${endExclusive}):`, "    print(i)"];

  const nextLine = normalizeLine(after[0] || "");
  const nextIndented = normalizeLine(after[1] || "");
  const sameLoopRegex = new RegExp(`^\\s*for\\s+i\\s+in\\s+range\\s*\\(\\s*${startValue}\\s*,\\s*${endExclusive}\\s*\\)\\s*:\\s*$`);
  const duplicateFollowingLoop = sameLoopRegex.test(nextLine) && /^\s*print\s*\(\s*i\s*\)\s*$/.test(nextIndented);

  const finalAfter = duplicateFollowingLoop ? after.slice(2) : after;
  return [...before, ...replacement, ...finalAfter].join("\n");
}

function applySecretFix(code, lineNumber) {
  const lines = code.split("\n");
  const idx = getClampedLineIndex(lines, lineNumber);
  if (idx === -1) {
    return code;
  }

  const line = lines[idx];
  const match = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*=.*$/);
  if (!match) {
    return code;
  }

  const varNameRaw = match[1];
  const varName = varNameRaw.replace(/-/g, "_");
  const keyName = varName.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const indent = (line.match(/^\s*/) || [""])[0];
  lines[idx] = `${indent}${varName} = os.getenv("${keyName}", "")`;

  let next = lines.join("\n");
  const hasImportOs = /^\s*import\s+os\s*$/m.test(next);
  if (!hasImportOs) {
    next = `import os\n${next}`;
  }
  return next;
}

function applyDynamicExecFix(code, lineNumber) {
  const lines = code.split("\n");
  const idx = getClampedLineIndex(lines, lineNumber);
  if (idx === -1) {
    return code;
  }

  const originalLine = lines[idx];
  let patchedLine = originalLine.replace(/\beval\(([^\n\)]*)\)/g, "ast.literal_eval($1)");
  patchedLine = patchedLine.replace(/\bexec\(([^\n\)]*)\)/g, "# exec removed for safety: $1");
  if (patchedLine === originalLine) {
    return code;
  }

  lines[idx] = patchedLine;
  let next = lines.join("\n");
  const hasImportAst = /^\s*import\s+ast\s*$/m.test(next);
  if (!hasImportAst && next !== code) {
    next = `import ast\n${next}`;
  }
  return next;
}

function applyTabsFix(code, lineNumber) {
  const lines = code.split("\n");
  const idx = getClampedLineIndex(lines, lineNumber);
  if (idx === -1) {
    return code;
  }
  lines[idx] = lines[idx].replace(/\t/g, "    ");
  return lines.join("\n");
}

function applyJsVarFix(code, lineNumber) {
  const lines = code.split("\n");
  const idx = getClampedLineIndex(lines, lineNumber);
  if (idx === -1) {
    return code;
  }
  lines[idx] = lines[idx].replace(/\bvar\b/g, "let");
  return lines.join("\n");
}

function applyJsEvalFix(code, lineNumber) {
  const lines = code.split("\n");
  const idx = getClampedLineIndex(lines, lineNumber);
  if (idx === -1) {
    return code;
  }
  lines[idx] = lines[idx].replace(/\beval\(/g, "/* eval removed */ (");
  return lines.join("\n");
}

function applyBackendSecurityFix(code, suggestion) {
  const text = `${suggestion?.message || ""} ${suggestion?.rationale || ""}`.toLowerCase();
  const lineNumber = suggestion?.anchor?.line;

  if (text.includes("secret") || text.includes("password") || text.includes("token") || text.includes("api key")) {
    return applySecretFix(code, lineNumber);
  }
  if (text.includes("eval") || text.includes("exec") || text.includes("dangerous")) {
    return applyDynamicExecFix(code, lineNumber);
  }
  if (text.includes("tab")) {
    return applyTabsFix(code, lineNumber);
  }
  return code;
}

function applyBackendQualityFix(code, suggestion) {
  const text = `${suggestion?.message || ""} ${suggestion?.rationale || ""}`.toLowerCase();
  const lineNumber = suggestion?.anchor?.line;

  if (text.includes("repeated") && text.includes("print")) {
    return applyPythonLoopRefactor(code, lineNumber);
  }

  return code;
}

function applyQuickFixToCode(code, ruleId, suggestion) {
  const lineNumber = suggestion?.anchor?.line;
  switch (ruleId) {
    case "python.loop.refactor":
      if (suggestion?.before && suggestion?.after) {
        const snippetResult = applyBeforeAfterSnippet(code, suggestion);
        if (snippetResult !== code) {
          return snippetResult;
        }
      }
      return applyPythonLoopRefactor(code, lineNumber);
    case "secrets.hardcoded":
      return applySecretFix(code, lineNumber);
    case "python.unsafe.dynamic-exec":
      return applyDynamicExecFix(code, lineNumber);
    case "style.tabs":
      return applyTabsFix(code, lineNumber);
    case "js.var.legacy":
      return applyJsVarFix(code, lineNumber);
    case "js.unsafe.eval":
      return applyJsEvalFix(code, lineNumber);
    case "security.warning":
      return applyBackendSecurityFix(code, suggestion);
    case "quality.review":
    case "quality.grade":
      return applyBackendQualityFix(code, suggestion);
    default:
      return code;
  }
}

function setCodeInTextarea(nextCode) {
  const textarea = getPrimaryTextarea();
  if (!textarea) {
    return false;
  }
  textarea.value = nextCode;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " " }));
  return true;
}

function setCodeInCodeMirror5(nextCode) {
  const cmRoot = document.querySelector(".CodeMirror");
  const cm = cmRoot && cmRoot.CodeMirror;
  if (!cm || typeof cm.setValue !== "function") {
    return false;
  }
  cm.setValue(nextCode);
  return true;
}

function setCodeInCodeMirror6(nextCode) {
  const cmRoot = document.querySelector(".cm-editor");
  if (!cmRoot) {
    return false;
  }

  const view = cmRoot.cmView?.view || cmRoot.cmView || cmRoot.view;
  if (!view || !view.state || typeof view.dispatch !== "function") {
    return false;
  }

  const from = 0;
  const to = view.state.doc.length;
  view.dispatch({ changes: { from, to, insert: nextCode } });
  return true;
}

function setCodeInAce(nextCode) {
  const aceRoot = document.querySelector(".ace_editor");
  if (!aceRoot || !window.ace || typeof window.ace.edit !== "function") {
    return false;
  }

  try {
    const editor = window.ace.edit(aceRoot);
    editor.setValue(nextCode, -1);
    return true;
  } catch {
    return false;
  }
}

function setCodeInMonaco(nextCode) {
  const editor = getMonacoFocusedEditor();
  if (!editor) {
    return false;
  }

  try {
    if (typeof editor.setValue === "function") {
      editor.setValue(nextCode);
      return true;
    }

    const model = typeof editor.getModel === "function" ? editor.getModel() : null;
    if (model && typeof model.setValue === "function") {
      model.setValue(nextCode);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

function setCodeInEditor(nextCode) {
  // Prefer concrete editor APIs first, then fallback to textarea writes.
  if (setCodeInMonaco(nextCode)) {
    return true;
  }
  if (setCodeInCodeMirror6(nextCode)) {
    return true;
  }
  if (setCodeInCodeMirror5(nextCode)) {
    return true;
  }
  if (setCodeInAce(nextCode)) {
    return true;
  }
  return setCodeInTextarea(nextCode);
}

function normalizeQuickFixSuggestion(ruleId, suggestion) {
  return {
    ...(suggestion || {}),
    rule_id: ruleId
  };
}

function canAttemptQuickFix(ruleId, suggestion) {
  if (suggestion?.prefetched_fix?.fixed_code) {
    return true;
  }
  if (suggestion?.after && String(suggestion.after).trim()) {
    return true;
  }
  if (suggestion?.fix?.replacement && String(suggestion.fix.replacement).trim()) {
    return true;
  }

  const supported = new Set([
    "python.loop.refactor",
    "secrets.hardcoded",
    "python.unsafe.dynamic-exec",
    "style.tabs",
    "js.var.legacy",
    "js.unsafe.eval",
    "security.warning"
  ]);
  return supported.has(String(ruleId || ""));
}

function shouldQueryBackendForQuickFix(ruleId) {
  if (!hasExtensionContext()) {
    return { allowed: false, reason: "Extension context unavailable for backend fix request." };
  }

  const language = detectLanguageByUrl();
  if (language !== "python") {
    return { allowed: false, reason: `Backend quick-fix is disabled for ${language}.` };
  }

  const localOnlyRules = new Set([
    "js.var.legacy",
    "js.unsafe.eval"
  ]);
  if (localOnlyRules.has(ruleId)) {
    return { allowed: false, reason: "Rule is handled locally and does not require backend validation." };
  }

  const disallowedRules = new Set([
    "info.no-issues",
    "analysis.error"
  ]);
  if (disallowedRules.has(ruleId)) {
    return { allowed: false, reason: "Rule is informational and does not support automated fixes." };
  }

  return { allowed: true, reason: "Backend validation enabled." };
}

async function requestBackendQuickFix(code, ruleId, suggestion, previewOnly = false) {
  const prefetchedCode = String(suggestion?.prefetched_fix?.fixed_code || "");
  if (!previewOnly && prefetchedCode && prefetchedCode !== code) {
    return { ok: true, code: prefetchedCode, source: "backend-prefetched" };
  }

  // For Python, fixes are prefetched during analysis; do not trigger a new backend query on click.
  if (!previewOnly && detectLanguageByUrl() === "python") {
    return { ok: false, reason: "Fix is not ready yet. Wait for analysis to finish and try again." };
  }

  if (!canAttemptQuickFix(ruleId, suggestion)) {
    return { ok: false, reason: "This suggestion does not include an automatic fix." };
  }

  const backendGate = shouldQueryBackendForQuickFix(ruleId);
  if (!backendGate.allowed) {
    return { ok: false, reason: backendGate.reason };
  }

  try {
    const backendFix = await chrome.runtime.sendMessage({
      type: "VALIDATE_QUICK_FIX",
      payload: {
        code,
        language: detectLanguageByUrl(),
        suggestion: normalizeQuickFixSuggestion(ruleId, suggestion),
        previewOnly
      }
    });

    const candidate = backendFix?.candidateCode || backendFix?.fixedCode || "";
    if (previewOnly) {
      if (!candidate || candidate === code) {
        return {
          ok: false,
          reason: backendFix?.error || backendFix?.message || "Backend preview could not produce a code change."
        };
      }
      return {
        ok: true,
        code: candidate,
        source: "backend-preview",
        message: backendFix?.message || "Preview generated by AI backend."
      };
    }

    if (!backendFix?.ok || !backendFix?.fixedCode) {
      return {
        ok: false,
        reason: backendFix?.error || backendFix?.message || "Backend could not validate a safe fix for this suggestion."
      };
    }

    if (backendFix.fixedCode === code) {
      return { ok: false, reason: "Backend validated a fix but it produced no changes." };
    }

    return { ok: true, code: backendFix.fixedCode, source: "backend-validated" };
  } catch {
    return { ok: false, reason: "Backend fix service unavailable." };
  }
}

function requestLocalQuickFix(code, ruleId, suggestion) {
  if (!canAttemptQuickFix(ruleId, suggestion)) {
    return { ok: false, reason: "This suggestion does not include a local fix transform." };
  }

  if (detectLanguageByUrl() === "python") {
    return { ok: false, reason: "Local Python fallback disabled: AI backend owns Python fixes." };
  }

  const localCode = applyQuickFixToCode(code, ruleId, normalizeQuickFixSuggestion(ruleId, suggestion));
  if (!localCode || localCode === code) {
    return { ok: false, reason: "Local fallback could not produce a safe edit for this suggestion." };
  }
  return { ok: true, code: localCode, source: "local-fallback" };
}

function buildQuickFixFailure(primaryReason, fallbackReason) {
  if (primaryReason && fallbackReason) {
    return `${primaryReason} Local fallback also failed: ${fallbackReason}`;
  }
  return primaryReason || fallbackReason || "Quick fix could not be applied.";
}

async function applyQuickFix(ruleId, suggestion) {
  const original = extractCode();
  if (!original) {
    return { ok: false, error: "No code found in active editor." };
  }

  showLoadingIndicator("Applying backend fix...");
  const backendResult = await requestBackendQuickFix(original, ruleId, suggestion);
  let selectedResult = backendResult;

  // Python fixes are server-owned to keep behavior consistent with backend validation.
  if (detectLanguageByUrl() === "python") {
    if (!backendResult.ok) {
      hideLoadingIndicator();
      return {
        ok: false,
        error: backendResult.reason || "Backend could not apply a safe fix."
      };
    }
  } else if (!backendResult.ok) {
    const localResult = requestLocalQuickFix(original, ruleId, suggestion);
    if (!localResult.ok) {
      hideLoadingIndicator();
      return {
        ok: false,
        error: buildQuickFixFailure(backendResult.reason, localResult.reason)
      };
    }
    selectedResult = localResult;
  }

  const wrote = setCodeInEditor(selectedResult.code);
  if (!wrote) {
    hideLoadingIndicator();
    return { ok: false, error: "Unable to apply quick fix in this editor." };
  }

  lastCode = "";
  const site = detectSite() || "broad-detection";
  publishSnapshot(site);
  safeSendMessage({ type: "FORCE_REANALYZE" });
  if (runtimeSettings.analysisMode !== "ai") {
    hideLoadingIndicator();
  }
  return { ok: true, source: selectedResult.source };
}

function ensureInlineStyles() {
  if (document.getElementById(INLINE_STYLE_ID)) {
    return;
  }

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
      position: fixed;
      inset: 0;
      z-index: 2147483638;
      pointer-events: none;
    }
    .${OVERLAY_HIGHLIGHT_CLASS} {
      position: fixed;
      pointer-events: auto;
      border-radius: 3px;
      border-bottom: 2px wavy #ef4444;
      background: rgba(239, 68, 68, 0.08);
    }
    .${OVERLAY_HIGHLIGHT_CLASS}.cc-medium {
      border-bottom-color: #f97316;
      background: rgba(249, 115, 22, 0.1);
    }
    .${OVERLAY_HIGHLIGHT_CLASS}.cc-low {
      border-bottom-color: #f59e0b;
      background: rgba(245, 158, 11, 0.09);
    }
    .cc-inline-block-highlight {
      outline: 2px solid rgba(239, 68, 68, 0.4);
      outline-offset: 2px;
      border-radius: 6px;
    }
    #${INLINE_CARD_ID} {
      position: fixed;
      z-index: 2147483640;
      max-width: 320px;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid #fca5a5;
      background: #fff7f7;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
      color: #111827;
      font-size: 12px;
      line-height: 1.35;
      display: none;
      pointer-events: auto;
    }
    #${INLINE_CARD_ID}.cc-medium {
      border-color: #fdba74;
      background: #fff7ed;
    }
    #${INLINE_CARD_ID}.cc-low {
      border-color: #fde68a;
      background: #fffbeb;
    }
    #${INLINE_CARD_ID} strong {
      display: block;
      margin-bottom: 5px;
      font-size: 12px;
    }
    #${INLINE_CARD_ID} .cc-rationale {
      color: #334155;
    }
    #${INLINE_CARD_ID} .cc-fix-preview {
      margin-top: 8px;
      border: 1px solid rgba(15, 23, 42, 0.14);
      background: #f8fafc;
      border-radius: 6px;
      padding: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 11px;
      white-space: pre-wrap;
      max-height: 120px;
      overflow: auto;
    }
    #${INLINE_CARD_ID} .cc-actions {
      margin-top: 8px;
    }
    #${INLINE_CARD_ID} button {
      border: 1px solid #0f766e;
      background: #0f766e;
      color: #ffffff;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    #${LOADING_INDICATOR_ID} {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 2147483641;
      display: none;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: 1px solid rgba(15, 23, 42, 0.15);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.98);
      color: #0f172a;
      font-size: 12px;
      box-shadow: 0 6px 20px rgba(15, 23, 42, 0.14);
      pointer-events: none;
    }
    #${LOADING_INDICATOR_ID} .cc-spinner {
      width: 12px;
      height: 12px;
      border: 2px solid rgba(15, 118, 110, 0.25);
      border-top-color: #0f766e;
      border-radius: 50%;
      animation: cc-spin 0.85s linear infinite;
    }
    @keyframes cc-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

function getOrCreateLoadingIndicator() {
  let indicator = document.getElementById(LOADING_INDICATOR_ID);
  if (indicator) {
    return indicator;
  }

  indicator = document.createElement("div");
  indicator.id = LOADING_INDICATOR_ID;
  indicator.innerHTML = '<span class="cc-spinner"></span><span class="cc-label">Querying backend...</span>';
  document.body.appendChild(indicator);
  return indicator;
}

function showLoadingIndicator(label = "Querying backend...") {
  ensureInlineStyles();
  const indicator = getOrCreateLoadingIndicator();
  const labelNode = indicator.querySelector(".cc-label");
  if (labelNode) {
    labelNode.textContent = label;
  }
  indicator.style.display = "inline-flex";

  if (loadingIndicatorTimer) {
    clearTimeout(loadingIndicatorTimer);
  }
  loadingIndicatorTimer = setTimeout(() => {
    loadingIndicatorTimer = 0;
    hideLoadingIndicator();
  }, LOADING_INDICATOR_TIMEOUT_MS);
}

function hideLoadingIndicator() {
  if (loadingIndicatorTimer) {
    clearTimeout(loadingIndicatorTimer);
    loadingIndicatorTimer = 0;
  }
  const indicator = document.getElementById(LOADING_INDICATOR_ID);
  if (indicator) {
    indicator.style.display = "none";
  }
}

function getOrCreateInlineCard() {
  let card = document.getElementById(INLINE_CARD_ID);
  if (card) {
    return card;
  }
  card = document.createElement("div");
  card.id = INLINE_CARD_ID;
  document.body.appendChild(card);
  return card;
}

function escapeInlineHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getPrefetchedPreviewForRange(suggestion) {
  const fixedCode = String(suggestion?.prefetched_fix?.fixed_code || "");
  if (!fixedCode) {
    return "";
  }

  const range = suggestion?.fix?.range || {};
  const startLine = Number(range.startLine || suggestion?.line || suggestion?.anchor?.line || 1);
  const endLineRaw = Number(range.endLine || suggestion?.end_line || startLine);
  const endLine = Number.isInteger(endLineRaw) && endLineRaw >= startLine ? endLineRaw : startLine;

  const lines = fixedCode.split("\n");
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > lines.length) {
    return "";
  }

  const boundedEnd = Math.min(endLine, lines.length);
  return lines.slice(startLine - 1, boundedEnd).join("\n").trim();
}

function getInlineFixPreviewText(suggestion) {
  const replacement = String(suggestion?.after || suggestion?.fix?.replacement || "").trim();
  if (replacement) {
    return replacement;
  }
  return getPrefetchedPreviewForRange(suggestion);
}

function showInlineCard(suggestion, rect) {
  const card = getOrCreateInlineCard();
  if (cardHideTimer) {
    clearTimeout(cardHideTimer);
    cardHideTimer = 0;
  }
  const severityToken = String(suggestion?.legacySeverity || suggestion?.severity || "info").toLowerCase();
  const sevClass = severityToken === "high" || severityToken === "error"
    ? "cc-high"
    : severityToken === "medium" || severityToken === "warning"
      ? "cc-medium"
      : "cc-low";
  currentCardSuggestion = suggestion;

  const fixText = getInlineFixPreviewText(suggestion);
  const hasFix = !!String(fixText).trim();
  const actionText = hasFix ? "Copy suggested fix" : "Copy suggestion details";
  const canApply = canAttemptQuickFix(suggestion?.rule_id, suggestion);

  card.className = sevClass;
  card.innerHTML = `
    <strong>${suggestion.message}</strong>
    <div><em>${suggestion.category || "issue"} | ${suggestion.severity || suggestion.legacySeverity || "info"}</em></div>
    <div class="cc-rationale">${suggestion.rationale || suggestion.message || "No details provided."}</div>
    ${hasFix ? `<div class="cc-fix-preview">${escapeInlineHtml(fixText)}</div>` : ""}
    <div class="cc-actions">
      ${canApply ? '<button type="button" data-cc-action="apply-fix">Apply Fix</button>' : ""}
      <button type="button" data-cc-action="dismiss">Dismiss</button>
      <button type="button" data-cc-action="copy-fix">${actionText}</button>
    </div>
  `;

  const left = Math.min(window.innerWidth - 340, rect.left + 8);
  const top = Math.min(window.innerHeight - 150, rect.bottom + 8);

  card.style.left = `${Math.max(8, left)}px`;
  card.style.top = `${Math.max(8, top)}px`;
  card.style.display = "block";
}

function hideInlineCard() {
  if (cardHideTimer) {
    clearTimeout(cardHideTimer);
    cardHideTimer = 0;
  }
  const card = document.getElementById(INLINE_CARD_ID);
  if (card) {
    card.style.display = "none";
  }
  currentCardSuggestion = null;
}

function scheduleHideInlineCard() {
  if (cardHideTimer) {
    clearTimeout(cardHideTimer);
  }
  cardHideTimer = setTimeout(() => {
    cardHideTimer = 0;
    hideInlineCard();
  }, CARD_HIDE_DELAY_MS);
}

function getOrCreateOverlayLayer() {
  let layer = document.getElementById(OVERLAY_LAYER_ID);
  if (layer) {
    return layer;
  }

  layer = document.createElement("div");
  layer.id = OVERLAY_LAYER_ID;
  document.body.appendChild(layer);
  return layer;
}

function clearOverlayLayer() {
  const layer = document.getElementById(OVERLAY_LAYER_ID);
  if (layer) {
    layer.innerHTML = "";
  }
}

function clearInlineHighlights() {
  clearOverlayLayer();
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
    el.classList.remove(HIGHLIGHT_CLASS, "cc-high", "cc-medium", "cc-low", "cc-inline-block-highlight");
    el.removeAttribute("data-cc-key");
  });
  activeSuggestionByKey = new Map();
  hideInlineCard();
}

function getSeverityClass(suggestion) {
  const severityToken = String(suggestion?.legacySeverity || suggestion?.severity || "info").toLowerCase();
  if (severityToken === "high" || severityToken === "error") {
    return "cc-high";
  }
  if (severityToken === "medium" || severityToken === "warning") {
    return "cc-medium";
  }
  return "cc-low";
}

function getSuggestionKey(suggestion, lineNumber) {
  const start = Number(suggestion?.line || suggestion?.anchor?.line || lineNumber || 1);
  const end = Number(suggestion?.end_line || start);
  const message = String(suggestion?.message || "rule").trim().toLowerCase();
  return `${suggestion.rule_id || "rule"}:${start}:${end}:${message}`;
}

function renderHighlightBox(layer, rect, key, severityClass) {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return;
  }

  const highlight = document.createElement("div");
  highlight.className = `${OVERLAY_HIGHLIGHT_CLASS} ${severityClass}`;
  highlight.dataset.ccKey = key;
  highlight.style.left = `${Math.max(0, rect.left)}px`;
  highlight.style.top = `${Math.max(0, rect.top)}px`;
  highlight.style.width = `${Math.max(10, rect.width)}px`;
  highlight.style.height = `${Math.max(6, rect.height)}px`;
  layer.appendChild(highlight);
}

function renderOverlaysFromLineNodes(lineNodes, suggestions) {
  const layer = getOrCreateOverlayLayer();

  suggestions.forEach((suggestion) => {
    const startLine = Number(suggestion?.line || suggestion?.anchor?.line || 1);
    const endLineRaw = Number(suggestion?.end_line || suggestion?.endLine || startLine);
    const endLine = Number.isInteger(endLineRaw) && endLineRaw >= startLine ? endLineRaw : startLine;
    if (!Number.isInteger(startLine) || startLine < 1) {
      return;
    }

    const key = getSuggestionKey(suggestion, startLine);
    if (dismissedSuggestionKeys.has(key)) {
      return;
    }
    activeSuggestionByKey.set(key, suggestion);
    const severityClass = getSeverityClass(suggestion);

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      const lineNode = lineNodes[lineNumber - 1];
      if (!lineNode || typeof lineNode.getBoundingClientRect !== "function") {
        continue;
      }

      const rect = lineNode.getBoundingClientRect();
      renderHighlightBox(layer, rect, key, severityClass);
    }
  });
}

function renderOverlayForElement(element, suggestion, lineNumber) {
  if (!element || typeof element.getBoundingClientRect !== "function") {
    return;
  }

  const key = getSuggestionKey(suggestion, lineNumber);
  if (dismissedSuggestionKeys.has(key)) {
    return;
  }
  activeSuggestionByKey.set(key, suggestion);

  const layer = getOrCreateOverlayLayer();
  const rect = element.getBoundingClientRect();
  renderHighlightBox(layer, rect, key, getSeverityClass(suggestion));
}

function getNormalizedSuggestions(suggestions) {
  return suggestions.map((item, index) => {
    const line = Number(item?.line || item?.anchor?.line || index + 1);
    return {
      ...item,
      line: Number.isInteger(line) && line > 0 ? line : index + 1,
      anchor: { line: Number.isInteger(line) && line > 0 ? line : index + 1 }
    };
  });
}

function hasRenderableFixSuggestion(suggestion) {
  if (detectLanguageByUrl() === "python") {
    return Boolean(String(suggestion?.prefetched_fix?.fixed_code || "").trim());
  }
  const replacement = String(suggestion?.after || suggestion?.fix?.replacement || "").trim();
  const prefetchedCode = String(suggestion?.prefetched_fix?.fixed_code || "").trim();
  return Boolean(replacement || prefetchedCode);
}

function renderFallbackContainerOverlay(suggestions) {
  const editorContainer = document.querySelector(".monaco-editor, .cm-editor, .CodeMirror, .ace_editor");
  if (!editorContainer || !suggestions.length) {
    return;
  }

  const firstSuggestion = suggestions[0];
  const lineNumber = Number(firstSuggestion?.line || firstSuggestion?.anchor?.line || 1);
  renderOverlayForElement(editorContainer, firstSuggestion, lineNumber);
}

function attachHoverHandlers() {
  if (hoverHandlersAttached) {
    return;
  }
  hoverHandlersAttached = true;

  document.addEventListener("mousemove", (event) => {
    const card = event.target?.closest?.(`#${INLINE_CARD_ID}`);
    if (card) {
      if (cardHideTimer) {
        clearTimeout(cardHideTimer);
        cardHideTimer = 0;
      }
      return;
    }

    const target = event.target?.closest?.(`.${OVERLAY_HIGHLIGHT_CLASS}`);
    if (!target) {
      scheduleHideInlineCard();
      return;
    }

    if (cardHideTimer) {
      clearTimeout(cardHideTimer);
      cardHideTimer = 0;
    }

    const key = target.dataset.ccKey;
    if (!key) {
      scheduleHideInlineCard();
      return;
    }

    const suggestion = activeSuggestionByKey.get(key);
    if (!suggestion) {
      scheduleHideInlineCard();
      return;
    }

    const rect = target.getBoundingClientRect();
    showInlineCard(suggestion, rect);
  });

  document.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("#cc-inline-card [data-cc-action]");
    if (!button || !currentCardSuggestion) {
      return;
    }

    const action = button.dataset.ccAction;

    if (action === "dismiss") {
      const key = getSuggestionKey(currentCardSuggestion, Number(currentCardSuggestion?.line || currentCardSuggestion?.anchor?.line || 1));
      dismissedSuggestionKeys.add(key);
      renderInlineSuggestions(latestResult || { suggestions: [] });
      return;
    }

    if (action === "apply-fix") {
      const ruleId = currentCardSuggestion?.rule_id;
      if (!ruleId) {
        button.textContent = "No fix";
        return;
      }
      const result = await applyQuickFix(ruleId, currentCardSuggestion);
      if (result?.ok) {
        const appliedKey = getSuggestionKey(
          currentCardSuggestion,
          Number(currentCardSuggestion?.line || currentCardSuggestion?.anchor?.line || 1)
        );
        const remainingSuggestions = (latestResult?.suggestions || []).filter((item) => {
          const itemKey = getSuggestionKey(item, Number(item?.line || item?.anchor?.line || 1));
          return itemKey !== appliedKey;
        });
        latestResult = {
          ...(latestResult || {}),
          suggestions: remainingSuggestions
        };
        dismissedSuggestionKeys.add(appliedKey);
        renderInlineSuggestions(latestResult);
      }
      button.textContent = result?.ok ? "Applied" : "Apply failed";
      setTimeout(() => {
        button.textContent = "Apply Fix";
      }, 1200);
      return;
    }

    if (action !== "copy-fix") {
      return;
    }

    const fixPayload = currentCardSuggestion.after
      || currentCardSuggestion?.fix?.replacement
      || `${currentCardSuggestion.message}\n\n${currentCardSuggestion.rationale || "No rationale provided."}`;
    try {
      await navigator.clipboard.writeText(fixPayload);
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = currentCardSuggestion?.after ? "Copy suggested fix" : "Copy suggestion details";
      }, 1000);
    } catch {
      button.textContent = "Copy failed";
    }
  });
}

function renderInlineSuggestions(result) {
  ensureInlineStyles();
  attachHoverHandlers();
  clearInlineHighlights();

  const suggestions = (result?.suggestions || []).filter((item) => hasRenderableFixSuggestion(item));
  if (!suggestions.length) {
    return;
  }

  const normalizedSuggestions = getNormalizedSuggestions(suggestions);

  const monacoLines = Array.from(document.querySelectorAll(".monaco-editor .view-lines .view-line, .view-lines .view-line"));
  if (monacoLines.length) {
    renderOverlaysFromLineNodes(monacoLines, normalizedSuggestions);
    return;
  }

  const codeMirrorLines = Array.from(document.querySelectorAll(".cm-editor .cm-line, .cm-content .cm-line, .CodeMirror-code pre"));
  if (codeMirrorLines.length) {
    renderOverlaysFromLineNodes(codeMirrorLines, normalizedSuggestions);
    return;
  }

  const aceLines = Array.from(document.querySelectorAll(".ace_line"));
  if (aceLines.length) {
    renderOverlaysFromLineNodes(aceLines, normalizedSuggestions);
    return;
  }

  const textarea = document.querySelector("textarea");
  if (textarea) {
    const firstSuggestion = normalizedSuggestions[0];
    const lineNumber = Number(firstSuggestion?.line || firstSuggestion?.anchor?.line || 1);
    renderOverlayForElement(textarea, firstSuggestion, lineNumber);
    return;
  }

  renderFallbackContainerOverlay(normalizedSuggestions);
}

async function shouldEnableBroadMode() {
  const settings = await safeStorageGet({ broadDetection: false });
  return !!settings.broadDetection;
}

async function loadRuntimeSettings() {
  const settings = await safeStorageGet({
    autoAnalyze: true,
    idleTimeout: 3000,
    analysisMode: "local"
  });
  const nextIdle = Number(settings?.idleTimeout);
  runtimeSettings = {
    autoAnalyze: settings?.autoAnalyze !== false,
    idleTimeout: Number.isInteger(nextIdle) && nextIdle >= 500 ? nextIdle : 3000,
    analysisMode: String(settings?.analysisMode || "local").toLowerCase() === "ai" ? "ai" : "local"
  };
}

async function isSupportedContext() {
  const site = detectSite();
  if (site) {
    return { supported: true, site };
  }

  const broadMode = await shouldEnableBroadMode();
  if (!broadMode) {
    return { supported: false, site: "unsupported" };
  }

  const foundEditor = EDITOR_SELECTORS.some((selector) => document.querySelector(selector));
  return { supported: foundEditor, site: foundEditor ? "broad-detection" : "unsupported" };
}

let lastCode = "";
let timer = null;

function publishSnapshot(site, force = false) {
  const code = extractCode();
  if (!code) {
    return;
  }
  if (!force && code === lastCode) {
    return;
  }
  lastCode = code;

  if (runtimeSettings.analysisMode === "ai") {
    showLoadingIndicator("Analyzing with backend...");
  }

  safeSendMessage({
    type: "CODE_SNAPSHOT",
    payload: {
      code,
      language: detectLanguageByUrl(),
      site,
      url: window.location.href
    }
  });
}

function scheduleOverlayRerender() {
  if (overlayRafId) {
    cancelAnimationFrame(overlayRafId);
  }

  overlayRafId = requestAnimationFrame(() => {
    overlayRafId = 0;
    if (latestResult?.suggestions?.length) {
      renderInlineSuggestions(latestResult);
    }
  });
}

function scheduleSnapshot(site) {
  if (!runtimeSettings.autoAnalyze) {
    return;
  }
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => publishSnapshot(site), runtimeSettings.idleTimeout);
}

function triggerManualAnalyze(site) {
  publishSnapshot(site, true);
  safeSendMessage({ type: "FORCE_REANALYZE" });
}

async function start() {
  await loadRuntimeSettings();
  const status = await isSupportedContext();

  // In iframe-heavy sites, only the frame with editor should mark supported.
  if (status.supported || window.top === window) {
    safeSendMessage({
      type: "SITE_STATUS",
      site: status.site,
      supported: status.supported
    });
  }

  if (!status.supported) {
    return;
  }

  publishSnapshot(status.site);
  requestLatestResultAndRender();

  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.shiftKey && String(event.key || "").toLowerCase() === "a") {
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
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }
      if (!changes.autoAnalyze && !changes.idleTimeout && !changes.analysisMode) {
        return;
      }
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
      const ruleId = message?.payload?.ruleId;
      if (!ruleId) {
        sendResponse({ ok: false, error: "Missing rule id for quick fix." });
        return true;
      }
      applyQuickFix(ruleId, message?.payload?.suggestion || null)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error || "Quick fix failed") }));
      return true;
    }
  });
}

start();
