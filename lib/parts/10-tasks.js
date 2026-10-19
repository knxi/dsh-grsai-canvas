    /** 未取回的任务存在这个 localStorage 键里(参考站也是这么做的:重开页面还能接着查)。 */
    const LS_TASKS = 'dsh.grsai-canvas.tasks';

    /**
     * 读未取回的任务。
     * @returns {Array<object>} 任务记录数组。
     */
    function readPendingTasks() {
      try {
        const raw = localStorage.getItem(LS_TASKS);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((item) => item && item.id) : [];
      } catch {
        return [];
      }
    }

    /**
     * 写未取回的任务(最多留 100 条)。
     *
     * 上限别定太小:超了就是「静默丢掉最老的那条未取回任务」—— 那张图已经花过钱,
     * 丢了再也取不回来。一条记录只有几百字节,100 条也不到 100KB。
     * @param {Array<object>} list - 任务记录。
     * @returns {void}
     */
    function writePendingTasks(list) {
      try {
        localStorage.setItem(LS_TASKS, JSON.stringify(list.slice(0, 100)));
      } catch {
        /* 隐私模式忽略 */
      }
    }

    /**
     * 上游状态归类:宽松一点 —— 多一个没见过的状态词,不该直接判成"未知状态"。
     * @param {unknown} raw - 上游返回的 status。
     * @returns {'done'|'running'|'failed'|'unknown'} 归类。
     */
    function classifyStatus(raw) {
      const value = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!value) return 'unknown';
      if (['succeeded', 'success', 'done', 'completed', 'complete', 'finished', 'ok'].includes(value)) return 'done';
      if (['running', 'pending', 'queued', 'processing', 'in_queue', 'in-progress', 'in_progress', 'created', 'starting', 'waiting'].includes(value)) {
        return 'running';
      }
      if (['failed', 'failure', 'error', 'violation', 'canceled', 'cancelled', 'rejected'].includes(value)) return 'failed';
      return 'unknown';
    }

    /**
     * 从上游返回里找出图片地址:先按官方 `results[0].url` 取,取不到再兜底深扫。
     * 上游字段偶尔会变,这里多认几种,免得"任务成功了却拿不到图"。
     * @param {any} data - `/result` 的 JSON。
     * @returns {string} 图片 URL;找不到返回空串。
     */
    function pickImageUrl(data) {
      if (!data || typeof data !== 'object') return '';
      const isUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());
      for (const key of ['url', 'imageUrl', 'image_url', 'output', 'src', 'href']) {
        if (isUrl(data[key])) return data[key].trim();
      }
      for (const key of ['results', 'data', 'images', 'outputs', 'result', 'items']) {
        const list = data[key];
        if (!list) continue;
        for (const item of Array.isArray(list) ? list : [list]) {
          if (isUrl(item)) return item.trim();
          if (item && typeof item === 'object') {
            for (const inner of ['url', 'imageUrl', 'image_url', 'src', 'href', 'path']) {
              if (isUrl(item[inner])) return item[inner].trim();
            }
          }
        }
      }
      // 最后的兜底:整个返回里第一个像图片链接的字符串
      let flat = '';
      try {
        flat = JSON.stringify(data);
      } catch {
        return '';
      }
      const image = flat.match(/https?:\/\/[^"'\s\\]+\.(?:png|jpe?g|webp|gif|bmp|avif)(?:\?[^"'\s\\]*)?/i);
      if (image) return image[0];
      const any = flat.match(/https?:\/\/[^"'\s\\]+/i);
      return any ? any[0] : '';
    }
