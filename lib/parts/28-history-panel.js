/* 生成记录面板(第一期 A):持久化记录的浏览/筛选/收藏/删除/清空/恢复参数/放回画布/下载。
 *
 * 改造前这里只显示本次会话的结果(刷新即失);现在列表来自持久记录(存工作区,
 * 刷新/重开都在),搜索、收藏过滤、分页、完整提示词与参数快照都在这一屏。
 *
 * 缺字段显示「—」:旧记录(或资源没存上的记录)本来就缺这些信息,不编造。
 * 面板本体是停靠区(dock)的一个标签页内容,自己不带外壳。
 */
    definePart('history-panel', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns {any} 面板内容(虚拟 DOM)。
       */
      function renderHistoryPanel(p) {
        const {
          S,
          clearRecords,
          compareRecord,
          downloadRecordImage,
          historyCorrupted,
          historyFavOnly,
          historyHostReady,
          historyLimit,
          historyOpenId,
          historyQuery,
          placeRecordImage,
          records,
          removeRecord,
          restoreRecordParams,
          sessionId,
          setHistoryFavOnly,
          setHistoryLimit,
          setHistoryOpenId,
          setHistoryQuery,
          toggleRecordFav,
        } = p;

        const query = historyQuery.trim().toLowerCase();
        const filtered = records.filter((record) => {
          if (historyFavOnly && !record.fav) return false;
          if (!query) return true;
          const hay = [record.promptUser, record.promptFinal, record.model, record.sourceName]
            .map((value) => String(value || '').toLowerCase())
            .join('\n');
          return hay.includes(query);
        });
        const shown = filtered.slice(0, historyLimit);
        const favCount = records.filter((item) => item.fav).length;

        /** 时间列:缺 at 就如实显示「—」。 */
        const fmtTime = (at) => {
          const n = Number(at);
          if (!n) return '—';
          const d = new Date(n);
          const sameDay = new Date().toDateString() === d.toDateString();
          const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
        };
        /** 尺寸列:优先实际宽高,没有再退回提交时的尺寸意图。 */
        const fmtSize = (record) => {
          if (Number(record.w) > 0 && Number(record.h) > 0) return `${record.w}×${record.h}`;
          if (record.exactSize) return String(record.exactSize);
          if (record.ratio) return String(record.ratio);
          return '—';
        };
        const fmtDim = (value) => (Number(value) > 0 ? String(Number(value)) : '—');
        /** 缩略图地址:本地文件优先;没存上的用来源链接;都没有就占位。 */
        const thumbSrc = (record) => {
          if (record.file) return routeUrl(`/ws-file?path=${encodeURIComponent(record.file)}`, p.sessionId);
          if (record.sourceUrl) return record.sourceUrl;
          return '';
        };

        const rows = shown.map((record) => {
          const open = historyOpenId === record.id;
          const src = thumbSrc(record);
          const prompt = record.promptUser || record.promptFinal || '';
          const paramRows = [
            ['模型', record.model],
            ['比例', record.ratio],
            ['质量', record.quality],
            ['背景', record.background],
            ['imageSize', record.imageSize],
            ['成品尺寸', record.exactSize],
            ['来源图', record.sourceName],
            ['参考图', Number(record.refCount) > 0 ? `${record.refCount} 张${Array.isArray(record.refNames) && record.refNames.length ? `(${record.refNames.join('、')})` : ''}` : ''],
            ['标注', fmtDim(record.marksCount)],
            ['文字层', fmtDim(record.textsCount)],
            ['裁剪提交', record.cropped ? '是' : record.cropped === false ? '否' : ''],
          ];
          return h('div', { key: record.id, style: Object.assign({}, S.listRow, { flexDirection: 'column', alignItems: 'stretch', gap: 4, cursor: 'pointer' }) },
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' }, onClick: () => setHistoryOpenId(open ? '' : record.id) },
              src
                ? h('img', { id: 'grsai-history-thumb-' + record.id, width: 46, height: 46, alt: '历史记录缩略图', src, style: { width: 46, height: 46, objectFit: 'cover', borderRadius: 4, border: '1px solid ' + S.token.line, flex: '0 0 auto', background: '#f5f5f5' } })
                : h('div', { style: { width: 46, height: 46, borderRadius: 4, border: '1px dashed ' + S.token.line, flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: S.token.label2 } }, '无图'),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: 11, color: S.token.label } },
                  `${fmtTime(record.at)} · ${record.model || '—'} · ${fmtSize(record)}`,
                  record.file ? '' : record.sourceUrl ? ' · ⚠ 未持久化' : ' · ⚠ 无图',
                ),
                h('div', { style: { fontSize: 11, color: S.token.label2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  prompt ? prompt.trim().split('\n').join(' ').slice(0, 80) : '(这条记录没存提示词)',
                ),
              ),
              h('button', {
                title: record.fav ? '取消收藏' : '收藏',
                onClick: (e) => { e.stopPropagation(); toggleRecordFav(record.id); },
                style: Object.assign({}, S.btn, { flex: '0 0 auto', color: record.fav ? '#d97706' : S.token.label2 }),
              }, record.fav ? '★' : '☆'),
            ),
            open && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, borderTop: '1px solid ' + S.token.line, paddingTop: 5 } },
              h('div', { style: { fontSize: 11, color: S.token.label, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 140, overflowY: 'auto', background: 'rgba(127,127,127,0.08)', borderRadius: 4, padding: '5px 6px' } },
                record.promptFinal || record.promptUser || '(这条记录没存提示词)',
              ),
              h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
                h('button', {
                  title: '把最终提交的提示词(含模板与标注说明)复制到剪贴板',
                  onClick: async (e) => {
                    e.stopPropagation();
                    try {
                      await navigator.clipboard.writeText(record.promptFinal || record.promptUser || '');
                      e.target.textContent = '已复制';
                      setTimeout(() => { if (e.target) e.target.textContent = '复制提示词'; }, 1200);
                    } catch { /* 剪贴板不可用时静默:文本就在上面,可手动选 */ }
                  },
                  style: S.btn,
                }, '复制提示词'),
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px', fontSize: 11, color: S.token.label2 } },
                paramRows.map(([label, value]) => h('div', { key: label },
                  h('span', { style: { color: S.token.label } }, `${label}:`),
                  ' ',
                  value ? String(value) : '—',
                )),
              ),
              h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
                h('button', { title: '把当时的参数与提示词回填到生成区(只回填,不自动生成)', onClick: () => restoreRecordParams(record, false), style: S.btn }, '恢复参数'),
                h('button', { title: '独立模式:不挂模板,直接用当时提交的完整提示词', onClick: () => restoreRecordParams(record, true), style: S.btn }, '仅最终提示词'),
                h('button', { title: '与画布上的来源图对比(来源图不在画布上会提示)', onClick: () => compareRecord(record), style: S.btn }, '对比'),
                h('button', { title: '把这张结果图放回画布', onClick: () => placeRecordImage(record), style: S.btn }, '放入画布'),
                h('button', { title: '下载这张结果图', onClick: () => downloadRecordImage(record), style: S.btn }, '下载'),
                h('button', { title: '从记录里删除(不碰画布与工作区文件)', onClick: () => removeRecord(record.id), style: S.btn }, '删除'),
              ),
            ),
          );
        });

        return h('div', { style: Object.assign({}, S.col, { gap: 6 }) },
          // ── 顶栏:搜索 / 收藏过滤 / 清空 ──
          h('div', { style: { display: 'flex', gap: 5, alignItems: 'center' } },
            h('input', {
              id: 'grsai-history-search',
              value: historyQuery,
              placeholder: '搜提示词 / 模型 / 来源图',
              onChange: (e) => { setHistoryQuery(e.target.value); setHistoryLimit(20); },
              style: Object.assign({}, S.input, { flex: 1, minWidth: 0 }),
            }),
            h('label', { title: '只看收藏', style: { display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: S.token.label2, flex: '0 0 auto' } },
              h('input', { id: 'grsai-history-fav-only', type: 'checkbox', checked: historyFavOnly, onChange: (e) => setHistoryFavOnly(e.target.checked) }),
              '★',
            ),
            h('button', {
              title: `清空全部记录${favCount ? `(含收藏 ${favCount} 条)` : ''}(需确认;不碰画布与工作区文件)`,
              disabled: !records.length,
              onClick: clearRecords,
              style: Object.assign({}, S.btn, !records.length ? { opacity: 0.4 } : null),
            }, '清空'),
          ),
          // ── 状态行:持久化能力 / 损坏警示 ──
          !historyHostReady && h('div', { style: { fontSize: 11, color: '#b45309' } },
            '宿主是旧版:生成记录只在当前页面有效,重启一次 DSH 后才会自动存进工作区'),
          historyHostReady && historyCorrupted && h('div', { style: { fontSize: 11, color: '#b45309' } },
            '⚠ 清单文件损坏(按空载入)。保存新变化前会先向你确认覆盖;旧内容无法找回'),
          // ── 列表 ──
          !records.length && h('div', { style: { fontSize: 11, color: S.token.label2, padding: '6px 0' } },
            historyHostReady
              ? '还没有生成记录 —— 每次生成成功都会自动记一条(缩略图、参数、提示词),存进工作区,重开画布还在'
              : '还没有生成记录'),
          !!records.length && !filtered.length && h('div', { style: { fontSize: 11, color: S.token.label2, padding: '6px 0' } },
            '没有匹配的记录(换个关键词,或取消「只看收藏」)'),
          rows,
          // ── 分页(有界加载)──
          filtered.length > shown.length && h('button', {
            onClick: () => setHistoryLimit(historyLimit + 20),
            style: Object.assign({}, S.btn, S.wideBtn),
          }, `显示更多(已显示 ${shown.length}/${filtered.length})`),
          !!filtered.length && h('div', { style: { fontSize: 10, color: S.token.label2 } },
            `共 ${records.length} 条${favCount ? `(收藏 ${favCount})` : ''} · 上限 400 条,超出时丢最旧、收藏优先保留`),
        );
      }

      return { renderHistoryPanel };
    });
