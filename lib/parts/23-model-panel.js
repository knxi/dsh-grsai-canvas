/* 模型菜单:点模型右边的 `▾` 弹出,一次列全型号(自绘 —— 原生 `<datalist>` 会被框里已有的字过滤成一个)。
 *
 * 全局零件作用域里的 `h`/`S`/`MODEL_CHOICES` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('model-panel', () => {
      /**
       * 模型菜单(点模型右边的 ▾ 弹出,再点一次收起)。
       *
       * 为什么不用 `<datalist>`:浏览器会拿输入框里已有的文字去**过滤**候选,框里写着
       * `gpt-image-2-vip` 时下拉就只剩这一条 —— 看着像"模型表只剩一个了",想换别的
       * 得先把框里的字删掉。自绘菜单永远列全,而且标出每个模型认哪种尺寸格式。
       */
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderModelPanel(p) {
        const { showModels, setShowModels, model, setModel, modelsBusy, modelsNote, fetchModels } = p;
        return showModels
          ? h(
              'div',
              {
                style: Object.assign({}, S.card, S.col, {
                  position: 'absolute',
                  // 叠在生成卡片里、紧贴「生成」那排按钮上方:卡片本身一定在可视区内,
                  // 这样菜单不会被 root 的 overflow:hidden 裁掉(窗口矮的时候也不会)
                  right: 0,
                  bottom: 36,
                  width: 322,
                  maxWidth: '100%',
                  maxHeight: 'calc(100% - 44px)',
                  gap: 4,
                  zIndex: 7,
                }),
              },
              h(
                'div',
                { style: S.row },
                h('strong', { style: { fontSize: 12 } }, `模型(${MODEL_CHOICES.length})`),
                h('span', { style: S.grow }),
                h(
                  'button',
                  {
                    style: Object.assign({}, S.tiny, modelsBusy ? { opacity: 0.5 } : null),
                    disabled: Boolean(modelsBusy),
                    title: '读工作区的 画布/models.json;没有就让 DSH 里的 Agent 去查一份最新的',
                    onClick: () => { fetchModels(); },
                  },
                  modelsBusy ? '⟳ 查询中…' : '⟳ 获取新模型',
                ),
                h('button', { style: S.tiny, onClick: () => setShowModels(false) }, '✕'),
              ),
              modelsNote ? h('div', { style: S.hint }, modelsNote) : null,
              h(
                'div',
                { style: S.list },
                MODEL_CHOICES.map((item) =>
                  h(
                    'div',
                    {
                      key: item.id,
                      style: Object.assign({}, S.listRow, item.id === model ? { background: 'rgba(59,130,246,0.14)' } : null),
                      title: `用 ${item.id}(这个模型的尺寸要填${item.note})`,
                      onClick: () => {
                        setModel(item.id);
                        setShowModels(false);
                      },
                    },
                    h('span', { style: Object.assign({}, S.grow, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, item.label),
                    h('span', { style: S.hint }, item.id === model ? '✓ 当前' : item.note),
                  ),
                ),
              ),
              MODEL_CHOICES.some((item) => item.id === model)
                ? null
                : h('div', { style: S.hint }, `当前是手填的「${model}」,不在清单里 —— 照样能用,插件会原样发给上游`),
            )
          : null;

      }

      return { renderModelPanel };
    });
