// 截图脚本：
//   npm run shot            -> 主界面
//   npm run shot -- --editor -> 添加照片弹层
//   npm run shot -- --viewer -> 看照片 + 文字逐字跳出
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

module.exports = function shot() {
  const mode = process.argv.includes('--editor') ? 'editor'
    : process.argv.includes('--viewer') ? 'viewer'
    : process.argv.includes('--photos') ? 'photos'
    : process.argv.includes('--library') ? 'library'
    : process.argv.includes('--hover') ? 'hover'
    : process.argv.includes('--settings') ? 'settings' : 'main';

  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) { console.log('SHOT 失败：没有窗口'); return app.exit(1); }
    try {
      if (mode === 'settings') {
        await win.webContents.executeJavaScript(`document.getElementById('settingsBtn').click()`);
        await new Promise((r) => setTimeout(r, 500));
      }
      if (mode === 'editor') {
        await win.webContents.executeJavaScript(`openEditor(Math.floor(blocks.length / 2))`);
        await new Promise((r) => setTimeout(r, 400));
      }
      if (mode === 'viewer') {
        await win.webContents.executeJavaScript(`(async () => {
          // 造几张彩色测试图，走完整的保存->读取->显示流程
          const colors = [['#ffd166','#ef476f'], ['#06d6a0','#118ab2'], ['#ffadad','#ff6397'], ['#b5e48c','#2d6a4f']];
          const cells = [];
          for (let k = 0; k < colors.length; k++) {
            const c = document.createElement('canvas');
            c.width = 640; c.height = 460;
            const g = c.getContext('2d');
            const lg = g.createLinearGradient(0, 0, 640, 460);
            lg.addColorStop(0, colors[k][0]); lg.addColorStop(1, colors[k][1]);
            g.fillStyle = lg; g.fillRect(0, 0, 640, 460);
            g.fillStyle = '#fff'; g.font = 'bold 72px sans-serif';
            g.fillText('照片' + (k + 1), 200, 260);
            const fn = await window.album.savePhoto(c.toDataURL('image/png'));
            cells.push({ photo: fn, desc: '', x: 0.5, y: 0.45 });
          }
          cells[1].desc = '2024.5.20 第一次一起去看海，风很大，你笑得特别好看。';
          state.cells = cells;
          rebuild();
          // 把带文字的那一格放到爱心正中间再打开
          let best = 0, bd = 1e9;
          blocks.forEach((b, i) => {
            const d = Math.hypot(b.cx - view.w / 2, b.cy - view.h / 2);
            if (d < bd) { bd = d; best = i; }
          });
          blocks[best].cell = cells[1];
          draw();
          openViewer(best);
        })()`);
        await new Promise((r) => setTimeout(r, 1600));
      }
      if (mode === 'library') {
        // 往图片库塞几张不同长宽比的测试图，然后打开“添加照片 + 图片库”
        const fsx = require('fs');
        const px = require('path');
        const dir = px.join(require('electron').app.getPath('userData'), 'album-data', 'pictures');
        fsx.mkdirSync(dir, { recursive: true });
        const shapes = [[300, 200], [200, 300], [240, 240], [360, 180], [180, 320]];
        for (let i = 0; i < shapes.length; i++) {
          const [W, H] = shapes[i];
          const png = await win.webContents.executeJavaScript(`(() => {
            const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H};
            const g = c.getContext('2d');
            const lg = g.createLinearGradient(0,0,${W},${H});
            lg.addColorStop(0, 'hsl(${i * 62},80%,60%)'); lg.addColorStop(1, 'hsl(${i * 62 + 60},75%,45%)');
            g.fillStyle = lg; g.fillRect(0,0,${W},${H});
            g.fillStyle = '#fff'; g.font = 'bold 34px sans-serif'; g.fillText('${W}x${H}', 18, ${H} / 2);
            return c.toDataURL('image/png');
          })()`);
          fsx.writeFileSync(px.join(dir, 'preview_' + W + 'x' + H + '.png'),
            Buffer.from(png.split(',')[1], 'base64'));
        }
        await win.webContents.executeJavaScript(`(async () => {
          openEditor(Math.floor(blocks.length / 2));
          document.getElementById('libToggleBtn').click();
        })()`);
        await new Promise((r) => setTimeout(r, 1600));
        const outDir = dir;
        // 截图前把窗口提到前面，偶发的 UnknownVizError 重试几次
      win.show(); win.focus();
      await new Promise((r) => setTimeout(r, 500));
      let img = null;
      for (let attempt = 0; attempt < 4 && !img; attempt++) {
        try {
          img = await win.webContents.capturePage();
        } catch (e) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      if (!img) throw new Error('截图失败');
        fs.writeFileSync(path.join(__dirname, 'shot-library.png'), img.toPNG());
        console.log('SHOT saved: ' + path.join(__dirname, 'shot-library.png') + '  (图片库: ' + outDir + ')');
        return app.exit(0);
      }
      if (mode === 'hover') {
        // 放几张测试图，然后把鼠标“移”到其中一张上，看悬停预览
        await win.webContents.executeJavaScript(`(async () => {
          const shapes = [[600,400],[360,540],[440,440],[720,320],[320,520]];
          const cells = [];
          for (let k = 0; k < shapes.length; k++) {
            const [W,H] = shapes[k];
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            const g = c.getContext('2d');
            const lg = g.createLinearGradient(0,0,W,H);
            lg.addColorStop(0, 'hsl(' + k*64 + ',85%,62%)');
            lg.addColorStop(1, 'hsl(' + (k*64+70) + ',80%,45%)');
            g.fillStyle = lg; g.fillRect(0,0,W,H);
            g.fillStyle = '#fff'; g.font = 'bold ' + Math.round(W/9) + 'px sans-serif';
            g.fillText(W + 'x' + H, W*0.1, H*0.6);
            const fn = await window.album.savePhoto(c.toDataURL('image/png'));
            cells.push({ photo: fn, desc: '', x: 0.5, y: 0.5, aspect: W/H });
          }
          state.cells = cells;
          rebuild();
        })()`);
        await new Promise((r) => setTimeout(r, 2600));
        const info = await win.webContents.executeJavaScript(`(() => {
          const b = blocks.find((x) => x.photoRef && x.cell) || blocks.find((x) => x.photoRef);
          const sx = view.w / 2 + (b.cx - cam.ax) * cam.zoom;
          const sy = view.h / 2 + (b.cy - cam.ay) * cam.zoom;
          document.getElementById('stage').dispatchEvent(new MouseEvent('mousemove', { clientX: sx, clientY: sy, bubbles: true }));
          return { cx: Math.round(sx), cy: Math.round(sy),
                   w: Math.round(b.w), h: Math.round(b.h),
                   scale: +previewScale(b).toFixed(2) };
        })()`);
        await new Promise((r) => setTimeout(r, 900));
        console.log('HOVER ' + JSON.stringify(info));
      }
      if (mode === 'photos') {
        await win.webContents.executeJavaScript(`(async () => {
          // 四张不同长宽比的测试图：横的、竖的、方的
          const shapes = [[640,420],[360,540],[420,420],[720,320],[300,500],[500,300]];
          const cells = [];
          for (let k = 0; k < shapes.length; k++) {
            const [W,H] = shapes[k];
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            const g = c.getContext('2d');
            const lg = g.createLinearGradient(0,0,W,H);
            const hue = k * 60;
            lg.addColorStop(0, 'hsl(' + hue + ',85%,62%)');
            lg.addColorStop(1, 'hsl(' + ((hue+70)%360) + ',80%,45%)');
            g.fillStyle = lg; g.fillRect(0,0,W,H);
            g.fillStyle = '#fff'; g.font = 'bold ' + Math.round(W/8) + 'px sans-serif';
            g.fillText(W + 'x' + H, W*0.12, H*0.6);
            const fn = await window.album.savePhoto(c.toDataURL('image/png'));
            // 换成归一化坐标，摆在当前可见区域中心附近
            const ux = (cam.ax - rect.x) / rect.w, uy = (cam.ay - rect.y) / rect.h;
            const off = [[-0.03,-0.03],[0.03,-0.03],[-0.03,0.03],[0.03,0.03],[0,-0.06],[0,0.06]];
            cells.push({ photo: fn, desc: '第' + (k+1) + '张 ' + W + 'x' + H,
                         x: ux + off[k][0], y: uy + off[k][1], aspect: W / H });
          }
          state.cells = cells;
          rebuild();
          window.__report = blocks.filter((b) => b.cell && b.cell.photo).map((b) => ({
            file: b.cell.photo,
            photo: Math.round((b.cell.aspect || 1) * 100) / 100,
            block: Math.round((b.w / b.h) * 100) / 100,
            size: Math.round(b.w) + 'x' + Math.round(b.h),
            bx: b.x, by: b.y, bw: b.w, bh: b.h
          }));
        })()`);
        await new Promise((r) => setTimeout(r, 2600));   // 等缩略图加载
        const rep = await win.webContents.executeJavaScript(`window.__report.map((r) => {
          const t = thumbs.get(r.file);
          return Object.assign(r, {
            thumb: t === 'loading' ? 'loading' : (t && t.img ? 'ok' : 'none'),
            screen: [Math.round(view.w/2 + (r.bx - cam.ax) * cam.zoom),
                     Math.round(view.h/2 + (r.by - cam.ay) * cam.zoom),
                     Math.round(r.bw * cam.zoom), Math.round(r.bh * cam.zoom)]
          });
        })`);
        console.log('PHOTO-BLOCKS ' + JSON.stringify(rep));
      }
      // 截图前把窗口提到前面，偶发的 UnknownVizError 重试几次
      win.show(); win.focus();
      await new Promise((r) => setTimeout(r, 500));
      let img = null;
      for (let attempt = 0; attempt < 4 && !img; attempt++) {
        try {
          img = await win.webContents.capturePage();
        } catch (e) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      if (!img) throw new Error('截图失败');
      const out = path.join(__dirname, `shot-${mode}.png`);
      fs.writeFileSync(out, img.toPNG());
      console.log('SHOT saved: ' + out);
      app.exit(0);
    } catch (e) {
      console.log('SHOT 失败：' + (e && e.message));
      app.exit(1);
    }
  }, 2800);
};
