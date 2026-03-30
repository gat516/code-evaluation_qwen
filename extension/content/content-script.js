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

start();
