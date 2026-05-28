const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const pipeline = require("./pipeline");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: "Video Creator",
    backgroundColor: "#0d0d0f",
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// Pick music file
ipcMain.handle("pick-music", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: "Audio", extensions: ["mp3","wav","aac","m4a","ogg","flac"] }],
    properties: ["openFile"],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Pick image file
ipcMain.handle("pick-image", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: "Images", extensions: ["jpg","jpeg","png","webp","gif"] }],
    properties: ["openFile"],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Pick output directory
ipcMain.handle("pick-output-dir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Run pipeline
ipcMain.handle("run-pipeline", (_, { sections, config }) => {
  return pipeline.run(sections, config, (event, data) => {
    mainWindow.webContents.send(event, data);
  });
});

ipcMain.handle("stop-pipeline", () => pipeline.stop());
