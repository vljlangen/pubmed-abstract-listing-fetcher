const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { ZipArchive } = require("archiver");

const projectRoot = path.join(__dirname, "..");
const pubmedScript = path.join(projectRoot, "pubmed_abstracts.js");
const references5Path = path.join(projectRoot, "references5.txt");
const licenseFilePath = path.join(projectRoot, "LICENSE");

function htmlToPlainText(html) {
  let s = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p\s*>/gi, "\n\n");
  s = s.replace(/<\/div\s*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "\n");
  s = htmlUnescape(s);
  s = s.replace(/\n[ \t]+\n/g, "\n\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim() + "\n";
}

function htmlUnescape(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, code) => {
    if (code[0] === "#") {
      const n =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n >= 0 ? String.fromCodePoint(n) : m;
    }
    const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : m;
  });
}

function emitLines(wc, chunk, carryRef, channel, parseProgress) {
  const buf = carryRef.value + chunk.toString("utf8");
  const parts = buf.split("\n");
  carryRef.value = parts.pop() || "";
  for (const line of parts) {
    wc.send(channel, line);
    if (parseProgress) parseProgressLine(line, wc);
  }
}

function parseProgressLine(line, wc) {
  const mProc = line.match(/Processing\s+(\d+)\s*\/\s*(\d+)/i);
  if (mProc) {
    wc.send("pubmed-progress", {
      current: Number(mProc[1]),
      total: Number(mProc[2]),
      indeterminate: false
    });
    return;
  }
  const mFound = line.match(/Found\s+(\d+)\s+reference line/i);
  if (mFound) {
    const total = Number(mFound[1]);
    wc.send("pubmed-progress", {
      current: 0,
      total,
      indeterminate: total === 0
    });
  }
}

function flushCarry(wc, carryRef, channel, parseProgress) {
  if (carryRef.value.length) {
    const line = carryRef.value;
    wc.send(channel, line);
    if (parseProgress) parseProgressLine(line, wc);
    carryRef.value = "";
  }
}

/**
 * Renders local HTML (with embedded CSS) to PDF using Chromium's print pipeline.
 */
async function renderHtmlToPdf(htmlFilePath, pdfOutPath) {
  const absHtml = path.resolve(htmlFilePath);
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  try {
    await win.loadFile(absHtml);
    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      displayHeaderFooter: false,
      pageSize: "A4"
    });
    await fs.promises.writeFile(pdfOutPath, pdfBuffer);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function zipArtifacts(htmlPath, destZipPath, pdfPath) {
  const htmlContent = fs.readFileSync(htmlPath, "utf8");
  const plain = htmlToPlainText(htmlContent);
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.append(htmlContent, { name: "pubmed_abstracts.html" });
    archive.append(plain, { name: "pubmed_abstracts.txt" });
    if (pdfPath && fs.existsSync(pdfPath)) {
      archive.file(pdfPath, { name: "pubmed_abstracts.pdf" });
    }
    archive.finalize();
  });
}

