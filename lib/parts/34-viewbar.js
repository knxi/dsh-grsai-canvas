/* 画布视图控制(右上角):缩小 / 百分比 / 放大 | 适应。
 *
 * 位置:顶部第一行的右端 —— 导航按钮(＋图片/工作区/Skills/记录/分层/放大/设置)是左对齐排的,
 * 右边这块一直空着,放这儿不挡任何按钮(同一行居中会撞上「设置」,所以不走居中)。
 * 比例读数原来在左下那条里,而且是个**裸数字**(`zoomLabel` 是数字 1、1.5,
 * 直接当子元素渲染出来就是 "1",不是百分比);现在整条搬上来,统一按百分比显示。
 * 缩放入口一直集中在这里(原来散在右上角那排里);空格拖拽平移、滚轮缩放仍在画布上直接用。
 *
 * 全局零件作用域里的 `h`/`S`/`line` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('viewbar', () => {
      /**
       * 当前倍数的百分比文本(整数;读不到就按 100%)。
       * @param {number} zoomLabel - 画布的 zoom。
       * @returns {string} 形如 `125%`。
       */
      function zoomText(zoomLabel) {
        const n = Number(zoomLabel);
        return `${Math.round((Number.isFinite(n) && n > 0 ? n : 1) * 100)}%`;
      }

      /**
       * 右上角那条:缩小 / 当前比例(点一下回 100%) / 放大 | 适应。
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderViewbar(p) {
        const { fitAll, zoomAtPoint, zoomTo, zoomLabel, size } = p;
        return h(
          'div',
          {
            style: Object.assign({}, S.float, {
              top: 6,
              right: 6,
              // 比顶部导航那行更靠上:右上角正好是它的空白区,顺手压住不被误挡
              zIndex: 6,
            }),
          },
          h(
            'div',
            { style: Object.assign({}, S.card, S.row, { padding: 4, gap: 2, alignItems: 'center' }) },
            h('button', { style: S.btn, title: '缩小', onClick: () => zoomAtPoint(size.w / 2, size.h / 2, 1 / 1.25) }, '－'),
            h(
              'button',
              {
                style: Object.assign({}, S.wideBtn, { minWidth: 58, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }),
                title: '当前视图比例 —— 点一下回到 100%',
                onClick: () => zoomTo(1),
              },
              zoomText(zoomLabel),
            ),
            h('button', { style: S.btn, title: '放大', onClick: () => zoomAtPoint(size.w / 2, size.h / 2, 1.25) }, '＋'),
            h('div', { style: { width: 1, alignSelf: 'stretch', background: line, margin: '4px 2px' } }),
            h('button', { style: S.wideBtn, title: '把所有图缩放到可见(0)', onClick: fitAll }, '适应'),
          ),
        );
      }

      return { renderViewbar };
    });
