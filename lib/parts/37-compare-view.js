/* 对比视图(第一期 B):两张图并排或滑杆叠加比较,独立覆盖层,关闭后画布分毫不改。
 *
 * 职责边界:
 * - 本零件不持有 state / ref / effect(CanvasTab 的 hook 链会被污染),渲染是纯函数,
 *   绘制是独立函数 drawCompareCanvas,由调用处的 effect 驱动;
 * - 不做拉伸对齐、不宣称配准:两图各按原始宽高比用同一倍率显示,尺寸不同时
 *   明确提示「不是像素级配准」;
 * - 100% = 1 图像像素对 1 物理像素(zoom 取 1/dpr,Retina 屏上不虚标);
 * - 滑杆是 DOM 控件,事件不会穿透到画布;关闭时监听器由调用处清理。
 */
    definePart('compare-view', () => {
      /** 棋盘格背景:透明 PNG 常用的底纹,比较时能看出图有没有透明区。 */
      function drawChecker(ctx, w, h) {
        const size = 12;
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#d4d4d4';
        for (let y = 0; y < h; y += size) {
          for (let x = ((y / size) % 2) * size; x < w; x += size * 2) {
            ctx.fillRect(x, y, size, size);
          }
        }
      }

      /** 以 (cx,cy) 为中心按 zoom 画一张图(自然尺寸 × zoom,不拉伸)。 */
      function drawCentered(ctx, img, cx, cy, zoom) {
        if (!img) return;
        const dw = img.naturalWidth * zoom;
        const dh = img.naturalHeight * zoom;
        ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
      }

      /**
       * 并排模式:左右各占一半。两图用同一 zoom(图像像素→CSS 像素倍率)与平移,
       * 即「同步缩放/平移」;「适应」倍率由调用处按两图都能完整看见来计算。
       */
      function drawSide(ctx, img, x0, halfW, h, cx, cy, zoom) {
        if (!img || !img.naturalWidth) return;
        drawCentered(ctx, img, x0 + halfW / 2 + cx, cy, zoom);
      }

      /**
       * 把两张解码图画到 canvas 上。
       * @param {HTMLCanvasElement} canvas - 画布元素(尺寸随容器)。
       * @param {object} opts - {imgA,imgB,mode:'side'|'slider',swap,slider(0..1),zoom,panX,panY,dpr}
       */
      function drawCompareCanvas(canvas, opts) {
        const { imgA, imgB, mode, swap, slider, zoom, panX, panY, dpr } = opts;
        const w = canvas.clientWidth || 0;
        const hgt = canvas.clientHeight || 0;
        if (!w || !hgt) return;
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(hgt * dpr));
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawChecker(ctx, w, hgt);
        const left = swap ? imgB : imgA;
        const right = swap ? imgA : imgB;
        const cy = hgt / 2 + panY;
        if (mode === 'side') {
          const half = w / 2;
          drawSide(ctx, left, 0, half, hgt, panX, cy, zoom);
          drawSide(ctx, right, half, half, hgt, panX, cy, zoom);
          ctx.strokeStyle = 'rgba(127,127,127,0.6)';
          ctx.beginPath();
          ctx.moveTo(half, 0);
          ctx.lineTo(half, hgt);
          ctx.stroke();
        } else {
          // 滑杆叠加:两图按同一倍率、中心对齐叠放(尺寸不同时不拉伸、不配准,UI 有提示)
          const cx = w / 2 + panX;
          drawCentered(ctx, left, cx, cy, zoom);
          const clipW = Math.max(0, Math.min(w, w * slider));
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, clipW, hgt);
          ctx.clip();
          drawCentered(ctx, right, cx, cy, zoom);
          ctx.restore();
          // 分割线 + 手柄
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(clipW, 0);
          ctx.lineTo(clipW, hgt);
          ctx.stroke();
          ctx.fillStyle = '#3b82f6';
          ctx.beginPath();
          ctx.arc(clipW, hgt / 2, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('↔', clipW, hgt / 2);
          ctx.lineWidth = 1;
        }
      }

      /**
       * @param {object} p - 依赖包(state 与 handler 全部由调用处注入)。
       * @returns {any} 覆盖层(虚拟 DOM)。
       */
      function renderCompareView(p) {
        const {
          S,
          closeCompare,
          compareA,
          compareB,
          compareCanvasRef,
          compareMode,
          comparePointerDown,
          comparePointerMove,
          comparePointerUp,
          compareSlider,
          compareSwap,
          compareWheel,
          compareZoom,
          exportCompareResult,
          fitCompare,
          setCompareMode,
          setCompareSlider,
          setCompareSwap,
          zoom100Compare,
        } = p;
        if (!compareA || !compareB) return null;
        const sizeA = `${compareA.naturalW || '?'}×${compareA.naturalH || '?'}`;
        const sizeB = `${compareB.naturalW || '?'}×${compareB.naturalH || '?'}`;
        const different = sizeA !== sizeB;
        const leftName = compareSwap ? compareB.name : compareA.name;
        const rightName = compareSwap ? compareA.name : compareB.name;
        const modeBtn = (value, label) => h('button', {
          style: Object.assign({}, S.tiny, compareMode === value ? S.btnOn : null),
          onClick: () => setCompareMode(value),
        }, label);
        return h('div', {
          style: {
            position: 'absolute', inset: 0, zIndex: 9,
            background: 'rgba(15,15,18,0.72)', backdropFilter: 'blur(2px)',
            display: 'flex', flexDirection: 'column',
          },
          onWheel: compareWheel,
        },
          // ── 顶栏 ──
          h('div', { style: { display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', padding: '6px 8px' } },
            h('span', { style: { color: '#fff', fontSize: 12, fontWeight: 600 } }, '对比视图'),
            h('span', { style: { color: 'rgba(255,255,255,0.75)', fontSize: 11 } }, `${leftName} ${sizeA} ⇄ ${rightName} ${sizeB}`),
            h('span', { style: S.grow }),
            h('button', { style: S.tiny, title: '交换左右(A/B 角色对调,不改画布)', onClick: () => setCompareSwap(!compareSwap) }, '⇄ 交换'),
            modeBtn('side', '并排'),
            modeBtn('slider', '滑杆叠加'),
            h('button', { style: S.tiny, title: '两图同步缩放到都能看见', onClick: fitCompare }, '适应'),
            h('button', { style: S.tiny, title: '100% = 1 图像像素对 1 物理像素(已按屏幕 DPR 折算)', onClick: zoom100Compare }, '100%'),
            h('button', { style: S.tiny, title: '下载当前的结果图(对比不改图,导出的就是结果原图)', onClick: exportCompareResult }, '导出结果图'),
            h('button', { style: S.tiny, title: '关闭对比(Esc)。画布不会有任何改动', onClick: closeCompare }, '✕ 关闭'),
          ),
          // ── 提示条 ──
          different && h('div', { style: { padding: '0 8px 4px', color: '#fbbf24', fontSize: 11 } },
            `两图尺寸不同(${sizeA} vs ${sizeB}):按原始宽高比同倍率显示、中心/半区对齐 —— 这是像素对比,不是配准对齐`),
          // ── 画布区 ──
          h('div', { style: { flex: 1, minHeight: 0, margin: '0 8px', position: 'relative' } },
            h('canvas', {
              ref: compareCanvasRef,
              style: { position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' },
              onPointerDown: comparePointerDown,
              onPointerMove: comparePointerMove,
              onPointerUp: comparePointerUp,
              onPointerCancel: comparePointerUp,
            }),
            compareMode === 'slider' && h('div', { style: { position: 'absolute', left: 8, right: 8, bottom: 10, display: 'flex', gap: 8, alignItems: 'center', pointerEvents: 'auto' } },
              h('span', { style: { color: '#fff', fontSize: 11, flex: '0 0 auto' } }, `◂ ${leftName}`),
              h('input', {
                id: 'grsai-compare-slider',
                type: 'range', min: 0, max: 1000, value: Math.round(compareSlider * 1000),
                onChange: (e) => setCompareSlider(Number(e.target.value) / 1000),
                style: { flex: 1, accentColor: '#3b82f6' },
                title: '拖动分割线:左边显示一张、右边显示另一张(滑杆事件不会穿透到画布)',
              }),
              h('span', { style: { color: '#fff', fontSize: 11, flex: '0 0 auto' } }, `${rightName} ▸`),
            ),
          ),
          // ── 底部说明 ──
          h('div', { style: { padding: '4px 8px 6px', color: 'rgba(255,255,255,0.6)', fontSize: 11 } },
            `滚轮缩放 · 拖拽平移${compareMode === 'slider' ? ' · 滑杆比对' : ''} · Esc 关闭(画布与原图都不会被改动)${compareZoom ? ` · 当前 ${(compareZoom * 100).toFixed(0)}%` : ''}`),
        );
      }

      return { renderCompareView, drawCompareCanvas };
    });
