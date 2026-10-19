/* 生成记录持久化(第一期 A):记录的快照结构、去重、裁剪与读写编队。
 *
 * 数据分两半:
 * - 结果图片本体:客户端生成成功后先经 /ws-save 落成 `画布/results/<记录ID>.<后缀>`
 *   (文件名由内部稳定 ID 生成,不信任远程 URL 里的任何路径成分;后缀跟着上游图真实格式走 ——
 *    /ws-save 会校验文件头,固定 .png 遇到 jpeg 结果会被拒);
 * - 清单:全部记录的元数据快照,固定走宿主 /history 路由(`画布/history.json`,
 *   路径由宿主决定,客户端传不了,天然没有越界风险)。
 *
 * 顺序铁律:**先保资源,再写清单**。清单写失败时记录还在本页内存里,只是没持久化;
 * 绝不因为持久化失败而重新发起生成(那是要再花一次钱的)。
 *
 * 快照语义(任务书):用户原始输入(promptUser)与最终提交提示词(promptFinal)分开存,
 * 恢复参数只回填不生成,旧记录缺字段就标缺失、不编造。
 *
 * 全局零件作用域里的 `api`/`uid` 直接用;CanvasTab 内部的状态与 ref 由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js`)。
 */
    definePart('history-store', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns {{ enabled, normalizeRecord, normalizeList, buildRecord, saveResource, makePersister, trimRecords }} 这组动作。
       */
      function createHistoryStore(p) {
        const { sessionRef, onError } = p;

        /** 结果图片的落盘目录(相对工作区)。 */
        const RESULTS_DIR = '画布/results';
        /** 清单最多保留多少条(和宿主 MAX_HISTORY_RECORDS 对齐)。 */
        const MAX_RECORDS = 400;

        /** 旧宿主(没重启)没有 /history 能力:记录仅本页有效,明确告知。 */
        function enabled(features) {
          return Array.isArray(features) && features.includes('history');
        }

        /**
         * 把任意来源(磁盘旧档/上游)的一条记录洗成安全形状。
         * 缺的字段就让它缺(undefined),渲染层显示「—」—— **不编造默认值**,
         * 否则「旧记录没存过这个参数」和「当时就是这个值」就分不出来了。
         * @param {any} raw - 原始记录。
         * @returns {object|null} 安全记录;没有稳定 ID 的丢弃。
         */
        function normalizeRecord(raw) {
          if (!raw || typeof raw !== 'object') return null;
          const id = typeof raw.id === 'string' ? raw.id.trim() : '';
          if (!id) return null;
          const out = { id };
          const pickStr = (key, cap) => {
            const value = raw[key];
            if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, cap);
          };
          pickStr('taskId', 80);
          pickStr('promptUser', 4000);
          pickStr('promptFinal', 8000);
          pickStr('skillId', 100);
          pickStr('skillText', 4000);
          pickStr('model', 100);
          pickStr('ratio', 100);
          pickStr('quality', 100);
          pickStr('background', 100);
          pickStr('imageSize', 100);
          pickStr('exactSize', 100);
          pickStr('sourceId', 80);
          pickStr('sourceName', 200);
          pickStr('sourceUrl', 500);
          pickStr('file', 300);
          for (const key of ['at', 'w', 'h', 'refCount', 'marksCount', 'textsCount']) {
            const n = Number(raw[key]);
            if (Number.isFinite(n)) out[key] = n;
          }
          for (const key of ['frame', 'cropped', 'submitTexts', 'fav']) {
            if (raw[key] === true) out[key] = true;
          }
          if (Array.isArray(raw.refNames)) {
            const names = raw.refNames.filter((name) => typeof name === 'string' && name.trim()).slice(0, 10);
            if (names.length) out.refNames = names;
          }
          return out;
        }

        /**
         * 洗一整份清单:丢掉坏条目、按时间新→旧排、去重(同 taskId 只留最新一条)。
         * @param {any} raw - GET /history 回来的 records(或任何数组)。
         * @returns {{ records: object[], dropped: number }} 安全清单与丢弃数。
         */
        function normalizeList(raw) {
          const list = Array.isArray(raw) ? raw : [];
          const seenTask = new Set();
          const seenId = new Set();
          const out = [];
          let dropped = 0;
          for (const item of list) {
            const record = normalizeRecord(item);
            if (!record) { dropped += 1; continue; }
            const dupKey = record.taskId || `id:${record.id}`;
            if (seenTask.has(dupKey) || seenId.has(record.id)) { dropped += 1; continue; }
            seenTask.add(dupKey);
            seenId.add(record.id);
            out.push(record);
          }
          out.sort((a, b) => (b.at || 0) - (a.at || 0));
          return { records: out, dropped };
        }

        /**
         * 从一次成功生成里建一条记录(纯函数,不做 IO)。
         * @param {object} snap - 生成侧快照(见 12-canvas-tab 的 handleRecordResult)。
         * @returns {object} 新记录(id 稳定,后续资源/去重都靠它)。
         */
        function buildRecord(snap) {
          const record = normalizeRecord(Object.assign({ id: uid('rec'), at: Date.now() }, snap)) || { id: uid('rec'), at: Date.now() };
          return record;
        }

        /**
         * 把结果图落成工作区文件,成功时返回相对路径(清单里的 `file` 字段)。
         * @param {object} record - 记录(用 record.id 当文件名)。
         * @param {string} dataUrl - 结果图 dataURL。
         * @param {string} session - 发起时的会话(防切工作区串台)。
         * @returns {Promise<string>} 相对路径。
         */
        async function saveResource(record, dataUrl, session) {
          // 后缀按上游图的真实格式取:宿主 /ws-save 会嗅探文件头,内容与后缀不符直接拒写
          const rel = `${RESULTS_DIR}/${record.id}${imageExtOf(dataUrl)}`;
          const data = await api('/ws-save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: rel, dataUrl }),
          }, session);
          return String((data && data.path) || rel);
        }

        /**
         * 建一个**串行化**的持久化队列。
         * 收藏/删除/入库都可能连着来,并行写同一份清单会互相覆盖(后写的赢),
         * 所以全部写动作排队执行;队列里的每次写都取 `getRecords()` 的最新全量清单。
         * 「清单损坏后首次覆盖要先确认」由调用方经 `shouldOverride()` 决定 —— 这里只管排队与报错。
         * @param {object} io - { sessionRef, getRecords, onError, shouldOverride }。
         * @returns {{ push, load }} 队列动作。
         */
        function makePersister(io) {
          const { sessionRef, getRecords, onError, shouldOverride } = io;
          let chain = Promise.resolve();

          function push(reason) {
            const session = sessionRef.current;
            chain = chain.then(async () => {
              const records = getRecords();
              if (typeof shouldOverride === 'function' && !shouldOverride()) {
                throw new Error('清单已损坏且未确认覆盖:本次修改只留在本页,重启前请先处理');
              }
              const data = await api('/history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ records }),
              }, session);
              return data;
            }).catch((e) => {
              // 持久化失败不致命:记录还在内存里。但要说清楚,并且绝不重试生成
              if (onError) onError(`生成记录没有保存到工作区(${(e && e.message) || e}),重启画布前仍可在本页使用${reason ? `(触发:${reason})` : ''}`);
            });
            return chain;
          }

          /**
           * 启动时读清单。会话守卫:回来时工作区已切走就丢弃,不污染新工作区的状态。
           * @param {string} session - 发起时的会话。
           * @returns {Promise<{ records: object[], corrupted: boolean, stale: boolean }>} 清单。
           */
          async function load(session) {
            try {
              const data = await api('/history', undefined, session);
              if (sessionRef.current !== session) return { records: [], corrupted: false, stale: true };
              const parsed = normalizeList(data && data.records);
              return { records: parsed.records, corrupted: Boolean(data && data.corrupted), stale: false };
            } catch (e) {
              if (sessionRef.current !== session) return { records: [], corrupted: false, stale: true };
              throw e;
            }
          }

          return { push, load };
        }

        /**
         * 有界裁剪:超限时保全部收藏,剩余名额从新到旧填非收藏;
         * 收藏本身超限才动收藏(从最旧开始丢)—— 调用方要把 touchedFav 明确报出来,不静默。
         * @param {object[]} list - 当前清单(新→旧)。
         * @returns {{ records: object[], trimmed: number, touchedFav: number }} 裁剪结果。
         */
        function trimRecords(list) {
          if (list.length <= MAX_RECORDS) return { records: list, trimmed: 0, touchedFav: 0 };
          const fav = list.filter((item) => item.fav);
          const plain = list.filter((item) => !item.fav);
          let favKeep = fav;
          let touchedFav = 0;
          if (fav.length > MAX_RECORDS) {
            favKeep = fav.slice(0, MAX_RECORDS);
            touchedFav = fav.length - favKeep.length;
          }
          const room = Math.max(0, MAX_RECORDS - favKeep.length);
          const records = favKeep.concat(plain.slice(0, room));
          return { records, trimmed: list.length - records.length, touchedFav };
        }

        return { RESULTS_DIR, MAX_RECORDS, enabled, normalizeRecord, normalizeList, buildRecord, saveResource, makePersister, trimRecords };
      }

      return { createHistoryStore };
    });
