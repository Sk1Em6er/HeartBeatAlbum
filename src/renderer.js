/* ================= 心动纪念册 · 渲染进程 =================
   构图：
     · 一层长方形铺满整个窗口（横的竖的随机分布）
     · 爱心轮廓固定大小、居中，不随滚轮变化
     · 爱心外面那一层：微微透明 + 模糊
     · 爱心里面那一层：完全清晰
   用 canvas 画，模糊/裁剪都是原生的，性能也好          */
const api = window.album;

const HEART_FILL = 0.78;      // 爱心占窗口较小边的比例（固定大小，不随滚轮变化）
const EASE = 0.16;            // 缩放动画的柔和程度（越小越绵）
const M = 40;                 // 画布往外多画一圈，模糊到窗口边缘时不会变淡
const COVER = 2.6;            // 铺的图案比窗口大多少倍（放大时不会露出边缘）
let GAP = 9;                  // 方块之间的缝（图案坐标；绘制和点击判定共用）
const BASE_MIN = 66;          // 长方形基准尺寸（会随滚轮整体放大缩小）
const BASE_MAX = 180;
const ZOOM_MIN = 1, ZOOM_MAX = 2.6;

const DEFAULT_SETTINGS = {
  zoom: 1.5,          // 长方形大小（几何缩放，不影响爱心）
  music: true,        // 背景音乐开关
  musicVolume: 0.35,  // 背景音乐音量
  strokeWidth: 3.5,   // 爱心外框粗细
  blur: 7,            // 爱心外部模糊
  outsideAlpha: 0.5   // 爱心外部透明度
};

let state = {
  version: 6,
  settings: Object.assign({}, DEFAULT_SETTINGS),
  cells: []                      // { photo, desc, x, y }  x/y 是归一化坐标
};

let view = { w: 1, h: 1 };             // 视口尺寸（CSS px）
let heartRect = { x: 0, y: 0, w: 1, h: 1 };
let rect = { x: 0, y: 0, w: 1, h: 1 };  // 铺图案的区域（比窗口大 COVER 倍）
let blocks = [];                       // { x, y, w, h, cx, cy, cell }（坐标在 rect 坐标系里）
let hoverBlock = null;
let currentBlock = -1;
let editorPhoto = null;
let typeTimer = null;
let pendingDraw = 0;
let rafId = 0;

const cam = { zoom: 1.5, ax: 0, ay: 0 };        // 当前镜头（ax/ay 是画面中心对应的图案坐标）
const camTarget = { zoom: 1.5, ax: 0, ay: 0 };  // 动画目标

const $ = (id) => document.getElementById(id);
const stageEl = $('stage');
const blurCanvas = $('mosaicBlur');
const sharpCanvas = $('mosaicSharp');
const outlinePath = $('outlinePath');
const overlay = $('overlay');
const settingsOverlay = $('settingsOverlay');

/* ================= 一、爱心几何 ================= */
let _geom = null;

function heartGeom() {
  if (_geom) return _geom;
  const pts = [];
  for (let i = 0; i < 720; i++) {
    const t = (i / 720) * Math.PI * 2;
    const s = Math.sin(t);
    pts.push([
      16 * s * s * s,
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    ]);
  }
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const [x, y] of pts) {
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  const w = xmax - xmin, h = ymax - ymin;
  const norm = pts.map(([x, y]) => [(x - xmin) / w, (ymax - y) / h]);   // 0~1，y 向下

  // 底部尖角：
  //   TIP_SLOPE = 0   -> 保持参数方程原本的尖（数学尖点，很细）
  //   TIP_SLOPE > 0   -> 把底部改成有明确夹角的直线收尖，再和原本的曲线平滑混合
  //                      尖角 = 2·atan(TIP_SLOPE)：0.42→45°、0.58→60°、1.0→90°
  const TIP_SLOPE = 0;
  const TIP_DEPTH = 0.14;     // 从底部往上 14% 的高度内生效
  if (TIP_SLOPE > 0) {
    const CX = 0.5;
    for (const p of norm) {
      const d = 1 - p[1];
      if (d <= 0 || d >= TIP_DEPTH) continue;
      const u = d / TIP_DEPTH;
      const sm = u * u * (3 - 2 * u);               // smoothstep，衔接处不留折角
      const wOrig = Math.abs(p[0] - CX);
      const wLine = TIP_SLOPE * d;                  // 直线收尖
      const w = wLine + (wOrig - wLine) * sm;
      p[0] = CX + (p[0] < CX ? -w : w);
    }
  }

  _geom = { aspect: h / w, norm };
  return _geom;
}

/* 每个高度上的半宽查表：判断“点在不在爱心里”只需一次查表比较，O(1) */
let _halfTable = null;
function heartHalfTable() {
  if (_halfTable) return _halfTable;
  const g = heartGeom();
  const p = g.norm;
  const N = 512;
  const t = new Float32Array(N);
  // 注意：不能拿多边形顶点直接填表 —— 中段曲线走得快，顶点会跳过好几行，
  // 表里会出现 0 的空洞。这里每一行拿水平线去和多边形求交，取最外侧。
  for (let i = 0; i < N; i++) {
    const ny = (i + 0.5) / N;
    let maxH = 0;
    for (let k = 0; k < p.length; k++) {
      const [x1, y1] = p[k], [x2, y2] = p[(k + 1) % p.length];
      if ((y1 <= ny) === (y2 <= ny)) continue;
      const xx = x1 + ((ny - y1) * (x2 - x1)) / (y2 - y1);
      const h = Math.abs(xx - 0.5);
      if (h > maxH) maxH = h;
    }
    t[i] = maxH;
  }
  _halfTable = t;
  return t;
}

/* 0~1 坐标里，这个点在不在爱心里 */
function insideHeartFast(nx, ny) {
  if (ny < 0 || ny > 1 || nx < 0 || nx > 1) return false;
  const t = heartHalfTable();
  const i = Math.max(0, Math.min(t.length - 1, Math.floor(ny * t.length)));
  return Math.abs(nx - 0.5) <= t[i];
}

/* 爱心在窗口里的位置（固定大小、居中） */
function layoutHeart() {
  const g = heartGeom();
  const availH = view.h * HEART_FILL;
  const availW = view.w * (HEART_FILL + 0.08);
  const hh = Math.min(availH, availW * g.aspect);
  const hw = hh / g.aspect;
  heartRect = { x: (view.w - hw) / 2, y: (view.h - hh) / 2, w: hw, h: hh };
}

