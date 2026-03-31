async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

let latestSuggestions = [];

function setFeedback(text) {
  const el = document.getElementById("copyFeedback");
  el.textContent = text;
  if (text) setTimeout(() => { el.textContent = ""; }, 1400);
}

function hasReplacement(item) {
  return !!String(item?.fix?.replacement || "").trim();
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    setFeedback("Copied to clipboard.");
  } catch {
    setFeedback("Copy failed.");
  }
}

async function applyQuickFixToActiveTab(item) {
  const tabId = await getActiveTabId();
  if (!tabId) { setFeedback("No active tab."); return; }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "APPLY_QUICK_FIX",
      payload: { suggestion: item }
    });

    if (response?.ok) {
      setFeedback("Fix applied.");
      await chrome.runtime.sendMessage({ type: "MANUAL_ANALYZE", tabId });
      await refreshState();
      return;
    }
    setFeedback(response?.error || "Unable to apply fix.");
  } catch {
    setFeedback("Unable to reach page editor.");
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
    const lineNum = Number(item?.line || item?.anchor?.line);
    const line = Number.isInteger(lineNum) && lineNum > 0 ? ` | line ${lineNum}` : "";
    const canApply = hasReplacement(item);
    const fixText = String(item?.fix?.replacement || "").trim();
    const sevToken = String(item?.severity || item?.legacySeverity || "info").toLowerCase();
    const cardSev = sevToken === "error" ? "high" : sevToken === "warning" ? "medium" : "low";

    const el = document.createElement("article");
    el.className = `suggestion ${cardSev}`;
    el.innerHTML = `
      <div class="meta">${item.category || "issue"} | ${item.severity || "info"}${line}</div>
      <strong>${item.message}</strong>
      <p>${item.rationale || item.message || ""}</p>
      ${fixText ? `<pre class="fix-preview">${fixText.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>` : ""}
      <div class="item-actions">
        ${canApply ? `<button class="secondary" data-action="apply-fix" data-index="${index}">Apply Fix</button>` : ""}
        ${fixText ? `<button class="secondary" data-action="copy-fix" data-index="${index}">Copy Fix</button>` : ""}
        ${!canApply ? '<span class="no-fix">No auto-fix available.</span>' : ""}
      </div>
    `;
    root.appendChild(el);
  });
}

function renderSummary(state) {
  const summary = document.getElementById("summary");
  const status = document.getElementById("status");
  const spinner = document.getElementById("sidebarSpinner");

  if (!state) {
    spinner?.classList.add("hidden");
    status.textContent = "Open a supported coding tab to start.";
    summary.textContent = "No active analysis state.";
    renderSuggestions([]);
    return;
  }

  const stateStatus = String(state.status || "idle");
  status.textContent = `Status: ${stateStatus}${state.site ? ` on ${state.site}` : ""}`;

  if (spinner) {
    if (stateStatus === "collecting" || stateStatus === "analyzing") {
      spinner.classList.remove("hidden");
    } else {
      spinner.classList.add("hidden");
    }
  }

  if (stateStatus === "error") {
    summary.textContent = `Error: ${state.error || "Unknown"}`;
    renderSuggestions([]);
    return;
  }

  const suggestions = state.result?.suggestions || [];
  const highCount = suggestions.filter((s) => {
    const t = String(s?.severity || s?.legacySeverity || "").toLowerCase();
    return t === "error" || t === "high";
  }).length;

  summary.textContent = suggestions.length
    ? `${suggestions.length} suggestion(s)${highCount ? ` | ${highCount} high priority` : ""}`
    : "Analysis in progress or not available yet.";

  renderSuggestions(suggestions);
}

async function refreshState() {
  const tabId = await getActiveTabId();
  if (!tabId) { renderSummary(null); return; }
  const response = await chrome.runtime.sendMessage({ type: "GET_TAB_STATE", tabId });
  renderSummary(response?.state || null);
}

async function requestManualAnalyze() {
  const tabId = await getActiveTabId();
  if (!tabId) { setFeedback("No active tab."); return; }
  const response = await chrome.runtime.sendMessage({ type: "MANUAL_ANALYZE", tabId });
  if (!response?.ok) setFeedback(response?.error || "Unable to trigger analysis.");
  await refreshState();
}

function onSuggestionActionClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  if (Number.isNaN(index) || !latestSuggestions[index]) return;
  const item = latestSuggestions[index];
  const action = button.dataset.action;

  if (action === "copy-fix") {
    const text = String(item?.fix?.replacement || "").trim();
    if (!text) { setFeedback("No fix to copy."); return; }
    copyTextToClipboard(text);
  } else if (action === "apply-fix") {
    if (!hasReplacement(item)) { setFeedback("No fix available."); return; }
    applyQuickFixToActiveTab(item);
  }
}

document.getElementById("refreshBtn").addEventListener("click", requestManualAnalyze);
document.getElementById("suggestions").addEventListener("click", onSuggestionActionClick);

refreshState();
setInterval(refreshState, 1200);