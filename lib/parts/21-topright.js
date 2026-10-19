/* 顶部导航(一行):加图 / 工作区 / Skills / 记录 / 分层接口 / 放大 / 设置(带更新角标)+ 隐藏的文件选择框 + 弹成浮窗。
 *
 * 视图控制(适应/100%/±)已挪到左下 34-viewbar;记录/工作区/Skills 三个入口开的是右侧停靠区(36-dock)的标签。
 *
 * 全局零件作用域里的 `h`/`S`/`line` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('topright', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderTopRight(p) {
        const {
          fileRef,
          addFiles,
          openWorkspace,
          togglePanel,
          dockOpen,
          activeSkill,
          actionsRef,
          apikey,
          layerCfg,
          layerHostReady,
          updateAvailable,
          updateInfo,
          upscaleHostReady,
          upscaleTiers,
          upscaleBusy,
        } = p;

        /** 顶导航按钮:当前停靠区标签或弹层开着时描蓝边,让「现在开的是哪块」一眼可见。 */
        const navBtn = (extra, on) => Object.assign({}, S.wideBtn, on ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null, extra || null);

        return h(
          'div',
          {
            style: Object.assign({}, S.float, S.row, {
              left: 6,
              right: 6,
              top: 6,
              // 整条导航按钮居中排(原来的 flex-start 全挤在左边,右边空一大片)
              justifyContent: 'center',
              flexWrap: 'wrap',
            }),
          },
          h(
            'div',
            {
              style: Object.assign({}, S.card, S.row, {
                padding: 4,
                maxWidth: '100%',
                flexWrap: 'wrap',
              }),
            },
            h('button', { style: S.wideBtn, title: '加入图片文件', onClick: () => fileRef.current && fileRef.current.click() }, '＋图片'),
            h('button', { style: navBtn(null, dockOpen === 'workspace'), 'data-nav-panel': 'workspace', title: '从工作区挑一张', onClick: () => { openWorkspace(); } }, '工作区'),
            h(
              'button',
              {
                style: navBtn(null, dockOpen === 'skills' || Boolean(activeSkill)),
                'data-nav-panel': 'skills',
                title: activeSkill ? `Skills 模板:已选「${activeSkill.name}」` : 'Skills 模板:证件照、抠图、换背景…(可自建)',
                onClick: () => togglePanel('skills'),
              },
              activeSkill ? `Skills·${activeSkill.name.length > 6 ? `${activeSkill.name.slice(0, 6)}…` : activeSkill.name}` : 'Skills',
            ),
            h('button', { style: navBtn(null, dockOpen === 'history'), 'data-nav-panel': 'history', title: '生成记录', onClick: () => togglePanel('history') }, '记录'),
            h('div', { style: { width: 1, alignSelf: 'stretch', background: line, margin: '4px 3px' } }),
            h(
              'button',
              {
                'data-nav-panel': 'layerkey',
                style: Object.assign(
                  {},
                  S.wideBtn,
                  layerHostReady && layerCfg.hasKey
                    ? null
                    : { border: '1px solid var(--dsw-alias-state-warn-label, #b7791f)', color: 'var(--dsw-alias-state-warn-label, #b7791f)' },
                ),
                title: !layerHostReady
                  ? '图片分层(Agent)接口:宿主半边是旧版,重启一次 DSH 后可用'
                  : layerCfg.hasKey
                    ? `图片分层(Agent)接口:已配置 ${layerCfg.masked} —— 点这里改地址 / 换 key`
                    : '图片分层(Agent)还没配接口和 key —— 点这里填(和 GrsAI 那把不是同一个)',
                onClick: () => togglePanel('layerkey'),
              },
              layerCfg.hasKey ? '🔑 分层' : '🔑 分层·未配',
            ),
            h(
              'button',
              {
                'data-nav-panel': 'upscale',
                style: Object.assign(
                  {},
                  S.wideBtn,
                  upscaleHostReady
                    ? null
                    : { border: '1px solid var(--dsw-alias-state-warn-label, #b7791f)', color: 'var(--dsw-alias-state-warn-label, #b7791f)' },
                ),
                title: !upscaleHostReady
                  ? 'AI 高清放大:宿主半边是旧版,重启一次 DSH 后可用'
                  : (upscaleTiers || []).some((t) => t.ready)
                    ? 'AI 高清放大 —— 用本机显卡,不联网、不花 API 额度'
                    : 'AI 高清放大 —— 还没下引擎(第一次约 7 MB,之后离线可用)',
                onClick: () => togglePanel('upscale'),
              },
              upscaleBusy ? '⬆ 放大中…' : '⬆ 放大',
            ),
            h('div', { style: { width: 1, alignSelf: 'stretch', background: line, margin: '4px 3px' } }),
            h('button', { style: S.btn, title: '弹成浮动面板(可拉大)', onClick: () => actionsRef.current.popOut && actionsRef.current.popOut() }, h('svg', { width: 17, height: 17, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }, h('path', { d: 'M13 4h5v5M18 4l-6 6M9 18H4v-5M4 18l6-6' }))),
            h(
              'button',
              {
                'data-nav-panel': 'settings',
                style: Object.assign(
                  {},
                  S.wideBtn,
                  apikey ? null : { border: '1px solid var(--dsw-alias-state-warn-label, #b7791f)', color: 'var(--dsw-alias-state-warn-label, #b7791f)' },
                  updateAvailable ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null,
                ),
                title: updateAvailable
                  ? `插件有新版本 ${updateInfo.version}(当前 ${updateInfo.current})——点这里去更新`
                  : apikey
                    ? '设置:APIKEY / 接口地址 / 参数 / 插件更新'
                    : '还没填 APIKEY —— 点这里填',
                onClick: () => togglePanel('settings'),
              },
              updateAvailable ? `设置 ⬆${updateInfo.version}` : apikey ? '设置' : '填 APIKEY',
            ),
            h('input', {
              id: 'grsai-file-import',
              ref: fileRef,
              type: 'file',
              accept: 'image/*',
              multiple: true,
              style: { display: 'none' },
              onChange: (event) => {
                addFiles(event.target.files, false);
                event.target.value = '';
              },
            }),
          ),
        );
      }

      return { renderTopRight };
    });
