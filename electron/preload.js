const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pubmedApp", {
  selectInputFile: () => ipcRenderer.invoke("select-input-file"),
  saveExampleReferences: () => ipcRenderer.invoke("save-example-references"),
  runPubmed: opts => ipcRenderer.invoke("run-pubmed", opts),
  onPubmedLog: fn => {
    const handler = (_e, line) => fn(line);
    ipcRenderer.on("pubmed-log", handler);
    return () => ipcRenderer.removeListener("pubmed-log", handler);
  },
  onPubmedProgress: fn => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on("pubmed-progress", handler);
    return () => ipcRenderer.removeListener("pubmed-progress", handler);
  }
});
