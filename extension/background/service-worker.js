const ANALYZE_DEBOUNCE_MS = 300;
const SNAPSHOT_DEDUPE_WINDOW_MS = 2500;

const tabState = new Map();

async function getSettings() {
  const defaults = {
    analysisMode: "ai",
    backendUrl: "http://127.0.0.1:8000",
    apiKey: "",
    broadDetection: false,
    autoAnalyze: true,
    idleTimeout: 3000
  };
  const values = await chrome.storage.sync.get(defaults);
  return values;
}

function toCanonicalSeverity(input) {
  const raw = String(input || "").toLowerCase();
  if (raw === "high" || raw === "error") return "error";
  if (raw === "medium" || raw === "warning") return "warning";
  return "info";
}

function toLegacySeverity(input) {
  const raw = String(input || "").toLowerCase();
  if (raw === "error" || raw === "high") return "high";
  if (raw === "warning" || raw === "medium") return "medium";
  return "low";
}

function guessRangeLine(item, fallbackLine) {
  const line = Number(item?.line ?? item?.start_line ?? item?.end_line ?? item?.anchor?.line ?? fallbackLine);
  return Number.isInteger(line) && line >= 1 ? line : fallbackLine;
}

function guessCol(input) {
  const col = Number(input);
  return Number.isInteger(col) && col >= 0 ? col : 0;
}

function normalizeSuggestion(item, index, code) {
  const raw = item || {};
  const line = guessRangeLine(raw, index + 1);
  const col = guessCol(raw?.col ?? raw?.fix?.range?.startCol);
  const endLine = guessRangeLine({ line: raw?.end_line, end_line: raw?.fix?.range?.endLine }, line);
  const endCol = guessCol(raw?.end_col ?? raw?.fix?.range?.endCol ?? col);

  const canonicalSeverity = toCanonicalSeverity(raw?.severity);
  const legacySeverity = toLegacySeverity(canonicalSeverity);
  const message = String(raw?.message || "Potential issue detected.");

  const replacement = String(raw?.fix?.replacement ?? "");
  const fix = {
    replacement,
    range: {
      startLine: line,
      startCol: col,
      endLine,
      endCol
    }
  };

  return {
    line,
    col,
    end_line: endLine,
    end_col: endCol,
    severity: canonicalSeverity,
    message,
    fix,
    source: "ai",
    legacySeverity,

    // Fields the content script and sidebar still reference:
    rule_id: String(raw?.rule_id || `ai.rule.${index + 1}`),
    category: String(raw?.category || "issue"),
    rationale: String(raw?.rationale || raw?.message || ""),
    anchor: { line },
    confidence: typeof raw?.confidence === "number" ? raw.confidence : 0.6
  };
}

function isSuggestionRelevantToCode(suggestion, code) {
  const text = `${suggestion?.message || ""}`.toLowerCase();
  const codeLower = String(code || "").toLowerCase();

  if (text.includes("no issues found") || text.includes("no problems found") || text.includes("looks good")) {
    return false;
  }
  if (text.includes("nameerror") && text.includes("none") && !/\bnone\b/.test(codeLower)) {
    return false;
  }
  return true;
}

function normalizeResult(result, snapshot) {
  const normalized = (result?.suggestions || [])
    .filter((item) => isSuggestionRelevantToCode(item, snapshot.code))
    .map((item, index) => normalizeSuggestion(item, index, snapshot.code));

  const deduped = [];
  const seen = new Set();
  for (const suggestion of normalized) {
    const key = `${suggestion.line}|${suggestion.end_line}|${suggestion.severity}|${suggestion.message.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(suggestion);
  }

  return {
    suggestions: deduped,
    model: result?.model || null,
    analysis_time_ms: Number(result?.analysis_time_ms || 0),
    metadata: {
      ...(result?.metadata || {}),
      analyzer: "ai-backend",
      mode: "ai"
    }
  };
}

function shouldSkipDuplicateSnapshot(state, snapshot) {
  if (!state?.snapshot || !snapshot) return false;
  const sameCode = String(state.snapshot.code || "") === String(snapshot.code || "");
  const sameLanguage = String(state.snapshot.language || "") === String(snapshot.language || "");
  const sameSite = String(state.snapshot.site || "") === String(snapshot.site || "");
  if (!sameCode || !sameLanguage || !sameSite) return false;
  return Date.now() - Number(state.updatedAt || 0) < SNAPSHOT_DEDUPE_WINDOW_MS;
}

async function analyzeCodeWithBackend(snapshot, settings) {
  const headers = { "Content-Type": "application/json" };
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

  return response.json();
}

async function setBadge(tabId, isSupported) {
  if (!tabId) return;
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

  const prev = tabState.get(tabId) || {};
  if (prev.analysisInFlight) {
    tabState.set(tabId, { ...prev, queuedSnapshot: snapshot, status: "collecting", updatedAt: Date.now() });
    return;
  }

  tabState.set(tabId, { ...prev, analysisInFlight: true, status: "analyzing", updatedAt: Date.now() });

  try {
    const result = await analyzeCodeWithBackend(snapshot, settings);
    const normalizedResult = normalizeResult(result, snapshot);

    tabState.set(tabId, {
      ...tabState.get(tabId),
      status: "result",
      result: normalizedResult,
      snapshot,
      updatedAt: Date.now()
    });

    const msg = { type: "ANALYSIS_RESULT", payload: normalizedResult };
    if (Number.isInteger(frameId) && frameId >= 0) {
      chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => {});
    }
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
  } finally {
    const nextState = tabState.get(tabId) || {};
    const queued = nextState.queuedSnapshot || null;
    tabState.set(tabId, { ...nextState, analysisInFlight: false, queuedSnapshot: null, updatedAt: Date.now() });
    if (queued) {
      analyzeSnapshot(tabId, queued).catch(() => {});
    }
  }
}

function scheduleAnalyze(tabId, snapshot) {
  const current = tabState.get(tabId) || {};
  if (current.timerId) clearTimeout(current.timerId);

  const timerId = setTimeout(async () => {
    await analyzeSnapshot(tabId, snapshot);
  }, ANALYZE_DEBOUNCE_MS);

  tabState.set(tabId, { ...current, status: "collecting", snapshot, frameId: snapshot.__frameId, timerId, updatedAt: Date.now() });
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
    const payload = { ...message.payload, __frameId: sender.frameId };
    const currentState = tabState.get(tabId) || {};
    if (shouldSkipDuplicateSnapshot(currentState, payload)) {
      sendResponse({ ok: true, deduped: true });
      return true;
    }

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
    sendResponse({ state: tabState.get(message.tabId) || null });
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
    chrome.tabs.sendMessage(requestedTabId, { type: "REQUEST_SNAPSHOT_AND_ANALYZE" })
      .then((response) => {
        sendResponse(response?.ok ? { ok: true, requestedSnapshot: true } : { ok: false, error: response?.error || "No code snapshot available yet." });
      })
      .catch(() => {
        sendResponse({ ok: false, error: "No code snapshot available yet. Open a supported editor tab first." });
      });
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

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const state = tabState.get(tabId);
  if (state?.timerId) clearTimeout(state.timerId);
  tabState.delete(tabId);
});