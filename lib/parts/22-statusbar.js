/* 左下角状态栏:缩放比例 / 图片数 / 参考图数 / 保存时间 / 一句提示。
 *
 * 全局零件作用域里的 `h`/`S` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('statusbar', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderStatusBar(p) {
        const { zoomLabel, images, refCount, saved, notice } = p;

        return h(
          'div',
          { style: S.status },
          `${Math.round(zoomLabel * 100)}% · ${images.length} 图${refCount ? ` / ${refCount} 参考` : ''}${saved ? ` · ${saved}` : ''}`,
          notice ? `\n${notice}` : '',
        );
      }

      return { renderStatusBar };
    });
