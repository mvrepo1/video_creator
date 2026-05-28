const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pickImage: () => ipcRenderer.invoke("pick-image"),
  pickOutputDir: () => ipcRenderer.invoke("pick-output-dir"),
  pickMusic: () => ipcRenderer.invoke("pick-music"),
  runPipeline: (sections, config) => ipcRenderer.invoke("run-pipeline", { sections, config }),
  stopPipeline: () => ipcRenderer.invoke("stop-pipeline"),
  on: (channel, cb) => {
    const valid = ["video-progress", "video-log", "video-done", "video-stopped", "video-error"];
    if (valid.includes(channel)) ipcRenderer.on(channel, (_, data) => cb(data));
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel),
});