/* 「图片分层(Agent)」的接口与密钥面板:右上角工具栏那颗「🔑 分层」开出来的独立浮层。
 *
 * 从「设置」里**拎出来**的:这条链路的 key 跟 GrsAI 那把不是同一个东西(它调的是 Seedream
 * 图层分解,一次返回逐层 PNG + 每层位置),混在一个面板里迟早搞混。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`LAYER_DEFAULT_BASE` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('layer-key-panel', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderLayerKeyPanel(p) {
        const {
          panelAnchor,
          clearLayerKey,
          fetchLayerModels,
          layerCfg,
          layerHostReady,
          layerModelsReady,
          saveLayerCfg,
          saveLayerModel,
          setLayerCfg,
          setShowLayerKey,
          showLayerKey,
          testLayerCfg,
        } = p;

        const busy = Boolean(layerCfg.busy);
        /**
         * 面板上真正列出来的模型。
         *
         * 宿主一次性把上游**全部**模型拿回来了(带 rank),所以「只看像的 / 显示全部」
         * 是纯本地切换 —— 切一次不会再打一次上游(上游限流很凶,连点两下就 429)。
         */
        const visibleModels = (layerCfg.models || []).filter((m) => layerCfg.modelsAll || m.rank > 0);
        /** 手写框里的原文(不 trim,免得打字时光标乱跳)与真正拿去保存的值。 */
        const draftRaw = String(layerCfg.modelDraft || '');
        const draft = draftRaw.trim();
        /** 宿主支不支持「取模型」——旧版没这条接口,提前把按钮灰掉并说明,别等点了才报"未知路由"。 */
        const modelsReady = Boolean(layerModelsReady);
        const state = !layerHostReady
          ? { text: '宿主旧版', style: S.hint }
          : layerCfg.hasKey
            ? { text: `已配置 ${layerCfg.masked}`, style: S.ok }
            : { text: '还没填', style: S.err };

        /** 悬停开的贴在按钮正下方(按自己的宽度往回收);手点开的还是老位置靠右。 */
        const place = panelAnchor
          ? { left: Math.max(6, Math.min(panelAnchor.left, panelAnchor.maxRight - 330)), right: 'auto', top: panelAnchor.top }
          : { right: 6, top: 42 };
        return showLayerKey
          ? h(
              'div',
              {
                // 悬停联动用:鼠标落进这块面板就算「还没走」,收起倒计时作废
                'data-nav-keep': 'layerkey',
                style: Object.assign({}, S.float, place, { width: 330, maxWidth: 'calc(100% - 16px)' }),
              },
              h(
                'div',
                { style: Object.assign({}, S.card, S.col, { gap: 6 }) },
                h(
                  'div',
                  { style: S.row },
                  h('strong', { style: { fontSize: 12 } }, '🔑 图片分层(Agent)'),
                  h('span', { style: S.grow }),
                  h('span', { style: state.style }, state.text),
                  h('button', { style: S.tiny, onClick: () => setShowLayerKey(false) }, '收起'),
                ),
                h(
                  'div',
                  { style: S.hint },
                  '画布 Skills 面板那颗「▶ 图片分层(交给 Agent)」用的接口与密钥 —— 它调的是 **Seedream 图层分解**(一次返回逐层透明 PNG + 每层位置),再由本地脚本按原位组装成可编辑 PSD。',
                ),
                h(
                  'div',
                  { style: S.hint },
                  '⚠ 和「设置」里那把 GrsAI 的 APIKEY **不是一个东西、不能互用**:GrsAI 那些型号(gpt-image / nano-banana)只出整图,没有图层分解接口。',
                ),
                !layerHostReady
                  ? h(
                      'div',
                      { style: S.err },
                      '宿主半边是旧版:这一项要**重启一次 DSH** 才能保存(双击桌面 `重启DSH.cmd`);客户端半边刷新页面即生效。',
                    )
                  : null,
                h('div', { style: S.hint }, '接口地址'),
                h('input', {
                  id: 'grsai-layer-base',
                  style: S.input,
                  placeholder: LAYER_DEFAULT_BASE,
                  value: layerCfg.base,
                  onChange: (e) => setLayerCfg(Object.assign({}, layerCfg, { base: e.target.value })),
                }),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: S.tiny,
                      title:
                        '换平台用的:图层分解各家路径不一样。默认提交 /v1/images/generations、查询 /v1/tasks;地址尾部带了 /v1 也不会被拼重',
                      onClick: () => setLayerCfg(Object.assign({}, layerCfg, { advanced: !layerCfg.advanced })),
                    },
                    layerCfg.advanced ? '▾ 端点路径(高级)' : '▸ 端点路径(高级)',
                  ),
                  h('span', { style: S.grow }),
                ),
                layerCfg.advanced
                  ? h(
                      'div',
                      { style: S.col },
                      h('div', { style: S.hint }, '提交端点(留空 = 用默认)'),
                      h('input', {
                        id: 'grsai-layer-submit',
                        style: S.input,
                        spellCheck: false,
                        autoComplete: 'off',
                        placeholder: layerCfg.defaultSubmitEndpoint || '/v1/images/generations',
                        value: layerCfg.submitEndpoint,
                        onChange: (e) => setLayerCfg(Object.assign({}, layerCfg, { submitEndpoint: e.target.value })),
                      }),
                      h('div', { style: S.hint }, '查询端点(留空 = 用默认;写 {id} 就按模板替换任务号,不写则自动补 /任务号)'),
                      h('input', {
                        id: 'grsai-layer-status',
                        style: S.input,
                        spellCheck: false,
                        autoComplete: 'off',
                        placeholder: layerCfg.defaultStatusEndpoint || '/v1/tasks',
                        value: layerCfg.statusEndpoint,
                        onChange: (e) => setLayerCfg(Object.assign({}, layerCfg, { statusEndpoint: e.target.value })),
                      }),
                      h(
                        'div',
                        { style: S.row },
                        h(
                          'button',
                          {
                            style: S.tiny,
                            title: '把这两格填回默认路径;再点「保存」就会覆盖配置里存的那两项',
                            onClick: () =>
                              setLayerCfg(
                                Object.assign({}, layerCfg, {
                                  submitEndpoint: layerCfg.defaultSubmitEndpoint || '/v1/images/generations',
                                  statusEndpoint: layerCfg.defaultStatusEndpoint || '/v1/tasks',
                                }),
                              ),
                          },
                          '用默认',
                        ),
                        h('span', { style: S.grow }),
                      ),
                      layerCfg.createUrl || layerCfg.statusUrl
                        ? h(
                            'div',
                            { style: S.hint },
                            `实际会打:${layerCfg.createUrl || '?'}\n轮询:${layerCfg.statusUrl || '?'}`,
                          )
                        : null,
                      layerCfg.modelsUrl ? h('div', { style: S.hint }, `测试连接会打:${layerCfg.modelsUrl}`) : null,
                      h(
                        'div',
                        { style: S.hint },
                        '地址尾部带不带 /v1 都行(拼的时候重复的 /v1 只留一段);端点也能直接写完整 URL,跨域名中转照样用。改完点「保存」。',
                      ),
                    )
                  : null,
                h('div', { style: S.hint }, layerCfg.hasKey ? 'API Key(已保存;填新的即覆盖,留空则不改)' : 'API Key'),
                h(
                  'div',
                  { style: S.row },
                  h('input', {
                    id: 'grsai-layer-token',
                    style: Object.assign({}, S.input, S.grow),
                    type: 'password',
                    autoComplete: 'off',
                    placeholder: layerCfg.hasKey ? '留空则保持已保存的 key' : '粘贴分层服务的 API Key',
                    value: layerCfg.key,
                    onChange: (e) => setLayerCfg(Object.assign({}, layerCfg, { key: e.target.value })),
                  }),
                  layerCfg.hasKey
                    ? h('button', { style: S.tiny, title: '清掉本机保存的分层密钥(地址留着)', onClick: clearLayerKey }, '清除')
                    : null,
                ),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.wideBtn, busy ? { opacity: 0.6 } : null),
                      disabled: busy || !layerHostReady,
                      onClick: saveLayerCfg,
                    },
                    layerCfg.busy === 'save' ? '保存中…' : '保存',
                  ),
                  h('span', { style: S.grow }),
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.tiny, busy || !layerHostReady || !layerCfg.hasKey ? { opacity: 0.6 } : null),
                      disabled: busy || !layerHostReady || !layerCfg.hasKey,
                      title: !layerHostReady ? '宿主是旧版:重启一次 DSH 后才能测试(接口 /layering-test 不在旧宿主能力清单里)' : '只 GET 一次 /v1/models 探连通性,不产生生成费用',
                      onClick: testLayerCfg,
                    },
                    layerCfg.busy === 'test' ? '测试中…' : '测试连接',
                  ),
                ),
                h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
                h('div', { style: S.hint }, '模型 ID(可以点下面的清单选一个,也可以自己写 —— 两边走的是同一条保存)'),
                h(
                  'div',
                  { style: S.row },
                  h('input', {
                    id: 'grsai-layer-model',
                    style: Object.assign({}, S.input, S.grow),
                    type: 'text',
                    spellCheck: false,
                    autoComplete: 'off',
                    placeholder: `例如 ${layerCfg.defaultModel || '上游文档里写的模型名'}`,
                    value: draftRaw,
                    disabled: busy || !layerHostReady,
                    onChange: (e) => setLayerCfg(Object.assign({}, layerCfg, { modelDraft: e.target.value })),
                    onKeyDown: (e) => {
                      // 回车即存:手写模型的常见用法是"粘上 → 回车",别逼人去点按钮
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveLayerModel(draft);
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.tiny, busy || !layerHostReady || !draft ? { opacity: 0.6 } : null),
                      disabled: busy || !layerHostReady || !draft,
                      title: '把这一格里的模型名写进技能配置(apimart_config.json 的 model)',
                      onClick: () => saveLayerModel(draft),
                    },
                    layerCfg.busy === 'model' ? '保存中…' : '保存此 ID',
                  ),
                ),
                h(
                  'div',
                  { style: S.hint },
                  `技能配置里现在存的是:${layerCfg.model || `(空 —— 跑起来会兜底用 ${layerCfg.defaultModel || '宿主默认模型'})`}`,
                ),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.tiny, busy || !layerCfg.hasKey || !modelsReady ? { opacity: 0.6 } : null),
                      disabled: busy || !layerCfg.hasKey || !modelsReady,
                      title: !modelsReady
                        ? '宿主半边是旧版(这条接口 0.19.6 才有)—— 重启一次 DSH 后可用'
                        : '拉一次上游的模型清单,挑出像「图层分解」的那些(只读,不产生费用)',
                      onClick: () => fetchLayerModels(false),
                    },
                    layerCfg.busy === 'models' ? '取模型中…' : '🔍 取可用模型',
                  ),
                  (layerCfg.models || []).length
                    ? h(
                        'button',
                        {
                          style: S.tiny,
                          disabled: busy,
                          title: '上游模型动辄几百个,默认只列像图层分解的;切换是本地过滤,不会再去问上游',
                          onClick: () => setLayerCfg(Object.assign({}, layerCfg, { modelsAll: !layerCfg.modelsAll })),
                        },
                        layerCfg.modelsAll ? '只看像的' : `显示全部(${(layerCfg.models || []).length})`,
                      )
                    : null,
                  h('span', { style: S.grow }),
                ),
                !modelsReady
                  ? h(
                      'div',
                      { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                      '⚠ 宿主半边是旧版:重启一次 DSH 之后才能「取可用模型」。',
                    )
                  : null,
                visibleModels.length
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 170, overflowY: 'auto', padding: '2px 0' } },
                      visibleModels.map((m) =>
                        h(
                          'button',
                          {
                            key: m.id,
                            style: Object.assign({}, S.tiny, {
                              textAlign: 'left',
                              wordBreak: 'break-all',
                              // ⚠ 两态都必须给**完整的 border**:本插件的样式 diff 不会清除"这次没有的 key",
                              // 只给颜色的话取消选中会留下一个空心黑框(工具栏那个老毛病)。
                              border:
                                layerCfg.model === m.id
                                  ? '1px solid var(--dsw-alias-label-primary, #3b82f6)'
                                  : '1px solid transparent',
                              background: 'transparent',
                              color: layerCfg.model === m.id ? 'var(--dsw-alias-label-primary, #3b82f6)' : label2,
                            }),
                            title: m.hint || m.id,
                            disabled: busy,
                            onClick: () => saveLayerModel(m.id),
                          },
                          `${layerCfg.model === m.id ? '● ' : '○ '}${m.id}`,
                          m.hint ? h('span', { style: { opacity: 0.6 } }, `  ·  ${m.hint}`) : null,
                        ),
                      ),
                    )
                  : null,
                layerCfg.note
                  ? h('div', { style: /失败|拒绝|连不上|没找到/.test(layerCfg.note) ? S.err : S.hint }, layerCfg.note)
                  : null,
                layerCfg.dir && layerHostReady
                  ? h('div', { style: S.hint }, `写入:${layerCfg.dir}\\config\\apimart_config.json(写在技能自己目录里,随技能走)`)
                  : null,
                h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
                h(
                  'div',
                  { style: S.hint },
                  '去哪拿:api.apimart.ai 注册后建 key。按张计费(1K 分层约 $0.0146、2K 分层约 $0.0293),1 美元起充、没有免费额度。',
                ),
                h('div', { style: S.hint }, '密钥只写不读:存好后这里只显示掩码,读接口也从不回原文。'),
              ),
            )
          : null;
      }

      return { renderLayerKeyPanel };
    });
