/* 左侧工具栏:工具按钮 + 撤销/重做/清空标注 + 颜色 + 粗细滑杆。
 *
 * 全局零件作用域里的 `h`/`S`/`TOOLS`/`TOOL_ICONS`/`COLORS`/`line` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('toolbar', () => {
      /** 图层顺序四个按钮(从上到下):图标 + 提示。排在后面的画在上面,所以「上移」= 在数组里往后挪一格。 */
      const LAYER_MOVES = [
        { dir: 'top', label: '置顶(画在最上面)', d: 'M11 17V8M6 13l5-5 5 5M5 4h12' },
        { dir: 'up', label: '上移一层', d: 'M11 18V7M6 12l5-5 5 5' },
        { dir: 'down', label: '下移一层', d: 'M11 4v11M6 10l5 5 5-5' },
        { dir: 'bottom', label: '置底(画在最下面)', d: 'M11 5v9M6 9l5 5 5-5M5 18h12' },
      ];
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderToolbar(p) {
        const {
          tool,
          chooseTool,
          undo,
          redo,
          clearMarks,
          color,
          setColor,
          markWidth,
          setMarkWidth,
          selected,
          reorderSelected,
        } = p;

        return h(
          'div',
          {
            style: Object.assign({}, S.float, S.col, {
              left: 6,
              top: 42,
              maxHeight: 'calc(100% - 100px)',
              overflowY: 'auto',
              overflowX: 'hidden',
              paddingRight: 1,
            }),
          },
          h(
            'div',
            { style: Object.assign({}, S.card, S.col, { padding: 4, gap: 2 }) },
            TOOLS.map((t) =>
              h(
                'button',
                {
                  key: t.id,
                  style: Object.assign({}, S.btn, tool === t.id ? S.btnOn : null),
                  title: `${t.label}(${t.key})`,
                  // 顺手 blur:点过的按钮若留着焦点,DSH 给按钮的全局样式会在它上面
                  // 再叠一层背景,看起来就像"上一个工具的选中框没消掉"。
                  onClick: (event) => {
                    chooseTool(t.id);
                    if (event && event.currentTarget && typeof event.currentTarget.blur === 'function') {
                      event.currentTarget.blur();
                    }
                  },
                },
                h(
                  'svg',
                  { width: 18, height: 18, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
                  h('path', { d: TOOL_ICONS[t.id] }),
                ),
              ),
            ),
            h('div', { style: { height: 1, background: line, margin: '3px 2px' } }),
            h(
              'button',
              { style: S.btn, title: '撤销(Ctrl+Z)', onClick: undo },
              h('svg', { width: 18, height: 18, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }, h('path', { d: 'M7 8H14a4.5 4.5 0 010 9H9M7 8l3-3M7 8l3 3' })),
            ),
            h(
              'button',
              { style: S.btn, title: '重做(Ctrl+Shift+Z)', onClick: redo },
              h('svg', { width: 18, height: 18, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }, h('path', { d: 'M15 8H8a4.5 4.5 0 000 9h5M15 8l-3-3M15 8l-3 3' })),
            ),
            h(
              'button',
              { style: S.btn, title: '清空这张图的标注', onClick: clearMarks },
              h('svg', { width: 18, height: 18, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }, h('path', { d: 'M4 6h14M8 6V4h6v2M6 6l1 12h8l1-12' })),
            ),
            h('div', { style: { height: 1, background: line, margin: '3px 2px' } }),
            // 图层顺序:排在后面的画在上面。没选中图片时先灰掉,免得点了没反应
            LAYER_MOVES.map((mv) =>
              h(
                'button',
                {
                  key: mv.dir,
                  style: Object.assign({}, S.btn, selected ? null : { opacity: 0.35, cursor: 'default' }),
                  title: mv.label,
                  onClick: () => {
                    if (selected) reorderSelected(mv.dir);
                  },
                },
                h(
                  'svg',
                  { width: 18, height: 18, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
                  h('path', { d: mv.d }),
                ),
              ),
            ),
            h('div', { style: { height: 1, background: line, margin: '3px 2px' } }),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center', padding: '2px 0' } },
              COLORS.map((c) =>
                h('button', {
                  key: c,
                  title: c,
                  style: Object.assign({}, S.btn, {
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    background: c,
                    border: color === c ? '2px solid var(--dsw-alias-label-primary, #3b82f6)' : '1px solid rgba(127,127,127,0.6)',
                  }),
                  onClick: () => setColor(c),
                }),
              ),
              h('input', {
                id: 'grsai-tool-markwidth',
                type: 'range',
                min: 2,
                max: 40,
                value: markWidth,
                title: `粗细 ${markWidth}px`,
                style: { width: 26, height: 60, writingMode: 'vertical-lr', direction: 'rtl' },
                onChange: (e) => setMarkWidth(Number(e.target.value)),
              }),
            ),
          ),
        );
      }

      return { renderToolbar };
    });
