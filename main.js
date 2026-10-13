// 心动纪念册 - Electron 主进程
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

// ---------- 数据存放位置（打包后也能用，不放在程序目录里） ----------
const DATA_DIR = path.join(app.getPath('userData'), 'album-data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PICTURE_DIR = path.join(DATA_DIR, 'pictures');   // 图片库：往里放图片，程序里就能直接挑
const MUSIC_DIR = path.join(DATA_DIR, 'music');       // 背景音乐：想用自己的歌就丢进来（没有就用内置合成音乐）
const DATA_FILE = path.join(DATA_DIR, 'album.json');
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac', '.opus'];

function ensureDirs() {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  fs.mkdirSync(PICTURE_DIR, { recursive: true });
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
}

/* music 文件夹里的音频（有就用它们当背景音乐） */
function listMusic() {
  ensureDirs();
  return fs.readdirSync(MUSIC_DIR)
    .filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()))
    .map((f) => {
      let st = { size: 0, mtimeMs: 0 };
      try { st = fs.statSync(path.join(MUSIC_DIR, f)); } catch (e) { /* ignore */ }
      return {
        name: f, size: st.size, mtime: st.mtimeMs,
        url: pathToFileURL(path.join(MUSIC_DIR, f)).href
      };
    })
    .sort((a, b) => a.mtime - b.mtime);
}

/* 图片库里有哪些图 */
function listPictures() {
  ensureDirs();
  return fs.readdirSync(PICTURE_DIR)
    .filter((f) => IMG_EXT.includes(path.extname(f).toLowerCase()))
    .map((f) => {
      let st = { size: 0, mtimeMs: 0 };
      try { st = fs.statSync(path.join(PICTURE_DIR, f)); } catch (e) { /* ignore */ }
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/* 同名的自动加序号，不覆盖 */
function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let out = name, i = 1;
  while (fs.existsSync(path.join(dir, out))) out = `${base}_${i++}${ext}`;
  return out;
}

/* 图片库里的图 -> 生成本地缩略图（用 Electron 自带的 nativeImage，省内存） */
function pictureThumb(name) {
  const p = path.join(PICTURE_DIR, path.basename(name));
  if (!fs.existsSync(p)) return null;
  try {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      const size = img.getSize();
      const w = Math.max(1, Math.min(280, size.width));
      return {
        dataUrl: img.resize({ width: w }).toDataURL(),
        width: size.width,
        height: size.height
      };
    }
  } catch (e) { /* 交给下面的兜底 */ }
  try {   // 兜底：直接把原文件当 data URL 发过去
    const ext = path.extname(p).toLowerCase();
    return {
      dataUrl: 'data:' + (MIME[ext] || 'image/png') + ';base64,' + fs.readFileSync(p).toString('base64'),
      width: 0, height: 0
    };
  } catch (e) { return null; }
}

function readData() {
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Object.assign({ version: 1, density: 13, cells: [] }, raw);
  } catch (e) {
    return { version: 1, density: 13, cells: [] };
  }
}

function writeData(data) {
  ensureDirs();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---------- 照片读取（带缓存） ----------
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
};
const photoCache = new Map();

function photoPath(fileName) {
  return path.join(PHOTO_DIR, path.basename(fileName)); // 防止路径穿越
}

function fileToDataUrl(fileName) {
  if (photoCache.has(fileName)) return photoCache.get(fileName);
  const p = photoPath(fileName);
  const ext = path.extname(p).toLowerCase();
  const url = 'data:' + (MIME[ext] || 'image/png') + ';base64,' +
    fs.readFileSync(p).toString('base64');
  photoCache.set(fileName, url);
  return url;
}

function saveDataUrlToFile(dataUrl) {
  const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('图片数据格式不正确');
  const ext = m[1] === 'image/jpeg' ? '.jpg'
    : m[1] === 'image/webp' ? '.webp'
    : m[1] === 'image/gif' ? '.gif'
    : m[1] === 'image/bmp' ? '.bmp' : '.png';
  const fileName = 'p' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
  ensureDirs();
  fs.writeFileSync(path.join(PHOTO_DIR, fileName), Buffer.from(m[2], 'base64'));
  photoCache.set(fileName, dataUrl);
  return fileName;
}