/* 爱心轮廓：描边用 px，裁剪用 0~1 归一化（相对整个窗口） */
function updateHeartPaths() {
  const g = heartGeom();
  const { x: hx, y: hy, w: hw, h: hh } = heartRect;
  let dPx = '';
  g.norm.forEach(([nx, ny], i) => {
    const X = hx + nx * hw, Y = hy + ny * hh;
    dPx += (i ? 'L' : 'M') + X.toFixed(2) + ' ' + Y.toFixed(2);
  });
  $('outline').setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
  outlinePath.setAttribute('d', dPx + 'Z');
  outlinePath.setAttribute('stroke-width', state.settings.strokeWidth);
  outlinePath.style.display = Number(state.settings.strokeWidth) > 0 ? '' : 'none';

  // 裁剪路径是相对“整块画布（含外扩）”的，所以要把 M 一并换算进去
  const cw = view.w + 2 * M, ch = view.h + 2 * M;
  let dClip = '';
  g.norm.forEach(([nx, ny], i) => {
    const X = (hx + nx * hw + M) / cw, Y = (hy + ny * hh + M) / ch;
    dClip += (i ? 'L' : 'M') + X.toFixed(5) + ' ' + Y.toFixed(5);
  });
  $('heartClipPath').setAttribute('d', dClip + 'Z');
}

/* ================= 二、铺满整个窗口的长方形（横竖随机、互不重叠） ================= */
function rnd(i) {
  let t = i + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

let TILE_MIN = 62, TILE_MAX = 180;          // 方块尺寸范围（按照片数自动调整）

function assignPhotos(tiles, list, geo) {
  tiles.forEach((t) => { t.photoRef = null; });
  if (!list.length) return;
  const { cx, cy, hw, hh, halfAt } = geo;

  // ① 在爱心里撒一批“均匀座位”（按爱心面积÷照片数算间距，带抖动，固定种子打乱）
  const y0 = cy - hh / 2;
  const seatStep = Math.sqrt((0.72 * hw * hh) / list.length) * 0.92;
  const cols = Math.max(3, Math.round(hw / seatStep));
  const rows = Math.max(3, Math.round(hh / seatStep));
  const stepX = hw / cols, stepY = hh / rows;
  const seats = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const jx = (rnd(r * 131 + c * 17 + 5) - 0.5) * stepX * 0.6;
      const jy = (rnd(r * 977 + c * 613 + 9) - 0.5) * stepY * 0.6;
      const sx = cx - hw / 2 + (c + 0.5) * stepX + jx;
      const sy = y0 + (r + 0.5) * stepY + jy;
      const half = halfAt(sy);
      if (half > 20 && Math.abs(sx - cx) < half - 8) seats.push({ x: sx, y: sy });
    }
  }
  for (let i = seats.length - 1; i > 0; i--) {
    const j = Math.floor(rnd(i * 2654435761) * (i + 1));
    const t = seats[i]; seats[i] = seats[j]; seats[j] = t;
  }

  // ② 每张照片认领“离自己座位最近”的方块；就在附近几个里挑形状最合适的
  const free = tiles.filter((t) => halfAt(t.cy) > 8 && Math.abs(t.cx - cx) < halfAt(t.cy) - 3);
  if (!free.length) return;
  const used = new Set();
  list.forEach((cell, i) => {
    const seat = seats[i % Math.max(1, seats.length)] || { x: cx, y: cy };
    const A = Math.max(0.2, Math.min(5, Number(cell.aspect) || 1));
    let best = null, bestD = Infinity, bestScore = -1e9;
    for (const t of free) {
      if (used.has(t)) continue;
      const d = Math.hypot(t.cx - seat.x, t.cy - seat.y);
      if (d < bestD) bestD = d;
    }
    for (const t of free) {
      if (used.has(t)) continue;
      const d = Math.hypot(t.cx - seat.x, t.cy - seat.y);
      if (d > bestD * 1.6 + 6) continue;                         // 只在附近几个里挑
      const aspectErr = Math.abs(Math.log((t.w / t.h) / A));     // 形状越合适越好（少裁一点）
      const score = -d / Math.max(1, bestD) - aspectErr * 0.35;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (best) { used.add(best); best.photoRef = cell; }
  });
}

function buildBlocks() {
  const list = state.cells.filter((c) => c && c.photo);

  // ① 让爱心里至少有 1.4 倍照片数的方块（照片就住在这些方块里）
  const DZ = DEFAULT_SETTINGS.zoom || 1.5;
  const hw = heartRect.w / DZ, hh = heartRect.h / DZ;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const y0 = cy - hh / 2;
  const t = heartHalfTable();
  const halfAt = (py) => {
    const ny = Math.max(0, Math.min(1, (py - y0) / hh));
    const i = Math.max(0, Math.min(t.length - 1, Math.floor(ny * t.length)));
    return t[i] * hw;
  };
  const need = Math.max(14, Math.ceil(list.length * 1.4));
  const side = Math.sqrt((0.72 * hw * hh) / need);
  TILE_MIN = Math.max(16, Math.round(side * 0.6));
  TILE_MAX = Math.max(TILE_MIN + 10, Math.round(side * 1.7));
  GAP = Math.max(4, Math.min(12, Math.round(side * 0.15)));      // 缝跟着方块大小走

  // ② 随机对半切铺满整个图案区（横竖混排、大小参差 —— 凌乱美的来源）
  const out = [];
  const push = (x, y, w, h) => {
    if (w < 13 || h < 13) return;                                // 太细的条子不画，露出浅粉底
    out.push({ x, y, w, h, cx: x + w / 2, cy: y + h / 2, photoRef: null });
  };
  (function cut(x, y, w, h, depth) {
    if (w < 6 || h < 6) return;
    const seed = Math.round(x) * 7919 + Math.round(y) * 104729 + Math.round(w) * 31 + Math.round(h) * 7;
    const lim = TILE_MIN + rnd(seed + 11) * (TILE_MAX - TILE_MIN);
    if (depth > 60 || (w <= lim && h <= lim)) { push(x, y, w, h); return; }
    let vertical;
    if (w > h * 1.25) vertical = true;
    else if (h > w * 1.25) vertical = false;
    else vertical = rnd(seed) < 0.5;
    const ratio = 0.3 + rnd(seed + 5) * 0.4;
    if (vertical && w >= 40) {
      const w1 = Math.max(20, Math.min(w - 20, Math.round(w * ratio)));
      cut(x, y, w1, h, depth + 1);
      cut(x + w1, y, w - w1, h, depth + 1);
    } else if (!vertical && h >= 40) {
      const h1 = Math.max(20, Math.min(h - 20, Math.round(h * ratio)));
      cut(x, y, w, h1, depth + 1);
      cut(x, y + h1, w, h - h1, depth + 1);
    } else {
      push(x, y, w, h);
    }
  })(rect.x, rect.y, rect.w, rect.h, 0);

  // ③ 把照片分派到爱心里的方块上（方块形状不变）
  assignPhotos(out, list, { cx, cy, hw, hh, halfAt });
  return out;
}

