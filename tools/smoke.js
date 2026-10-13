// 自检脚本：验证 铺满全屏的长方形 / 固定爱心 / 内外两层 / 照片 / 存档 / 设置
// 运行： npm run selftest
const { app, BrowserWindow } = require('electron');
/* 生成一段 1.2 秒的测试音频（WAV），用来验证“换成自己的音乐”这条链路 */
function makeTestWav() {
  const rate = 22050, secs = 1.2, n = Math.floor(rate * secs);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = Math.sin(2 * Math.PI * 440 * t) * 0.3 * Math.min(1, t * 8) * Math.min(1, (secs - t) * 4);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}
const fs = require('fs');
const path = require('path');

module.exports = function selftest() {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { console.log('SELFTEST 失败：没有找到窗口'); return app.exit(1); }
    try {
      const res = await win.webContents.executeJavaScript(`(async () => {
        const out = {};
        out.blocks = blocks.length;
        const areas = blocks.map((b) => b.w * b.h);
        out.avgBlock = Math.round(Math.sqrt(areas.reduce((a, b) => a + b, 0) / areas.length)) + 'px';
        out.minBlock = Math.round(Math.min(...blocks.map((b) => Math.min(b.w, b.h)))) + 'px';
        // 爱心里面大约有几块（方块中心落在爱心里）
        const hx0 = heartRect.x - rect.x, hy0 = heartRect.y - rect.y;
        out.inHeart = blocks.filter((b) =>
          b.cx > hx0 && b.cx < hx0 + heartRect.w &&
          b.cy > hy0 && b.cy < hy0 + heartRect.h).length;

        // 1) 长方形既要有横的也要有竖的
        out.landscape = blocks.filter((b) => b.w > b.h * 1.08).length;
        out.portrait = blocks.filter((b) => b.h > b.w * 1.08).length;
        out.mixed = out.landscape > 0 && out.portrait > 0;

        // 2) 任何两个方块都不能重叠（含照片 vs 普通方块）
        const ov = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 &&
                             a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
        let overlap = 0;
        for (let i = 0; i < blocks.length; i++)
          for (let j = i + 1; j < blocks.length; j++) {
            if (ov(blocks[i], blocks[j])) overlap++;
          }
        out.noOverlap = overlap === 0;
        out.overlapPairs = overlap;
        if (overlap) {
          const kind = { pp: 0, pe: 0, ee: 0 };
          const samples = [];
          for (let i = 0; i < blocks.length; i++)
            for (let j = i + 1; j < blocks.length; j++) {
              const a = blocks[i], b = blocks[j];
              if (!ov(a, b)) continue;
              if (a.photoRef && b.photoRef) kind.pp++;
              else if (!a.photoRef && !b.photoRef) kind.ee++;
              else kind.pe++;
              if (samples.length < 3) samples.push([
                [Math.round(a.x), Math.round(a.y), Math.round(a.w), Math.round(a.h), !!a.photoRef],
                [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h), !!b.photoRef]]);
            }
          out.overlapKind = kind;
          out.overlapSamples = samples;
        }

        // 3) 铺满整个窗口（四个角 + 中心 + 边缘中点都能命中）
        const probes = [[1, 1], [view.w - 1, 1], [1, view.h - 1], [view.w - 1, view.h - 1],
                        [view.w / 2, view.h / 2], [view.w / 2, 1], [1, view.h / 2],
                        [view.w * 0.2, view.h * 0.75], [view.w * 0.8, view.h * 0.25]];
        // 方块之间有 9px 的缝，细于 13px 的条子会被丢掉（露出浅粉底，属于设计内的留白），
        // 所以 13 + 9 ≈ 22px 内都算“正常”，容差取 24px
        const nearBlock = (sx, sy, pad) => {
          const q = screenToPattern(sx, sy, cam);
          return blocks.some((b) =>
            q.x > b.x - pad && q.x < b.x + b.w + pad &&
            q.y > b.y - pad && q.y < b.y + b.h + pad);
        };
        const covered = (sx, sy) => !!blockAt(sx, sy) || nearBlock(sx, sy, 24);
        out.coversScreen = probes.every((p) => covered(p[0], p[1]));
        if (!out.coversScreen) {
          out.coverMiss = probes.filter((p) => !covered(p[0], p[1])).map((p) => {
            const q = screenToPattern(p[0], p[1], cam);
            let best = 1e9;
            for (const b of blocks) {
              const dx = Math.max(b.x - q.x, 0, q.x - (b.x + b.w));
              const dy = Math.max(b.y - q.y, 0, q.y - (b.y + b.h));
              best = Math.min(best, Math.hypot(dx, dy));
            }
            return '离最近方块 ' + Math.round(best) + 'px';
          });
        }
        out.photoTiles = blocks.filter((b) => b.photoRef).length;
        // 照片方块的高矮/面积谱（看“有没有做面积均衡”）
        const pt = blocks.filter((b) => b.photoRef);
        if (pt.length) {
          const hs = pt.map((b) => b.h).sort((a, b) => a - b);
          const ars = pt.map((b) => b.w * b.h).sort((a, b) => a - b);
          out.photoHeightRange = Math.round(hs[0]) + '~' + Math.round(hs[hs.length - 1]);
          const ss = pt.map((b) => Math.min(b.w, b.h)).sort((a, b) => a - b);
          out.photoShortSide = Math.round(ss[0]) + '~' + Math.round(ss[ss.length - 1]);
          out.photoLongSide = Math.round(pt.map((b) => Math.max(b.w, b.h)).sort((a, b) => a - b).pop());
          out.photoAreaRange = Math.round(ars[0]) + '~' + Math.round(ars[ars.length - 1]);
          out.photoAreaSpread = +(ars[ars.length - 1] / ars[0]).toFixed(1) + 'x';
          // 分散度：把爱心按半径分 4 圈，和“爱心自身在该圈的面积”比较，
          // 两者接近就说明照片是均匀散布在爱心里（而不是聚在中心或挤在边上）
          {
            const hx0 = cam.ax, hy0 = cam.ay;
            const DZ = DEFAULT_SETTINGS.zoom || 1.5;
            const hwP = heartRect.w / DZ, hhP = heartRect.h / DZ;
            const R = Math.min(hwP, hhP) / 2;
            const y0P = hy0 - hhP / 2;
            const t = heartHalfTable();
            const halfAt = (py) => {
              const ny = Math.max(0, Math.min(1, (py - y0P) / hhP));
              const i = Math.max(0, Math.min(t.length - 1, Math.floor(ny * t.length)));
              return t[i] * hwP;
            };
            const ringArea = [0, 0, 0, 0], ringPhoto = [0, 0, 0, 0];
            for (let i = 0; i < 90; i++) {
              for (let j = 0; j < 90; j++) {
                const px = hx0 - hwP / 2 + ((i + 0.5) / 90) * hwP;
                const py = y0P + ((j + 0.5) / 90) * hhP;
                if (Math.abs(px - hx0) > halfAt(py)) continue;
                const d = Math.hypot(px - hx0, py - hy0) / R;
                ringArea[Math.min(3, Math.floor(d * 4))]++;
              }
            }
            for (const b of pt) {
              const d = Math.hypot(b.cx - hx0, b.cy - hy0) / R;
              ringPhoto[Math.min(3, Math.floor(d * 4))]++;
            }
            const tot = ringArea.reduce((a, b) => a + b, 0) || 1;
            const ptot = pt.length || 1;
            out.photoRings = ringPhoto.map((c, i) =>
              (100 * c / ptot).toFixed(0) + '%/' + (100 * ringArea[i] / tot).toFixed(0) + '%').join('  ');
            // 每圈“照片占比 / 面积占比”，越接近 1 越均匀
            const dens = ringPhoto.map((c, i) => (c / ptot) / Math.max(1e-6, ringArea[i] / tot));
            out.photoSpread = +Math.max(...dens).toFixed(2) + 'x ~ ' + +Math.min(...dens).toFixed(2) + 'x';
          }
        }

        // 3b) 照片方块里到底有没有把照片画上去（直接读画布像素）
        {
          const cv = document.getElementById('mosaicSharp');
          const cctx = cv.getContext('2d');
          const dpr = cv.width / (view.w + 2 * M);
          let painted = 0, checked = 0, samples = [];
          for (const b of blocks.filter((x) => x.photoRef)) {
            const sx = (view.w / 2 + (b.cx - cam.ax) * cam.zoom + M) * dpr;
            const sy = (view.h / 2 + (b.cy - cam.ay) * cam.zoom + M) * dpr;
            if (sx < 3 || sy < 3 || sx >= cv.width - 3 || sy >= cv.height - 3) continue;
            checked++;
            const d = cctx.getImageData(Math.round(sx), Math.round(sy), 1, 1).data;
            const pinkish = (d[0] - d[1]) > 60;          // 粉色底/深粉方块都满足
            if (!pinkish) painted++;
            if (samples.length < 4) samples.push(d[0] + ',' + d[1] + ',' + d[2]);
          }
          out.photoChecked = checked;
          out.photoPainted = painted;
          out.photoSamples = samples.join(' | ');
        }

        // 3c) 长按拖动画面：长按后移动会平移镜头；短按移动不会；拖完那一下不触发点击
        {
          const c0 = { ax: cam.ax, ay: cam.ay };
          const pe = (type, x, y, id) => new PointerEvent(type, {
            clientX: x, clientY: y, button: 0, buttons: 1, pointerId: id || 1, bubbles: true
          });
          stageEl.dispatchEvent(pe('pointerdown', 500, 400));
          await new Promise((r) => setTimeout(r, 360));           // 等过长按判定
          for (let i = 1; i <= 6; i++) stageEl.dispatchEvent(pe('pointermove', 500 + i * 20, 400 + i * 10));
          stageEl.dispatchEvent(pe('pointerup', 620, 460));
          out.panMoved = Math.abs(cam.ax - c0.ax) > 20 && Math.abs(cam.ay - c0.ay) > 8;
          out.panSuppressedClick = suppressClick === true;         // 拖完不误触“打开方块”
          // 纯点击（按下就抬起、没移动）不能被当成拖动
          suppressClick = false;
          const c2 = { ax: cam.ax, ay: cam.ay };
          stageEl.dispatchEvent(pe('pointerdown', 600, 500, 3));
          stageEl.dispatchEvent(pe('pointerup', 600, 500, 3));
          out.clickNotSwallowed = suppressClick === false && cam.ax === c2.ax && cam.ay === c2.ay;

          // 不用等长按：按住直接移动也要能拖动画面
          const c1 = { ax: cam.ax, ay: cam.ay };
          stageEl.dispatchEvent(pe('pointerdown', 300, 300, 2));
          for (let i = 1; i <= 4; i++) stageEl.dispatchEvent(pe('pointermove', 300 + i * 15, 300, 2));
          stageEl.dispatchEvent(pe('pointerup', 360, 300, 2));
          out.pressDragPans = Math.abs(cam.ax - c1.ax) > 10;

          camTarget.ax = rect.x + rect.w / 2;                      // 镜头归位
          camTarget.ay = rect.y + rect.h / 2;
          clampCam(camTarget);
          cam.ax = camTarget.ax; cam.ay = camTarget.ay;
          draw();
        }

        // 3d) 暖心话：标题后面有、设置里也有，且两处是同一句
        {
          const n = document.getElementById('phraseNote').textContent.trim();
          const t = document.title;
          out.quoteInWindowTitle = t.indexOf('心动纪念册 · ') === 0 && t.length > 8;
          out.quoteInSettings = n.length > 0;
          out.quoteSame = t === '心动纪念册 · ' + n;      // 两处同一句
          out.quoteOnScreenTitle = document.querySelector('.topbar .title').textContent.trim();
          out.quoteSample = t;
          out.quoteCount = PHRASES.length;
        }

        // 3e) 背景音乐：引擎真的在跑（音频上下文 running + 已经排了音符）
        {
          await new Promise((r) => setTimeout(r, 1200));
          const st = window.MUSIC.stats();
          out.musicPlaying = window.MUSIC.isPlaying() === true;
          out.musicCtx = st.state;                       // running = 音频上下文真的开着
          out.musicScheduled = st.scheduled;             // 已经排了多少个音符
          out.musicHasNotes = st.scheduled > 4;
          out.musicMode = bgm.mode;                      // synth 或 files
          // 开关能关掉
          window.MUSIC.stop();
          out.musicStops = window.MUSIC.isPlaying() === false;
          window.MUSIC.start();
          out.musicRestarts = window.MUSIC.isPlaying() === true;
          out.musicVolumeWorks = (() => {
            window.MUSIC.setVolume(0.2);
            return window.MUSIC.stats().volume === 0.2;
          })();
          // 频谱：确认真的出声，而且音色落在弦乐那种中频（不是静音、不是噪声）
          bgm.play();                                        // 走正式接口，让 bgm 状态保持一致
          window.MUSIC.start();
          await new Promise((r) => setTimeout(r, 1200));
          // 连着采 10 次取中位数（单次会撞上旋律的气口，读数忽高忽低）
          const rmss = [], cents = [];
          for (let k = 0; k < 10; k++) {
            await new Promise((r) => setTimeout(r, 320));
            const s2 = window.MUSIC.spectrum();
            if (s2.rms > 0) rmss.push(s2.rms);
            if (s2.centroid > 0) cents.push(s2.centroid);
          }
          const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
          const rmsMed = med(rmss) || 0;
          out.musicRmsDb = rmsMed > 0 ? +(20 * Math.log10(rmsMed)).toFixed(1) : -Infinity;
          out.musicCentroid = Math.round(med(cents) || 0);
          out.musicAudible = rmsMed > 0.002;                 // -54dBFS 以上就算真的在响
          out.musicTimbreOk = out.musicCentroid > 150 && out.musicCentroid < 6000;
        }

        // 4) 爱心固定大小、居中
        const before = Object.assign({}, heartRect);
        out.heartCenteredX = Math.abs((heartRect.x + heartRect.w / 2) - view.w / 2) < 0.5;
        out.heartCenteredY = Math.abs((heartRect.y + heartRect.h / 2) - view.h / 2) < 0.5;
        out.heartSize = Math.round(heartRect.w) + 'x' + Math.round(heartRect.h);

        // 5) 滚轮：柔和缩放 + 只改长方形、不动爱心 + 聚焦鼠标位置
        state.settings.zoom = 1.5;                      // 从中间开始，保证有放大的空间
        cam.zoom = camTarget.zoom = 1.5;
        clampCam(camTarget);
        const zoom0 = state.settings.zoom;
        const mx = 320, my = 240;                       // 假装鼠标在这里
        const focusBefore = screenToPattern(mx, my, camTarget);
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: mx, clientY: my, cancelable: true }));
        out.wheelZooms = state.settings.zoom > zoom0;
        out.heartUnchangedByWheel = heartRect.w === before.w && heartRect.h === before.h &&
                                    heartRect.x === before.x && heartRect.y === before.y;
        const focusAfter = screenToPattern(mx, my, camTarget);
        out.focusOnCursor = Math.hypot(focusAfter.x - focusBefore.x, focusAfter.y - focusBefore.y) < 1.0;
        // 动画是逐帧缓动过去的
        out.zoomEased = cam.zoom !== camTarget.zoom || Math.abs(camTarget.zoom - state.settings.zoom) < 1e-9;
        // 记录动画期间的每帧间隔，确认是逐帧平滑而不是跳变
        const frames = [];
        await new Promise((res) => {
          let last = performance.now(), n = 0;
          const step = () => {
            const now = performance.now();
            frames.push(now - last); last = now;
            if (++n < 42) requestAnimationFrame(step); else res();
          };
          requestAnimationFrame(step);
        });
        const mid = frames.slice(1, 30);
        out.frameMsAvg = +(mid.reduce((a, b) => a + b, 0) / mid.length).toFixed(1);
        out.zoomEnds = cam.zoom.toFixed(4) + ' -> ' + camTarget.zoom.toFixed(4);
        out.frameMsMax = +Math.max(...mid).toFixed(1);
        out.zoomSettled = Math.abs(cam.zoom - camTarget.zoom) < 0.01;
        out.smoothFrames = out.frameMsAvg < 30 && out.frameMsMax < 140;  // 机器忙时偶尔会有单帧抖动，主要看平均
        // 还原
        state.settings.zoom = zoom0;
        camTarget.zoom = zoom0;
        rebuild();
        syncSettingsLabels();

        // 5b) 爱心底部是圆角，不是尖角（0.99 高度处还有明显宽度）
        const norm = heartGeom().norm;
        const halfWidthAt = (yy) => Math.max(...[-1].concat(
          norm.filter((p) => Math.abs(p[1] - yy) < 0.008).map((p) => Math.abs(p[0] - 0.5))), 0);
        out.tipProfile = [0.70, 0.80, 0.86, 0.90, 0.93, 0.95, 0.97, 0.99]
          .map((y) => y + ':' + halfWidthAt(y).toFixed(3)).join(' ');
        out.tipWidth95 = +halfWidthAt(0.95).toFixed(3);
        out.tipWidth99 = +halfWidthAt(0.99).toFixed(3);
        out.tipAngleDeg = +(2 * Math.atan((halfWidthAt(0.985) - halfWidthAt(0.995)) / 0.01) * 180 / Math.PI).toFixed(1);
        out.tipClosed = halfWidthAt(0.998) < 0.012;   // 底部收成一个点
        out.tipMonotonic = (() => {
          let prev = 9;
          for (let y = 0.60; y <= 0.999; y += 0.01) {
            const w = halfWidthAt(y);
            if (w > prev + 0.004) return false;        // 不能忽宽忽窄
            prev = w;
          }
          return true;
        })();

        // 6) 两个图层：外面模糊+半透明、里面裁剪
        const bl = document.getElementById('mosaicBlur');
        const sh = document.getElementById('mosaicSharp');
        out.blurApplied = /blur\\(/.test(bl.style.filter) && Number(bl.style.opacity) > 0 && Number(bl.style.opacity) < 1;
        out.sharpClipped = getComputedStyle(sh).clipPath.includes('url');
        out.clipPathSet = document.getElementById('heartClipPath').getAttribute('d').length > 100;
        out.outlineSet = document.getElementById('outlinePath').getAttribute('d').length > 100;
        out.canvasesPainted = bl.width > 0 && sh.width > 0;

        // 6b) 每帧重绘耗时（滚轮动画是逐帧重绘的，必须够快）
        const t0 = performance.now();
        for (let i = 0; i < 10; i++) draw();
        out.drawMsPerFrame = +((performance.now() - t0) / 10).toFixed(2);

        // 6c) 坐标换算必须和绘制完全一致（鼠标点哪儿就选中哪儿）
        const toScreen = (px, py) => [
          view.w / 2 + (px - cam.ax) * cam.zoom,
          view.h / 2 + (py - cam.ay) * cam.zoom
        ];
        let hitOk = 0, hitBad = 0;
        blocks.slice(0, 400).forEach((b) => {
          const tests = [
            [b.x + b.w / 2, b.y + b.h / 2],                 // 中心
            [b.x + b.w * 0.25, b.y + b.h * 0.25],           // 内部靠左上
            [b.x + b.w * 0.75, b.y + b.h * 0.75]            // 内部靠右下
          ];
          for (const [px, py] of tests) {
            const [sx, sy] = toScreen(px, py);
            const got = blockAt(sx, sy);
            if (got === b) hitOk++; else hitBad++;
          }
        });
        out.hitTests = hitOk + ' 对 / ' + hitBad + ' 错';
        out.hitMatchesDraw = hitBad === 0;
        // 7) 点击命中：爱心里外都能定位到某一块
        out.hitInside = covered(heartRect.x + heartRect.w / 2, heartRect.y + heartRect.h / 2);
        out.hitOutside = covered(4, 4);

        // 8) 照片 + 存档 + 设置
        const backup = await window.album.loadData();
        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const fileName = await window.album.savePhoto(png);
        out.photoRoundTrip = (await window.album.getPhoto(fileName) || '').startsWith('data:image/png');
        const keep = state.cells.slice();
        state.cells = [{ photo: fileName, desc: '测试', x: 0.5, y: 0.5 }];
        state.settings.blur = 11;
        await persist();
        const again = await window.album.loadData();
        out.dataRoundTrip = again.cells[0].desc === '测试' && again.settings.blur === 11;
        await window.album.deletePhoto(fileName);
        out.deleted = (await window.album.getPhoto(fileName)) === null;
        state.cells = keep;
        state.settings = Object.assign({}, DEFAULT_SETTINGS);
        cam.zoom = camTarget.zoom = DEFAULT_SETTINGS.zoom;
        rebuild(); syncSettingsLabels();
        await window.album.saveData(backup || { version: 6, cells: [] });
        return out;
      })()`);
      // ---- 图片库（pictures 文件夹）----
      const testName = 'zz_selftest_图片.png';
      const picDir = path.join(app.getPath('userData'), 'album-data', 'pictures');
      const png = await win.webContents.executeJavaScript(`(() => {
        const c = document.createElement('canvas');
        c.width = 300; c.height = 150;
        const g = c.getContext('2d');
        g.fillStyle = '#44cccc'; g.fillRect(0, 0, 300, 150);
        return c.toDataURL('image/png');
      })()`);
      fs.mkdirSync(picDir, { recursive: true });
      fs.writeFileSync(path.join(picDir, testName), Buffer.from(png.split(',')[1], 'base64'));

      const lib = await win.webContents.executeJavaScript(`(async () => {
        const out = {};
        const paths = await window.album.paths();
        out.picturesDir = paths.pictures;
        const list = await window.album.libraryList();
        out.inList = list.some((i) => i.name === '${testName}');
        const th = await window.album.libraryThumb('${testName}');
        out.thumbOk = !!(th && th.dataUrl && th.dataUrl.indexOf('data:image') === 0);
        out.thumbSize = th ? th.width + 'x' + th.height : null;
        const used = await window.album.libraryUse('${testName}');
        out.used = !!(used && used.fileName);
        out.usedAspect = used && used.width ? +(used.width / used.height).toFixed(2) : null;
        out.photoReadable = used ? !!(await window.album.getPhoto(used.fileName)) : false;
        if (used) await window.album.deletePhoto(used.fileName);
        return out;
      })()`);
      try { fs.unlinkSync(path.join(picDir, testName)); } catch (e) { /* ignore */ }
      Object.assign(res, lib);

      // 3f) 换成自己的音乐：往 music 文件夹放一个音频，播放器应该切过去并真的在播
      {
        const MUSIC_DIR = path.join(app.getPath('userData'), 'album-data', 'music');
        fs.mkdirSync(MUSIC_DIR, { recursive: true });
        const testFile = path.join(MUSIC_DIR, '_selftest_tone.wav');
        fs.writeFileSync(testFile, makeTestWav());

        await win.webContents.executeJavaScript('bgm.reload()');
        await new Promise((r) => setTimeout(r, 1800));
        const r2 = await win.webContents.executeJavaScript(`({
          mode: bgm.mode,
          files: bgm.files.length,
          name: bgm.files[bgm.idx] && bgm.files[bgm.idx].name,
          playing: bgm.audio ? (!bgm.audio.paused && bgm.audio.currentTime > 0) : false,
          t: bgm.audio ? +bgm.audio.currentTime.toFixed(2) : -1,
          synthStopped: window.MUSIC.isPlaying() === false
        })`);
        res.musicFileMode = r2.mode === 'files';
        res.musicFileFound = r2.files >= 1 && /_selftest_tone/.test(r2.name || '');
        res.musicFilePlaying = r2.playing === true;
        res.musicFileTime = r2.t;
        res.synthHandedOver = r2.synthStopped === true;

        fs.unlinkSync(testFile);                 // 清理：不留在她的 music 文件夹里
        await win.webContents.executeJavaScript('bgm.reload()');
        await new Promise((r) => setTimeout(r, 600));
        const r3 = await win.webContents.executeJavaScript('({ mode: bgm.mode, synth: window.MUSIC.isPlaying() })');
        res.musicBackToSynth = r3.mode === 'synth' && r3.synth === true;
      }

      const winTitle = win.getTitle();                      // 主进程侧：真正显示在标题栏上的字
      console.log('窗口标题: ' + winTitle);
      console.log('SELFTEST ' + JSON.stringify(res, null, 1));
      const terms = {
        mixed: res.mixed, noOverlap: res.noOverlap, coversScreen: res.coversScreen,
        heartCenteredX: res.heartCenteredX, heartCenteredY: res.heartCenteredY,
        wheelZooms: res.wheelZooms, heartUnchangedByWheel: res.heartUnchangedByWheel,
        focusOnCursor: res.focusOnCursor, zoomSettled: res.zoomSettled, smoothFrames: res.smoothFrames,
        tipClosed: res.tipClosed, tipMonotonic: res.tipMonotonic, hitMatchesDraw: res.hitMatchesDraw,
        blurApplied: res.blurApplied, sharpClipped: res.sharpClipped, clipPathSet: res.clipPathSet,
        outlineSet: res.outlineSet, canvasesPainted: res.canvasesPainted,
        hitInside: res.hitInside, hitOutside: res.hitOutside,
        musicPlaying: res.musicPlaying, musicHasNotes: res.musicHasNotes,
        musicAudible: res.musicAudible, musicTimbreOk: res.musicTimbreOk,
        musicFileMode: res.musicFileMode, musicFileFound: res.musicFileFound,
        musicFilePlaying: res.musicFilePlaying, synthHandedOver: res.synthHandedOver,
        musicBackToSynth: res.musicBackToSynth,
        musicStops: res.musicStops, musicRestarts: res.musicRestarts,
        musicVolumeWorks: res.musicVolumeWorks,
        quoteInWindowTitle: res.quoteInWindowTitle, quoteInSettings: res.quoteInSettings,
        quoteSame: res.quoteSame, onScreenTitleUnchanged: res.quoteOnScreenTitle === '心动纪念册',
        windowTitleHasQuote: winTitle.indexOf('心动纪念册 · ') === 0 && winTitle.length > 8,
        panMoved: res.panMoved, panSuppressedClick: res.panSuppressedClick,
        pressDragPans: res.pressDragPans, clickNotSwallowed: res.clickNotSwallowed,
        photoRoundTrip: res.photoRoundTrip, dataRoundTrip: res.dataRoundTrip, deleted: res.deleted,
        libraryList: res.inList, libraryThumb: res.thumbOk && res.thumbSize === '300x150',
        libraryUse: res.used && res.usedAspect === 2 && res.photoReadable
      };
      const bad = Object.keys(terms).filter((k) => !terms[k]);
      const ok = bad.length === 0;
      if (bad.length) console.log('SELFTEST 未通过项: ' + bad.join(', '));
      console.log(ok ? '== 全部通过 ==' : '== 有项目未通过 ==');
      app.exit(ok ? 0 : 1);
    } catch (e) {
      console.log('SELFTEST 失败：' + (e && e.message));
      app.exit(1);
    }
  }, 2600);
};
