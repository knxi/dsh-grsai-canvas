/* 图层面板(停靠区「图层」标签):紧凑列表 = 缩略图 / 名称 / 参考标记 / 显示 / 锁定。
 *
 * 顺序与 `doc.images` 数组一致:首行 = 最底层(画在最下面),末行 = 最顶层 ——
 * 和左侧工具栏那四个排序按钮(置顶/上移/下移/置底)共用同一套语义。
 *
 * 交互:点行 = 选中(与画布点选同步,Ctrl/Shift+点击 = 加选/减选);
 * 双击名称 = 重命名;拖动行 = 排序;行尾两个开关 = 显示 / 锁定(独立属性,旧图默认全关)。
 * 锁定的行不能拖动、改名,普通删除会跳过它 —— 「解锁」按钮就在行尾。
 *
 * 全局零件作用域里的 `h`/`S`/`line` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('layers-panel', () => {
      /** 拖动中的行 id(dragover/drop 之间传递;零件级变量,不进 React 状态)。 */
      let dragId = null;

      /** 一行的开关按钮:文字 + 提示 + 激活高亮。 */
      function flagBtn(p) {
        // 解构出来叫 isOn / flagText(不叫 active / label / caption):主组件 12-canvas-tab.js 里有
        // `const active = document.activeElement;`、参考图角标的 `const label = …`、占位框的
        // `const caption = …`,check-deps.mjs 按名字取交集,会把这里的 props 解构误判成
        // "引用了主组件的自由变量"并要求 deps 里也传它。改个不撞车的名字就绕开了。
        const { active: isOn, label: flagText, on, title } = p;
        return h(
          'button',
          {
            style: Object.assign({}, S.tiny, {
              width: 26,
              padding: '2px 0',
              textAlign: 'center',
            }, isOn ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null),
            title,
            onClick: on,
          },
          flagText,
        );
      }

      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderLayersPanel(p) {
        const {
          deleteSelected,
          images,
          layerRenameId,
          layerRenameText,
          moveImageTo,
          renameImage,
          selectImageFromPanel,
          setImageFlag,
          setLayerRenameId,
          setLayerRenameText,
          selectedId,
          selectedIds,
        } = p;

        if (!images.length) {
          return h('div', { style: Object.assign({}, S.hint, { padding: '6px 2px' }) },
            '画布上还没有图片 —— 用左上角「＋图片」加一张,加进来的图都会出现在这里。');
        }

        const picked = new Set(selectedIds.length ? selectedIds : selectedId ? [selectedId] : []);
        const rows = images.map((im, idx) => {
          const editing = layerRenameId === im.id;
          const isTop = idx === images.length - 1;
          const row = h(
            'div',
            {
              key: im.id,
              draggable: !editing && !im.locked,
              style: Object.assign({}, S.row, {
                alignItems: 'center',
                gap: 4,
                padding: '3px 4px',
                borderRadius: 4,
                cursor: 'default',
                border: picked.has(im.id) ? '1px solid var(--dsw-alias-label-primary, #3b82f6)' : '1px solid transparent',
                background: picked.has(im.id) ? 'rgba(59,130,246,0.08)' : 'transparent',
                opacity: im.hidden ? 0.55 : 1,
              }),
              title: im.locked ? '已锁定:可选中查看,不能拖动/缩放/标注/改名/删除(行尾可解锁)' : undefined,
              onDragStart: (event) => {
                dragId = im.id;
                if (event && event.dataTransfer) {
                  event.dataTransfer.effectAllowed = 'move';
                  try { event.dataTransfer.setData('text/plain', im.id); } catch { /* 老实现只读 */ }
                }
              },
              onDragOver: (event) => {
                if (!dragId || dragId === im.id) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
              },
              onDrop: (event) => {
                event.preventDefault();
                const moving = dragId;
                dragId = null;
                if (!moving || moving === im.id) return;
                // 行的上半 = 插到这张图前面;下半 = 插到下一张前面(末行下半 = 顶层)
                const half = (event && event.nativeEvent && typeof event.nativeEvent.offsetY === 'number' && event.currentTarget.getBoundingClientRect)
                  ? event.nativeEvent.offsetY - 0 < event.currentTarget.getBoundingClientRect().height / 2
                  : true;
                const beforeId = half ? im.id : (isTop ? null : images[idx + 1].id);
                moveImageTo(moving, beforeId);
              },
              onDragEnd: () => { dragId = null; },
              onClick: (event) => selectImageFromPanel(im.id, event),
            },
            // 缩略图
            h('img', {
              width: 34,
              height: 34,
              src: im.dataUrl,
              alt: im.name || '图片',
              draggable: false,
              style: { width: 34, height: 34, objectFit: 'cover', borderRadius: 3, background: 'rgba(127,127,127,0.2)', flex: '0 0 auto' },
            }),
            // 名称(双击改名)
            editing
              ? h('input', {
                id: 'grsai-layer-rename',
                  key: 'rename',
                  autoFocus: true,
                  style: Object.assign({}, S.input, { flex: '1 1 0', minWidth: 60, padding: '2px 4px' }),
                  value: layerRenameText,
                  title: '回车确认,Esc 取消',
                  onChange: (e) => setLayerRenameText(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                      renameImage(im.id, layerRenameText);
                      setLayerRenameId('');
                    } else if (e.key === 'Escape') {
                      setLayerRenameId('');
                    }
                  },
                  onBlur: () => {
                    renameImage(im.id, layerRenameText);
                    setLayerRenameId('');
                  },
                })
              : h('span', {
                  style: Object.assign({}, S.grow, {
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textDecoration: im.hidden ? 'line-through' : 'none',
                  }),
                  title: `${im.name}(${im.naturalW || im.w}×${im.naturalH || im.h})双击改名`,
                  onDoubleClick: () => { setLayerRenameId(im.id); setLayerRenameText(im.name || ''); },
                }, `${im.locked ? '🔒 ' : ''}${im.name || '(未命名)'}`),
            // 参考标记 + 开关
            im.isRef ? h('span', { style: Object.assign({}, S.badge, { flex: '0 0 auto' }), title: '参考图:提交时会一起发给模型(点「参」取消)' }, '参考') : null,
            flagBtn({
              label: '参',
              active: im.isRef,
              title: im.isRef ? '取消参考图标记(不再发给模型)' : '标记为参考图(提交时会一起发给模型)',
              on: () => setImageFlag(im.id, 'isRef', !im.isRef),
            }),
            flagBtn({
              label: im.hidden ? '显' : '隐',
              active: im.hidden,
              title: im.hidden ? '显示这张图(恢复绘制与命中)' : '隐藏这张图(不绘制、不参与命中与提交)',
              on: () => setImageFlag(im.id, 'hidden', !im.hidden),
            }),
            flagBtn({
              label: im.locked ? '已锁' : '锁',
              active: im.locked,
              title: im.locked ? '解锁(恢复拖动/缩放/标注/改名/删除)' : '锁定(防误改:不能拖动/缩放/标注/改名/删除)',
              on: () => setImageFlag(im.id, 'locked', !im.locked),
            }),
            h('button', {
              style: Object.assign({}, S.tiny, { width: 26, padding: '2px 0', textAlign: 'center', color: im.locked ? 'rgba(127,127,127,0.55)' : '#e5484d' }),
              title: im.locked ? '已锁定:删除会跳过这张图' : '删除这张图(可 Ctrl+Z 撤销)',
              onClick: () => {
                selectImageFromPanel(im.id, null);
                deleteSelected();
              },
            }, '删'),
          );
          return row;
        });

        return h(
          'div',
          { style: Object.assign({}, S.col, { gap: 2 }) },
          rows,
          h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
          h('div', { style: Object.assign({}, S.hint, { fontSize: 11 }) },
            '首行在最底层,末行在最顶层;拖动行排序(锁定行不能拖)。隐藏的图不绘制、点不到、也不参与提交;锁定的图防误改,但可以选中查看、照常导出。'),
        );
      }

      return { renderLayersPanel };
    });
