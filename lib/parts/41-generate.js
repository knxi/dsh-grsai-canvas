/* 提交与生成:把「原图 + 标注」合成提交图、拼请求体、建任务、轮询取图、把结果摆回画布(原图旁边/生成框里)。
 *
 * 全局零件作用域里的 `api`/`sleep`/`uid`/`stamp`/`decodeImage`/`resizeDataUrl`/`proxyImageDataUrl`/`buildGenerateBody`/`sizeErrorFix`/`describeMarks`/`markHint`/`submissionSize`/`marksBounds`/`renderMarks`/`naturalMarkMap`/`drawImageTexts`/`classifyStatus`/`pickImageUrl`/`readPendingTasks`/`writePendingTasks`/`imageBounds`/`screenToWorld`/`fitCamera`/`rectVisible`/`parsePixelSize`/`clamp`/`MAX_PLACE_SIZE`/`GAP`/`MAX_SUBMIT_BYTES`/`SOURCE_SIZE` 直接用;CanvasTab 内部的状态与 ref 由调用处经 `p` 注入(调用处见 `12-canvas-tab.js`);
 * 零件里的函数闭包的是**当次渲染**的 p,所以每渲染一次就建一次(和原来一模一样)。
 */
    definePart('generate', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns {{ buildSubmission, referenceDataUrl, pollTask, placeResultImage, addPendingTask, removePendingTask, run }} 这组动作。
       */
      function createGenerate(p) {
        const {
          activeSkill,
          aliveRef,
          apikey,
          apiBase,
          appendHint,
          background,
          batchSizes,
          busy,
          camRef,
          cancelRef,
          cropToMark,
          customSize,
          docRef,
          expandFrameRef,
          finishChange,
          imageSize,
          imgCacheRef,
          jobsRef,
          model,
          onRecord,
          pendingRef,
          placeLockRef,
          prompt,
          quality,
          ratio,
          selected,
          selectedFrameId,
          scheduleDraw,
          sessionRef,
          setBusy,
          setError,
          setLastUpstream,
          setNotice,
          setPhase,
          setProgress,
          setRatio,
          setResults,
          setSelectedId,
          setSelectedIds,
          setShowSettings,
          sizeRef,
          submitTexts,
        } = p;

        /**
         * 合成「原图 + 标注」。先按上限等比缩小再合成 —— 大图按原始分辨率合成会爆内存/请求体。
         * @param image - 要提交的图片对象。
         * @returns {{ dataUrl, width, height, sourceWidth, sourceHeight, scaled, marks, cropped, bytes }}
         */
        function buildSubmission(image) {
          const el = imgCacheRef.current.get(image.id);
          if (!el || !el.complete || !el.naturalWidth) throw new Error('图片还在解码,稍等一下再提交');
          const naturalW = el.naturalWidth || image.naturalW || image.w;
          const naturalH = el.naturalHeight || image.naturalH || image.h;
          const list = docRef.current.marks.filter((mk) => mk.targetId === image.id);
          const region = submissionRegion(naturalW, naturalH, list, cropToMark);
          const { sx, sy, cropped } = region;
          const sw = region.width;
          const sh = region.height;
          const full = { width: region.fullWidth, height: region.fullHeight };
          const maskList = list.filter((mk) => mk.kind === 'mask');
          // 蒙版是"整图压暗 + 把涂过的地方抠亮":坐标按整张图算,一旦再裁剪就对不上了。
          // 所以有蒙版时自动按整图提交(裁剪勾了也不裁),免得压暗的罩子错位。
          const off = document.createElement('canvas');
          off.width = sw;
          off.height = sh;
          const c = off.getContext('2d');
          // 一次 drawImage 完成「缩放 + 裁剪」:整图按比例画在 (-sx,-sy) 上
          c.drawImage(el, 0, 0, naturalW, naturalH, -sx, -sy, full.width, full.height);
          // 蒙版:先把整张图压暗,再用 destination-out 把涂过的那几笔抠回原亮度。
          // 模型看到"还亮着的那片"就是这次要改的地方,比单画一块更不容易误解。
          if (maskList.length) {
            const maskMap = naturalMarkMap(full.width, full.height);
            c.save();
            c.fillStyle = 'rgba(0, 0, 0, 0.45)';
            c.fillRect(0, 0, full.width, full.height);

            // 不能直接对主画布用 destination-out:那会把蒙版区域擦成透明,
            // 上游拿到的是棋盘格而不是"恢复亮度的原图"。先做一张只含蒙版
            // alpha 的图,把原图裁进这张图后再盖回主画布。
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = full.width;
            maskCanvas.height = full.height;
            const maskCtx = maskCanvas.getContext('2d');
            maskCtx.strokeStyle = '#fff';
            maskCtx.lineCap = 'round';
            maskCtx.lineJoin = 'round';
            for (const mk of maskList) {
              maskCtx.lineWidth = Math.max(1, maskMap.wpx(mk.width));
              maskCtx.beginPath();
              for (let i = 0; i < mk.points.length; i += 1) {
                const q = maskMap.toPx(mk.points[i][0], mk.points[i][1]);
                if (i === 0) maskCtx.moveTo(q[0], q[1]);
                else maskCtx.lineTo(q[0], q[1]);
              }
              if (mk.points.length === 1) {
                const q = maskMap.toPx(mk.points[0][0], mk.points[0][1]);
                maskCtx.lineTo(q[0] + 0.01, q[1]);
              }
              maskCtx.stroke();
            }
            const restore = document.createElement('canvas');
            restore.width = full.width;
            restore.height = full.height;
            const restoreCtx = restore.getContext('2d');
            restoreCtx.drawImage(el, 0, 0, naturalW, naturalH, 0, 0, full.width, full.height);
            restoreCtx.globalCompositeOperation = 'destination-in';
            restoreCtx.drawImage(maskCanvas, 0, 0);
            c.globalCompositeOperation = 'source-over';
            c.drawImage(restore, 0, 0);
            c.restore();
          }
          if (!cropped && list.length) renderMarks(c, list, naturalMarkMap(full.width, full.height));
          // 文字图层默认**不**烧进提交图:模型看到图里有字,经常会试图"重画"它,结果更糊。
          // 想让它参与改图就在文字面板里勾「提交时带上文字」。
          if (submitTexts && Array.isArray(image.texts) && image.texts.length) {
            c.save();
            c.translate(-sx, -sy);
            drawImageTexts(c, image.texts, full.width, full.height);
            c.restore();
          }
          const dataUrl = off.toDataURL('image/png');
          if (!dataUrl || dataUrl.length < 64) throw new Error('合成失败:这张图太大,浏览器拿不出图像数据');
          return {
            dataUrl,
            width: sw,
            height: sh,
            sourceWidth: naturalW,
            sourceHeight: naturalH,
            scaled: full.width !== naturalW || full.height !== naturalH,
            marks: list.length,
            cropped,
            bytes: dataUrl.length,
          };
        }

        /**
         * 参考图也按同一上限缩一下,免得整包爆掉;本来就不大就原样返回。
         * @param image - 图片对象。
         * @returns {string} 提交用的 dataURL。
         */
        function referenceDataUrl(image) {
          const el = imgCacheRef.current.get(image.id);
          if (!el || !el.complete || !el.naturalWidth) return image.dataUrl;
          const size = submissionSize(el.naturalWidth, el.naturalHeight);
          if (size.scale >= 1) return image.dataUrl;
          const off = document.createElement('canvas');
          off.width = size.width;
          off.height = size.height;
          off.getContext('2d').drawImage(el, 0, 0, size.width, size.height);
          const dataUrl = off.toDataURL('image/png');
          return dataUrl && dataUrl.length > 64 ? dataUrl : image.dataUrl;
        }

        /**
         * 轮询任务直到出图。
         * @param id - 任务 id。
         * @param key - APIKEY。
         * @param options - `{isActive}` 续查生命周期检查、`{stop}` 打断判定、`{onProgress}` 进度回传(并发生成时用)。
         * @returns {Promise<string>} 结果图 URL。
         */
        async function pollTask(id, key, options) {
          // 「打断」怎么判定:正常生成用每个任务自己的旗子(options.stop);
          // 续查没有任务表,就还用全局的 cancelRef(点占位框上的「打断」也是置它)。
          const stopped = (options && options.stop) || (() => Boolean(cancelRef.current));
          let failures = 0;
          for (let i = 0; i < 240; i += 1) {
            // 把 3 秒拆成 6×0.5 秒:「打断」最多半秒内就能生效,而不是干等整 3 秒。
            for (let s = 0; s < 6; s += 1) {
              await sleep(500);
              if (options && options.isActive && !options.isActive()) throw new Error('续查已停止,任务保留等待下次恢复');
              if (stopped()) {
                const cancel = new Error('已打断本次生成');
                cancel.cancelled = true;
                throw cancel;
              }
              if (!aliveRef.current) throw new Error('画布标签页被关掉了(任务还在后台,重开画布会自动接着查)');
            }
            let data;
            try {
              data = await api(`/result?id=${encodeURIComponent(id)}`, { headers: { 'x-grsai-key': key, 'x-grsai-base': apiBase } }, sessionRef.current);
            } catch (e) {
              failures += 1;
              if (failures >= 5) throw e;
              continue;
            }
            failures = 0;
            if (!data) continue;
            let raw = '';
            try {
              raw = JSON.stringify(data).slice(0, 260);
            } catch {
              raw = '';
            }
            setLastUpstream(raw);
            const kind = classifyStatus(data.status);
            if (kind === 'done') {
              const url = pickImageUrl(data);
              if (!url) throw new Error(`任务成功了,但上游没给出图片地址。上游返回:${raw}`);
              return url;
            }
            if (kind === 'running') {
              if (typeof data.progress === 'number') {
                const pct = clamp(Math.round(data.progress), 0, 100);
                // 并发生成时不能往全局的 progress/phase 写(几张会互相盖):
                // 谁在跑就把进度报给谁自己的任务,汇总文案由任务表统一刷。
                if (options && options.onProgress) options.onProgress(pct);
                else {
                  setProgress(pct);
                  setPhase(`生成中… ${pct}%`);
                }
              } else if (!options || !options.onProgress) setPhase('生成中…');
              continue;
            }
            const reason =
              data.error ||
              data.msg ||
              data.failure_reason ||
              data.failureReason ||
              (kind === 'failed' ? '上游报告生成失败' : `未知任务状态:${data.status === undefined ? '(空)' : String(data.status)}`);
            const failure = new Error(String(reason));
            // 明确的失败(违规/失败)才算终局;未知状态/超时留着让续查再试
            failure.definitive = kind === 'failed';
            failure.raw = raw;
            throw failure;
          }
          throw new Error('等待超时(约 12 分钟)。任务可能还在跑 —— 重开画布会自动接着查。');
        }

        /**
         * 把一张结果图摆到画布上(原图旁边)。
         * @param dataUrl - 图片数据(dataURL)。
         * @param targetId - 原图 id;找不到就放到最右边/视口中央。
         * @returns {Promise<object|null>} 新图片对象。
         */
        async function placeResultImage(dataUrl, targetId, frame, opts) {
          const o = opts || {};
          let el = await decodeImage(dataUrl);
          // 「成品尺寸」:上游按最接近的档位渲染,这里再本地缩到你要的精确尺寸 ——
          // 画布上这张图、`存`、`下载` 用的都是缩放后的数据,所以交付尺寸就是你指定的那个。
          // 跨平台出图时每张的目标尺寸不一样,所以 `o.exactSize` 优先(不传就还是当前选的成品尺寸)。
          const exact = parsePixelSize(o.exactSize === undefined ? customSize : o.exactSize);
          if (exact && (exact[0] !== el.naturalWidth || exact[1] !== el.naturalHeight)) {
            dataUrl = resizeDataUrl(el, exact[0], exact[1]);
            el = await decodeImage(dataUrl);
          }
          const naturalW = el.naturalWidth || 512;
          const naturalH = el.naturalHeight || 512;
          const target = docRef.current.images.find((im) => im.id === targetId) || null;
          const cam = camRef.current;
          const view = sizeRef.current;
          // 新任务固定锚点并累加实际高度;slot 仅兼容旧任务记录。
          const slot = Math.max(0, Number(o.slot) || 0);
          const placement = o.placement;
          let w;
          let hh;
          let x;
          let y;
          if (frame) {
            // 结果填进生成框:位置与尺寸都按框。
            // 这是刻意的 —— 框就是用户要的成品尺寸(广告物料按框交付),宁可让它填满也不要
            // 等比内切留出白边。上游只按最接近的档位出图,比例差得多时确实会拉伸,
            // 但裁切/留白对成品更糟;要换比例就换框,或选一个能出目标比列的模型。
            w = Math.max(32, Math.round(frame.w));
            hh = Math.max(32, Math.round(frame.h));
            x = frame.x;
            y = frame.y;
          } else {
            const baseW = placement ? placement.w : target ? target.w : Math.min(MAX_PLACE_SIZE, naturalW);
            w = Math.max(32, Math.round(baseW));
            hh = Math.max(32, Math.round((naturalH / naturalW) * w));
            if (placement) {
              x = placement.x;
              y = placement.y + (Number(o.offsetY) || 0);
            } else if (target) {
              x = target.x + target.w + GAP;
              y = target.y + slot * (hh + GAP);
            } else {
              const box = imageBounds(docRef.current.images);
              if (box) {
                x = box.x1 + GAP;
                y = box.y0 + slot * (hh + GAP);
              } else {
                const [cx, cy] = screenToWorld(cam, view.w / 2, view.h / 2);
                x = cx - w / 2;
                y = cy - hh / 2 + slot * (hh + GAP);
              }
            }
          }
          const image = {
            id: uid('img'),
            // 指定了成品尺寸就把尺寸写进文件名,存到工作区后一眼能认出来
            name: `${exact ? `结果-${naturalW}x${naturalH}` : '结果'}-${stamp()}.png`,
            dataUrl,
            x,
            y,
            w,
            h: hh,
            naturalW,
            naturalH,
            isRef: false,
          };
          // 普通生成:只摘掉"这一次提交用的那个框",别的框留着(用户可能还要用)。
          // 扩图(`o.clearFrames`):整个画布的框都清掉 —— 结果图已经把这片区域占住了,
          // 留着旧框只会和结果图重叠、还挡点击。
          const nextFrames = o.clearFrames
            ? []
            : frame
              ? (docRef.current.frames || []).filter((f) => f.id !== frame.id)
              : docRef.current.frames || [];
          docRef.current = { images: [...docRef.current.images, image], marks: docRef.current.marks, frames: nextFrames };
          imgCacheRef.current.set(image.id, el);
          setSelectedId(image.id);
          setSelectedIds([image.id]);
          if (!rectVisible(cam, view, image.x, image.y, image.w, image.h)) {
            camRef.current = fitCamera(docRef.current.images, view);
          }
          finishChange(true);
          return image;
        }

        /**
         * 估算「这次要出的图」会落在哪、多大 —— 只给画布上的**生成占位框**用。
         *
         * 分支与 `placeResultImage` 一一对应(生成框 → 锚点 → 主图右侧 → 已有图右侧 → 视口中央),
         * 免得出现"框画在这儿、图却落在别处"。真实像素要等出图才知道,所以高度按
         * `placeholderAspect` 估出来的比例算 —— 有生成框(直接用框)或勾了成品尺寸时是**精确**的,
         * 其余情况略有出入(落图时会按真实比例重算,幅面只差一点点)。
         * @param {object} opts - frame / exactSize / aspectRatio / sourceAspect / targetId / placement / offsetY。
         * @returns {{x: number, y: number, w: number, h: number}} 世界坐标下的矩形。
         */
        function previewPlaceholderRect(opts) {
          const o = opts || {};
          const frame = o.frame;
          if (frame) {
            return { x: frame.x, y: frame.y, w: Math.max(32, Math.round(frame.w)), h: Math.max(32, Math.round(frame.h)) };
          }
          const aspect = placeholderAspect({ exactSize: o.exactSize, aspectRatio: o.aspectRatio, sourceAspect: o.sourceAspect });
          const natural = parsePixelSize(o.exactSize) || parsePixelSize(o.aspectRatio);
          const target = docRef.current.images.find((im) => im.id === o.targetId) || null;
          const placement = o.placement;
          const offsetY = Number(o.offsetY) || 0;
          let w;
          let x;
          let y;
          if (placement) {
            w = Math.max(32, Math.round(placement.w));
            x = placement.x;
            y = placement.y + offsetY;
          } else if (target) {
            w = Math.max(32, Math.round(target.w));
            x = target.x + target.w + GAP;
            y = target.y + offsetY;
          } else {
            // 上游像素值不知道时按「典型出图长边」估一个宽度 —— 只影响框在屏幕上的观感,不影响落点
            const guess = aspect >= 1 ? 1024 : Math.round(1024 * aspect);
            w = Math.max(32, Math.round(Math.min(MAX_PLACE_SIZE, natural ? natural[0] : guess)));
            const box = imageBounds(docRef.current.images);
            if (box) {
              x = box.x1 + GAP;
              y = box.y0 + offsetY;
            } else {
              const hh = Math.max(32, Math.round(w / aspect));
              const [cx, cy] = screenToWorld(camRef.current, sizeRef.current.w / 2, sizeRef.current.h / 2);
              x = cx - w / 2;
              y = cy - hh / 2;
            }
          }
          return { x, y, w, h: Math.max(32, Math.round(w / aspect)) };
        }

        /**
         * 在画布上挂一个「生成中」的占位框。
         *
         * 它**不进 `doc.images`**(所以不写存档、不进撤销栈、不出现在图层面板与导出里),
         * 只活在 `pendingRef` 这个绘制专用的数组里 —— 出图、失败、打断都会把它摘掉,
         * 绝不会在画布上留下"取不回来的假图"。
         * @param {{x: number, y: number, w: number, h: number}} rect - 世界坐标矩形。
         * @param {string} label - 这次出图的尺寸标签(跨平台出图时是平台名)。
         * @returns {object|null} 注册进去的那一条(清理时要把它传回来)。
         */
        function addPlaceholder(rect, label) {
          if (!pendingRef || !Array.isArray(pendingRef.current)) return null;
          const entry = {
            id: uid('ph'),
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            startedAt: Date.now(),
            label: label || '',
            // 下面这三个是「画布上的框」和「任务」之间的接口:
            // state 决定框里写「排队中」还是百分比,cancel 就是框里那个「⏹ 打断」按下去要干的事。
            pct: 0,
            state: 'queued',
            cancel: null,
          };
          pendingRef.current = [...pendingRef.current, entry];
          if (scheduleDraw) scheduleDraw();
          return entry;
        }

        /** 把占位框摘掉(落图/失败/打断后都要走一遍,否则框会一直挂在画布上)。 */
        function clearPlaceholder(entry) {
          if (!entry || !pendingRef || !Array.isArray(pendingRef.current)) return;
          const list = pendingRef.current;
          const next = list.filter((item) => item.id !== entry.id);
          if (next.length === list.length) return;
          pendingRef.current = next;
          if (scheduleDraw) scheduleDraw();
        }

        /** 记一个未取回的任务(重开画布会接着查)。 */
        function addPendingTask(entry) {
          writePendingTasks([entry, ...readPendingTasks().filter((item) => item.id !== entry.id)]);
        }
        /** 任务取回或终局失败后清掉。 */
        function removePendingTask(id) {
          writePendingTasks(readPendingTasks().filter((item) => item.id !== id));
        }

        // ── 任务表:同时跑几张、谁在排队、每张的进度与打断 ──────────────────
        // 任务本体放 `jobsRef`(一个 ref),**不占 state**:这样连点几次「生成」不会互相顶掉,
        // 生成卡里那几行任务也直接读它。`busy` 只当"还有任务在跑"的汇总。
        // 跨渲染也安全:run()/runJob() 可能在这一次渲染里发起,之后组件重渲染换了新闭包,
        // 但任务表与取消旗子都在 ref / 对象里,按 id 找得到。

        /** 当前的任务表。 */
        function listJobs() {
          return jobsRef && Array.isArray(jobsRef.current) ? jobsRef.current : [];
        }

        /** 写回任务表并刷新汇总状态(phase/progress 只是"给界面看的那一句话")。 */
        function writeJobs(next) {
          if (!jobsRef) return;
          jobsRef.current = next;
          if (!next.length) {
            setBusy(false);
            setPhase('');
            setProgress(0);
          } else {
            const running = next.filter((job) => job.state !== 'queued');
            const active = running[0] || next[0];
            setBusy(true);
            setPhase(
              next.length > 1
                ? `正在生成 ${running.length}/${next.length} 张…`
                : (active && active.phase) || '生成中…',
            );
            setProgress((active && active.pct) || 0);
          }
          if (scheduleDraw) scheduleDraw();
        }

        /** 改一个任务的字段(状态/进度/文案)。 */
        function patchJob(id, fields) {
          let hit = false;
          const next = listJobs().map((job) => {
            if (job.id !== id) return job;
            hit = true;
            return Object.assign({}, job, fields);
          });
          if (hit) writeJobs(next);
        }

        /** 落图要排队:两张同时出图时若一起算位置,会算出同一个点、叠在一起。 */
        function withPlaceLock(fn) {
          const prev = (placeLockRef && placeLockRef.current) || Promise.resolve();
          const next = prev.then(fn, fn);
          if (placeLockRef) placeLockRef.current = next.then(() => undefined, () => undefined);
          return next;
        }

        /** 打断**某一张**(画布上那个框里的「⏹ 打断」按下去就是它)。 */
        function cancelJob(id) {
          const job = listJobs().find((item) => item.id === id);
          if (!job) return;
          if (job.cancelFlag) job.cancelFlag.current = true;
          // 还在排队的任务压根没发出去过:立刻出队,别等下一次 pump(那之前占位框会一直挂着)。
          if (job.state === 'queued') {
            if (job.ph) clearPlaceholder(job.ph);
            writeJobs(listJobs().filter((item) => item.id !== job.id));
            return;
          }
          if (job.ph) job.ph.state = 'cancelling';
          patchJob(id, { phase: '正在打断…' });
        }

        /** 任务收尾:摘占位框、从表里去掉、让排队的补位。 */
        function finishJob(job) {
          if (job.ph) clearPlaceholder(job.ph);
          writeJobs(listJobs().filter((item) => item.id !== job.id));
          pump();
        }

        let pumping = false;
        /**
         * 真正干活的那个函数由 run() 定义(它要用 run 里冻结好的上下文)。
         * 每次渲染都会新建一个 generate 实例,所以这里必须是"最近一次 run 挂上来的"那个。
         */
        let runJobRef = null;
        /** 有空位就把排队中的任务发出去(同时跑几张由设置里的「同时生成」决定,默认 MAX_CONCURRENT_JOBS)。 */
        function pump() {
          if (pumping) return;
          pumping = true;
          try {
            for (let guard = 0; guard < 50; guard += 1) {
              // 没挂上 runJob 就什么也别动:先把任务写成 submitting 再 return 的话,
              // 它既不会被下一次 pump 选中(state 不是 queued),也不会走 finishJob,
              // 并发槽永久 +1,两次之后整条队列就停死了。
              if (!runJobRef) return;
              const list = listJobs();
              const running = list.filter((job) => job.state !== 'queued').length;
              if (running >= concurrencyLimit()) return;
              const queued = list.find((job) => job.state === 'queued');
              if (!queued) return;
              // 排队时就被「撤掉」的任务直接出队:留着它 pump 会照样提交到上游,白花一次钱,
              // 而用户看到的已经是「已从队列里撤掉」。
              if (queued.cancelFlag && queued.cancelFlag.current) {
                if (queued.ph) clearPlaceholder(queued.ph);
                writeJobs(listJobs().filter((job) => job.id !== queued.id));
                continue;
              }
              patchJob(queued.id, { state: 'submitting', phase: '正在提交…', startedAt: Date.now() });
              const current = listJobs().find((job) => job.id === queued.id) || queued;
              runJobRef(current).catch(() => {});
            }
          } finally {
            pumping = false;
          }
        }

        /**
         * 打断**全部**在跑的任务。
         * 界面上的主按钮已经不再变成「打断」了 —— 每张图在自己的占位框里有个「⏹ 打断」;
         * 这个函数留给快捷键/兜底,cancelRef 同时管着续查那条路径。
         */
        function cancelGenerate() {
          cancelRef.current = true;
          const list = listJobs();
          if (!list.length) {
            setPhase('正在打断…');
            return;
          }
          list.forEach((job) => {
            if (job.cancelFlag) job.cancelFlag.current = true;
            if (job.ph) job.ph.state = 'cancelling';
          });
          writeJobs(list.map((job) => Object.assign({}, job, { phase: '正在打断…' })));
        }

        /** 提交一次生成(可连点:不等前一张跑完,多出来的排队)。 */
        async function run() {
          cancelRef.current = false;
          setError('');
          setNotice('');
          if (!apikey) {
            setShowSettings(true);
            setError('先在「设置」里填入 GrsAI APIKEY(在 grsai.com 获取)');
            return;
          }
          // 场景框(生成框):有框就按框生成,结果填进框里
          const frames = docRef.current.frames || [];
          // 扩图框优先:它是刚拉出来的那个,"生成扩图"要填的就是它。
          // 中间点过空白处会把 selectedFrameId 清掉,兜底的 frames[last] 又可能挑错框 ——
          // 一旦挑不到 frame,结果就会掉进"落到主图右侧"的默认分支(看着像另起一行)。
          const expandFrame = expandFrameRef && expandFrameRef.current
            ? frames.find((item) => item.id === expandFrameRef.current) || null
            : null;
          const chosenFrame = expandFrame || frames.find((item) => item.id === selectedFrameId) || frames[frames.length - 1];
          const frame = chosenFrame ? Object.assign({}, chosenFrame) : null;
          const target = selected;
          if (target && target.hidden) {
            setError('主图当前是隐藏状态 —— 先在图层面板里点「显」把它显示出来,再生成');
            return;
          }
          if (!target && !frame && !prompt.trim()) {
            setError('选中一张图、画个生成框,或者写一句提示词直接生成');
            return;
          }
          let submission = null;
          if (target) {
            try {
              submission = buildSubmission(target);
            } catch (e) {
              setError(String((e && e.message) || e));
              return;
            }
          }
          // 隐藏的参考图不参与提交(任务书 C 期:隐藏图不收集参考)
          const refImages = docRef.current.images.filter((im) => im.isRef && !im.hidden && im.id !== (target && target.id));
          const refs = refImages.map((im) => referenceDataUrl(im));
          const payloadImages = submission ? [submission.dataUrl, ...refs] : refs.slice();
          if (!payloadImages.length && !prompt.trim()) {
            setError('至少放一张图,或者写一句提示词');
            return;
          }
          // 体积自查:宁可在这里说清楚,也不要让浏览器把连接掐了报一句 Failed to fetch
          const payloadBytes = payloadImages.reduce((sum, item) => sum + item.length, 0);
          if (payloadBytes > MAX_SUBMIT_BYTES) {
            setError(
              `这次要发 ${(payloadBytes / 1048576).toFixed(1)} MB,超过 ${Math.round(MAX_SUBMIT_BYTES / 1048576)} MB 上限:` +
                '去掉几张参考图、取消勾选参考,或勾上「只提交标注范围(裁剪)」再试',
            );
            return;
          }
          const targetMarkList = target ? docRef.current.marks.filter((mk) => mk.targetId === target.id) : [];
          // 把标注翻译成文字说明:图像模型不像读图 agent 那样会"看懂箭头",得直接告诉它
          const annotationBrief = !(submission && submission.marks)
            ? ''
            : submission.cropped
              ? describeMarks(targetMarkList.filter((mk) => mk.kind === 'text'))
              : describeMarks(targetMarkList);
          const text = [
            activeSkill ? activeSkill.prompt : '',
            prompt.trim(),
            annotationBrief,
            submission && submission.marks && appendHint ? markHint(submission) : '',
          ]
            .filter(Boolean)
            .join('\n\n');
          // 参考图编号说明:用户在提示词里点了名("参考图 2"/"图 3"/"第 2 张")才补 ——
          // 画布角标和生成卡片上的「参考图 N」就是这里的 N,模型看到的顺序是
          // [主图, 参考图1, 参考图2 …],所以要把"你说的参考图 N 是第几张"讲明白,
          // 否则图像模型只会把它们当成一堆平等的图。没点名就不塞,省得每次请求多一段废话。
          const refLegend = (() => {
            if (!refImages.length) return '';
            // 正则故意写 `[ \t]` / `[0-9]` 而不是 `\s` / `\d`:check-deps.mjs 是按标识符取交集的,
            // `\d` / `\s` 里的字母会被当成主组件的变量(12-canvas-tab.js 里确实有 `const d` / `const s`),
            // 于是误报"漏传依赖"。
            if (!/参考[ \t]*图?[ \t]*[0-9]|图[ \t]*[0-9]|第[ \t]*[0-9]+[ \t]*张/.test(text)) return '';
            const base = submission ? 2 : 1;
            const head = submission
              ? '参考图编号说明:这次提交的第 1 张是主图(要改的那张),参考图从第 2 张开始'
              : '参考图编号说明:这次没有主图,提交的第 1 张就是参考图1';
            const lines = refImages.map((im, i) => `参考图${i + 1} = 第 ${i + base} 张(${im.name})`);
            return `${head};${lines.join(';')}。`;
          })();
          const fullText = refLegend ? `${text}\n\n${refLegend}` : text;
          // 尺寸最后再掰一次:不同模型吃的格式不一样(gpt-image-2-vip 只认像素值)。
          // 「原图比例」要的是**实际要发出去那张图**的比例:有主图就是主图(勾了裁剪就是裁出来那块,
          // submission 的宽高已经是裁剪后的),只发参考图时用第一张参考图的自然尺寸。
          const refImage = refImages[0];
          const sourceAspect = frame
            ? frame.w / frame.h
            : submission
              ? submission.width / submission.height
              : refImage && refImage.naturalW && refImage.naturalH
                ? refImage.naturalW / refImage.naturalH
                : 0;
          const submissionNote = submission ? `${submission.width}×${submission.height}` : `${refs.length} 张参考图`;
          // 「跨平台」勾了尺寸就一批一批出:每张的参数先冻结成 plan ——
          // runJob 里有 await,期间组件可能重渲染(闭包里的 p 会换新的),不冻住就会串味。
          const batch = Array.isArray(batchSizes) ? batchSizes.filter(Boolean) : [];
          const plans = (batch.length ? batch : [frame ? '' : customSize || '']).map((sizeValue, index) => ({
            model,
            text: fullText,
            payloadImages,
            ratio: frame ? SOURCE_SIZE : ratio,
            sourceAspect,
            outputSize: sizeValue || '',
            exactSize: sizeValue || (frame ? '' : customSize) || '',
            quality,
            background,
            imageSize,
            targetId: target ? target.id : null,
            frame: index === 0 ? frame : undefined,
            slot: index,
            submissionNote,
            payloadBytes,
            label: (COMMON_OUTPUT_SIZES.find((item) => item.value === sizeValue) || {}).label || sizeValue || '当前尺寸',
            // ↓ 入库/续查要用的**当次快照**。并发生成时 runJob 可能已经跑在"另一次渲染"里,
            //   那时候闭包里的 prompt/target/refImages 早换人了 —— 所以一律先冻在这儿。
            promptUser: prompt.trim(),
            skillId: activeSkill ? activeSkill.id : '',
            skillText: activeSkill ? activeSkill.prompt : '',
            sourceId: target ? target.id : '',
            sourceName: target ? target.name : '',
            refCount: refImages.length,
            refNames: refImages.map((im) => im.name),
            cropped: Boolean(submission && submission.cropped),
            marksCount: submission && Array.isArray(submission.marks) ? submission.marks.length : 0,
            textsCount: target && Array.isArray(target.texts) ? target.texts.length : 0,
            submitTexts: Boolean(submitTexts),
          }));
          // 每个 plan 的请求体与比例提前算好(原来是进了 runOne 才算):
          // 占位框要在**排队的时候**就画出来 —— 先有框、再慢慢跑,才叫"不用干等"。
          for (const plan of plans) {
            plan.body = buildGenerateBody({
              model: plan.model,
              prompt: plan.text,
              images: plan.payloadImages,
              ratio: plan.ratio,
              sourceAspect: plan.sourceAspect,
              outputSize: plan.outputSize,
              quality: plan.quality,
              background: plan.background,
              imageSize: plan.imageSize,
            });
            plan.aspect = placeholderAspect({
              exactSize: plan.exactSize,
              aspectRatio: plan.body.aspectRatio,
              sourceAspect: plan.sourceAspect,
            });
          }

          /** 跑一个任务:建任务 → 等结果 → 落图。并发的几张各跑各的,只有"落图"那一步排队。 */
          async function runJob(job) {
            const cfg = job.plan;
            const flag = job.cancelFlag || { current: false };
            let taskId = null;
            try {
              // 提交前先确认这一张还该不该提交。画布已经卸载、或者排队时就被撤掉的任务,
              // 一旦真发了 /generate 就是白花一次钱 —— 而「撤掉」的提示早就给过用户了。
              if (!aliveRef.current) throw new Error('画布已关闭,这张不再提交');
              if (flag.current) {
                const skip = new Error('已打断本次生成');
                skip.cancelled = true;
                throw skip;
              }
              patchJob(job.id, {
                phase: `创建任务(提交 ${cfg.submissionNote} · ${(cfg.payloadBytes / 1048576).toFixed(1)}MB · ${cfg.label})…`,
              });
              const created = await api('/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-grsai-key': apikey, 'x-grsai-base': apiBase },
                body: JSON.stringify(cfg.body),
              }, sessionRef.current);
              taskId = created && created.id;
              if (!taskId) throw new Error((created && (created.error || created.msg)) || '创建任务失败');
              setLastUpstream(JSON.stringify(created).slice(0, 260));
              // 先记下来:万一中途关页面/切标签,重开画布还能把这张图取回来
              addPendingTask({
                id: taskId, model: cfg.model, prompt: cfg.text.slice(0, 200), targetId: cfg.targetId, at: Date.now(),
                frame: cfg.frame, exactSize: cfg.exactSize, aspect: cfg.aspect,
                placement: job.rect ? { x: job.rect.x, y: job.rect.y, w: job.rect.w } : null, offsetY: 0,
              });
              // 任务刚建好就被人打断了:别进轮询,直接当取消处理
              if (flag.current) {
                const cancel = new Error('已打断本次生成');
                cancel.cancelled = true;
                throw cancel;
              }
              patchJob(job.id, { state: 'running', phase: '生成中…' });
              if (job.ph) job.ph.state = 'running';
              const url = await pollTask(taskId, apikey, {
                stop: () => flag.current,
                onProgress: (pct) => {
                  // 进度只回填到**这张自己的框**上 —— 同一条上游上还跑着别的图呢
                  if (job.ph) job.ph.pct = pct;
                  patchJob(job.id, { pct, phase: `生成中… ${pct}%` });
                },
              });
              setResults((prev) => [{ id: taskId, url, at: Date.now(), model: cfg.model, prompt: cfg.text.slice(0, 400) }, ...prev].slice(0, 30));
              patchJob(job.id, { state: 'placing', phase: '落图…' });
              if (job.ph) job.ph.state = 'placing';
              const dataUrl = await proxyImageDataUrl(url, sessionRef.current);
              let made;
              try {
                made = await withPlaceLock(() => {
                // 进锁之后再定落点:前一张已经写回 doc 了,这儿看得见它,两张才不会叠一起。
                // 用户拖过占位框就照他拖的位置落(不再避让);没拖过才按 freeSpotY 往下找空位。
                const spot = job.ph && job.ph.moved
                  ? {
                      placement: { x: job.ph.x, y: job.ph.y, w: job.ph.w },
                      offsetY: 0,
                    }
                  : job.rect
                    ? {
                        placement: {
                          x: job.rect.x,
                          y: freeSpotY(docRef.current.images, job.rect.x, job.rect.y, job.rect.w, job.rect.h),
                          w: job.rect.w,
                        },
                        offsetY: 0,
                      }
                    : { placement: null, offsetY: 0 };
                return placeResultImage(dataUrl, cfg.targetId, cfg.frame, {
                  exactSize: cfg.exactSize,
                  placement: spot.placement,
                  offsetY: spot.offsetY,
                  // 扩图框生成的图会把原先的框一起收掉,不会留个空框在原地。
                  clearFrames: Boolean(cfg.frame && cfg.frame.expand),
                });
                });
              } catch (e) {
                // 图已经下载到手、只是没能放进画布(解码失败/内存不足/尺寸超限):
                // 标记成终局失败,别留在 pending 里让下次重开画布白忙一遍。
                if (e) e.placeFailed = true;
                throw e;
              }
              removePendingTask(taskId);
              // 入库(第一期 A):正常生成与续查都汇到这里,快照只带白名单字段,
              // 不带任何 header/密钥/调试日志。异步执行,不阻塞别的任务,
              // 也不因为持久化失败而重跑生成(那是再花一次钱)。
              if (typeof onRecord === 'function' && made) {
                Promise.resolve(onRecord({
                  taskId,
                  url,
                  dataUrl,
                  w: Number(made.naturalW) || Number(made.w) || 0,
                  h: Number(made.naturalH) || Number(made.h) || 0,
                  model: cfg.model,
                  ratio: cfg.ratio,
                  quality: cfg.quality,
                  background: cfg.background,
                  imageSize: cfg.imageSize,
                  exactSize: cfg.exactSize,
                  outputSize: cfg.outputSize,
                  promptUser: cfg.promptUser,
                  promptFinal: cfg.text,
                  skillId: cfg.skillId,
                  skillText: cfg.skillText,
                  sourceId: cfg.sourceId,
                  sourceName: cfg.sourceName,
                  refCount: cfg.refCount,
                  refNames: cfg.refNames,
                  frame: Boolean(cfg.frame),
                  cropped: cfg.cropped,
                  marksCount: cfg.marksCount,
                  textsCount: cfg.textsCount,
                  submitTexts: cfg.submitTexts,
                })).catch(() => {});
              }
              setNotice(`${job.queueLabel ? `${job.queueLabel} · ` : ''}${cfg.label} 完成 🎉`);
              return made;
            } catch (e) {
              // 打断 / 上游明确失败:这张不用再续查了。网络抖一下留着让续查接着试;
              // 但「结果已经取回、只差放进画布」(placeFailed)也必须收口 —— 否则每次
              // 重开画布都会重新下载再失败一遍,而用户永远等不到那张图。
              if (taskId && e && (e.definitive || e.cancelled || e.placeFailed)) removePendingTask(taskId);
              if (e && e.cancelled) {
                setNotice(`已打断这一张${job.queueLabel ? `(${job.queueLabel})` : ''},结果不会取回`);
              } else {
                const message = String((e && e.message) || e);
                // 上游说「这个尺寸不支持」是常见坑(比例给了只认像素的模型):
                // 直接把尺寸换成合法值,用户再点一次就行,不用自己去研究该填什么
                const sizeFix = sizeErrorFix(cfg.model, cfg.ratio, `${message} ${(e && e.raw) || ''}`);
                if (sizeFix && sizeFix.size !== cfg.ratio) setRatio(sizeFix.size);
                setError([sizeFix ? sizeFix.hint : message, e && e.raw ? `上游返回:${e.raw}` : ''].filter(Boolean).join('\n'));
              }
              return null;
            } finally {
              // 出图/失败/打断都在这儿收口:占位框绝不留在画布上
              finishJob(job);
            }
          }
          // 挂给 pump —— 它是 createGenerate 作用域里的,看不到这儿的 runJob
          runJobRef = runJob;

          // ── 落点预排 ─────────────────────────────────────────────────────
          // 一次点出去的多张,先各自占一个框:顺序往下排,并且躲开画布上已经在跑/排队的框,
          // 免得两个占位框画在同一个位置、出来两张图又叠在一起。
          const occupied = listJobs().map((item) => item.rect).filter(Boolean);
          const startBox = imageBounds(docRef.current.images);
          let basePlacement = target
            ? { x: target.x + target.w + GAP, y: target.y, w: target.w }
            : startBox
              ? { x: startBox.x1 + GAP, y: startBox.y0, w: Math.min(MAX_PLACE_SIZE, parsePixelSize(plans[0].exactSize)?.[0] || MAX_PLACE_SIZE) }
              : null;
          let baseY = basePlacement ? basePlacement.y : 0;
          let nextOffset = 0;
          const fresh = plans.map((plan, index) => {
            // 生成框/成品尺寸能算出精确的落图尺寸;只给比例的模型只能按比例估(见 previewPlaceholderRect)
            let rect = previewPlaceholderRect({
              frame: plan.frame,
              exactSize: plan.exactSize,
              aspectRatio: plan.body.aspectRatio,
              sourceAspect: plan.sourceAspect,
              targetId: plan.targetId,
              placement: basePlacement,
              offsetY: nextOffset,
            });
            if (!plan.frame) {
              rect = Object.assign({}, rect, { y: freeSpotY(occupied, rect.x, rect.y, rect.w, rect.h) });
              occupied.push(rect);
              if (!basePlacement) {
                // 画布上什么都没有的时候:第一张落在哪儿,后面几张就跟成一列(和"排成一列"的老行为一致)
                basePlacement = { x: rect.x, y: rect.y, w: rect.w };
                baseY = rect.y;
              }
              nextOffset = rect.y - baseY + rect.h + GAP;
            }
            const ph = addPlaceholder(
              rect,
              // 单张时标签就是尺寸本身,不用再挂"当前尺寸";跨平台出图才标 "2/3 · 小红书 3:4"
              plans.length > 1 ? `${index + 1}/${plans.length} · ${plan.label}` : '',
            );
            const flag = { current: false };
            const job = {
              id: uid('job'),
              state: 'queued',
              label: plan.label,
              queueLabel: plans.length > 1 ? `${index + 1}/${plans.length}` : '',
              phase: '排队中…',
              pct: 0,
              startedAt: Date.now(),
              plan,
              rect,
              cancelFlag: flag,
              ph,
            };
            // 框与任务挂上钩:画布上那个「⏹ 打断」按下去,打断的就是这一个任务
            if (ph) {
              ph.jobId = job.id;
              ph.state = 'queued';
              ph.cancel = () => cancelJob(job.id);
            }
            return job;
          });

          // 入队即返回:按钮立刻又能点(想再出几张就再点,多的排队,不用干等一张跑完)
          writeJobs([...listJobs(), ...fresh]);
          pump();
        }

        return { buildSubmission, referenceDataUrl, pollTask, placeResultImage, withPlaceLock, addPendingTask, removePendingTask, previewPlaceholderRect, run, cancelGenerate };
      }

      return { createGenerate };
    });
