const ALLOWLIST = [
  { name: "onecompiler", hostIncludes: ["onecompiler.com"] },
  { name: "replit", hostIncludes: ["replit.com"] },
  { name: "leetcode", hostIncludes: ["leetcode.com"] },
  { name: "hackerrank", hostIncludes: ["hackerrank.com"] }
];

const EDITOR_SELECTORS = [
  ".monaco-editor",
  ".CodeMirror",
  ".ace_editor",
  "textarea"
];

const INLINE_STYLE_ID = "cc-inline-style";
const INLINE_CARD_ID = "cc-inline-card";
const HIGHLIGHT_CLASS = "cc-inline-highlight";

let latestResult = null;

function detectSite() {
  const host = window.location.hostname;
  const matched = ALLOWLIST.find((site) => site.hostIncludes.some((frag) => host.includes(frag)));
  return matched ? matched.name : null;
}

function detectLanguageByUrl() {
  const url = window.location.href.toLowerCase();
  if (url.includes("python") || url.includes("py")) {
    return "python";
  }
  if (url.includes("javascript") || url.includes("js")) {
    return "javascript";
  }
  return "python";
}

function extractFromMonaco() {
  const lineNodes = document.querySelectorAll(".view-lines .view-line");
  if (!lineNodes.length) {
    return "";
  }
  return Array.from(lineNodes)
    .map((node) => node.textContent || "")
    .join("\n")
    .trim();
}

function extractFromCodeMirror() {
  const cmLines = document.querySelectorAll(".CodeMirror-code pre");
  if (!cmLines.length) {
    return "";
  }
  return Array.from(cmLines)
    .map((line) => line.textContent || "")
    .join("\n")
    .trim();
}

function extractFromAce() {
  const aceLines = document.querySelectorAll(".ace_line");
  if (!aceLines.length) {
    return "";
  }
  return Array.from(aceLines)
    .map((line) => line.textContent || "")
    .join("\n")
    .trim();
}

function extractFromTextarea() {
  const textareas = Array.from(document.querySelectorAll("textarea"));
  const ranked = textareas
    .map((ta) => ({ el: ta, len: (ta.value || "").length }))
    .sort((a, b) => b.len - a.len);

  return ranked[0]?.el?.value?.trim() || "";
}

function extractCode() {
  return extractFromMonaco() || extractFromCodeMirror() || extractFromAce() || extractFromTextarea();
}

