const ANALYZE_DEBOUNCE_MS = 900;

const tabState = new Map();
const cache = new Map();

function hashKey(input) {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

async function getSettings() {
  const defaults = {
    broadDetection: false,
    autoAnalyze: true
  };
  const values = await chrome.storage.sync.get(defaults);
  return values;
}

function buildSuggestion({ ruleId, severity, category, message, rationale, before, after, confidence }) {
  return {
    rule_id: ruleId,
    severity,
    category,
    message,
    rationale,
    before: before || null,
    after: after || null,
    confidence: confidence ?? 0.7
  };
}

function withAnchor(suggestion, lineNumber) {
  return {
    ...suggestion,
    anchor: lineNumber ? { line: lineNumber } : null
  };
}

function analyzePython(code) {
  const suggestions = [];
  const lines = code.split("\n");
  const printOnly = lines.filter((line) => line.trim().startsWith("print("));
  const repeatedPrintLine = lines.findIndex((line) => line.trim().startsWith("print(")) + 1;

  if (printOnly.length >= 5) {
    suggestions.push(withAnchor(
      buildSuggestion({
        ruleId: "python.loop.refactor",
        severity: "medium",
        category: "maintainability",
        message: "Repeated print statements could be replaced with a loop.",
        rationale: "Repeated sequential statements make the code harder to maintain and update.",
        confidence: 0.86
      }),
      repeatedPrintLine
    ));
  }

  const dynamicExecLine = lines.findIndex((line) => /\beval\s*\(|\bexec\s*\(/.test(line)) + 1;
  if (dynamicExecLine > 0) {
    suggestions.push(withAnchor(
      buildSuggestion({
        ruleId: "python.unsafe.dynamic-exec",
        severity: "high",
        category: "security",
        message: "Avoid eval/exec unless absolutely necessary.",
        rationale: "Dynamic code execution can introduce injection vulnerabilities.",
        confidence: 0.95
      }),
      dynamicExecLine
    ));
  }

  const secretLine = lines.findIndex((line) => /password\s*=\s*["'][^"']+["']|api[_-]?key\s*=\s*["'][^"']+["']|token\s*=\s*["'][^"']+["']/.test(line.toLowerCase())) + 1;
  if (secretLine > 0) {
    suggestions.push(withAnchor(
      buildSuggestion({
        ruleId: "secrets.hardcoded",
        severity: "high",
        category: "security",
        message: "Potential hardcoded secret detected.",
        rationale: "Credentials should be loaded from environment variables or a secure secret store.",
        confidence: 0.92
      }),
      secretLine
    ));
  }

  const tabLine = lines.findIndex((line) => /\t/.test(line)) + 1;
  if (tabLine > 0) {
    suggestions.push(withAnchor(
      buildSuggestion({
        ruleId: "style.tabs",
        severity: "low",
        category: "style",
        message: "Tabs detected in source.",
        rationale: "Consistent spaces are easier to maintain across editors and teams.",
        confidence: 0.66
      }),
      tabLine
    ));
  }

  return suggestions;
}

function analyzeJavascript(code) {
  const suggestions = [];
  const lines = code.split("\n");

  const evalLine = lines.findIndex((line) => /\beval\s*\(/.test(line)) + 1;
  if (evalLine > 0) {
    suggestions.push(withAnchor(
      buildSuggestion({
        ruleId: "js.unsafe.eval",
        severity: "high",
        category: "security",
        message: "Avoid eval in JavaScript.",
        rationale: "eval executes arbitrary code and can create severe security issues.",
        confidence: 0.95
      }),
      evalLine
    ));
  }

  const varLine = lines.findIndex((line) => /\bvar\b/.test(line)) + 1;
  if (varLine > 0) {
    suggestions.push(withAnchor(
      buildSuggestion({
        ruleId: "js.var.legacy",
        severity: "low",
        category: "style",
        message: "Prefer let/const over var.",
        rationale: "Block-scoped declarations reduce hoisting-related bugs.",
        confidence: 0.83
      }),
      varLine
    ));
  }

  return suggestions;
}

function analyzeCodeLocally(snapshot) {
  const language = (snapshot.language || "python").toLowerCase();
  const code = snapshot.code || "";
  let suggestions = [];

  if (language === "python") {
    suggestions = analyzePython(code);
  } else if (language === "javascript") {
    suggestions = analyzeJavascript(code);
  }

  if (!suggestions.length && code.trim()) {
    suggestions.push(
      buildSuggestion({
        ruleId: "info.no-issues",
        severity: "low",
        category: "info",
        message: "No obvious issues detected by local rules.",
        rationale: "This extension mode uses lightweight local heuristics only.",
        confidence: 0.55
      })
    );
  }

  return {
    suggestions,
    metadata: {
      analyzer: "local-rules",
      language,
      line_count: code.split("\n").length
    }
  };
}

async function setBadge(tabId, isSupported) {
  if (!tabId) {
    return;
  }
  if (isSupported) {
    await chrome.action.enable(tabId);
    await chrome.action.setBadgeText({ tabId, text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0f766e" });
  } else {
    await chrome.action.disable(tabId);
    await chrome.action.setBadgeText({ tabId, text: "" });
  }
}

async function analyzeSnapshot(tabId, snapshot) {
  const cacheKey = hashKey(`${snapshot.language}|${snapshot.site}|${snapshot.code}`);

  if (cache.has(cacheKey)) {
    tabState.set(tabId, {
      ...tabState.get(tabId),
      status: "result",
      result: cache.get(cacheKey),
      updatedAt: Date.now()
    });
    return;
  }

  tabState.set(tabId, {
    ...tabState.get(tabId),
    status: "analyzing",
    updatedAt: Date.now()
  });

  try {
    const result = analyzeCodeLocally(snapshot);
    cache.set(cacheKey, result);

    tabState.set(tabId, {
      ...tabState.get(tabId),
      status: "result",
      result,
      updatedAt: Date.now()
    });
    chrome.tabs.sendMessage(tabId, { type: "ANALYSIS_RESULT", payload: result }).catch(() => {});
  } catch (error) {
    tabState.set(tabId, {
      ...tabState.get(tabId),
      status: "error",
      error: String(error.message || error),
      updatedAt: Date.now()
    });
    chrome.tabs.sendMessage(tabId, { type: "ANALYSIS_ERROR", payload: { error: String(error.message || error) } }).catch(() => {});
  }
}

function scheduleAnalyze(tabId, snapshot) {
  const current = tabState.get(tabId) || {};
  if (current.timerId) {
    clearTimeout(current.timerId);
  }

  const timerId = setTimeout(async () => {
    await analyzeSnapshot(tabId, snapshot);
  }, ANALYZE_DEBOUNCE_MS);

  tabState.set(tabId, {
    ...current,
    status: "collecting",
    snapshot,
    timerId,
    updatedAt: Date.now()
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (message?.type === "SITE_STATUS" && tabId) {
    tabState.set(tabId, {
      ...(tabState.get(tabId) || {}),
      site: message.site,
      supported: !!message.supported,
      status: "idle",
      updatedAt: Date.now()
    });
    setBadge(tabId, !!message.supported);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "CODE_SNAPSHOT" && tabId) {
    getSettings().then((settings) => {
      if (!settings.autoAnalyze) {
        tabState.set(tabId, {
          ...(tabState.get(tabId) || {}),
          status: "stale",
          snapshot: message.payload,
          updatedAt: Date.now()
        });
        sendResponse({ ok: true, skipped: true });
        return;
      }
      scheduleAnalyze(tabId, message.payload);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "GET_TAB_STATE") {
    const requestedTabId = message.tabId;
    sendResponse({ state: tabState.get(requestedTabId) || null });
    return true;
  }

  if (message?.type === "MANUAL_ANALYZE") {
    const requestedTabId = message.tabId;
    const state = tabState.get(requestedTabId);
    if (state?.snapshot) {
      analyzeSnapshot(requestedTabId, state.snapshot).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false, error: "No code snapshot available yet." });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const state = tabState.get(tabId);
  if (state?.timerId) {
    clearTimeout(state.timerId);
  }
  tabState.delete(tabId);
});
