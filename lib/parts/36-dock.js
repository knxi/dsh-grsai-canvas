/* 受控停靠区(右侧):生成记录 / 图层 / 工作区 / Skills 四个标签共用一块面板。
 *
 * 同一时间只开一个标签(开合状态 `dockOpen` 在 CanvasTab 里,`togglePanel` 按簇分发);
 * 打开任何设置类弹层都会先把停靠区收起来。窄屏时占满除边距外的整行宽。
 *
 * 各标签的内容由调用处渲染好(「history-panel」「workspace-panel」「skills-panel」三个零件
 * 现在只出内容块,不再自带浮层外壳),这里只负责壳:标签栏 + 滚动区。
 *
 * 全局零件作用域里的 `h`/`S`/`line` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('dock', () => {
      /** 四个标签:开合值 + 按钮文案 + 角标取值器(可空)。 */
      const TABS = [
        { id: 'history', label: '记录', badge: (p) => (p.results.length ? String(p.results.length) : '') },
        { id: 'layers', label: '图层', badge: (p) => (p.images && p.images.length ? String(p.images.length) : '') },
        { id: 'workspace', label: '工作区', badge: (p) => (p.wsFiles && p.wsFiles.length ? String(p.wsFiles.length) : '') },
        { id: 'skills', label: 'Skills', badge: (p) => (p.skills && p.skills.length ? String(p.skills.length) : '') },
      ];
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderDock(p) {
        const {
          panelAnchor,
          dockOpen,
          historyPanel,
          images,
          layersPanel,
          results,
          setDockOpen,
          size,
          skills,
          skillsPanel,
          wsFiles,
          wsPanel,
        } = p;
        if (!dockOpen) return null;
        const narrow = size.w < 640;
        /** 悬停开的这块贴在按钮正下方(按自己的宽度往回收,别顶出右边界);窄屏整行宽,照旧靠右。 */
        const place = panelAnchor && !narrow
          ? { left: Math.max(6, Math.min(panelAnchor.left, panelAnchor.maxRight - 302)), right: 'auto', top: panelAnchor.top }
          : { right: 6, top: 42 };
        const body =
          dockOpen === 'history'
            ? historyPanel
            : dockOpen === 'layers'
              ? layersPanel
              : dockOpen === 'workspace'
                ? wsPanel
                : skillsPanel;
        return h(
          'div',
          {
            // 悬停联动用:鼠标落进这块面板就算「还没走」,收起倒计时作废
            'data-nav-keep': dockOpen,
            style: Object.assign({}, S.float, place, {
              width: narrow ? 'calc(100% - 12px)' : 302,
              maxHeight: 'calc(100% - 150px)',
            }),
          },
          h(
            'div',
            { style: Object.assign({}, S.card, S.col, { gap: 4, padding: 5, maxHeight: '100%', overflow: 'hidden' }) },
            h(
              'div',
              { style: S.row },
              TABS.map((tab) =>
                h(
                  'button',
                  {
                    key: tab.id,
                    style: Object.assign(
                      {},
                      S.wideBtn,
                      { flex: '1 1 0', padding: '5px 2px' },
                      dockOpen === tab.id
                        ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' }
                        : null,
                    ),
                    title: tab.id === 'layers' ? '图层:画布上所有图片的列表(显隐/锁定/排序/改名)' : `看${tab.label}`,
                    onClick: () => setDockOpen(dockOpen === tab.id ? '' : tab.id),
                  },
                  `${tab.label}${tab.badge({ images, results, skills, wsFiles }) ? ` ${tab.badge({ images, results, skills, wsFiles })}` : ''}`,
                ),
              ),
              h(
                'button',
                {
                  style: Object.assign({}, S.tiny, { flex: '0 0 auto', width: 24, padding: '2px 0', fontSize: 13 }),
                  title: '收起面板(鼠标移开也会自动收)',
                  onClick: () => setDockOpen(''),
                },
                '✕',
              ),
            ),
            h('div', { style: { height: 1, background: line, margin: '0 2px' } }),
            h(
              'div',
              { style: Object.assign({}, S.col, { gap: 5, overflowY: 'auto', minHeight: 60 }) },
              body,
            ),
          ),
        );
      }

      return { renderDock };
    });
