/* 尺寸菜单:点「尺寸」右边的 `▾` 弹出,按比例分组列全档位 + 常用成品尺寸快捷值。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`SOURCE_SIZE`/`SOURCE_TEXT`/`sizeMenuGroups`/`COMMON_OUTPUT_SIZES`/`convertSizeForModel` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('size-panel', () => {
      /**
       * 尺寸菜单(点「尺寸」右边的 ▾ 弹出)。
       *
       * 为什么也要自绘:原生 `<datalist>` 会拿输入框里已有的字过滤候选 —— 框里写着
       * 「原图比例」时下拉就只剩这一条,别的档位根本看不到(用户反馈"尺寸被固定了、
       * 没法指定")。这里按比例分组列全,并在顶部给「原图比例」「auto」和成品尺寸输入。
       */
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderSizePanel(p) {
        const {
          showSizes,
          setShowSizes,
          model,
          ratio,
          setRatio,
          setSizeDraft,
          setCustomSize,
          setNotice,
          dpi,
        } = p;
        return showSizes
          ? h(
              'div',
              {
                style: Object.assign({}, S.card, S.col, {
                  position: 'absolute',
                  right: 0,
                  bottom: 36,
                  width: 322,
                  maxWidth: '100%',
                  maxHeight: 'calc(100% - 44px)',
                  gap: 4,
                  zIndex: 8,
                }),
              },
              h(
                'div',
                { style: S.row },
                h('strong', { style: { fontSize: 12 } }, `尺寸(${model})`),
                h('span', { style: S.grow }),
                h('button', { style: S.tiny, onClick: () => setShowSizes(false) }, '✕'),
              ),
              h(
                'div',
                { style: S.list },
                h(
                  'div',
                  { style: S.listRow, onClick: () => { setRatio(SOURCE_SIZE); setSizeDraft(SOURCE_TEXT); setCustomSize(''); setShowSizes(false); } },
                  h('span', { style: S.grow }, '原图比例(跟随提交的那张图)'),
                  h('span', { style: S.hint }, ratio === SOURCE_SIZE ? '✓ 当前' : '默认'),
                ),
                h(
                  'div',
                  { style: S.listRow, onClick: () => { setRatio('auto'); setSizeDraft('auto'); setCustomSize(''); setShowSizes(false); } },
                  h('span', { style: S.grow }, 'auto(让上游自己定)'),
                  h('span', { style: S.hint }, ratio === 'auto' ? '✓ 当前' : ''),
                ),
                sizeMenuGroups(model).map((group) =>
                  h(
                    'div',
                    { key: `g-${group.title}` },
                    h('div', { style: Object.assign({}, S.hint, { padding: '4px 8px 0' }) }, group.title),
                    group.items.map((item) =>
                      h(
                        'div',
                        {
                          key: item.value,
                          style: Object.assign({}, S.listRow, item.value === ratio ? { background: 'rgba(59,130,246,0.14)' } : null),
                          onClick: () => {
                            setRatio(item.value);
                            setSizeDraft(item.value);
                            setCustomSize('');
                            setShowSizes(false);
                          },
                        },
                        h('span', { style: S.grow }, item.label),
                        h('span', { style: S.hint }, item.value === ratio ? '✓ 当前' : ''),
                      ),
                    ),
                  ),
                ),
              ),
              h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
              h('div', { style: S.hint }, '常用成品尺寸(点一下就填进「尺寸」框;上游按最近档位渲染,导出按这个尺寸本地缩放)'),
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                COMMON_OUTPUT_SIZES.map((preset) =>
                  h(
                    'button',
                    {
                      key: preset.value,
                      style: S.tiny,
                      title: `${preset.label} —— ${preset.note}`,
                      onClick: () => {
                        // 值可能是像素(1080x1440),也可能是实物尺寸(210x297mm)。
                        // 统一换算一次:存进 customSize 的一定是**像素** —— 下游(挑上游档位、本地精确缩放)不用改。
                        const conv = convertSizeForModel(model, preset.value, dpi);
                        if (conv && conv.mode === 'pixel') {
                          setCustomSize(conv.exact);
                          setNotice(conv.hint);
                        } else {
                          setCustomSize('');
                        }
                        setSizeDraft(preset.value);
                        setShowSizes(false);
                      },
                    },
                    preset.label,
                  ),
                ),
              ),
              h('div', { style: S.hint }, '也可以直接关掉菜单,在「尺寸」框里手写:1080x1440 / 3:4 / 竖版 / 小红书 / A4 — 插件会换算成上游认识的值'),
            )
          : null;

      }

      return { renderSizePanel };
    });