function ensureInlineStyles() {
  if (document.getElementById(INLINE_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = INLINE_STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      text-decoration: underline wavy #ef4444;
      text-decoration-thickness: 1.5px;
      text-underline-offset: 2px;
      background: rgba(239, 68, 68, 0.08);
      border-radius: 3px;
    }
    .${HIGHLIGHT_CLASS}.cc-low {
      text-decoration-color: #f59e0b;
      background: rgba(245, 158, 11, 0.09);
    }
    #${INLINE_CARD_ID} {
      position: fixed;
      z-index: 2147483640;
      max-width: 320px;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid #fca5a5;
      background: #fff7f7;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
      color: #111827;
      font-size: 12px;
      line-height: 1.35;
      display: none;
    }
    #${INLINE_CARD_ID}.cc-medium {
      border-color: #fdba74;
      background: #fff7ed;
    }
    #${INLINE_CARD_ID}.cc-low {
      border-color: #fde68a;
      background: #fffbeb;
    }
    #${INLINE_CARD_ID} strong {
      display: block;
      margin-bottom: 5px;
      font-size: 12px;
    }
    #${INLINE_CARD_ID} .cc-rationale {
      color: #334155;
    }
  `;
  document.head.appendChild(style);
}

function getOrCreateInlineCard() {
  let card = document.getElementById(INLINE_CARD_ID);
  if (card) {
    return card;
  }
  card = document.createElement("div");
  card.id = INLINE_CARD_ID;
  document.body.appendChild(card);
  return card;
}

function showInlineCard(suggestion, rect) {
  const card = getOrCreateInlineCard();
  const sevClass = suggestion.severity === "high" ? "cc-high" : suggestion.severity === "medium" ? "cc-medium" : "cc-low";

  card.className = sevClass;
  card.innerHTML = `
    <strong>${suggestion.message}</strong>
    <div><em>${suggestion.category} | ${suggestion.severity}</em></div>
    <div class="cc-rationale">${suggestion.rationale}</div>
  `;

  const left = Math.min(window.innerWidth - 340, rect.left + 8);
  const top = Math.min(window.innerHeight - 150, rect.bottom + 8);

  card.style.left = `${Math.max(8, left)}px`;
  card.style.top = `${Math.max(8, top)}px`;
  card.style.display = "block";
}

function hideInlineCard() {
  const card = document.getElementById(INLINE_CARD_ID);
  if (card) {
    card.style.display = "none";
  }
}

function clearInlineHighlights() {
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
    el.classList.remove(HIGHLIGHT_CLASS, "cc-high", "cc-medium", "cc-low");
    el.removeAttribute("data-cc-suggestion");
  });
  hideInlineCard();
}

function getSeverityClass(suggestion) {
  return suggestion.severity === "high" ? "cc-high" : suggestion.severity === "medium" ? "cc-medium" : "cc-low";
}

function bindHighlightInteraction(el, suggestion) {
  el.addEventListener("mouseenter", () => {
    const rect = el.getBoundingClientRect();
    showInlineCard(suggestion, rect);
  });
  el.addEventListener("mouseleave", () => {
    hideInlineCard();
  });
}

function applyHighlightsToLineNodes(lineNodes, suggestions) {
  const lineMap = new Map();
  suggestions.forEach((suggestion) => {
    const line = suggestion?.anchor?.line;
    if (line && Number.isInteger(line)) {
      lineMap.set(line, suggestion);
    }
  });

  lineNodes.forEach((lineNode, index) => {
    const lineNumber = index + 1;
    const suggestion = lineMap.get(lineNumber);
    if (!suggestion) {
      return;
    }

    lineNode.classList.add(HIGHLIGHT_CLASS, getSeverityClass(suggestion));
    lineNode.dataset.ccSuggestion = suggestion.message;
    bindHighlightInteraction(lineNode, suggestion);
  });
}

function renderInlineSuggestions(result) {
  ensureInlineStyles();
  clearInlineHighlights();

  const suggestions = result?.suggestions || [];
  if (!suggestions.length) {
    return;
  }

  const monacoLines = Array.from(document.querySelectorAll(".view-lines .view-line"));
  if (monacoLines.length) {
    applyHighlightsToLineNodes(monacoLines, suggestions);
    return;
  }

  const codeMirrorLines = Array.from(document.querySelectorAll(".CodeMirror-code pre"));
  if (codeMirrorLines.length) {
    applyHighlightsToLineNodes(codeMirrorLines, suggestions);
    return;
  }

  const aceLines = Array.from(document.querySelectorAll(".ace_line"));
  if (aceLines.length) {
    applyHighlightsToLineNodes(aceLines, suggestions);
    return;
  }

  const textarea = document.querySelector("textarea");
  if (textarea) {
    textarea.classList.add(HIGHLIGHT_CLASS, "cc-medium");
    bindHighlightInteraction(textarea, suggestions[0]);
  }
}

async function shouldEnableBroadMode() {
  const settings = await chrome.storage.sync.get({ broadDetection: false });
  return !!settings.broadDetection;
}

async function isSupportedContext() {
  const site = detectSite();
  if (site) {
    return { supported: true, site };
  }

  const broadMode = await shouldEnableBroadMode();
  if (!broadMode) {
    return { supported: false, site: "unsupported" };
  }

  const foundEditor = EDITOR_SELECTORS.some((selector) => document.querySelector(selector));
  return { supported: foundEditor, site: foundEditor ? "broad-detection" : "unsupported" };
}

let lastCode = "";
let timer = null;

function publishSnapshot(site) {
  const code = extractCode();
  if (!code || code === lastCode) {
    return;
  }
  lastCode = code;

  chrome.runtime.sendMessage({
    type: "CODE_SNAPSHOT",
    payload: {
      code,
      language: detectLanguageByUrl(),
      site,
      url: window.location.href
    }
  });
}

function scheduleSnapshot(site) {
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => publishSnapshot(site), 600);
}

async function start() {
  const status = await isSupportedContext();

  chrome.runtime.sendMessage({
    type: "SITE_STATUS",
    site: status.site,
    supported: status.supported
  });

  if (!status.supported) {
    return;
  }

  publishSnapshot(status.site);

  const observer = new MutationObserver(() => scheduleSnapshot(status.site));
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  window.addEventListener("keyup", () => scheduleSnapshot(status.site));
  window.addEventListener("paste", () => scheduleSnapshot(status.site));
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "ANALYSIS_RESULT") {
    latestResult = message.payload;
    renderInlineSuggestions(latestResult);
  }
  if (message?.type === "ANALYSIS_ERROR") {
    clearInlineHighlights();
  }
});

start();
