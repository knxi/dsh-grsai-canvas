    // ── 相机与世界坐标 ──────────────────────────────────────────────────
    // 世界单位 = 图片在 100% 缩放下的像素。screen = (world - cam.xy) * cam.zoom

    function worldToScreen(cam, wx, wy) {
      return [(wx - cam.x) * cam.zoom, (wy - cam.y) * cam.zoom];
    }
    function screenToWorld(cam, sx, sy) {
      return [sx / cam.zoom + cam.x, sy / cam.zoom + cam.y];
    }
    function imageBounds(images) {
      if (!images.length) return null;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const im of images) {
        x0 = Math.min(x0, im.x);
        y0 = Math.min(y0, im.y);
        x1 = Math.max(x1, im.x + im.w);
        y1 = Math.max(y1, im.y + im.h);
      }
      return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
    }
    /** 让所有图片落在视口里。 */
    function fitCamera(images, size) {
      const box = imageBounds(images);
      if (!box || box.w <= 0 || box.h <= 0) return { x: 0, y: 0, zoom: 1 };
      const zoom = clamp(Math.min((size.w * 0.92) / box.w, (size.h * 0.92) / box.h), MIN_ZOOM, MAX_ZOOM);
      const cx = (box.x0 + box.x1) / 2;
      const cy = (box.y0 + box.y1) / 2;
      return { x: cx - size.w / (2 * zoom), y: cy - size.h / (2 * zoom), zoom };
    }
    /** 某个世界矩形是否完整落在视口里。 */
    function rectVisible(cam, size, x, y, w, hh) {
      const a = worldToScreen(cam, x, y);
      const b = worldToScreen(cam, x + w, y + hh);
      return a[0] >= 0 && a[1] >= 0 && b[0] <= size.w && b[1] <= size.h;
    }
    /**
     * 从 (x, y) 起往下找一个**不与这些矩形重叠**的位置,返回校正后的 y。
     *
     * 用途:并发生成时几张图几乎同时落图,若都按"原图右边、同一行"摆就会叠在一起 ——
     * 落图前用它把后面的那张顺到下面去。传入的矩形可以是图片,也可以是**生成中的占位框**
     * (所以排队时就先把位置错开,出图后才不会跳)。
     * @param {Array<{x: number, y: number, w: number, h: number, hidden?: boolean}>} rects - 已有的矩形。
     * @param {number} x - 候选位置左上角 x。
     * @param {number} y - 候选位置左上角 y。
     * @param {number} w - 宽。
     * @param {number} hh - 高。
     * @returns {number} 不重叠的 y(实在找不到就返回下移 200 次后的值)。
     */
    function freeSpotY(rects, x, y, w, hh) {
      const list = (rects || []).filter((im) => im && !im.hidden && im.w > 0 && im.h > 0);
      let top = Number(y) || 0;
      for (let guard = 0; guard < 200; guard += 1) {
        let hit = null;
        for (const im of list) {
          const overlap = x < im.x + im.w && x + w > im.x && top < im.y + im.h && top + hh > im.y;
          if (!overlap) continue;
          if (!hit || im.y + im.h > hit.y + hit.h) hit = im;
        }
        if (!hit) break;
        top = hit.y + hit.h + GAP;
      }
      return top;
    }
