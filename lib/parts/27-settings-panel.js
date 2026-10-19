/* 右上角「设置」面板:① APIKEY 与接口地址 ② 质量/背景/DPI/提示词同步 ③ 插件更新(检查/更新/回滚)④ 画布维护(保存/清空,破坏性操作放这里离生成主按钮远一点)+ 快捷键提示。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`LS_KEY`/`QUALITIES`/`BACKGROUNDS`/`MM_PER_INCH`/`DRAFT_REL`/`DEFAULT_API_BASE`/`DEFAULT_UPDATE_URL`/`writePrefs` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('settings-panel', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderSettingsPanel(p) {
        const {
          panelAnchor,
          apiBase,
          apikey,
          applyUpdateNow,
          background,
          baseDraft,
          canUpdate,
          checkUpdate,
          clearCanvas,
          dpi,
          dpiDraft,
          draftSync,
          hostFeatures,
          hostStale,
          keyDraft,
          quality,
          rollbackUpdateNow,
          saveNow,
          setApiBase,
          setApikey,
          setBackground,
          setBaseDraft,
          setDpiDraft,
          setDraftSync,
          setError,
          setKeyDraft,
          setNotice,
          setQuality,
          setUpdateAuto,
          setUpdateDraft,
          setUpdateNote,
          setUpdateUrl,
          showSettings,
          updateAuto,
          updateBusy,
          updateDraft,
          updateInfo,
          updateNote,
          updateStatus,
          updateUrl,
        } = p;
        /** 悬停开的贴在按钮正下方(按自己的宽度往回收);手点开的还是老位置靠右。 */
        const place = panelAnchor
          ? { left: Math.max(6, Math.min(panelAnchor.left, panelAnchor.maxRight - 300)), right: 'auto', top: panelAnchor.top }
          : { right: 6, top: 42 };
        return showSettings
          ? h(
              'div',
              {
                // 悬停联动用:鼠标落进这块面板就算「还没走」,收起倒计时作废
                'data-nav-keep': 'settings',
                style: Object.assign({}, S.float, place, { width: 300, maxWidth: 'calc(100% - 16px)' }),
              },
              h(
                'div',
                { style: Object.assign({}, S.card, S.col, { gap: 6 }) },
                h('div', { style: S.row }, h('strong', { style: { fontSize: 12 } }, '① GrsAI APIKEY'), h('span', { style: S.grow }), h('span', { style: S.hint }, apikey ? '已填写' : '还没填')),
                h(
                  'div',
                  { style: S.row },
                  h('input', {
                    id: 'grsai-apikey',
                    style: Object.assign({}, S.input, S.grow),
                    type: 'password',
                    placeholder: '粘贴 grsai.com 的 APIKEY',
                    value: keyDraft,
                    onChange: (e) => setKeyDraft(e.target.value),
                  }),
                  apikey
                    ? h(
                        'button',
                        {
                          style: S.tiny,
                          onClick: () => {
                            try {
                              localStorage.removeItem(LS_KEY);
                            } catch {
                              /* 忽略 */
                            }
                            setApikey('');
                            setKeyDraft('');
                          },
                        },
                        '清除',
                      )
                    : null,
                ),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, '② 接口地址'),
                  h('span', { style: S.grow }),
                  apiBase !== DEFAULT_API_BASE ? h('button', { style: S.tiny, title: `恢复默认 ${DEFAULT_API_BASE}`, onClick: () => { setApiBase(DEFAULT_API_BASE); setBaseDraft(DEFAULT_API_BASE); } }, '恢复默认') : null,
                ),
                h('input', {
                  id: 'grsai-api-base',
                  style: Object.assign({}, S.input, { width: '100%' }),
                  placeholder: DEFAULT_API_BASE,
                  value: baseDraft,
                  onChange: (e) => setBaseDraft(e.target.value),
                }),
                h('div', { style: S.hint }, `只填到域名(或带路径前缀)即可,插件会自己拼 /v1/api/generate 和 /v1/api/result。当前生效:${apiBase}`),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: S.wideBtn,
                      onClick: () => {
                        const nextKey = keyDraft.trim();
                        try {
                          if (nextKey) localStorage.setItem(LS_KEY, nextKey);
                          else localStorage.removeItem(LS_KEY);
                        } catch {
                          /* 忽略 */
                        }
                        let nextBase = baseDraft.trim() || DEFAULT_API_BASE;
                        if (!/^https?:\/\//i.test(nextBase)) nextBase = `https://${nextBase}`;
                        try {
                          nextBase = new URL(nextBase).origin + new URL(nextBase).pathname.replace(/\/+$/, '');
                        } catch {
                          setError(`接口地址不是合法 URL:${baseDraft.trim()}`);
                          return;
                        }
                        setApikey(nextKey);
                        setApiBase(nextBase);
                        setBaseDraft(nextBase);
                        setError('');
                        setNotice(`已保存:KEY ${nextKey ? '已填' : '为空'},接口 ${nextBase}`);
                      },
                    },
                    '保存设置',
                  ),
                  h('span', { style: S.grow }),
                  h('span', { style: S.hint }, 'KEY 与地址都只存本机浏览器'),
                ),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, '质量'),
                  h(
                    'select',
                    { id: 'grsai-quality-select', style: Object.assign({}, S.input, { maxWidth: 90 }), value: quality, onChange: (e) => setQuality(e.target.value) },
                    QUALITIES.map((q) => h('option', { key: q.id, value: q.id }, q.label)),
                  ),
                  h('span', { style: S.hint }, '背景'),
                  h(
                    'select',
                    { id: 'grsai-background-select', style: Object.assign({}, S.input, { maxWidth: 90 }), value: background, onChange: (e) => setBackground(e.target.value) },
                    BACKGROUNDS.map((b) => h('option', { key: b.id, value: b.id }, b.label)),
                  ),
                ),
                h('div', { style: S.hint }, '质量/背景只对 gpt-image 系有意义;分辨率只对 nano-banana 系有意义。'),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, 'DPI'),
                  h('input', {
                    id: 'grsai-dpi',
                    style: Object.assign({}, S.input, { maxWidth: 72 }),
                    type: 'number',
                    min: 36,
                    max: 2400,
                    step: 1,
                    value: dpiDraft,
                    title: '毫米 / 厘米 / 英寸 尺寸换算成像素的基准(印刷常用 300)',
                    onChange: (e) => setDpiDraft(e.target.value),
                    onBlur: () => setDpiDraft(String(dpi)),
                  }),
                  h(
                    'span',
                    { style: S.hint },
                    `「尺寸」框里写 210x297mm 时按这个换算 —— 现在 210x297mm → ${Math.round((210 * dpi) / MM_PER_INCH)}×${Math.round((297 * dpi) / MM_PER_INCH)} 像素`,
                  ),
                ),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, '同时生成'),
                  h('input', {
                    id: 'grsai-max-jobs',
                    style: Object.assign({}, S.input, { maxWidth: 56 }),
                    type: 'number',
                    min: 1,
                    max: MAX_CONCURRENT_JOBS_MAX,
                    step: 1,
                    // 非受控:它只影响队列放行速度,不值得为它多一个 state(每次改都要重渲染整块)
                    defaultValue: String(concurrencyLimit()),
                    title: `同时在跑的任务数(1–${MAX_CONCURRENT_JOBS_MAX})。调大更容易撞上游限流,而且几个任务就是几次真实扣费。`,
                    onBlur: (e) => {
                      const next = clampConcurrency(e.target.value);
                      e.target.value = String(next);
                      writePrefs({ maxJobs: next });
                      setNotice(`同时生成数已设为 ${next} 张`);
                    },
                  }),
                  h('span', { style: S.hint }, `张同时跑(1–${MAX_CONCURRENT_JOBS_MAX});多出来的排队,能单独打断`),
                ),
                h(
                  'label',
                  { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }) },
                  h('input', {
                    id: 'grsai-draft-sync',
                    type: 'checkbox',
                    checked: draftSync,
                    onChange: (e) => {
                      setDraftSync(e.target.checked);
                      writePrefs({ draftSync: e.target.checked });
                    },
                  }),
                  '把提示词同步到工作区(让对话里的 AI 能帮你检查漏写的要求)',
                ),
                h(
                  'div',
                  { style: S.hint },
                  draftSync
                    ? `已同步到 <工作区>/${DRAFT_REL} —— 只写文字(提示词、文字图层、标注类型),不含图片`
                    : '已关闭:对话里的 AI 读不到你在写的提示词',
                ),
                // ── 插件自我更新 ────────────────────────────────────────
                h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
                h(
                  'div',
                  { style: S.row },
                  h('strong', { style: { fontSize: 12 } }, '③ 插件更新'),
                  h('span', { style: S.grow }),
                  updateStatus && updateStatus.disk && updateStatus.disk !== updateStatus.loaded
                    ? h('span', { style: S.warn }, `已装 ${updateStatus.disk},等着重启`)
                    : h('span', { style: S.hint }, `当前 ${updateStatus ? updateStatus.disk || updateStatus.loaded : (hostFeatures ? '—' : '探测中')}`),
                ),
                updateStatus === null
                  ? h(
                      'div',
                      { style: S.hint },
                      hostFeatures === null
                        ? '正在问宿主版本…'
                        : canUpdate()
                          ? '点「检查更新」查看本机版本与可回滚的备份'
                          : '⚠ 宿主半边是旧版:更新按钮要重启一次 DSH 才会出现',
                    )
                  : h(
                      'div',
                      null,
                      h('input', {
                        id: 'grsai-update-url',
                        style: Object.assign({}, S.input, { width: '100%' }),
                        placeholder: `留空 = 用默认地址(${DEFAULT_UPDATE_URL})`,
                        value: updateDraft,
                        onChange: (e) => setUpdateDraft(e.target.value),
                      }),
                      h(
                        'div',
                        { style: S.hint },
                        updateUrl.trim()
                          ? `当前用你填的地址:${updateUrl.trim()}`
                          : `当前用默认地址(装好就能自动检测):${DEFAULT_UPDATE_URL}`,
                      ),
                      h(
                        'label',
                        { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }) },
                        h('input', {
                          id: 'grsai-update-auto',
                          type: 'checkbox',
                          checked: updateAuto,
                          onChange: (e) => {
                            setUpdateAuto(e.target.checked);
                            writePrefs({ updateAuto: e.target.checked });
                          },
                        }),
                        '启动时自动检查(只检查版本,绝不会自动安装;取消勾选就完全不联网)',
                      ),
                      h(
                        'div',
                        { style: S.row },
                        h(
                          'button',
                          {
                            style: S.tiny,
                            disabled: updateBusy === 'check',
                            onClick: () => {
                              const next = updateDraft.trim();
                              setUpdateUrl(next);
                              writePrefs({ updateUrl: next });
                              // 返回 promise:调用方(以及测试)能等到检查真正结束
                              return checkUpdate(false);
                            },
                          },
                          updateBusy === 'check' ? '检查中…' : '检查更新',
                        ),
                        updateInfo && updateInfo.newer
                          ? h('button', { style: S.primary, disabled: Boolean(updateBusy), onClick: applyUpdateNow }, updateBusy === 'apply' ? '更新中…' : `立即更新到 ${updateInfo.version}`)
                          : h(
                              'button',
                              {
                                style: Object.assign({}, S.tiny, updateBusy ? { opacity: 0.6 } : null),
                                disabled: Boolean(updateBusy),
                                title: '从上次更新前自动备份的那份恢复',
                                onClick: rollbackUpdateNow,
                              },
                              updateBusy === 'rollback' ? '回滚中…' : '回滚上一版',
                            ),
                        h('span', { style: S.grow }),
                        updateUrl.trim() && updateUrl.trim() !== DEFAULT_UPDATE_URL
                          ? h(
                              'button',
                              {
                                style: S.tiny,
                                title: `改回默认地址 ${DEFAULT_UPDATE_URL}`,
                                onClick: () => {
                                  setUpdateUrl('');
                                  setUpdateDraft('');
                                  writePrefs({ updateUrl: '' });
                                  setUpdateNote('已改回默认更新源');
                                },
                              },
                              '恢复默认',
                            )
                          : null,
                        updateStatus && updateStatus.dir
                          ? h('span', { style: S.hint, title: updateStatus.dir }, '装在哪:…' + String(updateStatus.dir).slice(-22))
                          : null,
                      ),
                      updateInfo && updateInfo.newer
                        ? h(
                            'div',
                            { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-label-primary, #3b82f6)' }) },
                            `有新版 ${updateInfo.version}(当前 ${updateInfo.current})${updateInfo.notes ? ` —— ${updateInfo.notes}` : ''}`,
                          )
                        : null,
                      updateNote ? h('div', { style: /失败/.test(updateNote) ? S.err : S.ok }, updateNote) : null,
                      h(
                        'div',
                        { style: S.hint },
                        '更新只从上面那个地址下载、校验 sha256、只写插件自己的目录,并先把旧文件备份成 update-backup/。',
                      ),
                      updateStatus && updateStatus.backups && updateStatus.backups.length
                        ? h('div', { style: S.hint }, `可回滚的版本:${updateStatus.backups.map((b) => b.version || b.id).join('、')}`)
                        : null,
                      h(
                        'div',
                        { style: S.hint },
                        '更新后:刷新页面即用上新客户端;**重启 DSH** 宿主才会换(双击桌面 `重启DSH.cmd`)。',
                      ),
                    ),
                h('div', { style: S.hint }, '快捷键:V/B/A/R/O/T/E 切工具,空格拖动,滚轮缩放,Ctrl+Z 撤销,Ctrl+C 复制选中图,0 适应,1 原大。'),
                // ── 画布维护(低频 + 破坏性,放最底下) ─────────────────────
                h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.tiny, hostStale ? { opacity: 0.4, cursor: 'default' } : null),
                      title: hostStale ? '宿主是旧版:没有画布存档接口(/state),重启一次 DSH 后才能保存' : '立即保存画布',
                      onClick: () => {
                        if (!hostStale) saveNow(false);
                      },
                    },
                    '保存画布',
                  ),
                  h(
                    'button',
                    {
                      style: S.tiny,
                      title: '清空整个画布(删除所有图片、标注与场景框,可用 Ctrl+Z 撤回一次)',
                      onClick: () => {
                        if (window.confirm('清空整个画布?所有图片、标注与场景框都会被删掉(撤回只剩一次机会)。')) clearCanvas();
                      },
                    },
                    '清空画布',
                  ),
                  h('span', { style: S.grow }),
                  h('span', { style: S.hint }, '低频维护'),
                ),
              ),
            )
          : null;
      }

      return { renderSettingsPanel };
    });
