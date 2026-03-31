const ANALYZE_DEBOUNCE_MS = 300;
const SNAPSHOT_DEDUPE_WINDOW_MS = 2500;

const tabState = new Map();

async function getSettings() {
  const defaults = {
    analysisMode: "local",
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
  if (raw === "high" || raw === "error") {
    return "error";
  }
  if (raw === "medium" || raw === "warning") {
    return "warning";
  }
  return "info";
}

function toLegacySeverity(input) {
  const raw = String(input || "").toLowerCase();
  if (raw === "error" || raw === "high") {
    return "high";
  }
  if (raw === "warning" || raw === "medium") {
    return "medium";
  }
  return "low";
}

function guessRangeLine(item, fallbackLine) {
  const line = Number(item?.line ?? item?.start_line ?? item?.end_line ?? item?.anchor?.line ?? fallbackLine);
  if (Number.isInteger(line) && line >= 1) {
    return line;
  }
  return fallbackLine;
}

function guessCol(input) {
  const col = Number(input);
  if (Number.isInteger(col) && col >= 0) {
    return col;
  }
  return 0;
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

function normalizeSuggestion(item, index, code, sourceMode) {
  const anchored = ensureAnchors([item || {}], code)[0] || {};
  const line = guessRangeLine(anchored, index + 1);
  const col = guessCol(anchored?.col ?? anchored?.start_col ?? anchored?.fix?.range?.startCol);
  const endLine = guessRangeLine({
    line: anchored?.end_line,
    start_line: anchored?.endLine,
    end_line: anchored?.fix?.range?.endLine,
    anchor: anchored?.anchor
  }, line);
  const endCol = guessCol(anchored?.end_col ?? anchored?.endCol ?? anchored?.fix?.range?.endCol ?? col);

  const canonicalSeverity = toCanonicalSeverity(anchored?.severity);
  const legacySeverity = toLegacySeverity(canonicalSeverity);
  const message = String(anchored?.message || "Potential issue detected.");
  const messageLower = message.toLowerCase();

  let inferredCategory = "maintainability";
  if (/syntax|indent|parse|unexpected token|unclosed|mismatch/.test(messageLower)) {
    inferredCategory = "syntax";
  } else if (/runtime|traceback|exception|timed out|non-zero|nameerror|typeerror|valueerror|indexerror/.test(messageLower)) {
    inferredCategory = "runtime";
  } else if (/logic|correctness|wrong|off-by-one|incorrect|unexpected behavior/.test(messageLower)) {
    inferredCategory = "logic";
  }
  const replacement = String(anchored?.fix?.replacement ?? anchored?.after ?? "");
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
    // Canonical fields for the new architecture.
    line,
    col,
    end_line: endLine,
    end_col: endCol,
    severity: canonicalSeverity,
    message,
    fix,
    source: String(anchored?.source || sourceMode || "local"),

    // Backward-compatible fields for existing sidebar/content flows.
    rule_id: String(anchored?.rule_id || `${sourceMode || "local"}.rule.${index + 1}`),
    category: String(anchored?.category || inferredCategory),
    rationale: String(anchored?.rationale || anchored?.message || "No rationale provided."),
    before: String(anchored?.before || ""),
    after: replacement,
    anchor: { line },
    confidence: typeof anchored?.confidence === "number" ? anchored.confidence : 0.6,
    legacySeverity
  };
}

function isSuggestionRelevantToCode(suggestion, code) {
  const text = `${suggestion?.message || ""} ${suggestion?.rationale || ""}`.toLowerCase();
  const codeLower = String(code || "").toLowerCase();

  // Guard against a common hallucination where model flags lowercase none/true/false when code doesn't contain it.
  if (text.includes("nameerror") && text.includes("none") && !/\bnone\b/.test(codeLower)) {
    return false;
  }
  if (text.includes("true") && text.includes("case-sensitive") && !/\btrue\b/.test(codeLower)) {
    return false;
  }
  if (text.includes("false") && text.includes("case-sensitive") && !/\bfalse\b/.test(codeLower)) {
    return false;
  }

  return true;
}

function normalizeResult(result, snapshot, sourceMode) {
  const normalized = (result?.suggestions || [])
    .filter((item) => isSuggestionRelevantToCode(item, snapshot.code))
    .map((item, index) => normalizeSuggestion(item, index, snapshot.code, sourceMode));
  const deduped = [];
  const seen = new Set();
  for (const suggestion of normalized) {
    const key = [
      suggestion.line,
      suggestion.col,
      suggestion.end_line,
      suggestion.end_col,
      suggestion.severity,
      String(suggestion.message || "").trim().toLowerCase()
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(suggestion);
  }

  return {
    suggestions: deduped,
    model: result?.model || null,
    analysis_time_ms: Number(result?.analysis_time_ms || 0),
    execution: result?.execution || null,
    grading_tool_output: result?.grading_tool_output || null,
    metadata: {
      ...(result?.metadata || {}),
      analyzer: sourceMode === "ai" ? "ai-backend" : "local-rules",
      mode: sourceMode
    }
  };
}

function shouldSkipDuplicateSnapshot(state, snapshot) {
  if (!state?.snapshot || !snapshot) {
    return false;
  }

  const sameCode = String(state.snapshot.code || "") === String(snapshot.code || "");
  const sameLanguage = String(state.snapshot.language || "") === String(snapshot.language || "");
  const sameSite = String(state.snapshot.site || "") === String(snapshot.site || "");
  if (!sameCode || !sameLanguage || !sameSite) {
    return false;
  }

  const updatedAt = Number(state.updatedAt || 0);
  return Date.now() - updatedAt < SNAPSHOT_DEDUPE_WINDOW_MS;
}

function buildSuggestion(line, severity, message, rationale, ruleId) {
  return {
    line,
    col: 0,
    end_line: line,
    end_col: 1,
    severity,
    message,
    fix: {
      replacement: "",
      range: { startLine: line, startCol: 0, endLine: line, endCol: 1 }
    },
    source: "local",
    rule_id: ruleId,
    category: "correctness",
    rationale,
    anchor: { line },
    confidence: 0.75
  };
}

function analyzePythonLocally(code) {
  const lines = String(code || "").split("\n");
  const suggestions = [];

  const blockStarts = /^\s*(if|for|while|def|class|elif|else|except|finally)\b/;
  const commentOnly = /^\s*#/;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trim();
    if (!trimmed || commentOnly.test(trimmed)) {
      return;
    }

    if (blockStarts.test(trimmed) && !trimmed.endsWith(":")) {
      suggestions.push(buildSuggestion(
        lineNo,
        "error",
        "Block statement may be missing a trailing colon.",
        "Python block starters like if/for/def/class should end with ':'.",
        "python.syntax.missing-colon"
      ));
    }

    if (/\b(if|while)\s+.+[^=!<>]=[^=].*:\s*$/.test(trimmed)) {
      suggestions.push(buildSuggestion(
        lineNo,
        "error",
        "Possible assignment used in condition.",
        "Use '==' for comparison in Python conditions instead of '='.",
        "python.correctness.assignment-in-condition"
      ));
    }

    if (/\b(none|true|false)\b/.test(trimmed)) {
      suggestions.push(buildSuggestion(
        lineNo,
        "warning",
        "Python constants are case-sensitive.",
        "Use None, True, and False with capital first letters.",
        "python.name.case-sensitive-constants"
      ));
    }

    if (/^\s*except\s*:\s*$/.test(trimmed)) {
      suggestions.push(buildSuggestion(
        lineNo,
        "warning",
        "Bare except catches all exceptions.",
        "Catch specific exceptions to avoid hiding unexpected runtime failures.",
        "python.exceptions.bare-except"
      ));
    }

    if (/^\s*def\s+\w+\s*\([^)]*=\s*(\[\]|\{\})[^)]*\)\s*:/.test(trimmed)) {
      suggestions.push(buildSuggestion(
        lineNo,
        "warning",
        "Mutable default argument detected.",
        "Use None as default and create a new list/dict inside the function.",
        "python.correctness.mutable-default"
      ));
    }
  });

  const pairs = {
    "(": ")",
    "[": "]",
    "{": "}"
  };
  const opening = Object.keys(pairs);
  const closing = new Set(Object.values(pairs));
  const stack = [];

  lines.forEach((line, idx) => {
    for (const ch of line) {
      if (opening.includes(ch)) {
        stack.push({ ch, line: idx + 1 });
      } else if (closing.has(ch)) {
        const top = stack[stack.length - 1];
        if (!top || pairs[top.ch] !== ch) {
          suggestions.push(buildSuggestion(
            idx + 1,
            "error",
            "Mismatched closing bracket detected.",
            "Bracket pairs should be balanced: (), [], and {}.",
            "python.syntax.bracket-mismatch"
          ));
          return;
        }
        stack.pop();
      }
    }
  });

  if (stack.length) {
    const top = stack[stack.length - 1];
    suggestions.push(buildSuggestion(
      top.line,
      "error",
      "Unclosed bracket detected.",
      "A bracket appears to be opened but not closed.",
      "python.syntax.unclosed-bracket"
    ));
  }

  return {
    suggestions,
    model: "local-python-rules",
    analysis_time_ms: 1,
    metadata: {
      source: "local",
      language: "python"
    }
  };
}

