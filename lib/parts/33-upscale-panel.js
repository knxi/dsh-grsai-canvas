/* 「AI 高清放大」面板:右上角那颗「⬆ 放大」开出来的独立浮层。
 *
 * 这条链路和云端模型无关 —— 由宿主进程调用本机的 realesrgan 引擎,在**你自己的显卡**上跑:
 * 图片不出本机、不花任何 API 额度、断网也能用。引擎不随插件打包(会从 386 KB 涨到几十 MB),
 * 第一次点「下载引擎」时才从发布点拉下来,之后离线可用。
 *
 * 样式上刻意**不用实线描边**:面板里按钮多,一排深色边框在浅色卡片上会糊成一片"黑框",
 * 所以这里一律用「透明底 → 选中/主操作用淡背景」来表达,深浅主题都不会突兀。
 *
 * 依赖由调用处经 `p` 注入(调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('upscale-panel', () => {
      /** 档位的展示文案(实际下哪些文件由宿主那边的引擎清单决定)。 */
      const TIER_TEXT = {
        fast: {
          title: '快速放大',
          size: '约 10 MB',
          speed: '一张 1200px 图约 5 秒',
          quality: '轻量模型,动漫 / 插画 / 截图效果好',
        },
        quality: {
          title: '高清放大',
          size: '再下约 32 MB',
          speed: '一张 1200px 图约 40 秒',
          quality: '高质量模型,照片细节最足',
        },
      };

      /**
       * @param {object} p - 依赖包。
       * @returns {React element|null} 面板或空。
       */
      function renderUpscalePanel(p) {
        const {
          panelAnchor,
          ensureUpscale,
          hostFeatures,
          runUpscale,
          setShowUpscale,
          setUpscaleScale,
          setUpscaleTier,
          showUpscale,
          upscaleBusy,
          upscaleNote,
          upscaleScale,
          upscaleTier,
          upscaleTiers,
        } = p;
        if (!showUpscale) return null;

        const hostReady = Array.isArray(hostFeatures) && hostFeatures.includes('upscale');
        const stateOf = (id) => (upscaleTiers || []).find((item) => item.id === id) || null;
        const current = stateOf(upscaleTier);
        const ready = Boolean(current && current.ready);
        const busy = Boolean(upscaleBusy);

        /**
         * 面板里统一的"胶囊"样式:**没有任何描边**,选中态靠淡背景 + 主色文字。
         * @param {boolean} active - 是否选中 / 主操作。
         * @param {boolean} [strong] - 主操作用(更实的底 + 加粗)。
         * @returns {object} 内联样式。
         */
        const pill = (active, strong) =>
          Object.assign({}, S.tiny, {
            appearance: 'none',
            border: 'none',
            outline: 'none',
            background: active
              ? strong
                ? 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.24))'
                : 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))'
              : 'transparent',
            color: active ? label : label2,
            borderRadius: 8,
            padding: strong ? '6px 12px' : '5px 10px',
            fontSize: strong ? 13 : 12.5,
            fontWeight: active ? 600 : 400,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          });

        /** 档位一行(点一下切换;右边标着"已就绪 / 需要下载")。 */
        const tierRow = (id) => {
          const text = TIER_TEXT[id] || { title: id };
          const state = stateOf(id);
          const active = upscaleTier === id;
          return h(
            'button',
            {
              key: id,
              style: Object.assign(pill(active), { display: 'block', width: '100%', textAlign: 'left', marginBottom: 1 }),
              disabled: busy,
              title: `${text.quality} —— ${text.speed}`,
              onClick: () => setUpscaleTier(id),
            },
            `${active ? '● ' : '○ '}${text.title}`,
            h('span', { style: { float: 'right', opacity: 0.7, fontWeight: 400 } }, state && state.ready ? '已就绪' : `需下载 ${text.size}`),
          );
        };

        /** 悬停开的贴在按钮正下方(按自己的宽度往回收);手点开的还是老位置靠右。 */
        const place = panelAnchor
          ? { left: Math.max(6, Math.min(panelAnchor.left, panelAnchor.maxRight - 340)), right: 'auto', top: panelAnchor.top }
          : { right: 6, top: 42 };
        return h(
          'div',
          {
            // 悬停联动用:鼠标落进这块面板就算「还没走」,收起倒计时作废
            'data-nav-keep': 'upscale',
            style: Object.assign({}, S.float, place, { width: 340, maxWidth: 'calc(100% - 16px)' }),
          },
          h(
            'div',
            { style: Object.assign({}, S.card, S.col, { gap: 6 }) },
            h(
              'div',
              { style: S.row },
              h('strong', { style: { fontSize: 12 } }, '⬆ AI 高清放大'),
              h('span', { style: S.grow }),
              h('button', { style: pill(false), onClick: () => setShowUpscale(false) }, '收起'),
            ),
            h(
              'div',
              { style: S.hint },
              '用**本机显卡**放大(Real-ESRGAN):图片不出本机、不花 API 额度、断网也能用。引擎第一次用时才下载,之后一直离线可用。',
            ),
            !hostReady
              ? h(
                  'div',
                  { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                  '⚠ 宿主半边是旧版(还不认识这颗按钮)—— 重启一次 DSH 后可用。',
                )
              : null,
            h('div', { style: { height: 1, background: line, opacity: 0.6, margin: '2px 0' } }),
            tierRow('fast'),
            tierRow('quality'),
            h(
              'div',
              { style: Object.assign({}, S.row, { gap: 4, alignItems: 'center' }) },
              h('span', { style: S.hint }, '倍率'),
              [2, 3, 4].map((value) =>
                h(
                  'button',
                  {
                    key: value,
                    style: pill(upscaleScale === value),
                    disabled: busy,
                    title:
                      value === 4
                        ? '4x —— 模型原生倍率,细节最足'
                        : `${value}x —— 快档是原生变体;精档由 4x 缩到 ${value} 倍(耗时同 4x)`,
                    onClick: () => setUpscaleScale(value),
                  },
                  `${value}x`,
                ),
              ),
              h('span', { style: S.hint }, '8x 要连放两次,暂不提供'),
            ),
            h('div', { style: { height: 1, background: line, opacity: 0.6, margin: '2px 0' } }),
            h(
              'div',
              { style: S.row },
              ready
                ? h(
                    'button',
                    {
                      style: Object.assign(pill(true, true), { flex: 1, textAlign: 'center' }),
                      disabled: busy,
                      title: '把选中的图(没选就用最后一张)放到本机显卡上放大',
                      onClick: () => {
                        if (!busy) runUpscale();
                      },
                    },
                    busy === 'run' ? '⏳ 放大中…(大图可能要 40 秒)' : `▶ 开始放大 ${upscaleScale}x`,
                  )
                : h(
                    'button',
                    {
                      style: Object.assign(pill(true, true), { flex: 1, textAlign: 'center' }),
                      disabled: busy,
                      title: '把放大引擎下载到本机(只下一次,之后离线可用)',
                      onClick: () => {
                        if (!busy) ensureUpscale(upscaleTier);
                      },
                    },
                    busy === 'download' ? '⏳ 下载引擎中…' : `⬇ 下载引擎(${TIER_TEXT[upscaleTier] ? TIER_TEXT[upscaleTier].size : ''})`,
                  ),
              ready
                ? h(
                    'button',
                    {
                      style: pill(false),
                      disabled: busy,
                      title: '引擎已装好;想换成另一个档位直接点上面那颗,会增量补下载',
                      onClick: () => ensureUpscale(upscaleTier),
                    },
                    '检查',
                  )
                : null,
            ),
            upscaleNote
              ? h('div', { style: /失败|错误|旧版/.test(upscaleNote) ? S.err : S.hint }, upscaleNote)
              : null,
            current && current.ready
              ? h(
                  'div',
                  { style: S.hint },
                  `引擎位置:${current.installed}/${current.total} 个文件${current.bytes ? `,${(current.bytes / 1048576).toFixed(1)} MB` : ''}`,
                )
              : null,
            h('div', { style: S.hint }, '放大结果会存到工作区「画布输出」里,并直接摆到原图旁边。'),
          ),
        );
      }

      return { renderUpscalePanel };
    });
