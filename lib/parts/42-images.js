/* 图片操作:选中/删除/清空、图层顺序(置顶/上移/下移/置底)、对齐与分布、批量导出(多选存/下载)、导出成品(存 / 下载 / 复制到剪贴板 / 分层导出)、结果导入,以及工作区图片的读取与挑选。
 *
 * 全局零件作用域里的 `api`/`stamp`/`drawImageTexts`/`decodeImage`/`layerPaths`/`parseExportSize`/`textLayerManifest`/`isFontAvailable`/`TEXT_DEFAULTS`/`clipboardPngBlob`/`proxyImageDataUrl`/`fetchAsDataUrl`/`routeUrl` 直接用;CanvasTab 内部的状态与 ref 由调用处经 `p` 注入(调用处见 `12-canvas-tab.js`);
 * 零件里的函数闭包的是**当次渲染**的 p,所以每渲染一次就建一次(和原来一模一样)。
 */
    definePart('images', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns {{ toggleRef, deleteSelected, reorderSelected, setImageFlag, renameImage, moveImageTo, alignSelected, clearMarks, clearCanvas, renderExportDataUrl, saveImageToWorkspace, saveSelectedToWorkspace, saveImageLayered, downloadImage, downloadSelected, copyImageToClipboard, importResult, openWorkspace, refreshWorkspace, pickWorkspace }} 这组动作。
       */
      function createImages(p) {
        const {
          addImageFromDataUrl,
          camRef,
          docRef,
          dpi,
          finishChange,
          imgCacheRef,
          layerSize,
          savePath,
          selected,
          selectedIds,
          sessionRef,
          setError,
          setNotice,
          setSelectedId,
          setSelectedIds,
          setDockOpen,
          setWsBusy,
          setWsFiles,
          wsFiles,
        } = p;

        function toggleRef() {
          const image = selected;
          if (!image) return;
          image.isRef = !image.isRef;
          finishChange(true);
          setNotice(image.isRef ? '已标记为参考图(提交时会一起发给模型)' : '已取消参考图');
        }
        /**
         * 精确改这张图的位置/尺寸(属性卡上那四个数字框用)。
         *
         * 只吃有限数字:框里被清空或打了别的字时**不要**写进 doc —— 一个 NaN 就会让图
         * 从画布上消失(worldToScreen 算出 NaN,canvas 静默不画),用户只会觉得图丢了。
         * @param {{x?:number|string,y?:number|string,w?:number|string,h?:number|string}} patch - 要改的字段。
         */
        function setGeometry(patch) {
          const target = selected;
          if (!target || !patch) return;
          if (target.locked) {
            setNotice('这张图锁着 —— 先在图层面板解锁再改位置/尺寸');
            return;
          }
          const image = docRef.current.images.find((im) => im.id === target.id);
          if (!image) return;
          const next = {};
          for (const key of ['x', 'y', 'w', 'h']) {
            if (patch[key] === undefined || patch[key] === null || patch[key] === '') continue;
            const value = Number(patch[key]);
            if (!Number.isFinite(value)) continue;
            // 宽高最小 8 像素:拖到 0 宽之后这张图就再也点不中,只能从图层面板删
            const rounded = key === 'w' || key === 'h' ? Math.max(8, Math.round(value)) : Math.round(value);
            if (rounded !== Math.round(Number(image[key]) || 0)) next[key] = rounded;
          }
          if (!Object.keys(next).length) return;
          Object.assign(image, next);
          finishChange(true);
        }

        function deleteSelected() {
          const ids = selectedIds.length ? selectedIds : selected ? [selected.id] : [];
          if (!ids.length) return;
          // 普通删除跳过锁定图(要删锁着的图,先在图层面板解锁)
          const byId = new Map(docRef.current.images.map((im) => [im.id, im]));
          const removable = ids.filter((id) => byId.get(id) && !byId.get(id).locked);
          const lockedCount = ids.length - removable.length;
          if (!removable.length) {
            setNotice(lockedCount > 1 ? `选中的 ${lockedCount} 张图都锁着 —— 先在图层面板解锁再删` : '这张图锁着 —— 先在图层面板解锁再删');
            return;
          }
          const keep = new Set(removable);
          const label = removable.length > 1 ? `${removable.length} 张图` : byId.get(removable[0]).name || '图片';
          docRef.current = {
            images: docRef.current.images.filter((im) => !keep.has(im.id)),
            marks: docRef.current.marks.filter((mk) => !keep.has(mk.targetId)),
            frames: docRef.current.frames,
          };
          // 删掉的图也从解码缓存里摘掉:不然几 MB 的 dataURL 和 Image 对象会一直挂在 Map 里,
          // 反复生成/删除之后内存只涨不降,最后浏览器开始掉帧。
          for (const id of removable) imgCacheRef.current.delete(id);
          setSelectedId(null);
          setSelectedIds([]);
          finishChange(true);
          setNotice(`已删除:${label}${lockedCount ? `(另有 ${lockedCount} 张锁定,已跳过)` : ''}`);
        }
        /**
         * 调图层顺序:上移/下移一格,或直接置顶/置底。
         *
         * 图层顺序就是 `doc.images` 的数组顺序 —— 排在后面的画在上面,所以「上移」= 往后挪一格。
         * 多选时整块一起挪,彼此之间不会踩来踩去。
         * @param {'up'|'down'|'top'|'bottom'} dir - 移动方向。
         */
        function reorderSelected(dir) {
          const list = docRef.current.images;
          const ids = selectedIds.length ? selectedIds : selected ? [selected.id] : [];
          if (!list.length || !ids.length) return;
          const set = new Set(ids);
          if (!list.some((im) => set.has(im.id))) return;
          let next;
          if (dir === 'top' || dir === 'bottom') {
            const picked = list.filter((im) => set.has(im.id));
            const rest = list.filter((im) => !set.has(im.id));
            next = dir === 'top' ? rest.concat(picked) : picked.concat(rest);
          } else {
            next = list.slice();
            if (dir === 'up') {
              // 从上层往下扫,免得同一张图在一次操作里被连着换两格
              for (let i = next.length - 2; i >= 0; i -= 1) {
                if (set.has(next[i].id) && !set.has(next[i + 1].id)) {
                  const tmp = next[i];
                  next[i] = next[i + 1];
                  next[i + 1] = tmp;
                }
              }
            } else {
              for (let i = 1; i < next.length; i += 1) {
                if (set.has(next[i].id) && !set.has(next[i - 1].id)) {
                  const tmp = next[i];
                  next[i] = next[i - 1];
                  next[i - 1] = tmp;
                }
              }
            }
          }
          if (next.every((im, i) => im === list[i])) {
            setNotice(dir === 'top' || dir === 'up' ? '已经在最上层了' : '已经在最下层了');
            return;
          }
          docRef.current = { images: next, marks: docRef.current.marks, frames: docRef.current.frames };
          finishChange(true);
          const label = { up: '上移一层', down: '下移一层', top: '置顶', bottom: '置底' }[dir] || dir;
          setNotice(ids.length > 1 ? `已把选中的 ${ids.length} 张图${label}` : `图已${label}`);
        }

        /** 对齐/分布的目标图:对齐至少 2 张,分布至少 3 张。 */
        function alignTargets(min) {
          const ids = selectedIds.length ? selectedIds : selected ? [selected.id] : [];
          const picked = docRef.current.images.filter((im) => ids.includes(im.id));
          if (picked.length < min) {
            setNotice(min === 2 ? '先选中 2 张以上图(Shift 点选)再对齐' : '等距分布至少要选 3 张');
            return null;
          }
          return picked;
        }

        /**
         * 对齐 / 分布选中图。
         *
         * 对齐以**整批图的包围盒**为基准(不是画布),所以图散在哪都能一次排齐;
         * 分布则是首尾两张留在原地、中间的等间距铺开 —— 所以至少要 3 张。
         * 图上的标注存的是归一化坐标(相对图片),图挪了标注自动跟着走。
         * @param {'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom'|'hdist'|'vdist'} kind - 对齐方式。
         */
        function alignSelected(kind) {
          const isDist = kind === 'hdist' || kind === 'vdist';
          const picked = alignTargets(isDist ? 3 : 2);
          if (!picked) return;
          const box = imageBounds(picked);
          if (!box) return;
          const round = (n) => Math.round(n);
          if (isDist) {
            const horiz = kind === 'hdist';
            const sorted = picked.slice().sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
            const span = horiz ? box.w : box.h;
            const used = sorted.reduce((acc, im) => acc + (horiz ? im.w : im.h), 0);
            const gap = (span - used) / (sorted.length - 1);
            if (!(gap > 0)) {
              setNotice('这几张图加起来已经占满整批范围了,排不开 —— 先把图缩小一点再分布');
              return;
            }
            let cursor = horiz ? box.x0 : box.y0;
            for (const im of sorted) {
              if (horiz) im.x = round(cursor);
              else im.y = round(cursor);
              cursor += (horiz ? im.w : im.h) + gap;
            }
          } else {
            for (const im of picked) {
              if (kind === 'left') im.x = round(box.x0);
              else if (kind === 'right') im.x = round(box.x1 - im.w);
              else if (kind === 'hcenter') im.x = round(box.x0 + (box.w - im.w) / 2);
              else if (kind === 'top') im.y = round(box.y0);
              else if (kind === 'bottom') im.y = round(box.y1 - im.h);
              else if (kind === 'vcenter') im.y = round(box.y0 + (box.h - im.h) / 2);
            }
          }
          finishChange(true);
          const label = { left: '左对齐', hcenter: '水平居中', right: '右对齐', top: '顶对齐', vcenter: '垂直居中', bottom: '底对齐', hdist: '水平等距排开', vdist: '垂直等距排开' }[kind] || '对齐';
          setNotice(`${picked.length} 张图已${label}(Ctrl+Z 可撤销)`);
        }

        function clearMarks() {
          const target = selected;
          if (!target) return;
          if (!docRef.current.marks.some((mk) => mk.targetId === target.id)) return;
          docRef.current = { images: docRef.current.images, marks: docRef.current.marks.filter((mk) => mk.targetId !== target.id), frames: docRef.current.frames };
          finishChange(true);
          setNotice('已清空这张图上的标注');
        }
        function clearCanvas() {
          const images = docRef.current.images;
          if (!images.length && !(docRef.current.frames || []).length && !docRef.current.marks.length) return;
          // 清空会连隐藏/锁定的图一起拿走,先让用户点一次头
          const hidden = images.filter((im) => im.hidden).length;
          const locked = images.filter((im) => im.locked).length;
          const extra = [hidden ? `隐藏 ${hidden} 张` : '', locked ? `锁定 ${locked} 张` : ''].filter(Boolean).join('、');
          const ok = window.confirm(
            `清空画布上的全部内容?共 ${images.length} 张图${extra ? `(含${extra})` : ''}、${(docRef.current.frames || []).length} 个生成框。\n清空后可以用 Ctrl+Z 撤销。`,
          );
          if (!ok) return;
          docRef.current = { images: [], marks: [], frames: [] };
          imgCacheRef.current = new Map();
          setSelectedId(null);
          setSelectedIds([]);
          camRef.current = { x: 0, y: 0, zoom: 1 };
          finishChange(true);
          setNotice('画布已清空(可以 Ctrl+Z 撤销)');
        }
        /**
         * 图层面板的显式开关:isRef / hidden / locked(后两个是 C 期新增的独立属性)。
         *
         * 锁定挡的是"改内容和位置"(拖动/缩放/标注/文字/改名/排序/普通删除);
         * 开关本身(显示⇄隐藏、锁定⇄解锁、参考标记)是显式面板操作,锁定图也放行 ——
         * 否则锁定的图就永远没法从提交集合里摘出来了。
         * @param {string} id - 图片 id。
         * @param {'isRef'|'hidden'|'locked'} key - 属性名。
         * @param {boolean} value - 目标值。
         */
        function setImageFlag(id, key, value) {
          const image = docRef.current.images.find((im) => im.id === id);
          if (!image) return;
          const next = Boolean(value);
          if (Boolean(image[key]) === next) return;
          image[key] = next;
          finishChange(true);
          const label = {
            isRef: next ? '已标记为参考图(提交时会一起发给模型)' : '已取消参考图',
            hidden: next ? '已隐藏(画布上不显示、不参与提交)' : '已显示',
            locked: next ? '已锁定(不能拖动/缩放/标注/删除)' : '已解锁',
          }[key] || '已更新';
          setNotice(`${label}:${image.name || '图片'}`);
        }
        /** 面板重命名:锁定图要先解锁;空名不改。 */
        function renameImage(id, name) {
          const image = docRef.current.images.find((im) => im.id === id);
          const next = String(name == null ? '' : name).trim();
          if (!image || !next || next === image.name) return;
          if (image.locked) {
            setNotice('这张图锁着 —— 先解锁再改名');
            return;
          }
          image.name = next;
          finishChange(true);
          setNotice(`已重命名为:${next}`);
        }
        /**
         * 面板拖动排序:把一张图插到某张图前面(`beforeId`;放到最后传空)。
         *
         * 面板顺序 = `doc.images` 数组顺序(首行 = 最底层),所以排序就是改数组。
         * 锁定图要先解锁才能挪(和改名一样,属"改位置"类操作)。
         * @param {string} id - 要挪的图片 id。
         * @param {string|null} beforeId - 插到这张图前面;null = 放到最顶层(末尾)。
         */
        function moveImageTo(id, beforeId) {
          const list = docRef.current.images;
          const from = list.findIndex((im) => im.id === id);
          if (from < 0) return;
          if (list[from].locked) {
            setNotice('这张图锁着 —— 先解锁再调整顺序');
            return;
          }
          const rest = list.filter((im) => im.id !== id);
          const at = beforeId ? rest.findIndex((im) => im.id === beforeId) : rest.length;
          if (at < 0) return; // 拖到自己身上 = 没动
          const next = rest.slice();
          next.splice(at, 0, list[from]);
          if (next.every((im, i) => im === list[i])) return;
          docRef.current = { images: next, marks: docRef.current.marks, frames: docRef.current.frames };
          finishChange(true);
          setNotice('已调整图层顺序(Ctrl+Z 可撤销)');
        }
        /**
         * 把「图片 (+ 它的文字图层)」合成成一张 dataURL(存 / 下载 / 分层导出用)。
         *
         * 这是"字不糊"的关键一步:文字是本地用本机字体矢量绘制的,**按目标分辨率**画 ——
         * 你要多大就按那个尺寸的坐标系画字,边缘永远清晰
         * —— 而让模型在图里"画字"是画像素,放多大都糊。
         * @param {object} image - 画布上的图片对象。
         * @param {{ onlyBase?: boolean, size?: { w: number, h: number } }} [opts] - `onlyBase` 只要底图(不画文字);`size` 按指定尺寸导出(缺省 = 原图分辨率)。
         * @returns {Promise<string>} dataURL。
         */
        async function renderExportDataUrl(image, opts) {
          const o = opts || {};
          const texts = Array.isArray(image.texts) ? image.texts : [];
          const want = o.size && Number(o.size.w) > 0 && Number(o.size.h) > 0
            ? { w: Math.round(Number(o.size.w)), h: Math.round(Number(o.size.h)) }
            : null;
          // 没文字、也没要求换尺寸 → 原图原样返回,省一次编解码
          if (!texts.length && !want) return image.dataUrl;
          const el = imgCacheRef.current.get(image.id) || (await decodeImage(image.dataUrl));
          const nw = el.naturalWidth || image.naturalW || image.w;
          const nh = el.naturalHeight || image.naturalH || image.h;
          const w = want ? want.w : nw;
          const h = want ? want.h : nh;
          // 只要底图、尺寸又没变 → 原图本身就是底图(文字图层从来没烧进 dataUrl)
          if (o.onlyBase && w === nw && h === nh) return image.dataUrl;
          const off = document.createElement('canvas');
          off.width = w;
          off.height = h;
          const c = off.getContext('2d');
          c.imageSmoothingEnabled = true;
          c.imageSmoothingQuality = 'high';
          c.drawImage(el, 0, 0, w, h);
          if (!o.onlyBase) drawImageTexts(c, texts, w, h);
          const out = off.toDataURL('image/png');
          return out && out.length > 64 ? out : image.dataUrl;
        }

        /** 导出目标清单:选了多张就按图层顺序整批返回,否则只返回主选中那张。 */
        function exportTargets() {
          if (selectedIds.length) {
            const want = new Set(selectedIds);
            return docRef.current.images.filter((im) => want.has(im.id));
          }
          return selected ? [selected] : [];
        }

        /** 批量存工作区时的文件名:同一秒里的多张图不能互相覆盖,所以带序号。 */
        function batchRelPath(image, idx, dataUrl) {
          const stem = (image.name || 'grsai').replace(/\.[a-z0-9]+$/i, '') || 'grsai';
          const tpl = savePath.trim();
          if (tpl) {
            const m = /^(.*?)(\.[a-z0-9]+)$/i.exec(tpl);
            return withImageExt(m ? `${m[1]}-${idx}${m[2]}` : `${tpl}-${idx}.png`, dataUrl);
          }
          return withImageExt(`画布输出/${stem}-${stamp()}-${idx}.png`, dataUrl);
        }

        async function saveImageToWorkspace(image) {
          if (!image) return;
          setError('');
          try {
            // 带文字图层时按原图分辨率把字烧进去(存下来的就是成品图)
            const dataUrl = await renderExportDataUrl(image);
            // 后缀跟着真实格式走:没有文字也没换尺寸时 renderExportDataUrl 会原样返回上游图,
            // 那张可能是 jpeg / webp,写死 .png 会被宿主按"内容和后缀对不上"拒掉。
            const rel = withImageExt(savePath.trim() || `画布输出/${(image.name || 'grsai').replace(/\.[a-z0-9]+$/i, '')}-${stamp()}.png`, dataUrl);
            const data = await api('/ws-save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: rel, dataUrl }),
            }, sessionRef.current);
            setNotice(`已保存:${data.path}${Array.isArray(image.texts) && image.texts.length ? '(文字按原图分辨率烧入)' : ''}`);
          } catch (e) {
            setError(String((e && e.message) || e));
          }
        }

        /**
         * 分层导出:一次落盘三个文件 —— 成品图 / 无文字底图 / 文字参数 JSON。
         *
         * 底图是位图(放大就糊),文字是矢量的(多清晰都行),所以分开存最划算:
         * 以后想换尺寸重出、想改字、想把同一套排版套到别的底图上,都还有得救;
         * 烧在一起的成品图就只能从头再来。
         * @param {object} image - 画布上的图片对象。
         */
        /**
         * 存工作区(多选版):选了多张就逐张落盘,一张失败不影响其余。
         *
         * 存的还是「存 / 下载」那张成品 —— 原图分辨率 + 文字图层。单张时直接走老路,
         * 多张时文件名带序号,免得同一秒里几笔写进同一个路径互相覆盖。
         */
        async function saveSelectedToWorkspace() {
          const list = exportTargets();
          if (!list.length) return;
          if (list.length === 1) return saveImageToWorkspace(list[0]);
          setError('');
          const done = [];
          const failed = [];
          for (let i = 0; i < list.length; i += 1) {
            const im = list[i];
            setNotice(`正在保存 ${i + 1}/${list.length}:${im.name || '图片'}…`);
            try {
              const dataUrl = await renderExportDataUrl(im);
              const rel = batchRelPath(im, i + 1, dataUrl);
              await api('/ws-save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: rel, dataUrl }),
              }, sessionRef.current);
              done.push(rel);
            } catch (e) {
              failed.push(`${im.name || '图片'}:${String((e && e.message) || e)}`);
            }
          }
          setNotice(done.length
            ? `已存 ${done.length}/${list.length} 张到工作区:${done.slice(0, 3).join('、')}${done.length > 3 ? ` 等 ${done.length} 个文件` : ''}`
            : '一张都没存上,看下面的报错');
          if (failed.length) setError(`这几张没存上 —— ${failed.join(';')}`);
        }

        async function saveImageLayered(image) {
          if (!image) return;
          setError('');
          const texts = Array.isArray(image.texts) ? image.texts : [];
          const natW = Number(image.naturalW || image.w) || 0;
          const natH = Number(image.naturalH || image.h) || 0;
          const want = parseExportSize(layerSize, dpi);
          const size = want ? { w: want.w, h: want.h } : natW > 0 && natH > 0 ? { w: natW, h: natH } : null;
          const baseRel = savePath.trim() || `画布输出/${(image.name || 'grsai').replace(/\.[a-z0-9]+$/i, '')}-${stamp()}.png`;
          // 导出时就把"这台机器到底有没有这个字体"记下来 —— 换台机器重出时一眼看得出来
          const fonts = {};
          for (const tx of texts) {
            const family = String(tx.font || TEXT_DEFAULTS.font);
            if (!(family in fonts)) fonts[family] = isFontAvailable(family);
          }
          try {
            const save = (target, dataUrl) => api('/ws-save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: target, dataUrl }),
            }, sessionRef.current);
            const done = [];
            // ① 成品:底图 + 文字,文字按导出尺寸矢量绘制
            const fullUrl = await renderExportDataUrl(image, size ? { size } : undefined);
            // 基名后缀按成品真实格式定(成品有文字时一定是 png;没文字没换尺寸时是上游原图)
            const paths = layerPaths(withImageExt(baseRel, fullUrl));
            await save(paths.full, fullUrl);
            done.push(paths.full);
            // ② 底图:一个字的痕迹都没有 —— 换尺寸/重排版都拿它当底
            const baseUrl = await renderExportDataUrl(image, Object.assign({ onlyBase: true }, size ? { size } : {}));
            const baseTarget = withImageExt(paths.base, baseUrl);
            await save(baseTarget, baseUrl);
            done.push(baseTarget);
            // ③ 文字参数:没有文字图层就不产生这个文件
            if (texts.length) {
              const json = JSON.stringify(textLayerManifest(image, size, fonts), null, 2);
              await save(paths.meta, `data:application/json,${encodeURIComponent(json)}`);
              done.push(paths.meta);
            }
            const missing = Object.keys(fonts).filter((family) => fonts[family] === false);
            const warn = missing.length ? `　⚠ 本机没有 ${missing.join('、')} —— 重出时会换成替代字体` : '';
            setNotice(`已分层导出 ${done.length} 个文件:${done.join('、')}${size ? `(按 ${size.w}×${size.h})` : ''}${want && want.shrunk ? '(超画布上限已等比缩小)' : ''}${warn}`);
          } catch (e) {
            setError(String((e && e.message) || e));
          }
        }

        async function downloadImage(image) {
          if (!image) return;
          let href = image.dataUrl;
          try {
            href = await renderExportDataUrl(image);
          } catch {
            href = image.dataUrl; // 合成失败就退回落原始图,别让下载点了没反应
          }
          const a = document.createElement('a');
          a.href = href;
          // 后缀按真实格式来(合成失败退化到上游原图时可能是 jpeg,别把 .png 写死)
          const stem = String(image.name || `grsai-${stamp()}`).replace(/\.[a-z0-9]+$/i, '');
          a.download = `${stem || 'grsai'}${imageExtOf(href)}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }

        /**
         * 复制一张图到系统剪贴板(Ctrl+C / 「复制」按钮)。
         *
         * 复制的是「存 / 下载」那张成品 —— 原图分辨率 + 文字图层,不是画布上那张缩略图,
         * 也不是带箭头红框的提交图:粘到微信/PPT/PS 里就是能直接用的图。
         * @param {object} image - 画布上的图片对象。
         * @param {string} [hint] - 提示语里额外带一句(多选时说清楚只复制了哪张)。
         */
        /**
         * 下载(多选版):逐张触发浏览器下载。
         *
         * 张与张之间留点间隔 —— 连着点太密,有的浏览器会把后面几个当弹窗拦掉。
         */
        async function downloadSelected() {
          const list = exportTargets();
          if (!list.length) return;
          if (list.length === 1) return downloadImage(list[0]);
          setError('');
          for (let i = 0; i < list.length; i += 1) {
            const im = list[i];
            let href = im.dataUrl;
            try {
              href = await renderExportDataUrl(im);
            } catch {
              href = im.dataUrl; // 合成失败就退回落原图,别让下载点了没反应
            }
            const stem = String(im.name || 'grsai').replace(/\.[a-z0-9]+$/i, '') || 'grsai';
            const a = document.createElement('a');
            a.href = href;
            a.download = `${stem}-${i + 1}${imageExtOf(href)}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (i < list.length - 1) await new Promise((resolve) => setTimeout(resolve, 350));
          }
          setNotice(`已开始下载 ${list.length} 张 —— 浏览器可能会问一次「是否允许下载多个文件」`);
        }

        async function copyImageToClipboard(image, hint) {
          if (!image) return;
          setError('');
          const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
          const Item = typeof ClipboardItem !== 'undefined' ? ClipboardItem : null;
          if (!clip || typeof clip.write !== 'function' || !Item) {
            setError('这个浏览器不让网页把图片写进剪贴板,用「下载」拿到文件再拖进去吧');
            return;
          }
          const makePng = () => renderExportDataUrl(image).then(clipboardPngBlob);
          try {
            // 先把 Promise 交出去:大图编码要几百毫秒,等编码完再写的话,按下 Ctrl+C 那次的
            // "用户手势"已经过期,浏览器会直接拒掉(NotAllowedError)。
            // ClipboardItem 收 Promise 就是为这种场景准备的。
            await clip.write([new Item({ 'image/png': makePng() })]);
          } catch (first) {
            try {
              // 少数实现不收 Promise(要求现成的 Blob):编码完再写一次。
              await clip.write([new Item({ 'image/png': await makePng() })]);
            } catch (second) {
              setError(`复制失败:${String((second && second.message) || second)}(可以先用「下载」)`);
              return;
            }
          }
          setNotice(`已复制「${image.name || '图片'}」到剪贴板,可直接粘到聊天/PPT/PS${hint || ''}`);
        }
        async function importResult(item) {
          try {
            const dataUrl = await proxyImageDataUrl(item.url, sessionRef.current);
            await addImageFromDataUrl(dataUrl, `结果-${stamp()}.png`, false);
          } catch (e) {
            setError(String((e && e.message) || e));
          }
        }
        async function openWorkspace() {
          setDockOpen('workspace');
          if (wsFiles) return;
          setWsBusy(true);
          try {
            const data = await api('/ws-list', undefined, sessionRef.current);
            setWsFiles(data.files || []);
          } catch (e) {
            setError(String((e && e.message) || e));
            setWsFiles([]);
          } finally {
            setWsBusy(false);
          }
        }
        async function refreshWorkspace() {
          setWsBusy(true);
          try {
            const data = await api('/ws-list', undefined, sessionRef.current);
            setWsFiles(data.files || []);
          } catch (e) {
            setError(String((e && e.message) || e));
          } finally {
            setWsBusy(false);
          }
        }
        async function pickWorkspace(rel) {
          setError('');
          try {
            const dataUrl = await fetchAsDataUrl(routeUrl(`/ws-file?path=${encodeURIComponent(rel)}`, sessionRef.current));
            await addImageFromDataUrl(dataUrl, rel.split('/').pop() || rel, false);
            setDockOpen('');
          } catch (e) {
            setError(String((e && e.message) || e));
          }
        }

        return { toggleRef, deleteSelected, reorderSelected, setImageFlag, setGeometry, renameImage, moveImageTo, alignSelected, clearMarks, clearCanvas, renderExportDataUrl, saveImageToWorkspace, saveSelectedToWorkspace, saveImageLayered, downloadImage, downloadSelected, copyImageToClipboard, importResult, openWorkspace, refreshWorkspace, pickWorkspace };
      }

      return { createImages };
    });
