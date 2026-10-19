/* 工作区内容块:列当前会话工作区里的图片(点一下放到画布)+ 保存路径输入框。
 *
 * 0.21 起本零件只出内容块(不带浮层外壳),装进右侧停靠区(36-dock)的「工作区」标签;
 * 开合由 `dockOpen` 控制,这里不再判断。
 *
 * 全局零件作用域里的 `h`/`S`/`stamp`/`humanSize` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('workspace-panel', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderWorkspacePanel(p) {
        const {
          pickWorkspace,
          refreshWorkspace,
          savePath,
          setSavePath,
          wsBusy,
          wsFiles,
        } = p;
        return h(
          'div',
          { style: Object.assign({}, S.col, { gap: 5 }) },
          h(
            'div',
            { style: S.row },
            wsBusy ? h('span', { style: S.hint }, '读取中…') : null,
            h('span', { style: S.grow }),
            h('button', { style: S.tiny, onClick: refreshWorkspace }, '刷新'),
          ),
          h(
            'div',
            { style: S.list },
            (wsFiles || []).length === 0
              ? h('div', { style: Object.assign({}, S.listRow, { cursor: 'default' }) }, wsBusy ? '读取中…' : '没找到图片文件')
              : wsFiles.map((file) =>
                  h(
                    'div',
                    { key: file.path, style: S.listRow, onClick: () => pickWorkspace(file.path), title: '点一下放到画布' },
                    h('span', { style: Object.assign({}, S.grow, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, file.path),
                    h('span', { style: S.hint }, humanSize(file.size)),
                  ),
                ),
          ),
          h('div', { style: S.row }, h('span', { style: S.hint }, '保存路径'), h('input', { id: 'grsai-save-path', style: Object.assign({}, S.input, S.grow), placeholder: `画布输出/grsai-${stamp()}.png`, value: savePath, onChange: (e) => setSavePath(e.target.value) })),
        );
      }

      return { renderWorkspacePanel };
    });
