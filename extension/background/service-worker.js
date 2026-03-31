const ANALYZE_DEBOUNCE_MS = 900;

const tabState = new Map();

async function getSettings() {
  const defaults = {
    backendUrl: "http://127.0.0.1:8000",
    apiKey: "",
    broadDetection: false,
    autoAnalyze: true
  };
  const values = await chrome.storage.sync.get(defaults);
  return values;
}

function findLineForTokens(lines, tokens) {
  for (let i = 0; i < lines.length; i += 1) {
    const normalized = lines[i].toLowerCase();
    if (tokens.some((token) => normalized.includes(token))) {
      return i + 1;
    }
  }
  return 1;
}

function ensureAnchors(suggestions, code) {
  const lines = (code || "").split("\n");
  return (suggestions || []).map((item) => {
    if (item?.anchor?.line) {
      return item;
    }

    const searchBase = `${item?.message || ""} ${item?.rationale || ""}`.toLowerCase();
    let line = 1;
    if (searchBase.includes("eval") || searchBase.includes("exec")) {
      line = findLineForTokens(lines, ["eval(", "exec("]);
    } else if (searchBase.includes("secret") || searchBase.includes("password") || searchBase.includes("token") || searchBase.includes("api key")) {
      line = findLineForTokens(lines, ["password", "token", "api_key", "apikey", "api-key"]);
    } else if (searchBase.includes("print") || searchBase.includes("loop") || searchBase.includes("repeated")) {
      line = findLineForTokens(lines, ["print(", "for ", "while "]);
    } else if (searchBase.includes("tab")) {
      line = findLineForTokens(lines, ["\t"]);
    } else if (searchBase.includes("var") || searchBase.includes("let") || searchBase.includes("const")) {
      line = findLineForTokens(lines, ["var ", "let ", "const "]);
    }

    return {
      ...item,
      anchor: { line }
    };
  });
}

async function analyzeCodeWithBackend(snapshot, settings) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (settings.apiKey) {
    headers["X-API-Key"] = settings.apiKey;
  }

  const response = await fetch(`${settings.backendUrl}/analyze`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      code: snapshot.code,
      language: snapshot.language || "python",
      site: snapshot.site,
      metadata: {
        url: snapshot.url,
        source: "extension"
      }
    })
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const msg = body?.detail?.message || body?.detail?.error || `Backend returned ${response.status}`;
    throw new Error(msg);
  }

  const result = await response.json();
  const normalized = {
    ...result,
    suggestions: ensureAnchors(result.suggestions || [], snapshot.code),
    metadata: {
      ...(result.metadata || {}),
      analyzer: "ai-backend",
      mode: "ai"
    }
  };

  return normalized;
}

async function requestValidatedFix(payload, settings) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (settings.apiKey) {
    headers["X-API-Key"] = settings.apiKey;
  }

  const response = await fetch(`${settings.backendUrl}/fix`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      code: payload.code,
      language: payload.language || "python",
      suggestion: payload.suggestion,
      exec_timeout_s: 2,
      preview_only: !!payload.previewOnly
    })
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const msg = body?.detail?.message || body?.detail?.error || `Backend returned ${response.status}`;
    throw new Error(msg);
  }

  return response.json();
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
  const frameId = snapshot.__frameId;
  const settings = await getSettings();

  tabState.set(tabId, {
    ...tabState.get(tabId),
    status: "analyzing",
    updatedAt: Date.now()
  });

  try {
    const result = await analyzeCodeWithBackend(snapshot, settings);

    tabState.set(tabId, {
      ...tabState.get(tabId),
      status: "result",
      result,
      updatedAt: Date.now()
    });
    const msg = { type: "ANALYSIS_RESULT", payload: result };
    if (Number.isInteger(frameId) && frameId >= 0) {
      chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => {});
    }
    // Also broadcast without frame targeting so whichever frame hosts the editor can render inline suggestions.
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  } catch (error) {
    tabState.set(tabId, {
      ...tabState.get(tabId),
      status: "error",
      error: String(error.message || error),
      updatedAt: Date.now()
    });
    const msg = { type: "ANALYSIS_ERROR", payload: { error: String(error.message || error) } };
    if (Number.isInteger(frameId) && frameId >= 0) {
      chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => {});
    }
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
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
    frameId: snapshot.__frameId,
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
    const payload = {
      ...message.payload,
      __frameId: sender.frameId
    };
    getSettings().then((settings) => {
      if (!settings.autoAnalyze) {
        tabState.set(tabId, {
          ...(tabState.get(tabId) || {}),
          status: "stale",
          snapshot: payload,
          frameId: sender.frameId,
          updatedAt: Date.now()
        });
        sendResponse({ ok: true, skipped: true });
        return;
      }
      scheduleAnalyze(tabId, payload);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "GET_TAB_STATE") {
    const requestedTabId = message.tabId;
    sendResponse({ state: tabState.get(requestedTabId) || null });
    return true;
  }

  if (message?.type === "GET_LATEST_RESULT" && tabId) {
    const state = tabState.get(tabId) || null;
    sendResponse({ result: state?.result || null, status: state?.status || "idle" });
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

  if (message?.type === "FORCE_REANALYZE" && tabId) {
    const state = tabState.get(tabId);
    if (state?.snapshot) {
      analyzeSnapshot(tabId, state.snapshot).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false, error: "No code snapshot available yet." });
    return true;
  }

  if (message?.type === "VALIDATE_QUICK_FIX") {
    getSettings()
      .then((settings) => requestValidatedFix(message.payload || {}, settings))
      .then((result) => {
        sendResponse({
          ok: !!result?.applied,
          fixedCode: result?.fixed_code || null,
          candidateCode: result?.candidate_code || null,
          message: result?.message || "",
          validation: result?.validation || {}
        });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: String(error?.message || error || "Fix validation failed") });
      });
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
