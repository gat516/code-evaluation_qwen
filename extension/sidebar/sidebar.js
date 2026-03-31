async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

let latestSuggestions = [];
let previewState = {
  visible: false,
  meta: "",
  code: ""
};

function clearPreview() {
  const section = document.getElementById("previewSection");
  section.classList.add("hidden");
  document.getElementById("previewMeta").textContent = "";
  document.getElementById("previewCode").textContent = "";
  previewState = {
    visible: false,
    meta: "",
    code: ""
  };
}

function renderPreview(message, code, source) {
  const section = document.getElementById("previewSection");
  const meta = `${message || "Preview generated."}${source ? ` | ${source}` : ""}`;
  const previewCode = code || "No preview available.";
  section.classList.remove("hidden");
  document.getElementById("previewMeta").textContent = meta;
  document.getElementById("previewCode").textContent = previewCode;
  previewState = {
    visible: true,
    meta,
    code: previewCode
  };
}

function restorePreview() {
  if (!previewState.visible) {
    return;
  }
  const section = document.getElementById("previewSection");
  section.classList.remove("hidden");
  document.getElementById("previewMeta").textContent = previewState.meta;
  document.getElementById("previewCode").textContent = previewState.code;
}

function suggestionsFingerprint(items) {
  return JSON.stringify((items || []).map((item) => ({
    rule: item?.rule_id || "",
    msg: item?.message || "",
    line: item?.line || item?.anchor?.line || 0,
    sev: item?.severity || item?.legacySeverity || ""
  })));
}

let lastSuggestionsFingerprint = "";

function hasQuickFix(item) {
  if (!item) {
    return false;
  }

  const ruleId = String(item?.rule_id || "");
  if (ruleId === "info.no-issues" || ruleId === "analysis.error") {
    return false;
  }

  if ((item.after && String(item.after).trim()) || (item?.fix?.replacement && String(item.fix.replacement).trim())) {
    return true;
  }

  const quickFixRules = new Set([
    "python.loop.refactor",
    "secrets.hardcoded",
    "python.unsafe.dynamic-exec",
    "style.tabs",
    "js.var.legacy",
    "js.unsafe.eval",
    "security.warning"
  ]);

  return quickFixRules.has(item.rule_id);
}

function buildQuickFix(item) {
  if (item?.after && String(item.after).trim()) {
    return String(item.after);
  }

  if (item?.fix?.replacement && String(item.fix.replacement).trim()) {
    return String(item.fix.replacement);
  }

  return null;
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    const feedback = document.getElementById("copyFeedback");
    feedback.textContent = "Copied to clipboard.";
    setTimeout(() => {
      feedback.textContent = "";
    }, 1200);
  } catch {
    const feedback = document.getElementById("copyFeedback");
    feedback.textContent = "Copy failed.";
  }
}

function setFeedback(text) {
  const feedback = document.getElementById("copyFeedback");
  feedback.textContent = text;
  if (!text) {
    return;
  }
  setTimeout(() => {
    feedback.textContent = "";
  }, 1400);
}

async function applyQuickFixToActiveTab(item) {
  const tabId = await getActiveTabId();
  if (!tabId) {
    setFeedback("No active tab.");
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "APPLY_QUICK_FIX",
      payload: {
        ruleId: item.rule_id,
        suggestion: item
      }
    });

    if (response?.ok) {
      if (response?.source === "backend-validated" || response?.source === "backend-prefetched") {
        setFeedback("Quick fix applied (backend validated).");
      } else {
        setFeedback("Quick fix applied (local fallback).");
      }
      await chrome.runtime.sendMessage({ type: "MANUAL_ANALYZE", tabId });
      await refreshState();
      return;
    }

    setFeedback(response?.error || "Unable to apply quick fix.");
  } catch {
    setFeedback("Unable to reach page editor for auto-fix.");
  }
}