/* 铺图案的区域：比窗口大 COVER 倍，滚轮放大时不会露出边缘 */
function layoutRect() {
  rect = {
    x: -view.w * (COVER - 1) / 2,
    y: -view.h * (COVER - 1) / 2,
    w: view.w * COVER,
    h: view.h * COVER
  };
}

/* ================= 暖心话：每次打开随机挑一句，写在“窗口标题”后面（设置里也显示同一句） ================= */
const PHRASES = [
  '今天也要好好喜欢你',
  '把喜欢你的证据，一张张收好',
  '和你在一起的每一天，都值得被记下来',
  '遇见你之后，日子就有了光',
  '我们的故事，还在继续',
  '平淡日子里，藏着最长的告白',
  '有你在的地方，就是心动的地方',
  '慢慢来，我们把日子过成想要的样子',
  '愿年年岁岁，身边都还是你',
  '每一张照片，都是一个想你的理由'
];

function pickPhrase() {
  const p = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  document.title = '心动纪念册 · ' + p;      // 窗口标题栏 / 任务栏上显示的就是这句
  const n = $('phraseNote');
  if (n) n.textContent = p;                  // 设置面板里的“待定”位置也用同一句
  window.__phrase = p;
  return p;
}

/* ================= 背景音乐 =================
   有 music 文件夹里的音频就用它们循环播放；没有就用内置的合成纯音乐（music.js） */
const bgm = {
  mode: 'synth',
  files: [],
  audio: null,
  idx: 0,
  on: false,

  async init() {
    await this.reload(true);
  },

  /* 重新读 music 文件夹：空 -> 用内置合成；有文件 -> 用你的音乐（免重启切换） */
  async reload(fromInit) {
    let list = [];
    try { list = await api.musicList(); } catch (e) { list = []; }
    const prevName = this.mode === 'files' && this.files[this.idx] ? this.files[this.idx].name : null;
    this.files = list;

    const vol = Number(state.settings.musicVolume) || 0.35;

    if (!list.length) {                       // 没有文件：用内置合成
      if (this.mode === 'files') {
        if (this.audio) this.audio.pause();
        this.audio = null;
        this.mode = 'synth';
      }
      if (state.settings.music) {             // 该响就得响（原来这里漏了，会导致默认不播放）
        this.on = true;
        window.MUSIC.setVolume(vol);
        window.MUSIC.start();
      } else if (!fromInit) {
        this.pause();
      }
      this.sync();
      return;
    }

    const keep = list.findIndex((f) => f.name === prevName);
    this.idx = keep >= 0 ? keep : 0;
    if (this.mode !== 'files') {              // 从内置切到你的音乐
      if (this.on) window.MUSIC.stop();
      this.mode = 'files';
      this.audio = new Audio();
      this.audio.addEventListener('ended', () => this.next());
    }
    this.audio.volume = vol;
    const url = list[this.idx].url;
    if (this.audio.src !== url) this.audio.src = url;
    if (state.settings.music && !this.on) this.play();
    if (this.on) this.audio.play().catch(() => {});
    this.sync();
  },

  next() {
    if (!this.files.length) return;
    this.idx = (this.idx + 1) % this.files.length;
    if (this.audio) this.audio.src = this.files[this.idx].url;
    if (this.on && this.audio) this.audio.play().catch(() => {});
    this.sync();
  },

  play() {
    this.on = true;
    if (this.mode === 'files' && this.audio) {
      this.audio.play().catch(() => {});
    } else {
      window.MUSIC.start();
      window.MUSIC.setVolume(Number(state.settings.musicVolume) || 0.35);
    }
    this.sync();
  },

  pause() {
    this.on = false;
    if (this.mode === 'files' && this.audio) this.audio.pause();
    else window.MUSIC.stop();
    this.sync();
  },

  setVolume(v) {
    const vol = Math.max(0, Math.min(1, v));
    if (this.mode === 'files' && this.audio) this.audio.volume = vol;
    else window.MUSIC.setVolume(vol);
  },

  apply(fromInit) {
    if (state.settings.music) this.play();
    else { this.sync(); if (!fromInit) this.pause(); }
  },

  sync() {
    const b = $('musicBtn');
    if (b) b.textContent = this.on ? '🎵 播放中' : '🔇 已关闭';
    const v = $('musicVol');
    if (v) v.value = String(Number(state.settings.musicVolume) || 0.35);
    const vv = $('musicVolVal');
    if (vv) vv.textContent = Math.round((Number(state.settings.musicVolume) || 0.35) * 100) + '%';
    const mp = $('musicPath');
    if (mp) {
      mp.textContent = this.mode === 'files'
        ? `${this.idx + 1}/${this.files.length} · ${this.files[this.idx].name}`
        : '内置小提琴曲（点「＋ 导入音乐」换成你自己的）';
    }
  }
};

/* ================= 三、照片缩略图（小图缓存，省内存） ================= */
const thumbs = new Map();        // fileName -> { img } | 'loading'

function getThumb(fileName) {
  const hit = thumbs.get(fileName);
  if (hit) return hit === 'loading' ? null : hit.img;
  thumbs.set(fileName, 'loading');
  (async () => {
    try {
      const url = await api.getPhoto(fileName);
      if (!url) throw new Error('missing');
      const img = await loadImage(url);
      const max = 520;                       // 保留原始长宽比，只缩小
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const tw = Math.max(1, Math.round(img.width * k));
      const th = Math.max(1, Math.round(img.height * k));
      const c = document.createElement('canvas');
      c.width = tw; c.height = th;
      c.getContext('2d').drawImage(img, 0, 0, tw, th);
      const small = new Image();
      small.onload = () => { thumbs.set(fileName, { img: small }); scheduleDraw(); };
      small.src = c.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      thumbs.set(fileName, { img: null });
    }
  })();
  return null;
}

