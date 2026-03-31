async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

let latestSuggestions = [];

function hasQuickFix(item) {
  if (!item) {
    return false;
  }

  if (item.after && String(item.after).trim()) {
    return true;
  }

  const text = `${item?.message || ""} ${item?.rationale || ""}`.toLowerCase();
  if (item?.rule_id === "quality.review" || item?.rule_id === "quality.grade") {
    return text.includes("repeated") && text.includes("print");
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
  const text = `${item?.message || ""} ${item?.rationale || ""}`.toLowerCase();

  if (item?.after && String(item.after).trim()) {
    return String(item.after);
  }

  switch (item.rule_id) {
    case "quality.review":
    case "quality.grade":
      if (text.includes("repeated") && text.includes("print")) {
        return "for i in range(1, 7):\n    print(i)";
      }
      return null;
    case "python.loop.refactor":
      if (item?.before && item?.after) {
        const beforeLines = String(item.before)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const ints = beforeLines
          .map((line) => line.match(/\(\s*(-?\d+)\s*\)/))
          .filter(Boolean)
          .map((m) => Number(m[1]));
        const sequential = ints.length === beforeLines.length
          && ints.every((v, idx) => idx === 0 || v === ints[idx - 1] + 1);
        if (sequential && ints.length >= 2) {
          const startValue = ints[0];
          const endExclusive = ints[ints.length - 1] + 1;
          return `for i in range(${startValue}, ${endExclusive}):\n    ${item.after}`;
        }
      }
      return "for i in range(1, 6):\n    print(i)";
    case "secrets.hardcoded":
      return "import os\npassword = os.getenv(\"APP_PASSWORD\", \"\")\ntoken = os.getenv(\"APP_TOKEN\", \"\")";
    case "python.unsafe.dynamic-exec":
      return "import ast\nuser_input = input(\"value: \")\nparsed = ast.literal_eval(user_input)";
    case "style.tabs":
      return "Replace tab indentation with 4 spaces for consistent formatting.";
    case "js.var.legacy":
      return "Replace `var` declarations with `let` or `const` depending on mutability.";
    case "js.unsafe.eval":
      return "Avoid eval(); parse input explicitly (JSON.parse or validated parser).";
    case "security.warning":
      if (text.includes("secret") || text.includes("password") || text.includes("token") || text.includes("api key")) {
        return "import os\npassword = os.getenv(\"APP_PASSWORD\", \"\")\ntoken = os.getenv(\"APP_TOKEN\", \"\")";
      }
      if (text.includes("eval") || text.includes("exec")) {
        return "import ast\nuser_input = input(\"value: \")\nparsed = ast.literal_eval(user_input)";
      }
      return null;
    default:
      return null;
  }
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
    const fixAvailable = hasQuickFix(item) && !!buildQuickFix(item);
    const el = document.createElement("article");
    el.className = `suggestion ${item.severity || "low"}`;
    el.innerHTML = `
      <div class="meta">${item.category} | ${item.severity}${line} | confidence ${Math.round((item.confidence || 0) * 100)}%</div>
      <strong>${item.message}</strong>
      <p>${item.rationale}</p>
      <div class="item-actions">
        ${fixAvailable
          ? `<button class="secondary" data-action="apply-fix" data-index="${index}">Apply quick fix</button>
             <button class="secondary" data-action="copy-fix" data-index="${index}">Copy quick fix</button>`
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
    const quickFix = buildQuickFix(item);
    if (!quickFix) {
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
