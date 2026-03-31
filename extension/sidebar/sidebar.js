async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

let latestSuggestions = [];

function hasQuickFix(item) {
  if (!item) {
    return false;
  }

  const ruleId = String(item?.rule_id || "");
  if (ruleId === "info.no-issues" || ruleId === "analysis.error") {
    return false;
  }

  if (item.after && String(item.after).trim()) {
    return true;
  }

  if (ruleId.startsWith("correctness.") || ruleId.startsWith("quality.") || ruleId.startsWith("security.")) {
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
      if (response?.source === "backend-validated") {
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

  if (!items?.length) {
    root.textContent = "No suggestions yet.";
    return;
  }

  items.forEach((item, index) => {
    const line = item?.anchor?.line ? ` | line ${item.anchor.line}` : "";
    const canApplyFix = hasQuickFix(item);
    const quickFixPreview = buildQuickFix(item);
    const canCopyFix = !!quickFixPreview;
    const el = document.createElement("article");
    el.className = `suggestion ${item.severity || "low"}`;
    el.innerHTML = `
      <div class="meta">${item.category} | ${item.severity}${line} | confidence ${Math.round((item.confidence || 0) * 100)}%</div>
      <strong>${item.message}</strong>
      <p>${item.rationale}</p>
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
  const highCount = suggestions.filter((item) => item.severity === "high").length;
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
