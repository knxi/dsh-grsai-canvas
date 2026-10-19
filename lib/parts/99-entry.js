
    /** 标签页标题。 */
    function CanvasTitle() {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, '🎨', '画布');
    }

    /** 引导页/入口按钮的小图标。 */
    function CanvasGlyph(props) {
      const size = (props && props.size) || 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 1.5, y: 1.5, width: 13, height: 13, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 5.6, cy: 5.8, r: 1.5, fill: 'currentColor' }),
        h('path', { d: 'M2.2 12.4 6 8.6l2.6 2.6L11 8.9l2.8 3.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];

    /**
     * 画布 → 对话的桥:点击「图片分层(交给 Agent)」时,往当前会话发一条消息,
     * 效果等于替用户在输入框里按了回车,agent 随即收到并开始干活。
     *
     * 两个服务**惰性取**(点击那一刻才 `ctx.get`),而不是写进 `inject`:
     * 少了它们只是这一颗按钮不可用,不该把整个画布插件卡在依赖上。
     * `sessions.binding(id).session` 是会话实体,`conversation.sendSession`
     * 是 DSH 官方给客户端插件用的公开提交入口(mode: `queue` 不打断正在跑的回合)。
     *
     * @param ctx - 客户端根上下文。
     * @returns {{ send: (text: string, sessionId: string) => Promise<{ok: boolean, error?: string}> }} 桥。
     */
    function createAgentBridge(ctx) {
      return {
        async send(text, sessionId) {
          try {
            if (typeof ctx.get !== 'function') return { ok: false, error: '当前 DSH 版本没有会话服务' };
            const sessions = ctx.get('sessions');
            const conversation = ctx.get('conversation');
            if (!sessions || !conversation) {
              return { ok: false, error: '会话服务不可用:请在对话页打开画布,或直接对 agent 说「图片分层」' };
            }
            const binding = sessionId ? sessions.binding(sessionId) : undefined;
            if (!binding || !binding.session) {
              return { ok: false, error: '当前会话还没就绪:先点一下对话输入框再试' };
            }
            await conversation.sendSession(binding.session, text, [], 'queue');
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
          }
        },
        /**
         * 带图发一条(「帮我写提示词」用):把图注册成对话草稿附件,再连同文字一起提交。
         *
         * 图和话是同一条消息过去的 —— agent 收到时既看得到画布现状,也看得到你的要求。
         * 附件这条路走不通(老版本 DSH 没有 createDrafts)就退化成纯文字:
         * 提示词照样能写,只是 agent 看不到图。
         * @param text - 发给 agent 的话。
         * @param sessionId - 当前会话 id。
         * @param image - `{ dataUrl, name }`:要一起发过去的图。
         * @returns `withImage` 说明图到底带上了没有。
         */
        async sendWithImage(text, sessionId, image) {
          try {
            if (typeof ctx.get !== 'function') return { ok: false, error: '当前 DSH 版本没有会话服务' };
            const sessions = ctx.get('sessions');
            const conversation = ctx.get('conversation');
            if (!sessions || !conversation) {
              return { ok: false, error: '会话服务不可用:请在对话页打开画布,或直接对 agent 说「图片分层」' };
            }
            const binding = sessionId ? sessions.binding(sessionId) : undefined;
            if (!binding || !binding.session) {
              return { ok: false, error: '当前会话还没就绪:先点一下对话输入框再试' };
            }
            const ids = [];
            let withImage = false;
            if (image && image.dataUrl && typeof conversation.createDrafts === 'function') {
              try {
                const blob = await dataUrlToBlob(image.dataUrl);
                const file = new File([blob], image.name || `画布-${Date.now()}.png`, { type: blob.type || 'image/png' });
                const sid = (binding.session && binding.session.id) || sessionId;
                const drafts = await conversation.createDrafts(sid, [file]);
                for (const draft of drafts || []) {
                  if (draft && draft.id) ids.push(draft.id);
                }
                withImage = ids.length > 0;
              } catch {
                /* 附件注册失败就只发文字 */
              }
            }
            await conversation.sendSession(binding.session, text, ids, 'queue');
            return { ok: true, withImage };
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
          }
        },
      };
    }

    /**
     * 插件体:注册 tab 类型、面板体、标题和侧栏入口。
     * @param ctx - 客户端根上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const definition = {
        id: CANVAS_ID,
        kind: CANVAS_KIND,
        priority: 'extension',
        title: () => '画布',
        guide: [
          {
            order: 20,
            title: () => '画布',
            description: () => '无限画布改图:自由摆放、直接标注、结果放原图旁边对比',
            icon: CanvasGlyph,
          },
        ],
      };

      ctx.effect(() => ctx.sidebarRightTabs.register(definition), 'grsai-canvas: tab type');

      /** 画布 → 对话的桥(建一次就够,内部惰性取服务)。 */
      const agentBridge = createAgentBridge(ctx);

      /** 面板体:顺手把「弹成浮动面板」接到 sidebarRight 上。 */
      function CanvasBody(props) {
        const useTabInfo = props && props.useTabInfo;
        const info = typeof useTabInfo === 'function' ? useTabInfo() : null;
        const tabId = info && info.tab ? info.tab.id : null;
        const enhanced = Object.assign({}, props, {
          agentBridge,
          popOut: () => {
            if (!tabId) return;
            try {
              ctx.sidebarRight.float(tabId);
            } catch {
              /* 已浮动或没有面板时忽略 */
            }
          },
        });
        return h(CanvasTab, enhanced);
      }

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: CANVAS_ID }, CanvasBody),
          ),
        'grsai-canvas: tab body',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: CANVAS_ID }, CanvasTitle),
          ),
        'grsai-canvas: tab title',
      );

      /** 侧栏左下角入口。 */
      function OpenCanvasButton(props) {
        const wide = Boolean(props && props.wide);
        return h(
          'button',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: wide ? 'flex-start' : 'center',
              gap: 6,
              width: '100%',
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary, currentColor)',
              cursor: 'pointer',
              borderRadius: 8,
              padding: wide ? '7px 8px' : '6px',
              fontSize: 14,
              lineHeight: '22px',
              transition: 'background .12s',
            },
            title: '画布:用 GrsAI 改图',
            onClick: () => {
              try {
                ctx.sidebarRight.openTab(CANVAS_KIND);
              } catch {
                /* 面板没挂载时忽略 */
              }
            },
          },
          h('span', { style: { display: 'inline-flex' } }, h(CanvasGlyph, { size: 16 })),
          wide ? h('span', null, '画布') : null,
        );
      }

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register({ name: 'sidebar.footer.action', id: CANVAS_ID, order: 40, label: '画布' }, OpenCanvasButton),
          ),
        'grsai-canvas: sidebar entry',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    /** 给离线测试用的状态声明顺序。 */
    exports.__stateOrder = STATE_ORDER;
    /** 给离线测试用的纯函数(坐标/几何/标注绘制),运行时不用。 */
    exports.__internals = {
      worldToScreen,
      screenToWorld,
      imageBounds,
      fitCamera,
      rectVisible,
      normalizeRect,
      cloneDoc,
      marksBounds,
      markDistanceToPoint,
      renderMarks,
      screenMarkMap,
      naturalMarkMap,
      describeMarks,
      markHint,
      clamp,
      submissionSize,
      SUBMIT_MAX_SIDE,
      MAX_SUBMIT_BYTES,
      classifyStatus,
      pickImageUrl,
      readPendingTasks,
      writePendingTasks,
      LS_TASKS,
      BUILTIN_SKILLS,
      QUALITIES,
      BACKGROUNDS,
      IMAGE_SIZES,
      MODEL_CHOICES,
      // 按模型换算尺寸(比例 ↔ 像素)—— 上游同一个 aspectRatio 字段格式不同
      MODEL_SIZES,
      SIZE_LABELS,
      MODEL_SIZE_ALIAS,
      COMMON_SIZES,
      parsePixelSize,
      parseRatio,
      sizeAspect,
      sizeTableFor,
      sizeFormatOf,
      sizeOptionsFor,
      isValidSize,
      defaultSizeFor,
      nearestSize,
      normalizeSize,
      sizeWarning,
      sizeErrorFix,
      buildGenerateBody,
      pickClosestSize,
      // 「尺寸」里代表「跟随提交的那张图」的特殊值
      SOURCE_SIZE,
      SOURCE_TEXT,
      SOURCE_LABEL,
      sizeMenuGroups,
      COMMON_OUTPUT_SIZES,
      resizeDataUrl,
      // 「尺寸」框里的人类写法 → 上游值(输入 1080x1440 / 3:4 / 竖版 / 小红书 都能换算)
      parseHumanSize,
      convertSizeForModel,
      SIZE_KEYWORDS,
      SIZE_DIRECTIONS,
      // 实物尺寸(mm / cm / 英寸)→ 像素(DPI 可在设置里改)
      SIZE_UNITS,
      parseUnitSize,
      normalizeDpi,
      DEFAULT_DPI,
      MM_PER_INCH,
      // 超出浏览器 canvas 上限时自动换算(实物降 DPI / 裸像素等比缩小)
      fitScale,
      MAX_OUTPUT_SIDE,
      MAX_OUTPUT_PIXELS,
      MIN_DPI,
      // 提交前自检(把"老忘写"的要求列出来 + 给出可追加的句子)
      preflightChecks,
      // 草稿同步到工作区的落盘位置
      DRAFT_REL,
      // 文字图层(本机字体、本地矢量绘制)
      TEXT_DEFAULTS,
      FONT_CANDIDATES,
      textLines,
      estimateTextWidth,
      textLayerBounds,
      hitTextLayer,
      drawImageTexts,
      // 分层导出(成品图 / 无文字底图 / 文字参数 JSON)
      layerPaths,
      parseExportSize,
      textLayerManifest,
    };