async function analyzeCodeLocally(snapshot) {
  const language = String(snapshot?.language || "python").toLowerCase();
  if (language !== "python") {
    return {
      suggestions: [],
      model: "local-rules",
      analysis_time_ms: 1,
      metadata: {
        source: "local",
        warning: `Local mode currently supports python; received ${language}.`
      }
    };
  }
  return analyzePythonLocally(snapshot.code || "");
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

  return response.json();
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

  const prev = tabState.get(tabId) || {};
  if (prev.analysisInFlight) {
    tabState.set(tabId, {
      ...prev,
      queuedSnapshot: snapshot,
      status: "collecting",
      updatedAt: Date.now()
    });
    return;
  }

  tabState.set(tabId, {
    ...prev,
    analysisInFlight: true,
    status: "analyzing",
    updatedAt: Date.now()
  });

  try {
    let result;
    const mode = String(settings.analysisMode || "local").toLowerCase() === "ai" ? "ai" : "local";
    if (mode === "ai") {
      try {
        result = await analyzeCodeWithBackend(snapshot, settings);
      } catch (error) {
        const fallback = await analyzeCodeLocally(snapshot);
        result = {
          ...fallback,
          metadata: {
            ...(fallback.metadata || {}),
            fallback_warning: String(error?.message || error || "AI analysis failed; using local fallback.")
          }
        };
      }
    } else {
      result = await analyzeCodeLocally(snapshot);
    }

    const normalizedResult = normalizeResult(result, snapshot, mode);

    tabState.set(tabId, {
      ...tabState.get(tabId),
      status: "result",
      result: normalizedResult,
      updatedAt: Date.now()
    });
    const msg = { type: "ANALYSIS_RESULT", payload: normalizedResult };
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
  } finally {
    const nextState = tabState.get(tabId) || {};
    const queued = nextState.queuedSnapshot || null;
    tabState.set(tabId, {
      ...nextState,
      analysisInFlight: false,
      queuedSnapshot: null,
      updatedAt: Date.now()
    });

    if (queued) {
      analyzeSnapshot(tabId, queued).catch(() => {});
    }
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