/* ================= 四、照片按位置配对到长方形 ================= */
function assignCells() {
  // 照片方块已经知道自己属于谁，直接用
  blocks.forEach((b) => { b.cell = b.photoRef || null; });
  const used = new Set();
  blocks.forEach((b) => { if (b.cell) used.add(b.cell); });

  // 剩下的（只有文字、或者照片暂时没落位的）按位置就近配对到空格子
  const rest = state.cells.filter((c) => c && (c.photo || c.desc) && !used.has(c));
  const free = blocks.filter((b) => !b.cell);
  if (rest.length && free.length) {
    const pairs = [];
    rest.forEach((cell, ci) => {
      const nx = typeof cell.x === 'number' ? cell.x : -9;
      const ny = typeof cell.y === 'number' ? cell.y : -9;
      free.forEach((b, bi) => {
        const dx = nx - (b.cx - rect.x) / rect.w;
        const dy = ny - (b.cy - rect.y) / rect.h;
        pairs.push({ ci, bi, d: dx * dx + dy * dy });
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const takenCell = new Set(), takenBlock = new Set();
    for (const p of pairs) {
      if (takenCell.has(p.ci) || takenBlock.has(p.bi)) continue;
      takenCell.add(p.ci); takenBlock.add(p.bi);
      free[p.bi].cell = rest[p.ci];
    }
  }

  // 记住每格现在的位置，下次重建时照片还在这儿
  blocks.forEach((b) => {
    if (b.cell) {
      b.cell.x = (b.cx - rect.x) / rect.w;
      b.cell.y = (b.cy - rect.y) / rect.h;
    }
  });
}

/* ================= 五、画图 ================= */
function scheduleDraw() {
  if (pendingDraw) return;
  pendingDraw = requestAnimationFrame(() => {
    pendingDraw = 0;
    draw();
  });
}

function fitCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = view.w + 2 * M, ch = view.h + 2 * M;
  const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
  canvas.style.left = -M + 'px';
  canvas.style.top = -M + 'px';
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, M * dpr, M * dpr);   // 之后都按窗口坐标画
  return ctx;
}

/* 画一个方块（照片 or 粉色底） */
function drawTile(ctx, b, z) {
  const gap = GAP;
  const x = b.x + gap / 2, y = b.y + gap / 2;
  const w = Math.max(1, b.w - gap), h = Math.max(1, b.h - gap);
  const cell = b.cell;
  const thumb = cell && cell.photo ? getThumb(cell.photo) : null;

  if (thumb && thumb.complete && thumb.naturalWidth) {
    const sc = Math.max(w / thumb.naturalWidth, h / thumb.naturalHeight);
    const sw = w / sc, sh = h / sc;
    ctx.drawImage(thumb,
      (thumb.naturalWidth - sw) / 2, (thumb.naturalHeight - sh) / 2, sw, sh,
      x, y, w, h);
    ctx.fillStyle = 'rgba(255, 190, 215, .12)';       // 照片上盖一点点粉，保持整体调性
    ctx.fillRect(x, y, w, h);
  } else {
    ctx.fillStyle = cell && (cell.photo || cell.desc) ? '#ff6397' : '#ffc4da';
    ctx.fillRect(x, y, w, h);
    if (cell && cell.photo) {
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.font = `${Math.max(8, Math.min(w, h) * 0.42)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♥', x + w / 2, y + h / 2 + 1);
    }
  }
  // 内高光，让每块有厚度（线宽按 1/zoom 折算，屏幕上始终是 1px）
  ctx.strokeStyle = 'rgba(255,255,255,.42)';
  ctx.lineWidth = 1 / z;
  ctx.strokeRect(x + 0.5 / z, y + 0.5 / z, w - 1 / z, h - 1 / z);
}

/* 悬停预览：鼠标停在带照片的方块上时，它会放大浮起来 */
let hoverAmt = 0, hoverRaf = 0;
function previewScale(b) {
  const m = Math.min(b.w, b.h);
  return Math.max(1.15, Math.min(1.9, 130 / m));
}
function animateHover() {
  if (hoverRaf) return;
  const step = () => {
    hoverRaf = 0;
    const want = (hoverBlock && hoverBlock.cell && hoverBlock.cell.photo) ? 1 : 0;
    const d = want - hoverAmt;
    if (Math.abs(d) < 0.03) { hoverAmt = want; draw(); return; }
    hoverAmt += d * 0.28;
    draw();
    hoverRaf = requestAnimationFrame(step);
  };
  hoverRaf = requestAnimationFrame(step);
}

function draw() {
  const z = cam.zoom;
  const halfW = view.w / (2 * z), halfH = view.h / (2 * z);
  const visX0 = cam.ax - halfW, visX1 = cam.ax + halfW;
  const visY0 = cam.ay - halfH, visY1 = cam.ay + halfH;

  for (const canvas of [blurCanvas, sharpCanvas]) {
    const ctx = fitCanvas(canvas);
    ctx.clearRect(-M, -M, view.w + 2 * M, view.h + 2 * M);
    // 镜头：把图案按 zoom 放大，并让光标/中心对准
    ctx.translate(view.w / 2, view.h / 2);
    ctx.scale(z, z);
    ctx.translate(-cam.ax, -cam.ay);

    if (canvas === sharpCanvas) {                    // 只有“爱心里面”这层铺底色
      ctx.fillStyle = '#ffe0ed';
      ctx.fillRect(visX0, visY0, visX1 - visX0, visY1 - visY0);
    }

    const order = blocks.slice().sort((a, b) => (a.photoRef ? 1 : 0) - (b.photoRef ? 1 : 0));
    for (const b of order) {
      if (b.x + b.w < visX0 || b.x > visX1 || b.y + b.h < visY0 || b.y > visY1) continue;  // 视野外不画
      drawTile(ctx, b, z);
      if (b === hoverBlock && hoverAmt < 0.5) {      // 预览时会另外放大画一次
        ctx.strokeStyle = 'rgba(255, 90, 145, .85)';
        ctx.lineWidth = 2 / z;
        ctx.strokeRect(b.x + GAP / 2 + 1 / z, b.y + GAP / 2 + 1 / z, b.w - GAP - 2 / z, b.h - GAP - 2 / z);
      }
    }

    // 悬停的那一块放大画在最上面（预览效果）
    if (b_visible(hoverBlock, visX0, visX1, visY0, visY1) && hoverAmt > 0.01) {
      const b = hoverBlock;
      const s = 1 + (previewScale(b) - 1) * hoverAmt;
      ctx.save();
      ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
      ctx.scale(s, s);
      ctx.translate(-(b.x + b.w / 2), -(b.y + b.h / 2));
      ctx.shadowColor = 'rgba(190, 50, 100, .45)';
      ctx.shadowBlur = 26 / z;
      ctx.shadowOffsetY = 8 / z;
      drawTile(ctx, b, z);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255, 90, 145, .95)';
      ctx.lineWidth = 2.5 / z;
      const g = GAP / 2;
      const w2 = b.w * s - GAP, h2 = b.h * s - GAP;
      ctx.strokeRect(b.x + b.w / 2 - w2 / 2 + 1 / z, b.y + b.h / 2 - h2 / 2 + 1 / z, w2 - 2 / z, h2 - 2 / z);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);   // 复位，别影响下一次
  }
}

function b_visible(b, x0, x1, y0, y1) {
  return !!b && !(b.x + b.w < x0 || b.x > x1 || b.y + b.h < y0 || b.y > y1);
}

/* ================= 六、整体重建 ================= */
function rebuild() {
  layoutHeart();
  layoutRect();
  updateHeartPaths();
  blocks = buildBlocks();
  assignCells();
  applyOutsideStyle();
  clampCam(camTarget);
  cam.zoom = camTarget.zoom; cam.ax = camTarget.ax; cam.ay = camTarget.ay;
  draw();
}

function applyOutsideStyle() {
  const s = state.settings;
  blurCanvas.style.filter = Number(s.blur) > 0 ? `blur(${s.blur}px)` : 'none';
  blurCanvas.style.opacity = String(s.outsideAlpha);
}

/* ================= 六点五、镜头（几何缩放，爱心不受影响） ================= */
function screenToPattern(sx, sy, c) {
  return {
    x: c.ax + (sx - view.w / 2) / c.zoom,
    y: c.ay + (sy - view.h / 2) / c.zoom
  };
}

/* 图案必须始终盖满窗口，所以限制画面中心能跑的范围 */
function clampCam(c) {
  const hw = view.w / (2 * c.zoom), hh = view.h / (2 * c.zoom);
  const minX = rect.x + hw, maxX = rect.x + rect.w - hw;
  const minY = rect.y + hh, maxY = rect.y + rect.h - hh;
  c.ax = minX > maxX ? (rect.x + rect.w / 2) : Math.max(minX, Math.min(maxX, c.ax));
  c.ay = minY > maxY ? (rect.y + rect.h / 2) : Math.max(minY, Math.min(maxY, c.ay));
}

/* 以某个屏幕点为焦点缩放（滚轮就是靠这个聚焦到鼠标位置的） */
function zoomAt(factor, sx, sy) {
  const z0 = camTarget.zoom;
  const z1 = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z0 * factor));
  if (Math.abs(z1 - z0) < 0.0005) return;
  const p = screenToPattern(sx, sy, camTarget);
  camTarget.ax = p.x - (sx - view.w / 2) / z1;      // 让鼠标下面那个点保持不动
  camTarget.ay = p.y - (sy - view.h / 2) / z1;
  camTarget.zoom = z1;
  clampCam(camTarget);
  state.settings.zoom = z1;
  syncSettingsLabels();
  queueSettingsSave();
  startAnim();
}

function startAnim() {
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function tick() {
  rafId = 0;
  try {
    const dz = camTarget.zoom - cam.zoom;
    const dx = camTarget.ax - cam.ax;
    const dy = camTarget.ay - cam.ay;
    if (Math.abs(dz) < 0.0006 && Math.abs(dx) < 0.12 && Math.abs(dy) < 0.12) {
      cam.zoom = camTarget.zoom; cam.ax = camTarget.ax; cam.ay = camTarget.ay;
      draw();
      return;
    }
    cam.zoom += dz * EASE;
    cam.ax += dx * EASE;
    cam.ay += dy * EASE;
    draw();
    rafId = requestAnimationFrame(tick);
  } catch (e) {
    // 万一某帧画崩了，也要把循环标志清掉，不然动画会永久卡住
    console.error('动画帧出错', e);
    rafId = 0;
  }
}

/* ================= 七、交互 ================= */
/* 鼠标在哪个方块上。先按“看得见的那块”（四周内缩了半条缝）判定，
   这样鼠标明明在某个方块里、靠近边缘时不会选到隔壁去 */
function blockAt(sx, sy) {
  const p = screenToPattern(sx, sy, cam);
  let normal = null;
  for (const b of blocks) {
    const w = b.w - GAP, h = b.h - GAP;
    if (w <= 0 || h <= 0) continue;
    const x = b.x + GAP / 2, y = b.y + GAP / 2;
    if (p.x >= x && p.x < x + w && p.y >= y && p.y < y + h) {
      if (b.photoRef) return b;          // 照片方块优先（万一有压盖也点到照片）
      if (!normal) normal = b;
    }
  }
  if (normal) return normal;
  // 正好点在缝里：退回按整块范围选（缝只有 9px，影响很小）
  for (const b of blocks) {
    if (p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h) return b;
  }
  return null;
}

stageEl.addEventListener('mousemove', (e) => {
  const b = blockAt(e.clientX, e.clientY);
  if (b !== hoverBlock) {
    hoverBlock = b;
    stageEl.classList.toggle('pointing', !!b);
    scheduleDraw();
    animateHover();
  }
});
stageEl.addEventListener('mouseleave', () => {
  if (hoverBlock) { hoverBlock = null; stageEl.classList.remove('pointing'); scheduleDraw(); animateHover(); }
});

stageEl.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; return; }   // 刚刚是长按拖动，不算点击
  const b = blockAt(e.clientX, e.clientY);
  if (!b) return;
  const i = blocks.indexOf(b);
  if (i < 0) return;
  if (b.cell && b.cell.photo) openViewer(i);
  else openEditor(i);
});

/* 按住拖动 = 移动画面（不用等长按）；单纯点击仍然是打开方块
   —— 判据是“手指有没有真的移动过”，所以点一下不会被当成拖动 */
const LONG_PRESS_MS = 0;            // 0 = 按住即拖；想改回“长按才拖”就填 280
const LONG_PRESS_SLOP = 7;          // 长按判定前允许的抖动（LONG_PRESS_MS > 0 时才有用）
const PAN_START_PX = 2;             // 移动超过这么多像素才算拖动

let pressTimer = null;
let pressOrigin = null;
let panFrom = null;
let panning = false;
let panMoved = false;
let suppressClick = false;
let lastPointer = [0, 0];

function startPan() {
  panning = true;
  if (LONG_PRESS_MS > 0) {          // 长按模式下立刻给反馈；直接拖动模式等真的动了再变
    hoverBlock = null;
    stageEl.classList.remove('pointing');
    stageEl.classList.add('panning');
    scheduleDraw();
    animateHover();
  }
}

function endPress() {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  pressOrigin = null;
  if (panning) {
    panning = false;
    panFrom = null;
    stageEl.classList.remove('panning');
    const b = blockAt(lastPointer[0], lastPointer[1]);   // 恢复悬停高亮
    hoverBlock = b;
    stageEl.classList.toggle('pointing', !!b);
    scheduleDraw();
    animateHover();
  }
}

stageEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || modalOpen()) return;
  lastPointer = [e.clientX, e.clientY];
  pressOrigin = { x: e.clientX, y: e.clientY };
  panFrom = { x: e.clientX, y: e.clientY, ax: camTarget.ax, ay: camTarget.ay };
  panning = false;
  panMoved = false;
  try { stageEl.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件可能不支持 */ }
  clearTimeout(pressTimer);
  if (LONG_PRESS_MS <= 0) startPan();
  else pressTimer = setTimeout(() => { if (pressOrigin) startPan(); }, LONG_PRESS_MS);
});

stageEl.addEventListener('pointermove', (e) => {
  lastPointer = [e.clientX, e.clientY];
  if (!pressOrigin) return;
  if (!panning) {
    // 还没到长按时间就移动了 -> 不是长按，取消
    if (Math.hypot(e.clientX - pressOrigin.x, e.clientY - pressOrigin.y) > LONG_PRESS_SLOP) {
      clearTimeout(pressTimer);
      pressTimer = null;
      pressOrigin = null;
    }
    return;
  }
  if (!panMoved) {
    if (Math.hypot(e.clientX - panFrom.x, e.clientY - panFrom.y) < PAN_START_PX) return;
    panMoved = true;                                        // 真的开始拖了
    hoverBlock = null;                                      // 拖动时不显示悬停高亮
    stageEl.classList.remove('pointing');
    stageEl.classList.add('panning');
    animateHover();
  }
  const ddx = (e.clientX - panFrom.x) / cam.zoom;           // 屏幕位移换算成图案位移
  const ddy = (e.clientY - panFrom.y) / cam.zoom;
  camTarget.ax = panFrom.ax - ddx;
  camTarget.ay = panFrom.ay - ddy;
  clampCam(camTarget);
  cam.ax = camTarget.ax;                                    // 拖动要跟手，直接生效
  cam.ay = camTarget.ay;
  draw();
});

stageEl.addEventListener('pointerup', (e) => {
  if (panning && panMoved) {                                // 真拖过 -> 松手别误开方块
    suppressClick = true;
    clearTimeout(suppressClick.t);
    suppressClick.t = setTimeout(() => { suppressClick = false; }, 200);
  }
  endPress();
  try { stageEl.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});

stageEl.addEventListener('pointercancel', () => { endPress(); });

/* 滚轮：以鼠标位置为焦点柔和地放大缩小长方形，爱心纹丝不动 */
window.addEventListener('wheel', (e) => {
  if (modalOpen()) return;
  e.preventDefault();
  zoomAt(Math.exp(-e.deltaY * 0.0011), e.clientX, e.clientY);
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOpen()) {
    closeOverlay();
    settingsOverlay.classList.add('hidden');
    return;
  }
  if (modalOpen()) return;
  if (e.key === '+' || e.key === '=') zoomAt(1.12, view.w / 2, view.h / 2);
  if (e.key === '-' || e.key === '_') zoomAt(1 / 1.12, view.w / 2, view.h / 2);
});

function modalOpen() {
  return !overlay.classList.contains('hidden') || !settingsOverlay.classList.contains('hidden');
}

/* ================= 八、存档 ================= */
async function persist() {
  try { await api.saveData(state); } catch (e) { console.error('保存失败', e); }
}

let saveTimer = null;
function queueSettingsSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 600);
}

/* ================= 九、弹层 ================= */
function openEditor(i) {
  currentBlock = i;
  const cell = blocks[i].cell;
  editorPhoto = cell && cell.photo ? { dataUrl: null, file: cell.photo, isNew: false } : null;

  $('editorTitle').textContent = cell && cell.photo ? '编辑这一格' : '这个方格里还没有照片哦';
  $('editorDesc').value = (cell && cell.desc) || '';
  const thumb = $('editorThumb');
  const clearBtn = $('clearPhotoBtn');

  if (cell && cell.photo) {
    thumb.textContent = '载入中…';
    thumb.className = 'thumb has';
    clearBtn.classList.remove('hidden');
    api.getPhoto(cell.photo).then((url) => {
      if (!url) { thumb.className = 'thumb empty'; thumb.textContent = '照片找不到了'; return; }
      if (editorPhoto && editorPhoto.file === cell.photo) {
        editorPhoto.dataUrl = url;
        thumb.style.backgroundImage = `url("${url}")`;
        thumb.textContent = '';
      }
    });
  } else {
    thumb.className = 'thumb empty';
    thumb.style.backgroundImage = '';
    thumb.textContent = '还没有选择照片';
    clearBtn.classList.add('hidden');
  }
  showView('editorView');
}

function showView(id) {
  $('editorView').classList.add('hidden');
  $('viewerView').classList.add('hidden');
  $(id).classList.remove('hidden');
  overlay.classList.remove('hidden');
}

function closeOverlay() {
  stopTyping();
  overlay.classList.add('hidden');
  currentBlock = -1;
  editorPhoto = null;
}

/* 文字一个一个跳出来 */
function stopTyping() {
  if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
}

function typeText(el, text) {
  stopTyping();
  el.innerHTML = '';
  const chars = Array.from(text || '');
  let i = 0;
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '|';
  el.appendChild(caret);

  (function step() {
    if (i >= chars.length) { caret.remove(); typeTimer = null; return; }
    const ch = chars[i++];
    if (ch === '\n') {
      el.insertBefore(document.createElement('br'), caret);
    } else {
      const s = document.createElement('span');
      s.className = 'pop';
      s.textContent = ch === ' ' ? '\u00a0' : ch;
      el.insertBefore(s, caret);
    }
    let delay = 78;
    if ('，。！？、；：,.!?;:'.includes(ch)) delay = 320;
    else if (ch === '\n') delay = 260;
    else if (rnd(i) > 0.85) delay = 130;
    typeTimer = setTimeout(step, delay);
  })();
}

async function openViewer(i) {
  currentBlock = i;
  const cell = blocks[i].cell || {};
  const img = $('viewerImg');
  const desc = $('viewerDesc');
  desc.textContent = '';
  img.removeAttribute('src');
  showView('viewerView');
  const url = await api.getPhoto(cell.photo);
  if (url) img.src = url;
  typeText(desc, cell.desc && cell.desc.trim() ? cell.desc : '（这一格还没有写下文字～）');
}

/* ================= 图片库（pictures 文件夹） ================= */
const libThumbs = new Map();          // name -> { dataUrl, width, height }
let libSelected = null;

async function refreshLibrary() {
  const grid = $('libGrid');
  const list = await api.libraryList();
  $('libCount').textContent = list.length ? list.length + ' 张' : '';
  $('libEmpty').classList.toggle('hidden', list.length > 0);
  grid.innerHTML = '';
  if (!list.length) return;

  const frag = document.createDocumentFragment();
  for (const item of list) {
    const el = document.createElement('div');
    el.className = 'libitem' + (libSelected === item.name ? ' sel' : '');
    el.dataset.name = item.name;
    el.title = item.name;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '从图片库里删掉';
    el.appendChild(del);
    frag.appendChild(el);

    const cached = libThumbs.get(item.name);
    if (cached) {
      el.style.backgroundImage = `url("${cached.dataUrl}")`;
    } else {
      api.libraryThumb(item.name).then((r) => {
        if (!r || !r.dataUrl) return;
        libThumbs.set(item.name, r);
        el.style.backgroundImage = `url("${r.dataUrl}")`;
      });
    }
  }
  grid.appendChild(frag);
}

$('libToggleBtn').addEventListener('click', async () => {
  const panel = $('libraryPanel');
  const show = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  if (show) {
    await showLibraryCount();
    await refreshLibrary();
  }
});

$('libAddBtn').addEventListener('click', async () => {
  const r = await api.libraryAdd();
  if (r && r.added) toast(`导入 ${r.added} 张图片 💗`);
  await refreshLibrary();
});

$('libOpenBtn').addEventListener('click', () => api.libraryOpen());
$('openPicsBtn').addEventListener('click', () => api.libraryOpen());

async function importToLibrary() {
  const r = await api.libraryAdd();
  if (r && r.added) toast(`已导入 ${r.added} 张到图片库 💗`);
  else if (r && r.canceled) { /* 用户取消 */ }
  else toast('没有导入新图片');
  await showLibraryCount();
}

$('importPicsBtn').addEventListener('click', importToLibrary);

/* 设置面板里显示图片库有多少张 */
async function showLibraryCount() {
  try {
    const list = await api.libraryList();
    $('picsPath').textContent = list.length ? `共 ${list.length} 张，可在格子里选用` : '还是空的';
  } catch (e) { /* ignore */ }
}

$('libGrid').addEventListener('click', async (e) => {
  const item = e.target.closest('.libitem');
  if (!item) return;
  const name = item.dataset.name;
  if (e.target.classList.contains('del')) {           // 删除
    const list = await api.libraryRemove(name);
    libThumbs.delete(name);
    if (libSelected === name) libSelected = null;
    $('libCount').textContent = list.length ? list.length + ' 张' : '';
    $('libEmpty').classList.toggle('hidden', list.length > 0);
    await refreshLibrary();
    return;
  }
  // 选中这张
  libSelected = name;
  $('libGrid').querySelectorAll('.libitem').forEach((el) => {
    el.classList.toggle('sel', el.dataset.name === name);
  });
  let info = libThumbs.get(name);
  if (!info) {
    info = await api.libraryThumb(name);
    if (info) libThumbs.set(name, info);
  }
  if (!info || !info.dataUrl) { toast('这张图片读不出来'); return; }
  const aspect = (info.width && info.height) ? info.width / info.height : 1;
  editorPhoto = { libName: name, dataUrl: info.dataUrl, isNew: false, file: null, aspect };
  const thumb = $('editorThumb');
  thumb.className = 'thumb has';
  thumb.style.backgroundImage = `url("${dataUrl}")`;
  thumb.textContent = '';
  $('clearPhotoBtn').classList.remove('hidden');
});

/* 添加 / 编辑照片 */
$('pickBtn').addEventListener('click', async () => {
  const picked = await api.pickPhoto();
  if (!picked) return;
  const small = await downscale(picked.dataUrl, 1400, 0.88);
  let aspect = 1;
  try {
    const im = await loadImage(small);
    aspect = im.width / im.height;
  } catch (e) { /* 用方形的兜底 */ }
  editorPhoto = { dataUrl: small, file: null, isNew: true, aspect };
  libSelected = null;
  $('libGrid').querySelectorAll('.libitem.sel').forEach((el) => el.classList.remove('sel'));
  const thumb = $('editorThumb');
  thumb.className = 'thumb has';
  thumb.style.backgroundImage = `url("${small}")`;
  thumb.textContent = '';
  $('clearPhotoBtn').classList.remove('hidden');
});

$('clearPhotoBtn').addEventListener('click', () => {
  editorPhoto = null;
  const thumb = $('editorThumb');
  thumb.className = 'thumb empty';
  thumb.style.backgroundImage = '';
  thumb.textContent = '还没有选择照片';
  $('clearPhotoBtn').classList.add('hidden');
});

$('saveBtn').addEventListener('click', async () => {
  if (currentBlock < 0) return;
  const b = blocks[currentBlock];
  const desc = $('editorDesc').value.trim();
  const oldPhoto = b.cell && b.cell.photo;

  try {
    let photo = null;
    let aspect = editorPhoto ? editorPhoto.aspect : null;
    if (editorPhoto) {
      if (editorPhoto.libName) {
        const r = await api.libraryUse(editorPhoto.libName);   // 从图片库复制一份进相册
        photo = r ? r.fileName : null;
        if (r && r.width && r.height) aspect = r.width / r.height;
      } else if (editorPhoto.isNew && editorPhoto.dataUrl) {
        photo = await api.savePhoto(editorPhoto.dataUrl);
      } else {
        photo = editorPhoto.file || null;
      }
    }
    if (oldPhoto && oldPhoto !== photo) {                      // 换图了就把旧图清掉
      api.deletePhoto(oldPhoto);
      thumbs.delete(oldPhoto);
    }

    if (photo || desc) {
      if (!b.cell) {
        b.cell = { photo: null, desc: '', x: (b.cx - rect.x) / rect.w, y: (b.cy - rect.y) / rect.h };
        state.cells.push(b.cell);
      }
      b.cell.photo = photo;
      b.cell.desc = desc;
      b.cell.aspect = aspect || b.cell.aspect || 1;
      b.cell.x = (b.cx - rect.x) / rect.w;      // 记住位置，换布局后照片还在原地
      b.cell.y = (b.cy - rect.y) / rect.h;
    } else if (b.cell) {
      const k = state.cells.indexOf(b.cell);
      if (k >= 0) state.cells.splice(k, 1);
      b.cell = null;
    }

    await persist();
    draw();
    closeOverlay();
    toast(photo ? '已经放进纪念册啦 💗' : '这一格空着也很好看～');
  } catch (err) {
    console.error(err);
    toast('保存出了点问题，再试一次好吗');
  }
});

$('editBtn').addEventListener('click', () => { if (currentBlock >= 0) openEditor(currentBlock); });
$('replayBtn').addEventListener('click', () => {
  const cell = (blocks[currentBlock] || {}).cell || {};
  typeText($('viewerDesc'), cell.desc && cell.desc.trim() ? cell.desc : '（这一格还没有写下文字～）');
});
$('delBtn').addEventListener('click', async () => {
  if (currentBlock < 0) return;
  const b = blocks[currentBlock];
  if (b.cell) {
    if (b.cell.photo) { api.deletePhoto(b.cell.photo); thumbs.delete(b.cell.photo); }
    const k = state.cells.indexOf(b.cell);
    if (k >= 0) state.cells.splice(k, 1);
    b.cell = null;
    await persist();
    draw();
  }
  closeOverlay();
  toast('这一格已经清空了');
});

overlay.addEventListener('click', (e) => {
  if (e.target === overlay || e.target.hasAttribute('data-close')) closeOverlay();
});

/* ================= 十、设置 ================= */
function syncSettingsLabels() {
  $('setBlockScale').value = state.settings.zoom;
  $('setBlockScaleVal').textContent = Number(state.settings.zoom).toFixed(2) + '×';
  $('setBlur').value = state.settings.blur;
  $('setBlurVal').textContent = Number(state.settings.blur).toFixed(0) + 'px';
  $('setAlpha').value = state.settings.outsideAlpha;
  $('setAlphaVal').textContent = Math.round(state.settings.outsideAlpha * 100) + '%';
  $('setStroke').value = state.settings.strokeWidth;
  $('setStrokeVal').textContent = Number(state.settings.strokeWidth).toFixed(1);
}

function applyStroke() {
  outlinePath.setAttribute('stroke-width', state.settings.strokeWidth);
  outlinePath.style.display = Number(state.settings.strokeWidth) > 0 ? '' : 'none';
}

$('musicBtn').addEventListener('click', () => {
  state.settings.music = !state.settings.music;
  if (state.settings.music) bgm.play(); else bgm.pause();
  persist();
});

$('musicVol').addEventListener('input', (e) => {
  state.settings.musicVolume = Number(e.target.value);
  bgm.setVolume(state.settings.musicVolume);
  bgm.sync();
});
$('musicVol').addEventListener('change', persist);

$('openMusicBtn').addEventListener('click', async () => {
  await api.openMusicFolder();
  toast('把 mp3 / flac 丢进这个文件夹，或在设置里点「＋ 导入音乐」');
});

$('importMusicBtn').addEventListener('click', async () => {
  const r = await api.musicAdd();
  if (r && r.added) {
    await bgm.reload();                       // 免重启，立刻换成你的音乐
    if (!state.settings.music) { state.settings.music = true; bgm.play(); }
    if (bgm.mode === 'files' && bgm.audio) bgm.audio.play().catch(() => {});
    toast(`已导入 ${r.added} 首，开始播放你的音乐 🎻`);
    persist();
  } else if (r && !r.added) {
    toast('没有选中音乐文件');
  }
});

$('settingsBtn').addEventListener('click', () => {
  syncSettingsLabels();
  showLibraryCount();
  settingsOverlay.classList.remove('hidden');
});

$('setBlockScale').addEventListener('input', (e) => {
  const z = Number(e.target.value);
  const p = screenToPattern(view.w / 2, view.h / 2, camTarget);   // 以窗口中心为焦点
  camTarget.zoom = z;
  camTarget.ax = p.x;          // 画面中心对应的图案点保持不动
  camTarget.ay = p.y;
  clampCam(camTarget);
  state.settings.zoom = z;
  syncSettingsLabels();
  startAnim();
});
$('setBlockScale').addEventListener('change', persist);

$('setBlur').addEventListener('input', (e) => {
  state.settings.blur = Number(e.target.value);
  applyOutsideStyle();
  syncSettingsLabels();
});
$('setBlur').addEventListener('change', persist);

$('setAlpha').addEventListener('input', (e) => {
  state.settings.outsideAlpha = Number(e.target.value);
  applyOutsideStyle();
  syncSettingsLabels();
});
$('setAlpha').addEventListener('change', persist);

$('setStroke').addEventListener('input', (e) => {
  state.settings.strokeWidth = Number(e.target.value);
  applyStroke();
  syncSettingsLabels();
});
$('setStroke').addEventListener('change', persist);

$('openDataBtn').addEventListener('click', () => api.openDataFolder());

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay || e.target.hasAttribute('data-close-settings')) {
    settingsOverlay.classList.add('hidden');
  }
});

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ================= 十一、图片压缩 ================= */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function downscale(dataUrl, max, quality) {
  try {
    const img = await loadImage(dataUrl);
    if (img.width <= max && img.height <= max) return dataUrl;
    const scale = Math.min(max / img.width, max / img.height);
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } catch (e) {
    return dataUrl;
  }
}

/* ================= 十二、窗口尺寸 ================= */
function resize() {
  // 保持画面中心对应的图案点不变
  const p = screenToPattern(view.w / 2, view.h / 2, cam);
  view = { w: window.innerWidth, h: window.innerHeight };
  layoutHeart();
  layoutRect();
  updateHeartPaths();
  blocks = buildBlocks();
  assignCells();
  applyOutsideStyle();
  camTarget.ax = p.x; camTarget.ay = p.y;
  clampCam(camTarget);
  cam.zoom = camTarget.zoom; cam.ax = camTarget.ax; cam.ay = camTarget.ay;
  draw();
}

window.addEventListener('resize', resize);

/* ================= 十三、启动 ================= */
(async function init() {
  view = { w: window.innerWidth, h: window.innerHeight };
  try {
    const loaded = await api.loadData();
    if (loaded) {
      state.cells = Array.isArray(loaded.cells) ? loaded.cells.filter(Boolean) : [];
      state.settings = Object.assign({}, DEFAULT_SETTINGS, loaded.settings || {});
      state.settings.zoom = Number(state.settings.zoom) || DEFAULT_SETTINGS.zoom;
      state.version = 6;
    }
  } catch (e) {
    console.error('读取存档失败', e);
  }
  pickPhrase();                                   // 每次打开换一句暖心话
  bgm.init();                                     // 背景音乐（有 music 文件就用文件，否则内置合成）
  cam.zoom = camTarget.zoom = Number(state.settings.zoom) || 1.5;
  layoutRect();                                   // 先把镜头对准图案中心，而不是左上角
  cam.ax = camTarget.ax = rect.x + rect.w / 2;
  cam.ay = camTarget.ay = rect.y + rect.h / 2;
  rebuild();
  syncSettingsLabels();
  try {
    const p = await api.paths();
    $('picsPath').textContent = p.pictures;
  } catch (e) { /* ignore */ }
})();
