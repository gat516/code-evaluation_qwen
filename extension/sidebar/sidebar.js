async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

function renderSuggestions(items) {
  const root = document.getElementById("suggestions");
  root.innerHTML = "";

  if (!items?.length) {
    root.textContent = "No suggestions yet.";
    return;
  }

  items.forEach((item) => {
    const el = document.createElement("article");
    el.className = `suggestion ${item.severity || "low"}`;
    el.innerHTML = `
      <div class="meta">${item.category} | ${item.severity} | confidence ${Math.round((item.confidence || 0) * 100)}%</div>
      <strong>${item.message}</strong>
      <p>${item.rationale}</p>
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
    summary.textContent = `Error: ${state.error || "Unknown backend error"}`;
    renderSuggestions([]);
    return;
  }

  const grade = state.result?.grading_tool_output?.grade;
  const warning = state.result?.grading_tool_output?.security_warning;
  if (typeof grade === "number") {
    summary.textContent = `Score ${grade}/100${warning ? " | Security warning detected" : ""}`;
  } else {
    summary.textContent = "Analysis in progress or not available yet.";
  }

  renderSuggestions(state.result?.suggestions || []);
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

document.getElementById("refreshBtn").addEventListener("click", requestManualAnalyze);

refreshState();
setInterval(refreshState, 1200);
