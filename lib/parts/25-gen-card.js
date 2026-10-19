/* 右下角「生成/发送」区块(画布的主操作区):错误/进度、主图与参考图摘要、场景框、提示词输入框、模型与尺寸、提交前自检、提交按钮、模型/尺寸菜单。选中图片的信息与操作、对齐分布、文字图层在属性区(35-props-card);保存/清空画布在设置面板(27)。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`IMAGE_SIZES`/`SOURCE_SIZE`/`SOURCE_TEXT`/`SIZE_TIPS`/`STALE_HOST_HINT` 与尺寸纯函数(`convertSizeForModel`/`sizeWarning`/`parsePixelSize`/`nearestSize`/`sizeFormatOf`/`sizeAspect`/`isValidSize`/`normalizeSize`)直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('gen-card', () => {
      /**
       * 「跨平台」能勾的常用平台尺寸:取 `COMMON_OUTPUT_SIZES` 里标了 `batch` 的那几项
       * (标记在 03 的尺寸表上,这里不再重抄一遍像素值)。
       */
      const BATCH_CHOICES = COMMON_OUTPUT_SIZES.filter((item) => item.batch);
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderGenCard(p) {
        const {
          activeSkill,
          apikey,
          appendHint,
          applyFrameSize,
          applyPreflightFixes,
          applySizeDraft,
          applySkill,
          batchSizes,
          busy,
          cancelGenerate,
          cropToMark,
          customSize,
          docRef,
          dpi,
          error,
          finishChange,
          frameSizeDraft,
          hostStale,
          imageSize,
          images,
          jobsRef,
          lastUpstream,
          model,
          modelPanel,
          phase,
          preflight,
          preflightFixes,
          preflightSkill,
          progress,
          prompt,
          promptRef,
          ratio,
          refCount,
          removeFrame,
          run,
          selected,
          selectedFrameId,
          selectedFrame,
          selectedMarks,
          setAppendHint,
          setBatchSizes,
          setCropToMark,
          setFrameSizeDraft,
          setImageSize,
          setModel,
          setPrompt,
          setRatio,
          setShowGen,
          setShowSettings,
          setSizeDraft,
          showGen,
          showModels,
          showSizes,
          sizeDraft,
          sizePanel,
          sourceAspect,
          sourceImage,
          sourceResolved,
          submitPreview,
          togglePanel,
        } = p;
        return h(
          'div',
          { style: S.gen },
          error ? h('div', { style: Object.assign({}, S.card, { padding: '4px 7px', flexShrink: 0, maxHeight: 80, overflowY: 'auto' }) }, h('div', { style: S.err }, error)) : null,
          busy
            ? (() => {
                // 任务本体在 jobsRef 里(不占 state):这里只把它读出来显示。
                // 每张的进度、状态都在它自己的行上,所以在排队/同时在跑几张一眼能看清。
                const jobs = jobsRef && Array.isArray(jobsRef.current) ? jobsRef.current : [];
                const running = jobs.filter((job) => job.state !== 'queued').length;
                return h(
                  'div',
                  { style: Object.assign({}, S.card, S.col, { padding: '5px 7px', gap: 4, flexShrink: 0, maxHeight: 120, overflowY: 'auto' }) },
                  h(
                    'div',
                    { style: S.hint },
                    jobs.length
                      ? `正在生成 ${running}/${jobs.length} 张 —— 想停哪张,就点画布上那个框里的「⏹ 打断」`
                      : phase || '处理中…',
                  ),
                  jobs.slice(0, 4).map((job) =>
                    h(
                      'div',
                      { key: job.id, style: S.row },
                      h('span', { style: S.hint }, `${job.queueLabel ? `${job.queueLabel} · ` : ''}${job.label || ''}`),
                      h('span', { style: S.grow }),
                      h(
                        'span',
                        { style: S.hint },
                        job.state === 'queued' ? '排队中' : job.pct > 0 ? `${job.pct}%` : job.phase || '生成中…',
                      ),
                    ),
                  ),
                  jobs.length > 4 ? h('div', { style: S.hint }, `…还有 ${jobs.length - 4} 张在等`) : null,
                  // 续查时没有 jobsRef 条目(老任务走的是另一条路径),那就还显示总进度条
                  !jobs.length
                    ? h('div', { style: S.bar }, h('div', { style: Object.assign({}, S.barInner, { width: `${progress || 8}%` }) }))
                    : null,
                  lastUpstream
                    ? h(
                        'details',
                        { style: Object.assign({}, S.hint, { opacity: 0.72, minWidth: 0 }) },
                        h('summary', { style: { cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '上游最近返回(点开看原文)'),
                        h('div', { style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' } }, lastUpstream),
                      )
                    : null,
                );
              })()
            : null,
          showGen
            ? h(
            'div',
            { style: Object.assign({}, S.card, S.col, { minHeight: 0, overflowY: 'auto', flex: '0 1 auto' }) },
            hostStale
              ? h(
                  'div',
                  { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                  `⚠ ${STALE_HOST_HINT}`,
                )
              : null,
            !apikey
              ? h(
                  'div',
                  { style: Object.assign({}, S.row, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                  h('span', { style: S.hint }, '⚠ 还没填 APIKEY'),
                  h('button', { style: S.tiny, onClick: () => setShowSettings(true) }, '点这里填 →'),
                )
              : null,
            // 选中图片的信息与操作(参考/复制/存/下载/分层/删除)已迁到属性区(35-props-card)
            (() => {
              const frames = docRef.current.frames || [];
              if (!frames.length) return null;
              // 明确删「显示中的这个框」:优先选中框;没选中时显示最后一框并写明,免得多框时删错
              const shownFrame = frames.find((f) => f.id === selectedFrameId) || frames[frames.length - 1];
              const shownIsPicked = Boolean(selectedFrameId) && shownFrame.id === selectedFrameId;
              return h(
                'div',
                { style: S.row },
                h(
                  'span',
                  { style: S.badge, title: '场景框(生成框):模型会在框内生成新图,框的比例就是生成图片的比例' },
                  `场景框 ${Math.round(shownFrame.w)}×${Math.round(shownFrame.h)} (${(shownFrame.w / shownFrame.h).toFixed(2)})${shownIsPicked ? '' : '(最后一个)'}`,
                ),
                h('input', {
                  id: 'grsai-gen-frame-size',
                  style: Object.assign({}, S.input, S.grow),
                  placeholder: '改尺寸/比例:800x600 / 210x297mm / 3:4',
                  value: frameSizeDraft,
                  title: '输入像素 800x600、实物 210x297mm 或比例 3:4,失焦生效',
                  onChange: (e) => setFrameSizeDraft(e.target.value),
                  onBlur: applyFrameSize,
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.target.blur();
                    }
                  },
                }),
                h('button', {
                  style: S.tiny,
                  title: shownIsPicked ? '删除选中的这个场景框' : '当前没选中框:将删除显示中的(最后一个)场景框',
                  onClick: () => removeFrame(shownFrame.id),
                }, '删框'),
              );
            })(),
            // 本次输入:主图 + 参考图(一起发给模型);隐藏的参考图不参与提交,下面会提示有几张被排除
            (() => {
              const refs = images.filter((im) => im.isRef && !im.hidden && im.id !== (selected && selected.id));
              const hiddenRefs = images.filter((im) => im.isRef && im.hidden && im.id !== (selected && selected.id)).length;
              if (!selected && !refs.length) return null;
              // 名字统一兜底:存档被外部改过/旧版本缺 name 时,直接取 .length 会让整块生成卡抛错白屏
              const mainName = selected ? String(selected.name || '图片') : '';
              return h(
                'div',
                { style: S.col },
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, '主图'),
                  selected
                    ? h('span', { style: S.badge, title: `主图(被改的图):${mainName}` }, `${mainName.length > 12 ? `${mainName.slice(0, 10)}…` : mainName} ${selected.naturalW || selected.w}×${selected.naturalH || selected.h}`)
                    : h('span', { style: S.hint }, '未选(文生图)'),
                  h('span', { style: S.grow }),
                  refs.length ? h('span', { style: S.hint }, `参考 ${refs.length} 张`) : h('span', { style: S.hint }, '无参考图'),
                  hiddenRefs
                    ? h('span', { style: S.hint, title: '隐藏的图不参与生成;在图层面板点「显」可以恢复' }, `另有 ${hiddenRefs} 张隐藏参考图不参与`)
                    : null,
                  h('button', { style: S.tiny, title: '收起面板(把画布让出来)', onClick: () => setShowGen(false) }, '▾'),
                ),
                refs.length
                  ? h(
                      'div',
                      { style: S.row },
                      refs.map((im, idx) => {
                        const refName = String(im.name || '图片');
                        // 编号跟画布角标、提交顺序三处一致(主图不占参考编号,参考从 1 起):
                        // 用户在提示词里写「参考图2」,指的就是这一颗。
                        return h(
                          'button',
                          {
                            key: im.id,
                            style: S.tiny,
                            title: `参考图${idx + 1}「${refName}」:提示词里写「参考图${idx + 1}」就能指到它,提交时会自动补上编号说明(第 1 张是主图,后面依次是参考图);点一下取消参考`,
                            onClick: () => {
                              im.isRef = false;
                              finishChange(true);
                            },
                          },
                          `参考图${idx + 1}:${refName.length > 8 ? `${refName.slice(0, 6)}…` : refName} ✕`,
                        );
                      }),
                    )
                  : null,
              );
            })(),
            h('textarea', {
              id: 'grsai-prompt',
              ref: promptRef,
              style: S.textarea,
              placeholder: selected
                ? selectedMarks.length
                  ? '写一句「要改成什么」(强烈建议):例如「箭头指着的招牌改成深夜食堂」。只画箭头,模型容易猜错。'
                  : '想怎么改这张图?例如:把招牌换成「深夜食堂」'
                : '选中一张图来改;也可以只写提示词直接生成新图',
              value: prompt,
              onChange: (event) => setPrompt(event.target.value),
            }),
            h(
              'div',
              { style: S.row },
              h('span', { style: S.hint }, '模型'),
              h('input', {
                id: 'grsai-model-input',
                style: Object.assign({}, S.input, { maxWidth: 150 }),
                value: model,
                title: '可以直接输入任意模型名;点右边 ▾ 从菜单里挑',
                onChange: (e) => setModel(e.target.value),
              }),
              h(
                'button',
                {
                  style: Object.assign({}, S.caret, showModels ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null),
                  title: '列出全部模型(含上游尺寸表里的型号)',
                  'aria-label': '打开模型列表',
                  onClick: () => togglePanel('models'),
                },
                '▾',
              ),
              h('span', { style: S.hint }, '尺寸'),
              h('input', {
                id: 'grsai-size-draft',
                style: Object.assign({}, S.input, { maxWidth: 132 }),
                // 框里显示你写的原话(1080x1440 / 3:4 / 竖版 / 小红书…),失焦时换算给上游
                value: sizeDraft,
                placeholder: `${SOURCE_TEXT} / 210x297mm / 1080x1440 / 3:4 / 竖版 / 小红书`,
                title: `${SIZE_TIPS[sizeFormatOf(model)]}\n可以直接写:\n· 实物尺寸(带单位)210x297mm / 21x29.7cm / 8.5x11in —— 按 ${dpi} DPI 换算成像素\n· 像素 1080x1440(不写单位就是像素)\n· 比例 3:4、方向 竖版/横屏/方图、常用名 小红书/A4/头像…\n失焦(或按回车)时插件会换算成上游认识的值;点右边 ▾ 也能挑`,
                onChange: (e) => setSizeDraft(e.target.value),
                onBlur: () => {
                  if (!applySizeDraft()) {
                    // 认不出来的写法:沿用老规矩,能当尺寸用就地规范化,否则留着让黄字提示
                    const cur = String(sizeDraft).trim();
                    if (cur === SOURCE_TEXT) setRatio(SOURCE_SIZE);
                    else if (sizeAspect(cur) !== null && !isValidSize(model, cur)) setRatio(normalizeSize(model, cur));
                  }
                },
                onKeyDown: (e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.target.blur();
                  }
                },
              }),
              h(
                'button',
                {
                  style: Object.assign({}, S.caret, showSizes ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null),
                  title: '列出这个模型支持的全部尺寸 / 指定成品尺寸',
                  'aria-label': '打开尺寸列表',
                  onClick: () => togglePanel('sizes'),
                },
                '▾',
              ),
              model.indexOf('nano-banana') === 0
                ? h(
                    'select',
                    { id: 'grsai-image-size-select', style: Object.assign({}, S.input, { maxWidth: 70 }), value: imageSize, onChange: (e) => setImageSize(e.target.value) },
                    IMAGE_SIZES.map((sn) => h('option', { key: sn, value: sn }, sn)),
                  )
                : null,
            ),
            // 输入框里写的原话会被换算给上游 —— 这里把"会发什么/导出多少"当场说清楚(含 mm→像素)
            (() => {
              const conv = convertSizeForModel(model, sizeDraft, dpi);
              if (conv) return h('div', { style: S.hint }, conv.hint);
              const warn = sizeWarning(model, sizeDraft);
              return warn ? h('div', { style: S.warn }, `⚠ ${warn}`) : null;
            })(),
            // 指定了成品尺寸就把「提交按什么渲染 / 最后缩放到多少」写清楚,免得人猜
            parsePixelSize(customSize)
              ? h(
                  'div',
                  { style: S.hint },
                  `成品尺寸 ${customSize}:提交按「${nearestSize(model, parsePixelSize(customSize)[0] / parsePixelSize(customSize)[1])}」渲染` +
                    `(上游只认它那张尺寸表),回来后本地精确缩放到 ${parsePixelSize(customSize)[0]}×${parsePixelSize(customSize)[1]}`,
                )
              : null,
            ratio === SOURCE_SIZE || selectedFrame
              ? h(
                  'div',
                  { style: S.hint },
                  selectedFrame
                    ? `场景框比例:${Math.round(selectedFrame.w)}×${Math.round(selectedFrame.h)} → 这次发 ${sourceResolved}`
                    : sourceAspect > 0 && sourceImage
                    ? `原图比例:按「${sourceImage.name || '这张图'}」${sourceImage.naturalW}×${sourceImage.naturalH} → 这次发 ${sourceResolved}` +
                      `${submitPreview && submitPreview.cropped ? `(裁剪后 ${submitPreview.width}×${submitPreview.height})` : ''}`
                    : `原图比例:没有输入图片 → 这次发 ${sourceResolved}`,
                )
              : null,
            // 仅在「模板的比例真的换算到了当前尺寸上」时提示,免得存档恢复出模板时说了不实的话
            activeSkill && activeSkill.ratio && sizeFormatOf(model) === 'pixel' && ratio === nearestSize(model, activeSkill.ratio)
              ? h('div', { style: S.hint }, `模板「${activeSkill.name}」写的比例 ${activeSkill.ratio} 已按 ${model} 换算成 ${nearestSize(model, activeSkill.ratio)}(这个模型只收像素值)`)
              : null,
            selectedMarks.some((mk) => mk.kind === 'mask')
              ? h(
                  'div',
                  { style: S.hint },
                  `蓝色蒙版 ${selectedMarks.filter((mk) => mk.kind === 'mask').length} 处:只改涂到的地方,其余压暗后一起发给模型(所以这一张按整图提交,不裁剪)`,
                )
              : null,
            selectedMarks.length
              ? h(
                  'div',
                  { style: S.row },
                  h(
                    'label',
                    { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }) },
                    h('input', {
                      id: 'grsai-crop-to-mark',
                      type: 'checkbox',
                      checked: cropToMark,
                      disabled: selectedMarks.some((mk) => mk.kind === 'mask'),
                      onChange: (e) => setCropToMark(e.target.checked),
                    }),
                    selectedMarks.some((mk) => mk.kind === 'mask') ? '只提交标注范围(裁剪,有蒙版时自动跳过)' : '只提交标注范围(裁剪)',
                  ),
                  h(
                    'label',
                    { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }) },
                    h('input', { id: 'grsai-append-hint', type: 'checkbox', checked: appendHint, onChange: (e) => setAppendHint(e.target.checked) }),
                    '附加「按标注改」说明',
                  ),
                )
              : null,
            preflight.issues.length
              ? h(
                  'div',
                  { style: Object.assign({}, S.col, { display: 'flex', gap: 3, padding: '6px 0', borderTop: `1px solid ${line}` }) },
                  h(
                    'div',
                    { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                    `⚠ 提交前建议(${preflight.issues.length}) —— 点一下补上,省得又忘写`,
                  ),
                  preflight.issues.map((item) => h('div', { key: item.id, style: S.hint }, `· ${item.text}`)),
                  preflightFixes.length || preflightSkill
                    ? h(
                        'div',
                        { style: S.row },
                        preflightFixes.length
                          ? h('button', { style: S.tiny, title: '把这些要求追加到提示词末尾', onClick: applyPreflightFixes }, `补上这 ${preflightFixes.length} 条`)
                          : null,
                        preflightSkill
                          ? h(
                              'button',
                              { style: S.tiny, title: '套用「留白配图」:让模型只出干净底图,字由本机字体本地加', onClick: () => applySkill(preflightSkill.action.slice(6), true) },
                              '套用「留白配图」',
                            )
                          : null,
                        h('span', { style: S.grow }),
                      )
                    : null,
                )
              : null,
            h(
              'div',
              { style: Object.assign({}, S.col, { gap: 3 }) },
              h(
                'div',
                { style: S.row },
                h('span', { style: S.hint }, '跨平台一次出图'),
                h('span', { style: S.grow }),
                batchSizes.length
                  ? h('button', { style: S.tiny, title: '取消全部勾选,回到只出当前尺寸这一张(不会清空画布)', onClick: () => setBatchSizes([]) }, '取消勾选')
                  : null,
              ),
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                BATCH_CHOICES.map((item) =>
                  h(
                    'label',
                    {
                      key: item.value,
                      style: Object.assign({}, S.tiny, { display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer' }),
                      title: `${item.note} · 成图尺寸 ${item.value}`,
                    },
                    h('input', {
                      id: 'grsai-batch-' + item.value,
                      type: 'checkbox',
                      checked: batchSizes.includes(item.value),
                      onChange: (e) => {
                        const value = item.value;
                        setBatchSizes((cur) =>
                          e.target.checked ? [...cur.filter((v) => v !== value), value] : cur.filter((v) => v !== value),
                        );
                      },
                    }),
                    item.label,
                  ),
                ),
              ),
              h(
                'div',
                { style: S.hint },
                batchSizes.length
                  ? `会按勾的 ${batchSizes.length} 个尺寸各出一张(最多同时跑 2 张,其余的排队),结果排在原图旁边往下顺,不重叠。`
                  : '勾一个以上:同一句提示词按每个平台尺寸各出一张成图。不勾就还是只出当前这一张。',
              ),
            ),
            h(
              'div',
              { style: S.row },
              h(
                'button',
                {
                  style: S.primary,
                  title: '提交一次生成。生成中也能继续点:不会等前一张跑完;想停某一张就点画布上那个框里的「⏹ 打断」',
                  onClick: run,
                },
                batchSizes.length ? `跨平台出图(${batchSizes.length} 张)` : selected ? '按标注改图' : '生成新图',
              ),
              h(
                'span',
                { style: S.hint },
                submitPreview
                  ? `提交 ${submitPreview.width}×${submitPreview.height}${submitPreview.scale < 1 ? `(缩小)` : ''}${refCount ? ` +${refCount} 参考` : ''}`
                  : refCount
                    ? `带 ${refCount} 张参考图`
                    : '',
              ),
              activeSkill ? h('button', { style: S.tiny, title: '取消这个模板', onClick: () => applySkill(activeSkill.id) }, `模板:${activeSkill.name} ✕`) : null,
              // 保存画布/清空画布挪到了「设置」面板(低频维护,破坏性操作远离主按钮)
            ),
          )
            : h(
                'div',
                { style: Object.assign({}, S.card, S.row, { padding: 4 }) },
                h('button', { style: S.tiny, title: '展开生成面板', onClick: () => setShowGen(true) }, '▸ 生成'),
                selected ? h('span', { style: S.badge, title: selected.name }, selected.name.length > 10 ? `${selected.name.slice(0, 8)}…` : selected.name) : null,
                h('span', { style: S.grow }),
                h(
                  'button',
                  {
                    style: S.primary,
                    title: '提交一次生成。生成中也能继续点:不会等前一张跑完;想停某一张就点画布上那个框里的「⏹ 打断」',
                    onClick: run,
                  },
                  batchSizes.length ? `跨平台出图(${batchSizes.length} 张)` : selected ? '按标注改图' : '生成新图',
                ),
              ),
          modelPanel,
          sizePanel,
        );
      }

      return { renderGenCard };
    });
