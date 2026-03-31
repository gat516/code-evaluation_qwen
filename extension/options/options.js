const defaults = {
  analysisMode: "local",
  backendUrl: "http://127.0.0.1:8000",
  apiKey: "",
  broadDetection: false,
  autoAnalyze: true,
  idleTimeout: 3000
};

async function loadSettings() {
  const settings = await chrome.storage.sync.get(defaults);
  document.getElementById("analysisMode").value = settings.analysisMode || defaults.analysisMode;
  document.getElementById("backendUrl").value = settings.backendUrl || defaults.backendUrl;
  document.getElementById("apiKey").value = settings.apiKey || "";
  document.getElementById("broadDetection").checked = !!settings.broadDetection;
  document.getElementById("autoAnalyze").checked = !!settings.autoAnalyze;
  document.getElementById("idleTimeout").value = String(settings.idleTimeout || defaults.idleTimeout);
}

async function saveSettings() {
  const idleTimeoutRaw = Number(document.getElementById("idleTimeout").value);
  const idleTimeout = Number.isInteger(idleTimeoutRaw) && idleTimeoutRaw >= 500 ? idleTimeoutRaw : defaults.idleTimeout;

  const next = {
    analysisMode: document.getElementById("analysisMode").value === "ai" ? "ai" : "local",
    backendUrl: document.getElementById("backendUrl").value.trim() || defaults.backendUrl,
    apiKey: document.getElementById("apiKey").value.trim(),
    broadDetection: document.getElementById("broadDetection").checked,
    autoAnalyze: document.getElementById("autoAnalyze").checked,
    idleTimeout
  };
  await chrome.storage.sync.set(next);
  document.getElementById("saved").textContent = "Saved.";
  setTimeout(() => {
    document.getElementById("saved").textContent = "";
  }, 1200);
}

document.getElementById("saveBtn").addEventListener("click", saveSettings);
loadSettings();