function renderSuggestions(items) {
  const root = document.getElementById("suggestions");
  root.innerHTML = "";
  latestSuggestions = items || [];

  const nextFingerprint = suggestionsFingerprint(items);
  const changed = nextFingerprint !== lastSuggestionsFingerprint;
  lastSuggestionsFingerprint = nextFingerprint;
  if (changed) {
    clearPreview();
  } else {
    restorePreview();
  }

  if (!items?.length) {
    root.textContent = "No suggestions yet.";
    return;
  }

  items.forEach((item, index) => {
    const lineNumber = Number(item?.line || item?.anchor?.line);
    const line = Number.isInteger(lineNumber) && lineNumber > 0 ? ` | line ${lineNumber}` : "";
    const canApplyFix = hasQuickFix(item);
    const quickFixPreview = buildQuickFix(item);
    const canCopyFix = !!quickFixPreview;
    const severityToken = String(item?.legacySeverity || item?.severity || "low").toLowerCase();
    const cardSeverity = severityToken === "error" ? "high" : severityToken === "warning" ? "medium" : severityToken;
    const el = document.createElement("article");
    el.className = `suggestion ${cardSeverity || "low"}`;
    el.innerHTML = `
      <div class="meta">${item.category || "issue"} | ${item.severity || item.legacySeverity || "info"}${line} | confidence ${Math.round((item.confidence || 0) * 100)}%</div>
      <strong>${item.message}</strong>
      <p>${item.rationale || "No rationale provided."}</p>
      <div class="item-actions">
        ${canApplyFix
            ? `<button class="secondary" data-action="apply-fix" data-index="${index}">Apply quick fix</button>
             ${canCopyFix ? `<button class="secondary" data-action="copy-fix" data-index="${index}">Copy quick fix</button>` : ""}`
          : `<span class="no-fix">No auto-fix available for this suggestion.</span>`}
      </div>
    `;
    root.appendChild(el);
  });
}

function renderSummary(state) {
  const summary = document.getElementById("summary");
  const status = document.getElementById("status");

  if (!state) {
    status.textContent = "Open a supported coding tab to start.";
    summary.textContent = "No active analysis state.";
    renderSuggestions([]);
    return;
  }

  status.textContent = `Status: ${state.status || "idle"}${state.site ? ` on ${state.site}` : ""}`;

  if (state.status === "error") {
    summary.textContent = `Error: ${state.error || "Unknown analysis error"}`;
    renderSuggestions([]);
    return;
  }

  const suggestions = state.result?.suggestions || [];
  const fallbackWarning = state.result?.metadata?.fallback_warning || "";
  const highCount = suggestions.filter((item) => {
    const token = String(item?.legacySeverity || item?.severity || "").toLowerCase();
    return token === "high" || token === "error";
  }).length;
  if (suggestions.length) {
    summary.textContent = `${suggestions.length} suggestion(s)${highCount ? ` | ${highCount} high priority` : ""}${fallbackWarning ? ` | ${fallbackWarning}` : ""}`;
  } else {
    summary.textContent = fallbackWarning || "Analysis in progress or not available yet.";
  }

  if (fallbackWarning) {
    status.textContent = `Status: ${state.status || "idle"}${state.site ? ` on ${state.site}` : ""} | local fallback`;
  }

  renderSuggestions(suggestions);
}

async function refreshState() {
  const tabId = await getActiveTabId();
  if (!tabId) {
    renderSummary(null);
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "GET_TAB_STATE", tabId });
  renderSummary(response?.state || null);
}

async function requestManualAnalyze() {
  const tabId = await getActiveTabId();
  if (!tabId) {
    return;
  }
  clearPreview();
  await chrome.runtime.sendMessage({ type: "MANUAL_ANALYZE", tabId });
  await refreshState();
}

function onSuggestionActionClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const index = Number(button.dataset.index);
  if (Number.isNaN(index) || !latestSuggestions[index]) {
    return;
  }

  const item = latestSuggestions[index];
  const action = button.dataset.action;

  if (action === "copy-fix") {
    const quickFix = buildQuickFix(item);
    if (!quickFix) {
      setFeedback("No quick fix available for this suggestion.");
      return;
    }
    copyTextToClipboard(quickFix);
  } else if (action === "apply-fix") {
    if (!hasQuickFix(item)) {
      setFeedback("No quick fix available for this suggestion.");
      return;
    }
    applyQuickFixToActiveTab(item);
  }
}

document.getElementById("refreshBtn").addEventListener("click", requestManualAnalyze);
document.getElementById("suggestions").addEventListener("click", onSuggestionActionClick);

refreshState();
setInterval(refreshState, 1200);
clearPreview();