// ---------- 窗口 ----------
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 840,
    minWidth: 620,
    minHeight: 560,
    title: '心动纪念册',
    backgroundColor: '#fff6f9',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required'   // 打开就能有背景音乐，不用先点一下
    }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 开发时方便在终端看到页面里的报错（正式使用无影响）
  win.webContents.on('console-message', (...args) => {
    const d = args[1];
    if (d && typeof d === 'object' && 'message' in d) {
      console.log('[渲染进程]', d.message, `${d.sourceId || ''}:${d.lineNumber || 0}`);
    } else {
      console.log('[渲染进程]', args[2], `${args[4] || ''}:${args[3] || 0}`);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[加载失败]', code, desc, url);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------
ipcMain.handle('data:load', () => readData());
ipcMain.handle('data:save', (_e, data) => { writeData(data); return true; });

ipcMain.handle('photo:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择一张照片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  const ext = path.extname(p).toLowerCase();
  const dataUrl = 'data:' + (MIME[ext] || 'image/png') + ';base64,' +
    fs.readFileSync(p).toString('base64');
  return { name: path.basename(p), dataUrl };
});

ipcMain.handle('photo:save', (_e, dataUrl) => saveDataUrlToFile(dataUrl));

/* ---------- 图片库 ---------- */
ipcMain.handle('app:paths', () => {
  ensureDirs();
  return { data: DATA_DIR, pictures: PICTURE_DIR };
});

ipcMain.handle('library:list', () => listPictures());

ipcMain.handle('library:thumb', (_e, name) => pictureThumb(name));

ipcMain.handle('library:add', async () => {
  ensureDirs();
  const res = await dialog.showOpenDialog(win, {
    title: '导入图片到图片库（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }]
  });
  if (res.canceled || !res.filePaths.length) return { added: 0, list: listPictures() };
  let added = 0;
  for (const src of res.filePaths) {
    if (!IMG_EXT.includes(path.extname(src).toLowerCase())) continue;
    try {
      fs.copyFileSync(src, path.join(PICTURE_DIR, uniqueName(PICTURE_DIR, path.basename(src))));
      added++;
    } catch (e) { /* 跳过失败的 */ }
  }
  return { added, list: listPictures() };
});

/* 从图片库挑一张 -> 复制进相册自己的 photos 目录（相册不依赖图片库之后还在不在） */
ipcMain.handle('library:use', (_e, name) => {
  ensureDirs();
  const src = path.join(PICTURE_DIR, path.basename(name));
  if (!fs.existsSync(src)) return null;
  const fileName = uniqueName(PHOTO_DIR, path.basename(name));
  fs.copyFileSync(src, path.join(PHOTO_DIR, fileName));
  photoCache.delete(fileName);
  let w = 0, h = 0;
  try { const sz = nativeImage.createFromPath(src).getSize(); w = sz.width; h = sz.height; } catch (e) { /* ignore */ }
  return { fileName, width: w, height: h };
});

ipcMain.handle('library:remove', (_e, name) => {
  try { fs.unlinkSync(path.join(PICTURE_DIR, path.basename(name))); } catch (e) { /* ignore */ }
  return listPictures();
});

ipcMain.handle('music:list', () => listMusic());

ipcMain.handle('music:add', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择音乐（小提琴曲等）',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音频', extensions: ['mp3', 'm4a', 'aac', 'ogg', 'wav', 'flac', 'opus'] }]
  });
  if (res.canceled || !res.filePaths.length) return { added: 0, list: listMusic() };
  let added = 0;
  for (const src of res.filePaths) {
    try {
      fs.copyFileSync(src, path.join(MUSIC_DIR, uniqueName(MUSIC_DIR, path.basename(src))));
      added++;
    } catch (e) { /* 跳过读不了的文件 */ }
  }
  return { added, list: listMusic() };
});
ipcMain.handle('music:open', async () => {
  ensureDirs();
  await shell.openPath(MUSIC_DIR);
  return MUSIC_DIR;
});

ipcMain.handle('library:open', async () => {
  ensureDirs();
  await shell.openPath(PICTURE_DIR);
  return PICTURE_DIR;
});

/* 把图片库里的图直接拖进 photos 目录的接口之外，还给一个“列表里第 N 张”的便利接口用不着，
   前端拿到 dataUrl 后走 photo:save 即可 */
ipcMain.handle('app:openDataFolder', async () => {
  ensureDirs();
  await shell.openPath(DATA_DIR);
  return DATA_DIR;
});
ipcMain.handle('photo:get', (_e, fileName) => {
  try { return fileToDataUrl(fileName); } catch (e) { return null; }
});
ipcMain.handle('photo:delete', (_e, fileName) => {
  try {
    fs.unlinkSync(photoPath(fileName));
  } catch (e) { /* 文件不存在就算了 */ }
  photoCache.delete(fileName);
  return true;
});

// 自检 / 截图模式
if (process.argv.includes('--selftest')) {
  try { require('./tools/smoke.js')(); } catch (e) { console.error(e); }
}
if (process.argv.includes('--shot')) {
  try { require('./tools/shot.js')(); } catch (e) { console.error(e); }
}
