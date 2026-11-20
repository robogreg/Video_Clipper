const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const ffmpegPath = require('ffmpeg-static');

const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'flv', '3gp'];

let win = null;
let exportProc = null;
let exportCanceled = false;

// ---------- ffmpeg helpers ----------

function runFfmpeg(args, onStdout) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-20000); });
    if (onStdout) proc.stdout.on('data', (d) => onStdout(d.toString()));
    proc.on('error', (err) => resolve({ code: -1, stderr: String(err), proc }));
    proc.on('close', (code) => resolve({ code, stderr, proc }));
    if (onStdout) exportProc = proc;
  });
}

// Read codec / size / duration by parsing `ffmpeg -i` output (no ffprobe needed).
async function probe(file) {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', file]);
  const info = { codec: null, pixFmt: null, width: 0, height: 0, duration: 0, hasAudio: /Stream #.*Audio:/.test(stderr) };
  const d = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (d) info.duration = (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]);
  const line = stderr.split(/\r?\n/).find((l) => /Stream #.*Video:/.test(l) && !/attached pic/.test(l));
  if (line) {
    const c = line.match(/Video: (\w+)[^,]*, (\w+)/);
    if (c) { info.codec = c[1]; info.pixFmt = c[2]; }
    const s = line.match(/, (\d{2,5})x(\d{2,5})/);
    if (s) { info.width = +s[1]; info.height = +s[2]; }
  }
  return info;
}

// Encoder settings that keep the source codec at visually-lossless quality.
function encoderArgs(info, ext) {
  const a = [];
  switch (info.codec) {
    case 'h264': a.push('-c:v', 'libx264', '-crf', '17', '-preset', 'medium'); break;
    case 'hevc':
      a.push('-c:v', 'libx265', '-crf', '20', '-preset', 'medium');
      if (['mp4', 'mov', 'm4v'].includes(ext)) a.push('-tag:v', 'hvc1');
      break;
    case 'vp9': a.push('-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-row-mt', '1'); break;
    case 'vp8': a.push('-c:v', 'libvpx', '-crf', '8', '-b:v', '8M'); break;
    case 'av1': a.push('-c:v', 'libsvtav1', '-crf', '26', '-preset', '7'); break;
    case 'mpeg4': a.push('-c:v', 'mpeg4', '-q:v', '3'); break;
    case 'mpeg2video': a.push('-c:v', 'mpeg2video', '-q:v', '3'); break;
    default: a.push('-q:v', '3'); // let ffmpeg pick the container's default codec
  }
  if (info.pixFmt && /^(yuv|yuvj|gbr|nv)/.test(info.pixFmt) && ['h264', 'hevc', 'vp9', 'av1'].includes(info.codec)) {
    a.push('-pix_fmt', info.pixFmt.replace(/^yuvj/, 'yuv'));
  }
  return a;
}

// ---------- file loading ----------

async function loadFile(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return {
    path: file,
    url: pathToFileURL(file).href,
    name: path.basename(file),
    info: await probe(file),
  };
}

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open video',
    properties: ['openFile'],
    filters: [{ name: 'Videos', extensions: VIDEO_EXTS }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return loadFile(r.filePaths[0]);
});

ipcMain.handle('open-path', (_e, file) => loadFile(file));

// ---------- export ----------

ipcMain.handle('export', async (_e, { file, start, end, fast }) => {
  const ext = path.extname(file).slice(1).toLowerCase();
  const base = path.basename(file, path.extname(file));
  const save = await dialog.showSaveDialog(win, {
    title: 'Save trimmed video',
    defaultPath: path.join(path.dirname(file), `${base}_trimmed.${ext}`),
    filters: [{ name: ext.toUpperCase() + ' video', extensions: [ext] }],
  });
  if (save.canceled || !save.filePath) return { canceled: true };
  let out = save.filePath;
  if (path.extname(out).toLowerCase() !== '.' + ext) out += '.' + ext;
  if (path.resolve(out).toLowerCase() === path.resolve(file).toLowerCase()) {
    return { error: 'Pick a different name — the trimmed copy can’t overwrite the original.' };
  }

  const info = await probe(file);
  const duration = Math.max(0.05, end - start);
  const args = ['-hide_banner', '-y', '-ss', start.toFixed(3), '-i', file, '-t', duration.toFixed(3),
    '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0'];
  if (fast) args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  else args.push(...encoderArgs(info, ext), '-c:a', 'copy');
  if (['mp4', 'mov', 'm4v'].includes(ext)) args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats', out);

  exportCanceled = false;
  win.webContents.send('export-progress', 0);
  const { code, stderr } = await runFfmpeg(args, (text) => {
    const m = [...text.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
    if (m) win.webContents.send('export-progress', Math.min(1, (+m[1] / 1e6) / duration));
  });
  exportProc = null;

  if (exportCanceled) {
    fs.rm(out, { force: true }, () => {});
    return { canceled: true };
  }
  if (code !== 0) {
    fs.rm(out, { force: true }, () => {});
    const tail = stderr.trim().split(/\r?\n/).slice(-4).join('\n');
    return { error: tail || 'ffmpeg failed.' };
  }
  return { ok: true, out };
});

ipcMain.handle('cancel-export', () => {
  if (exportProc) { exportCanceled = true; exportProc.kill(); }
});

ipcMain.handle('show-in-folder', (_e, file) => shell.showItemInFolder(file));

// ---------- window ----------

function fileFromArgv(argv) {
  const cand = argv.slice(1).filter((a) => !a.startsWith('-') && VIDEO_EXTS.includes(path.extname(a).slice(1).toLowerCase()));
  return cand.length ? path.resolve(cand[cand.length - 1]) : null;
}

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#111113',
    title: 'Video Clipper',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', async () => {
    const data = await loadFile(fileFromArgv(process.argv));
    if (data) win.webContents.send('open-file', data);
  });

  // Dev aid: CLIPPER_SHOT=<png path> saves a screenshot of the window and quits.
  if (process.env.CLIPPER_SHOT) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.CLIPPER_SHOT, img.toPNG());
      app.quit();
    }, 6000);
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (exportProc) exportProc.kill();
  app.quit();
});
