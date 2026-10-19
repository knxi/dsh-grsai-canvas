    const TOOL_ICONS = {
      select: 'M4 2.5l13.5 7.6-5.8 1.4-1.4 5.8z',
      brush: 'M3.5 17.5c3 0 4.4-2.1 4.4-4.4l7.6-7.6 3 3-7.6 7.6c0 2.3-2.1 3.5-4.4 3.5-1.5 0-2.5-.6-3-2.1z',
      mask: 'M11 4.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM11 4.5v14',
      arrow: 'M4 18L17.5 4.5M17.5 4.5h-6.2M17.5 4.5v6.2',
      rect: 'M4 5.5h14v12H4z',
      ellipse: 'M11 5.5c4 0 7 2.4 7 5.5s-3 5.5-7 5.5-7-2.4-7-5.5 3-5.5 7-5.5z',
      shape: 'M4 6h14v11H4zM4 10h14M4 14h14',
      eraser: 'M7.5 17.5l-3.4-3.4 8-8 4.3 4.3-5.4 5.4zM10.5 19.5h8',
    };

    /**
     * useState 的声明顺序。测试用的假 hooks 按这个顺序喂值,改动组件时同步这里
     * (bundle 会把这份清单导出成 `__stateOrder`,测试会核对数量)。
     */
    const STATE_ORDER = [
      'tool', 'selectedId', 'selectedIds', 'docVersion', 'loaded',
      'apikey', 'keyDraft', 'apiBase', 'baseDraft', 'prompt', 'model', 'ratio', 'quality', 'background', 'imageSize',
      'cropToMark', 'batchSizes', 'appendHint', 'color', 'markWidth',
      'busy', 'phase', 'progress', 'error', 'notice', 'saved',
      'showSettings', 'dockOpen', 'wsFiles', 'wsBusy', 'results',
      'records', 'historyQuery', 'historyFavOnly', 'historyOpenId', 'historyLimit', 'historyCorrupted',
      'compareA', 'compareB', 'compareMode', 'compareSwap', 'compareSlider', 'compareZoom', 'comparePan', 'compareTick',
      'layerRenameId', 'layerRenameText',
      'savePath', 'layerSize', 'showGen', 'showModels', 'showSizes', 'customSize', 'sizeDraft', 'dpiDraft',
      'selectedTextId', 'showText', 'submitTexts', 'fontList',
      'size', 'spaceDown', 'zoomLabel', 'hostStale', 'lastUpstream',
      'skills', 'activeSkillId', 'skillDraft', 'agentBusy', 'layerCfg', 'showLayerKey', 'hostFeatures',
      'showUpscale', 'upscaleTier', 'upscaleScale', 'upscaleBusy', 'upscaleTiers', 'upscaleNote',
      'updateUrl', 'updateDraft', 'updateAuto', 'updateInfo', 'updateStatus', 'updateBusy', 'updateNote',
      'draftSync', 'frameSizeDraft', 'frameDraft', 'selectedFrameId', 'menuAt', 'textEditId', 'expandFrameId',
      'modelsBusy', 'modelsNote',
    ];

    // ── 通用小工具 ──────────────────────────────────────────────────────

    let seq = 0;
    function uid(prefix) {
      seq += 1;
      return `${prefix || 'x'}${Date.now().toString(36)}${seq.toString(36)}`;
    }
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }
    function tokenValue() {
      try {
        return new URLSearchParams(location.search).get('token') || '';
      } catch {
        return '';
      }
    }
    function routeUrl(path, sessionId) {
      const params = [];
      const token = tokenValue();
      if (token) params.push(`token=${encodeURIComponent(token)}`);
      if (sessionId) params.push(`session=${encodeURIComponent(sessionId)}`);
      if (!params.length) return ROUTE + path;
      return `${ROUTE}${path}${path.includes('?') ? '&' : '?'}${params.join('&')}`;
    }
    async function api(path, init, sessionId) {
      // 没有传 signal 就补一个超时:半开的连接会让 /result 轮询永远卡在 await 上,
      // MAX_CONCURRENT_JOBS 被占满后整条队列再也不动,画布上的「打断」也按不动。
      // 45 秒够慢网络传完最大的存档,又能在真的挂死时收口。
      const options = Object.assign({ credentials: 'same-origin' }, init);
      if (!options.signal && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        options.signal = AbortSignal.timeout(45000);
      }
      let response;
      try {
        response = await fetch(routeUrl(path, sessionId), options);
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new Error(`请求超时(45 秒):${path}`);
        }
        throw e;
      }
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!response.ok) throw new Error((data && (data.error || data.msg)) || `HTTP ${response.status}`);
      return data;
    }
    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(blob);
      });
    }
    async function fetchAsDataUrl(url) {
      const init = { credentials: 'same-origin' };
      // 取图也设个上限:图片站挂住不响应时,不封顶就一直占着一个 pending 任务
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(60000);
      let response;
      try {
        response = await fetch(url, init);
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error('取图超时(60 秒):图片地址没有响应');
        throw e;
      }
      if (!response.ok) throw new Error(`取图失败:HTTP ${response.status}`);
      return blobToDataUrl(await response.blob());
    }
    function proxyImageDataUrl(remoteUrl, sessionId) {
      return fetchAsDataUrl(routeUrl(`/image?url=${encodeURIComponent(remoteUrl)}`, sessionId));
    }
    /** 解码一张图,拿它的自然尺寸。 */
    function decodeImage(dataUrl) {
      return new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('图片解码失败'));
        el.src = dataUrl;
      });
    }
    /**
     * dataURL → Blob(复制到剪贴板用)。
     * 先让浏览器自己解:fetch 对 `data:` 是原生解码,几十 MB 的 PNG 也不会把主线程卡住;
     * 万一这个环境不认 data: URL 的 fetch,再退回手写 base64 解码。
     * @param {string} dataUrl - dataURL。
     * @returns {Promise<Blob>} 带正确 MIME 的 Blob。
     */
    async function dataUrlToBlob(dataUrl) {
      const text = String(dataUrl || '');
      if (!/^data:/i.test(text)) throw new Error('不是 dataURL,没法当图片复制');
      if (typeof fetch === 'function') {
        try {
          const res = await fetch(text);
          if (res && res.ok) {
            const blob = await res.blob();
            if (blob && blob.size) return blob;
          }
        } catch {
          /* 走下面的手写解码 */
        }
      }
      const comma = text.indexOf(',');
      if (comma < 0) throw new Error('dataURL 坏了');
      const head = text.slice(0, comma);
      const body = text.slice(comma + 1);
      const binary = /;base64/i.test(head) ? atob(body) : decodeURIComponent(body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
      const mime = (/^data:([^;,]+)/i.exec(head) || [])[1] || 'application/octet-stream';
      return new Blob([bytes], { type: mime });
    }
    /**
     * 把一张图做成「能写进系统剪贴板」的 PNG Blob。
     *
     * 剪贴板里的图只有 PNG 这一种通行写法,而且浏览器会拿声明的类型和 Blob 实际类型对一对 ——
     * 对不上就直接拒收。原图可能是 jpg/webp(甚至就是画布上那张没转过的结果图),
     * 所以不是 PNG 的先按**原始像素**重画成 PNG 再交出去。
     * @param {string} dataUrl - 图片的 dataURL。
     * @returns {Promise<Blob>} image/png 的 Blob。
     */
    async function clipboardPngBlob(dataUrl) {
      const text = String(dataUrl || '');
      if (/^data:image\/png[;,]/.test(text)) {
        const blob = await dataUrlToBlob(text);
        if (blob && blob.type === 'image/png') return blob;
      }
      const el = await decodeImage(text);
      const off = document.createElement('canvas');
      off.width = el.naturalWidth || el.width || 1;
      off.height = el.naturalHeight || el.height || 1;
      off.getContext('2d').drawImage(el, 0, 0);
      return dataUrlToBlob(off.toDataURL('image/png'));
    }
    /**
     * 从 dataURL 的 MIME 推图片后缀。
     *
     * 上游结果图不一定是 PNG(jpeg / webp 都见过),而 `/ws-save` 会校验「文件头与后缀一致」,
     * 所以文件名必须跟着真实格式走 —— 一律写 `.png` 会被宿主当成"内容和后缀对不上"拒掉。
     * @param {string} dataUrl - 图片 dataURL(空/异常时按 png 处理,和上游最常见的情况一致)。
     * @returns {string} `.png` / `.jpg` / `.webp` / `.gif` / `.bmp` / `.avif`。
     */
    function imageExtOf(dataUrl) {
      const m = /^data:([^;,]+)/i.exec(String(dataUrl || ''));
      const mime = m ? m[1].toLowerCase() : '';
      if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
      if (mime === 'image/webp') return '.webp';
      if (mime === 'image/gif') return '.gif';
      if (mime === 'image/bmp') return '.bmp';
      if (mime === 'image/avif') return '.avif';
      return '.png';
    }
    /**
     * 让文件名后缀与 dataURL 的真实格式一致:填 `.png` 却拿到 jpeg,会自动改成 `.jpg`。
     * @param {string} rel - 工作区相对路径(可带后缀,也可不带)。
     * @param {string} dataUrl - 要写进去的图片 dataURL。
     * @returns {string} 修正过后缀的路径。
     */
    function withImageExt(rel, dataUrl) {
      const want = imageExtOf(dataUrl);
      const file = String(rel == null ? '' : rel).trim() || `画布输出/${stamp()}${want}`;
      const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
      const dot = file.lastIndexOf('.');
      const stem = dot > slash + 1 ? file.slice(0, dot) : file;
      return `${stem}${want}`;
    }
    function stamp() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }
    /** 毫秒 → `01:23`(画布上的占位框显示"已经等了多久")。 */
    function durationText(ms) {
      const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }
    /** 比较 `a.b.c` 形式的版本号:a<b 返回 -1,相等 0,更大 1。 */
    function compareVersion(a, b) {
      const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d < 0 ? -1 : 1;
      }
      return 0;
    }
    /** 宿主不支持存档接口时的提示文案。 */
    const STALE_HOST_HINT = '宿主半边还是旧版(没有画布存档接口),画布自动保存/恢复暂时不可用 —— 重启一次 DSH 就会一致。';
    function humanSize(bytes) {
      if (!bytes && bytes !== 0) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    function readPrefs() {
      try {
        return JSON.parse(localStorage.getItem(LS_PREFS) || '{}') || {};
      } catch {
        return {};
      }
    }
    function writePrefs(patch) {
      try {
        localStorage.setItem(LS_PREFS, JSON.stringify(Object.assign(readPrefs(), patch)));
      } catch {
        /* 隐私模式忽略 */
      }
    }
    /**
     * 把用户填的「同时生成数」夹进 1–MAX_CONCURRENT_JOBS_MAX。
     * 空值/写坏了就回默认值 —— 宁可慢一点,也不要因为一个手滑变成一次开一大堆任务(每个都扣费)。
     * @param {string|number} value - 输入框里的原话。
     * @returns {number} 1–4 之间的整数。
     */
    function clampConcurrency(value) {
      if (value == null || value === '') return MAX_CONCURRENT_JOBS;
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return MAX_CONCURRENT_JOBS;
      return Math.max(1, Math.min(MAX_CONCURRENT_JOBS_MAX, n));
    }
    /** 当前生效的「同时生成数」:设置面板写进本机 prefs,没设过就是默认值。 */
    function concurrencyLimit() {
      const prefs = readPrefs();
      return clampConcurrency(prefs ? prefs.maxJobs : undefined);
    }
    /**
     * 参考图编号:**必须与提交顺序一致**(41-generate 里 `payloadImages = [主图, ...参考图]`)。
     * 主选图在提交里是第 1 张(主图),不占参考号;其余 `isRef` 且未隐藏的图按图层顺序从 1 编号。
     * 画布角标、生成卡上的「参考图 N」、以及提交时补的编号说明,三处都用这一个规则。
     * @param {Array<object>} images - 画布图片列表(顺序 = 图层顺序 = 提交顺序)。
     * @param {string|null} selectedId - 当前主选图 id(它的 isRef 不算参考)。
     * @returns {Map<string, number>} 图 id → 参考号(1 起)。
     */
    function refNumbers(images, selectedId) {
      const map = new Map();
      let no = 0;
      for (const image of Array.isArray(images) ? images : []) {
        if (!image || !image.isRef || image.hidden) continue;
        if (selectedId && image.id === selectedId) continue;
        no += 1;
        map.set(image.id, no);
      }
      return map;
    }
    /**
     * 在画布上画参考图角标:贴在图的内侧左上角,越过视口时收进来(图被裁掉一半也看得见)。
     * 主图用深灰、参考图用蓝,跟生成卡上的编号配同一套颜色语言。
     * @param {CanvasRenderingContext2D} c - 画布上下文。
     * @param {number} sx - 图左上角的屏幕 x。
     * @param {number} sy - 图左上角的屏幕 y。
     * @param {number} W - 画布宽(CSS 像素)。
     * @param {number} H - 画布高(CSS 像素)。
     * @param {string} label - 「主图」或「参考 N」。
     * @param {boolean} isMain - 主图 true(深灰),参考图 false(蓝)。
     */
    function drawRefBadge(c, sx, sy, W, H, label, isMain) {
      c.save();
      c.font = '600 11px system-ui, sans-serif';
      const tw = c.measureText(label).width;
      const bw = tw + 10;
      const bh = 17;
      const bx = Math.max(2, Math.min(sx + 5, W - bw - 2));
      const by = Math.max(2, Math.min(sy + 5, H - bh - 2));
      c.fillStyle = isMain ? 'rgba(15,23,42,0.72)' : 'rgba(59,130,246,0.92)';
      c.fillRect(bx, by, bw, bh);
      c.fillStyle = '#fff';
      c.fillText(label, bx + 5, by + 12);
      c.restore();
    }
    function normalizeRect(rect) {
      return {
        x0: Math.min(rect.x0, rect.x1),
        y0: Math.min(rect.y0, rect.y1),
        x1: Math.max(rect.x0, rect.x1),
        y1: Math.max(rect.y0, rect.y1),
      };
    }
