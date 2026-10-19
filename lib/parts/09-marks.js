    // ── 标注渲染 ────────────────────────────────────────────────────────
    /**
     * 把一组标注画到 2D 上下文里。
     * @param c - 目标上下文。
     * @param marks - 标注数组。
     * @param map - `{ toPx(nx, ny), wpx(f), hpx(f) }`:归一化坐标 → 目标像素,
     *   以及宽度(相对图片宽)与字号(相对图片高)的换算。
     */
    function renderMarks(c, marks, map) {
      // 提交用的图先描一层深色底,保证标注在任何底色(白墙/深色照片)上都醒目
      if (map && map.halo) renderMarksPass(c, marks, map, true);
      renderMarksPass(c, marks, map, false);
    }

    /**
     * 画一遍标注。
     * @param c - 2D 上下文。
     * @param marks - 标注数组。
     * @param map - 坐标/尺寸换算(见 {@link screenMarkMap} 与 {@link naturalMarkMap})。
     * @param halo - true 时只画"深色加粗底衬",用于提交给模型的图。
     */
    function renderMarksPass(c, marks, map, halo) {
      for (const mark of marks) {
        c.save();
        c.lineCap = 'round';
        c.lineJoin = 'round';
        const stroke = halo ? 'rgba(0,0,0,0.55)' : mark.color;
        const widthScale = halo ? 2.4 : 1;
        if (mark.kind === 'brush') {
          c.strokeStyle = stroke;
          c.lineWidth = Math.max(1, map.wpx(mark.width) * widthScale);
          c.globalAlpha = halo ? 1 : map.halo ? 0.95 : 0.9;
          c.beginPath();
          for (let i = 0; i < mark.points.length; i += 1) {
            const q = map.toPx(mark.points[i][0], mark.points[i][1]);
            if (i === 0) c.moveTo(q[0], q[1]);
            else c.lineTo(q[0], q[1]);
          }
          if (mark.points.length === 1) {
            const q = map.toPx(mark.points[0][0], mark.points[0][1]);
            c.lineTo(q[0] + 0.01, q[1]);
          }
          c.stroke();
        } else if (mark.kind === 'mask') {
          // 蒙版:屏幕上只给一层"涂到哪"的半透明蓝示意。
          // 提交图里**不画**这一笔 —— 那时它才变成本体:未涂区域压暗、涂过的地方抠回原亮度
          // (做法见 41-generate.js 的 buildSubmission,那里用 destination-out 抠)。
          if (!map.halo) {
            c.strokeStyle = 'rgba(10,132,255,0.30)';
            c.lineWidth = Math.max(1, map.wpx(mark.width));
            c.globalAlpha = 1;
            c.beginPath();
            for (let i = 0; i < mark.points.length; i += 1) {
              const q = map.toPx(mark.points[i][0], mark.points[i][1]);
              if (i === 0) c.moveTo(q[0], q[1]);
              else c.lineTo(q[0], q[1]);
            }
            if (mark.points.length === 1) {
              const q = map.toPx(mark.points[0][0], mark.points[0][1]);
              c.lineTo(q[0] + 0.01, q[1]);
            }
            c.stroke();
          }
        } else if (mark.kind === 'pen') { // legacy:钢笔工具早已从 TOOLS 移除,此分支仅兼容旧存档
          // 钢笔:把点连成平滑曲线(二次贝塞尔走中点),比画笔更顺
          c.strokeStyle = stroke;
          c.lineWidth = Math.max(1, map.wpx(mark.width) * widthScale);
          c.globalAlpha = halo ? 1 : 0.9;
          const pts = mark.points.map((p) => map.toPx(p[0], p[1]));
          c.beginPath();
          if (pts.length === 1) {
            c.moveTo(pts[0][0], pts[0][1]);
            c.lineTo(pts[0][0] + 0.01, pts[0][1]);
          } else if (pts.length === 2) {
            c.moveTo(pts[0][0], pts[0][1]);
            c.lineTo(pts[1][0], pts[1][1]);
          } else {
            c.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length - 1; i += 1) {
              const mx = (pts[i][0] + pts[i + 1][0]) / 2;
              const my = (pts[i][1] + pts[i + 1][1]) / 2;
              c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
            }
            c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
          }
          c.stroke();
        } else if (mark.kind === 'rect' || mark.kind === 'ellipse') {
          const box = normalizeRect(mark.rect);
          const a = map.toPx(box.x0, box.y0);
          const b = map.toPx(box.x1, box.y1);
          const x = Math.min(a[0], b[0]);
          const y = Math.min(a[1], b[1]);
          const w = Math.abs(b[0] - a[0]);
          const hh = Math.abs(b[1] - a[1]);
          const path = () => {
            c.beginPath();
            if (mark.kind === 'rect') c.rect(x, y, w, hh);
            else c.ellipse(x + w / 2, y + hh / 2, Math.max(0.5, w / 2), Math.max(0.5, hh / 2), 0, 0, Math.PI * 2);
          };
          c.strokeStyle = stroke;
          c.fillStyle = stroke;
          c.lineWidth = Math.max(1, map.wpx(mark.width) * widthScale);
          if (!halo) {
            c.globalAlpha = 0.3;
            path();
            c.fill();
            c.globalAlpha = 1;
          }
          path();
          c.stroke();
        } else if (mark.kind === 'arrow') {
          const a = map.toPx(mark.from[0], mark.from[1]);
          const b = map.toPx(mark.to[0], mark.to[1]);
          c.strokeStyle = stroke;
          c.fillStyle = stroke;
          c.lineWidth = Math.max(1, map.wpx(mark.width) * widthScale);
          c.beginPath();
          c.moveTo(a[0], a[1]);
          c.lineTo(b[0], b[1]);
          c.stroke();
          const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
          const head = Math.max(7, map.wpx(mark.width) * (halo ? 3.9 : 3.4));
          c.beginPath();
          c.moveTo(b[0], b[1]);
          c.lineTo(b[0] - head * Math.cos(angle - 0.42), b[1] - head * Math.sin(angle - 0.42));
          c.lineTo(b[0] - head * Math.cos(angle + 0.42), b[1] - head * Math.sin(angle + 0.42));
          c.closePath();
          c.fill();
        } else if (mark.kind === 'text') { // legacy:旧式文字标注,已被文字图层(text layer)取代,仅兼容旧存档
          const size = Math.max(5, map.hpx(mark.size));
          c.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
          c.textBaseline = 'top';
          const at = map.toPx(mark.at[0], mark.at[1]);
          const lines = String(mark.text).split('\n');
          c.lineJoin = 'round';
          for (let i = 0; i < lines.length; i += 1) {
            const ty = at[1] + i * size * 1.3;
            c.lineWidth = Math.max(2, size * (halo ? 0.3 : 0.16));
            c.strokeStyle = halo ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.6)';
            c.strokeText(lines[i], at[0], ty);
            if (!halo) {
              c.fillStyle = mark.color;
              c.fillText(lines[i], at[0], ty);
            }
          }
        }
        c.restore();
      }
    }

    /** 屏幕坐标下的标注映射(给画布用)。 */
    function screenMarkMap(cam, image) {
      return {
        toPx: (nx, ny) => worldToScreen(cam, image.x + nx * image.w, image.y + ny * image.h),
        wpx: (f) => f * image.w * cam.zoom,
        hpx: (f) => f * image.h * cam.zoom,
      };
    }
    /** 图片自然像素下的标注映射(给提交合成用)。带 `halo`,提交的图上线要更醒目。 */
    function naturalMarkMap(width, height) {
      return {
        toPx: (nx, ny) => [nx * width, ny * height],
        wpx: (f) => f * width,
        hpx: (f) => f * height,
        halo: true,
      };
    }
    /**
     * 把画在图上的一堆标注翻译成"给模型看的文字说明"。
     *
     * 这一步是这个插件能不能"被听懂"的关键:图像模型不是读图 agent,只给它一根红箭头,
     * 它多半不知道你想把箭头指的地方改成什么。所以把「箭头从哪指到哪、框住哪块、
     * 上面写了什么字」都写成句子,并把文字标注原样抬进提示词当指令用。
     *
     * @param marks - 同一张图上的标注。
     * @returns {string} 多行说明;没有标注时返回空串。
     */
    function describeMarks(marks) {
      if (!marks || !marks.length) return '';
      const pct = (v) => `${Math.round(clamp(v, 0, 1) * 100)}%`;
      const where = (nx, ny) => {
        const h = nx < 0.34 ? '左' : nx > 0.66 ? '右' : '中';
        const v = ny < 0.34 ? '上' : ny > 0.66 ? '下' : '中';
        if (h === '中' && v === '中') return '画面中央';
        if (h === '中') return `${v}方`;
        if (v === '中') return `${h}方`;
        return `${h}${v}方`;
      };
      const lines = [];
      const labels = [];
      for (const mark of marks) {
        if (mark.kind === 'arrow') {
          lines.push(
            `- 红色箭头:从 (${pct(mark.from[0])}, ${pct(mark.from[1])}) 指向 (${pct(mark.to[0])}, ${pct(mark.to[1])}) 的${where(mark.to[0], mark.to[1])} —— 箭头所指的位置就是这次要改的目标,箭头起点是参照物。`,
          );
        } else if (mark.kind === 'rect') {
          const b = normalizeRect(mark.rect);
          lines.push(`- 红色矩形框:框住 (${pct(b.x0)}, ${pct(b.y0)}) 到 (${pct(b.x1)}, ${pct(b.y1)}) 的${where((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)},框内是要改的地方。`);
        } else if (mark.kind === 'ellipse') {
          const b = normalizeRect(mark.rect);
          lines.push(`- 红色椭圆圈:圈住 (${pct(b.x0)}, ${pct(b.y0)}) 到 (${pct(b.x1)}, ${pct(b.y1)}) 的${where((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)},圈内是要改的地方。`);
        } else if (mark.kind === 'brush') {
          const b = marksBounds([mark]);
          if (b) lines.push(`- 红色涂抹:盖住 (${pct(b.x0)}, ${pct(b.y0)}) 到 (${pct(b.x1)}, ${pct(b.y1)}) 的${where((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)}一片,这一片是要改的地方。`);
        } else if (mark.kind === 'mask') {
          const b = marksBounds([mark]);
          if (b) lines.push(`- 蓝色蒙版:整张图只有 (${pct(b.x0)}, ${pct(b.y0)}) 到 (${pct(b.x1)}, ${pct(b.y1)}) 的${where((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)}这一片标了蒙版,它就是这次**唯一**要改的地方,其余部分我已经压暗,请原样保留、不要改动。`);
        } else if (mark.kind === 'pen') {
          const b = marksBounds([mark]);
          if (b) lines.push(`- 红色钢笔曲线:从 (${pct(b.x0)}, ${pct(b.y0)}) 到 (${pct(b.x1)}, ${pct(b.y1)}) 划了一条平滑曲线,曲线经过的地方是要改/勾勒的地方。`);
        } else if (mark.kind === 'text') {
          const text = String(mark.text || '').trim();
          if (!text) continue;
          labels.push(text);
          lines.push(`- 画面里的手写标注文字「${text}」写在 (${pct(mark.at[0])}, ${pct(mark.at[1])}) 的${where(mark.at[0], mark.at[1])},它写的就是修改要求本身。`);
        }
      }
      if (!lines.length) return '';
      const head = labels.length
        ? `图上有我画的标注。它们的文字内容就是修改要求,请照做:${labels.map((t) => `「${t}」`).join('')}。标注位置如下:`
        : '图上有我画的标注,请按它们的指示修改:';
      return `${head}\n${lines.map((line, i) => line.replace(/^- /, `${i + 1}. `)).join('\n')}`;
    }
    /** 一组标注的包围盒(归一化)。 */
    function marksBounds(marks) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      const add = (nx, ny) => {
        x0 = Math.min(x0, nx);
        y0 = Math.min(y0, ny);
        x1 = Math.max(x1, nx);
        y1 = Math.max(y1, ny);
      };
      for (const mark of marks) {
        if (mark.kind === 'brush' || mark.kind === 'pen' || mark.kind === 'mask') for (const p of mark.points) add(p[0], p[1]);
        else if (mark.kind === 'rect' || mark.kind === 'ellipse') {
          const box = normalizeRect(mark.rect);
          add(box.x0, box.y0);
          add(box.x1, box.y1);
        } else if (mark.kind === 'arrow') {
          add(mark.from[0], mark.from[1]);
          add(mark.to[0], mark.to[1]);
        } else if (mark.kind === 'text') add(mark.at[0], mark.at[1]);
      }
      if (!Number.isFinite(x0)) return null;
      return { x0, y0, x1, y1 };
    }
    function markDistanceToPoint(mark, image, wx, wy) {
      const toWorld = (nx, ny) => [image.x + nx * image.w, image.y + ny * image.h];
      const points = [];
      if (mark.kind === 'brush' || mark.kind === 'pen' || mark.kind === 'mask') for (const p of mark.points) points.push(toWorld(p[0], p[1]));
      else if (mark.kind === 'rect' || mark.kind === 'ellipse') {
        const b = normalizeRect(mark.rect);
        points.push(toWorld(b.x0, b.y0), toWorld(b.x1, b.y1));
      } else if (mark.kind === 'arrow') {
        points.push(toWorld(mark.from[0], mark.from[1]), toWorld(mark.to[0], mark.to[1]));
      } else if (mark.kind === 'text') points.push(toWorld(mark.at[0], mark.at[1]));
      let best = Infinity;
      for (const p of points) best = Math.min(best, Math.hypot(p[0] - wx, p[1] - wy));
      return best;
    }
    /** 随提交附带的要求说明。 */
    function markHint(submission) {
      if (submission.cropped) {
        return '这张图是从原图里裁下来的待修改区域,请只重绘这张图本身,保持它原有的风格与比例。';
      }
      return (
        '修改要求:\n' +
        '1. 只按上面的标注位置和内容修改;画面其余部分(主体、构图、风格、比例、光线)保持原样,不要重绘整张图。\n' +
        '2. 输出必须是清理干净的成品图:不要保留任何标注痕迹(红色箭头、线框、涂抹、手写标注文字),也不要有任何多余的标记。'
      );
    }
    /**
     * 提交用的合成尺寸:长边不超过 SUBMIT_MAX_SIDE,其余等比;本来就够小就原样。
     * @param naturalW - 原图宽。
     * @param naturalH - 原图高。
     * @returns {{ width: number, height: number, scale: number }} 目标尺寸与缩放比。
     */
    function submissionSize(naturalW, naturalH) {
      const scale = Math.min(1, SUBMIT_MAX_SIDE / Math.max(naturalW || 1, naturalH || 1));
      return {
        width: Math.max(1, Math.round((naturalW || 1) * scale)),
        height: Math.max(1, Math.round((naturalH || 1) * scale)),
        scale,
      };
    }

    /** 提交图与 UI 预览共用的裁剪范围,蒙版始终提交整图。 */
    function submissionRegion(naturalW, naturalH, marks, cropToMark) {
      const full = submissionSize(naturalW, naturalH);
      const list = marks || [];
      let sx = 0;
      let sy = 0;
      let width = full.width;
      let height = full.height;
      let cropped = false;
      if (cropToMark && list.length && !list.some((mark) => mark.kind === 'mask')) {
        const bounds = marksBounds(list);
        if (bounds) {
          const x0 = clamp(bounds.x0 - 0.02, 0, 1);
          const y0 = clamp(bounds.y0 - 0.02, 0, 1);
          const x1 = clamp(bounds.x1 + 0.02, 0, 1);
          const y1 = clamp(bounds.y1 + 0.02, 0, 1);
          sx = Math.min(full.width - 1, Math.round(x0 * full.width));
          sy = Math.min(full.height - 1, Math.round(y0 * full.height));
          width = Math.min(full.width - sx, Math.max(16, Math.round((x1 - x0) * full.width)));
          height = Math.min(full.height - sy, Math.max(16, Math.round((y1 - y0) * full.height)));
          cropped = true;
        }
      }
      return { width, height, sx, sy, fullWidth: full.width, fullHeight: full.height, scale: full.scale, cropped };
    }