async function rmDirRecursive(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function createWindow() {
  const win = new BrowserWindow({
    title: "PubMed Abstract Listing Fetcher",
    width: 920,
    height: 780,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

let mainWindow;

app.whenReady().then(() => {
  app.setName("PubMed Abstract Listing Fetcher");
  mainWindow = createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("select-input-file", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Choose references text file",
    properties: ["openFile"],
    filters: [{ name: "Text", extensions: ["txt", "text"] }, { name: "All", extensions: ["*"] }]
  });
  if (canceled || !filePaths[0]) return { path: null };
  return { path: filePaths[0] };
});

ipcMain.handle("save-example-references", async () => {
  if (!fs.existsSync(references5Path)) {
    return { saved: false, error: `Missing file: ${references5Path}` };
  }
  const raw = await fs.promises.readFile(references5Path, "utf8");
  const lines = raw.split(/\r\n|\n|\r/);
  const content = lines.slice(0, 3).join("\n");
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Save example references",
    defaultPath: path.join(app.getPath("documents"), "references.txt"),
    filters: [{ name: "Text", extensions: ["txt"] }]
  });
  if (canceled || !filePath) return { saved: false };
  await fs.promises.writeFile(filePath, content, "utf8");
  return { saved: true, path: filePath };
});

ipcMain.handle("read-license-file", async () => {
  try {
    if (!fs.existsSync(licenseFilePath)) {
      return { ok: false, error: "LICENSE file not found." };
    }
    const text = await fs.promises.readFile(licenseFilePath, "utf8");
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle("run-pubmed", async (event, opts) => {
  const wc = event.sender;
  const mode = opts && opts.mode;
  const text = (opts && opts.text) || "";
  const filePath = opts && opts.filePath;

  if (mode === "paste" && !text.trim()) {
    return { ok: false, error: "Paste some reference lines or switch to a file." };
  }
  if (mode === "file" && !filePath) {
    return { ok: false, error: "Choose a references file first." };
  }

  if (!fs.existsSync(pubmedScript)) {
    return { ok: false, error: `Missing script: ${pubmedScript}` };
  }

  const tempDir = path.join(os.tmpdir(), `pubmed-electron-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  const inputPath = path.join(tempDir, "references.txt");
  const outputPath = path.join(tempDir, "pubmed_abstracts.html");
  const pdfPath = path.join(tempDir, "pubmed_abstracts.pdf");
  const tempZipPath = path.join(tempDir, "pubmed-abstracts-output.zip");

  try {
    if (mode === "paste") {
      await fs.promises.writeFile(inputPath, text.replace(/\r\n/g, "\n"), "utf8");
    } else {
      await fs.promises.copyFile(filePath, inputPath);
    }

    wc.send("pubmed-progress", { current: 0, total: 1, indeterminate: true });

    const stdoutCarry = { value: "" };
    const stderrCarry = { value: "" };
    const stderrText = [];

    const runEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    };

    const { code, stderr } = await new Promise((resolve, reject) => {
      const nodeProc = spawn(process.execPath, [pubmedScript, inputPath, outputPath], {
        cwd: projectRoot,
        env: runEnv,
        shell: false
      });

      nodeProc.stdout.on("data", chunk => emitLines(wc, chunk, stdoutCarry, "pubmed-log", true));
      nodeProc.stderr.on("data", chunk => {
        stderrText.push(chunk.toString("utf8"));
        emitLines(wc, chunk, stderrCarry, "pubmed-log", false);
      });
      nodeProc.on("error", reject);
      nodeProc.on("close", exitCode => {
        flushCarry(wc, stdoutCarry, "pubmed-log", true);
        flushCarry(wc, stderrCarry, "pubmed-log", false);
        resolve({ code: exitCode, stderr: stderrText.join("") });
      });
    });

    if (code !== 0) {
      await rmDirRecursive(tempDir);
      return { ok: false, error: stderr.trim() || `Process exited with code ${code}` };
    }

    if (!fs.existsSync(outputPath)) {
      await rmDirRecursive(tempDir);
      return { ok: false, error: "Output HTML was not created." };
    }

    try {
      await renderHtmlToPdf(outputPath, pdfPath);
    } catch (pdfErr) {
      wc.send("pubmed-log", `  PDF export skipped: ${pdfErr.message || pdfErr}`);
    }

    await zipArtifacts(outputPath, tempZipPath, pdfPath);

    const { canceled, filePath: savePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Save PubMed output",
      defaultPath: path.join(app.getPath("documents"), "pubmed-abstracts-output.zip"),
      filters: [{ name: "ZIP archive", extensions: ["zip"] }]
    });

    if (canceled || !savePath) {
      await rmDirRecursive(tempDir);
      return { ok: true, saved: false, canceled: true };
    }

    await fs.promises.copyFile(tempZipPath, savePath);
    await rmDirRecursive(tempDir);

    wc.send("pubmed-progress", {
      current: 1,
      total: 1,
      indeterminate: false
    });

    return { ok: true, saved: true, path: savePath };
  } catch (e) {
    await rmDirRecursive(tempDir);
    return { ok: false, error: String(e.message || e) };
  }
});
