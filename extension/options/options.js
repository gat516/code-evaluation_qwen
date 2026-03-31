const defaults = {
  broadDetection: false,
  autoAnalyze: true
};

async function loadSettings() {
  const settings = await chrome.storage.sync.get(defaults);
  document.getElementById("broadDetection").checked = !!settings.broadDetection;
  document.getElementById("autoAnalyze").checked = !!settings.autoAnalyze;
}

async function saveSettings() {
  const next = {
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
