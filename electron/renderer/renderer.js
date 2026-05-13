/* global pubmedApp */

const refsInput = document.getElementById("refsInput");
const pastePanel = document.getElementById("pastePanel");
const filePanel = document.getElementById("filePanel");
const pickFileBtn = document.getElementById("pickFileBtn");
const fileLabel = document.getElementById("fileLabel");
const runBtn = document.getElementById("runBtn");
const exampleBtn = document.getElementById("exampleBtn");
const logOut = document.getElementById("logOut");
const progressEl = document.getElementById("progress");
const statusLine = document.getElementById("statusLine");

let selectedFilePath = null;

function currentMode() {
  const r = document.querySelector('input[name="src"]:checked');
  return r ? r.value : "paste";
}

function syncPanels() {
  const m = currentMode();
  pastePanel.hidden = m !== "paste";
  filePanel.hidden = m !== "file";
}

document.querySelectorAll('input[name="src"]').forEach(el => {
  el.addEventListener("change", syncPanels);
});

pickFileBtn.addEventListener("click", async () => {
  if (!window.pubmedApp) return;
  const { path } = await window.pubmedApp.selectInputFile();
  if (path) {
    selectedFilePath = path;
    const short = path.replace(/^.*\//, "");
    fileLabel.textContent = short;
  }
});

function appendLog(line) {
  logOut.textContent += (logOut.textContent ? "\n" : "") + line;
  logOut.scrollTop = logOut.scrollHeight;
}

function setProgress(data) {
  if (data.indeterminate) {
    progressEl.removeAttribute("value");
  } else {
    const total = Math.max(1, Number(data.total) || 1);
    const cur = Math.min(total, Math.max(0, Number(data.current) || 0));
    progressEl.max = total;
    progressEl.value = cur;
  }
}

exampleBtn.addEventListener("click", async () => {
  if (!window.pubmedApp) return;
  statusLine.textContent = "";
  const r = await window.pubmedApp.saveExampleReferences();
  if (r.error) statusLine.textContent = r.error;
  else if (r.saved) statusLine.textContent = `Saved example to ${r.path}`;
  else statusLine.textContent = "Canceled.";
});

runBtn.addEventListener("click", async () => {
  if (!window.pubmedApp) {
    statusLine.textContent = "This page must run inside Electron.";
    return;
  }

  const mode = currentMode();
  logOut.textContent = "";
  statusLine.textContent = "";
  setProgress({ current: 0, total: 1, indeterminate: true });

  const offLog = window.pubmedApp.onPubmedLog(appendLog);
  const offProg = window.pubmedApp.onPubmedProgress(setProgress);

  runBtn.disabled = true;
  exampleBtn.disabled = true;
  pickFileBtn.disabled = true;
  document.querySelectorAll('input[name="src"]').forEach(i => {
    i.disabled = true;
  });

  try {
    const payload =
      mode === "paste"
        ? { mode: "paste", text: refsInput.value }
        : { mode: "file", filePath: selectedFilePath };

    const result = await window.pubmedApp.runPubmed(payload);

    if (!result.ok) {
      statusLine.textContent = result.error || "Run failed.";
      return;
    }
    if (result.canceled) {
      statusLine.textContent = "Run finished; save canceled (temporary files removed).";
      return;
    }
    if (result.saved) {
      statusLine.textContent = `Saved ZIP to ${result.path}`;
    }
  } catch (err) {
    statusLine.textContent = String(err && err.message ? err.message : err);
  } finally {
    offLog();
    offProg();
    runBtn.disabled = false;
    exampleBtn.disabled = false;
    pickFileBtn.disabled = false;
    document.querySelectorAll('input[name="src"]').forEach(i => {
      i.disabled = false;
    });
  }
});

syncPanels();
