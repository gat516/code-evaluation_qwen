const API_BASE_URL_DEFAULT = "http://localhost:8000";
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
    backendUrl: API_BASE_URL_DEFAULT,
    broadDetection: false,
    autoAnalyze: true,
    apiKey: ""
  };
  const values = await chrome.storage.sync.get(defaults);
  return values;
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
  const settings = await getSettings();
  const backendUrl = settings.backendUrl || API_BASE_URL_DEFAULT;
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

  const headers = {
    "Content-Type": "application/json"
  };
  if (settings.apiKey) {
    headers["X-API-Key"] = settings.apiKey;
  }

  try {
    const response = await fetch(`${backendUrl}/analyze`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        code: snapshot.code,
        language: snapshot.language || "python",
        site: snapshot.site,
        metadata: {
          url: snapshot.url
        }
      })
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody?.detail?.message || `Backend returned ${response.status}`);
    }

    const result = await response.json();
    cache.set(cacheKey, result);

    tabState.set(tabId, {
      ...tabState.get(tabId),
      status: "result",
      result,
      updatedAt: Date.now()
    });
  } catch (error) {
    tabState.set(tabId, {
      ...tabState.get(tabId),
      status: "error",
      error: String(error.message || error),
      updatedAt: Date.now()
    });
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
