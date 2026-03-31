const defaults = {
  analysisMode: "local",
  backendUrl: "http://127.0.0.1:8000",
  apiKey: "",
  broadDetection: false,
  autoAnalyze: true
};

async function loadSettings() {
  const settings = await chrome.storage.sync.get(defaults);
  document.getElementById("analysisMode").value = settings.analysisMode || defaults.analysisMode;
  document.getElementById("backendUrl").value = settings.backendUrl || defaults.backendUrl;
  document.getElementById("apiKey").value = settings.apiKey || "";
  document.getElementById("broadDetection").checked = !!settings.broadDetection;
  document.getElementById("autoAnalyze").checked = !!settings.autoAnalyze;
}

async function saveSettings() {
  const next = {
    analysisMode: document.getElementById("analysisMode").value,
    backendUrl: document.getElementById("backendUrl").value.trim() || defaults.backendUrl,
    apiKey: document.getElementById("apiKey").value.trim(),
    broadDetection: document.getElementById("broadDetection").checked,
    autoAnalyze: document.getElementById("autoAnalyze").checked
  };
  await chrome.storage.sync.set(next);
  document.getElementById("saved").textContent = "Saved.";
  setTimeout(() => {
    document.getElementById("saved").textContent = "";
  }, 1200);
}

document.getElementById("saveBtn").addEventListener("click", saveSettings);
loadSettings();
