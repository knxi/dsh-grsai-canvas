    // ── 文字图层(本机字体,本地绘制)────────────────────────────────────
    //
    // 为什么要有它:图像模型"画字"是画像素 —— 出图分辨率就那么大,字必然是糊的,
    // 还经常把笔画写错。所以正确做法是让模型只出**干净底图**(Skills 里有「留白配图」模板),
    // 文字用**本机已安装的字体**在本地矢量绘制,导出时按原图分辨率烧进去 —— 边缘是清晰的。

    /** 新加一条文字时的默认样式(字号是"占图高的比例",所以缩放/导出都等比)。 */
    const TEXT_DEFAULTS = {
      font: '微软雅黑',
      size: 0.08,
      color: '#ffffff',
      weight: 700,
      align: 'center',
      shadow: true,
      lineHeight: 1.25,
    };

    /** 常见中文字体候选(能不能用现场检测;也可以用「导入字体文件」加载任意字体)。 */
    const FONT_CANDIDATES = [
      '微软雅黑',
      'Microsoft YaHei',
      '思源黑体',
      'Noto Sans SC',
      '黑体',
      'SimHei',
      '宋体',
      'SimSun',
      '楷体',
      'KaiTi',
      '仿宋',
      'FangSong',
      '等线',
      'DengXian',
      '苹方',
      'PingFang SC',
      'HarmonyOS Sans SC',
      '阿里巴巴普惠体',
      'Alibaba PuHuiTi',
      '站酷高端黑',
      '霞鹜文楷',
      'LXGW WenKai',
      '思源宋体',
      'Noto Serif SC',
      'JetBrains Mono',
      'Consolas',
      'Arial',
    ];

    /** 一段文字按换行拆行。 */
    function textLines(value) {
      return String(value == null ? '' : value).split('\n');
    }

    /**
     * 估一行字有多宽(不依赖 measureText,便于离线测试与命中判断)。
     * 中日韩字符按 1 个字宽算,其余(字母/数字/空格)按 0.55 字宽算。
     */
    function estimateTextWidth(line, sizePx) {
      let units = 0;
      for (const ch of String(line || '')) units += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.55;
      return units * sizePx;
    }

    /**
     * 某个字体在这台机器上能不能用。
     * 办法:同一段字用"基准字体"和"基准字体 + 候选"各量一次宽度,不一样就说明候选真的生效了。
     * @param {string} name - 字体名。
     * @returns {boolean} 可用给 true。
     */
    function isFontAvailable(name) {
      const key = String(name || '').trim();
      if (!key) return false;
      try {
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx || typeof ctx.measureText !== 'function') return false;
        const probe = '汉字WMwmwiii888';
        return ['monospace', 'serif', 'sans-serif'].some((fallback) => {
          ctx.font = `72px ${fallback}`;
          const base = ctx.measureText(probe).width;
          ctx.font = `72px "${key}", ${fallback}`;
          const test = ctx.measureText(probe).width;
          return Number.isFinite(base) && Number.isFinite(test) && Math.abs(base - test) > 0.5;
        });
      } catch (e) {
        return false;
      }
    }

    /** 列出这台机器上真的有的候选字体(检测失败的返回空数组,由界面兜底成手填)。 */
    function availableFonts() {
      return FONT_CANDIDATES.filter((font) => isFontAvailable(font));
    }

    /**
     * 把一组文字图层画到 2D 上下文上 —— **按目标分辨率**算字号与坐标。
     *
     * 屏幕预览、原图导出的都走这一个函数:导出时传原图自然尺寸,字就是按原分辨率矢量绘制的,
     * 不管图片多大都是清晰的。调用方负责把上下文原点挪到图片左上角(见绘制循环里的 translate)。
     *
     * @param {CanvasRenderingContext2D} c - 上下文(原点 = 图片左上角)。
     * @param {Array<object>} texts - 文字图层数组。
     * @param {number} w - 图片显示宽(像素)。
     * @param {number} h - 图片显示高(像素)。
     */
    function drawImageTexts(c, texts, w, h) {
      const list = Array.isArray(texts) ? texts : [];
      for (const item of list) {
        const value = String(item.value == null ? '' : item.value);
        if (!value.trim()) continue;
        const sizePx = Math.max(6, h * (Number(item.size) || TEXT_DEFAULTS.size));
        const lineHeight = sizePx * (Number(item.lineHeight) || TEXT_DEFAULTS.lineHeight);
        const lines = textLines(value);
        const cx = (Number(item.nx) || 0) * w;
        const cy = (Number(item.ny) || 0) * h;
        const totalH = lineHeight * lines.length;
        c.save();
        c.font = `${item.weight || 700} ${sizePx}px "${item.font || TEXT_DEFAULTS.font}", "Microsoft YaHei", "PingFang SC", sans-serif`;
        c.textAlign = item.align === 'left' ? 'left' : item.align === 'right' ? 'right' : 'center';
        c.textBaseline = 'middle';
        c.lineJoin = 'round';
        // 深色描边:保证在任何底图上都看得清(比纯阴影更稳)
        if (item.shadow !== false) {
          c.strokeStyle = 'rgba(0,0,0,0.72)';
          c.lineWidth = Math.max(2, sizePx * 0.14);
        }
        lines.forEach((line, index) => {
          const y = cy - totalH / 2 + lineHeight * (index + 0.5);
          if (item.shadow !== false) c.strokeText(line, cx, y);
          c.fillStyle = item.color || TEXT_DEFAULTS.color;
          c.fillText(line, cx, y);
        });
        c.restore();
      }
    }

    /**
     * 文字图层在图内坐标系里的包围盒(拖动命中、选中框用)。
     * 宽高按估算算,不做 measureText —— 离线也能跑,而且误差对"点没点到"够用。
     */
    function textLayerBounds(item, w, h) {
      const sizePx = Math.max(6, h * (Number(item.size) || TEXT_DEFAULTS.size));
      const lineHeight = sizePx * (Number(item.lineHeight) || TEXT_DEFAULTS.lineHeight);
      const lines = textLines(item.value);
      const width = Math.max(sizePx, ...lines.map((line) => estimateTextWidth(line, sizePx)));
      const cx = (Number(item.nx) || 0) * w;
      const cy = (Number(item.ny) || 0) * h;
      const left = item.align === 'left' ? cx : item.align === 'right' ? cx - width : cx - width / 2;
      const height = lineHeight * lines.length;
      return { x: left, y: cy - height / 2, w: width, h: height };
    }

    /**
     * 在 [0,1] 归一化坐标里找点到了哪条文字(从上往下找,后加的在上)。
     * @param {Array<object>} texts - 文字图层。
     * @param {number} nx - 归一化 x。
     * @param {number} ny - 归一化 y。
     * @param {number} scale - 图片显示尺寸/自然尺寸(w/h 同步缩放,这里传宽的比例即可)。
     */
    function hitTextLayer(texts, nx, ny, w, h) {
      const list = Array.isArray(texts) ? texts : [];
      // w/h 是**图片的显示宽高**(像素)。之前调用点传的是"显示尺寸/自然尺寸"这个比例,
      // 于是包围盒被 textLayerBounds 里 `Math.max(6, …)` 的下限顶成比整张图还大,
      // 「选择」工具下点这张图任何位置都会命中文字 → 图片再也拖不动。
      const W = Number(w) || 1;
      const H = Number(h == null ? w : h) || 1;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const box = textLayerBounds(list[i], W, H);
        const px = nx * W;
        const py = ny * H;
        const pad = 4;
        if (px >= box.x - pad && px <= box.x + box.w + pad && py >= box.y - pad && py <= box.y + box.h + pad) return list[i];
      }
      return null;
    }

    // ── 分层导出:成品图 / 无文字底图 / 文字参数 ────────────────────────
    //
    // 为什么要分层:**底图是位图(放大就糊),文字是矢量的(多清晰都行)**。
    // 烧在一起的成品图只能重来;分开存,以后换尺寸重出、改字、把同一套文字套到别的底图上,都还有得救。

    /**
     * 把「保存路径」派生成分层导出的三个文件名。
     *
     * `画布输出/图-123.png` →
     *   - `full` 成品(底图 + 文字)
     *   - `base` 底图(不含任何文字)
     *   - `meta` 文字参数 JSON
     *
     * 没有扩展名就按 `.png` 补;点号落在目录名里(`a.b/图`)不算扩展名。
     * @param {string} rel - 相对工作区的保存路径。
     * @returns {{ full: string, base: string, meta: string }} 三个落盘路径。
     */
    function layerPaths(rel) {
      const file = String(rel == null ? '' : rel).trim();
      const dot = file.lastIndexOf('.');
      const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
      const hasExt = dot > slash + 1 && dot < file.length - 1;
      const stem = hasExt ? file.slice(0, dot) : file;
      const ext = hasExt ? file.slice(dot) : '.png';
      return {
        full: file,
        base: `${stem}-底图${ext}`,
        meta: `${stem}.texts.json`,
      };
    }

    /**
     * 「导出尺寸」框 → 目标像素。
     *
     * 复用「尺寸」框那一整套人类写法,但**只认能定出具体像素的**:
     * `1080x1440` / `小红书` / `A4` / `210x297mm` 都行;
     * `3:4`、`竖版` 定不出像素(底图是位图,凭空指定一个分辨率没有意义),一律当"留空"。
     * @param {string} text - 输入框里的原话。
     * @param {number} dpi - 实物尺寸(mm/cm/英寸)的换算基准。
     * @returns {{ w: number, h: number, shrunk?: boolean }|null} 目标像素;null = 按原图分辨率。
     */
    function parseExportSize(text, dpi) {
      const parsed = parseHumanSize(text, dpi);
      if (parsed.mode !== 'pixel' || !parsed.pixels) return null;
      const w = Math.round(Number(parsed.pixels[0]) || 0);
      const h = Math.round(Number(parsed.pixels[1]) || 0);
      if (!(w > 0) || !(h > 0)) return null;
      // 和成品尺寸走同一套保险:超过浏览器画布上限就等比缩下来
      const scale = fitScale(w, h);
      if (scale < 1) return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), shrunk: true };
      return { w, h };
    }

    /**
     * 生成分层导出里的文字参数清单(JSON)。
     *
     * 关键:文字在这里是**参数**不是像素 —— 坐标是 0~1 的归一化值,字号是"占图高的比例",
     * 所以这份 JSON 配上任意尺寸的底图,都能重画出一模一样的排版,而且永远清晰。
     * @param {object} image - 画布上的图片对象。
     * @param {{ w: number, h: number }|null} size - 成品实际导出的尺寸。
     * @param {Record<string, boolean>} [fonts] - 字体名 → 本机是否可用(缺省不写这一节)。
     * @returns {object} 可直接 JSON.stringify 的清单。
     */
    function textLayerManifest(image, size, fonts) {
      const src = image && Array.isArray(image.texts) ? image.texts : [];
      const texts = src.map((tx) => ({
        id: String(tx.id || ''),
        value: String(tx.value == null ? '' : tx.value),
        nx: Number(tx.nx) || 0,
        ny: Number(tx.ny) || 0,
        size: Number(tx.size) || TEXT_DEFAULTS.size,
        font: String(tx.font || TEXT_DEFAULTS.font),
        weight: Number(tx.weight) || TEXT_DEFAULTS.weight,
        align: tx.align === 'left' || tx.align === 'right' ? tx.align : 'center',
        color: String(tx.color || TEXT_DEFAULTS.color),
        shadow: tx.shadow !== false,
        lineHeight: Number(tx.lineHeight) || TEXT_DEFAULTS.lineHeight,
      }));
      const out = {
        version: 1,
        plugin: 'dsh-grsai-canvas',
        exportedAt: new Date().toISOString(),
        note: '文字是矢量参数:nx/ny 是 0~1 的归一化坐标,size 是占图高的比例 —— 换 exportW/exportH 就能在任意分辨率上重画,边缘永远清晰。',
        image: {
          name: String((image && image.name) || ''),
          naturalW: Number((image && image.naturalW) || (image && image.w) || 0),
          naturalH: Number((image && image.naturalH) || (image && image.h) || 0),
          exportW: Number(size && size.w) || 0,
          exportH: Number(size && size.h) || 0,
        },
        texts,
      };
      if (fonts && typeof fonts === 'object') out.fonts = fonts;
      return out;
    }

    function cloneDoc(doc) {
      return {
        // texts 要深拷一层:浅拷会让两份文档共用同一个文字数组,撤销就失灵了
        images: doc.images.map((im) => Object.assign({}, im, { texts: (im.texts || []).map((tx) => Object.assign({}, tx)) })),
        marks: doc.marks.map((mk) => Object.assign({}, mk)),
        frames: (doc.frames || []).map((f) => Object.assign({}, f)),
      };
    }
