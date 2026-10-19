/* 选中对象属性区(右侧、生成卡上方,仅选中了图片才出现):图片信息与操作那一行
 * (参考/复制/存工作区/下载/导出底图与文字/删除)、多选时的对齐分布条、文字图层整块。
 * 从「生成卡」迁出来(任务书 §6.2:未选图不常驻图片操作,生成区只留生成相关)。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`COLORS`/`TEXT_DEFAULTS`/`FONT_CANDIDATES` 直接用;
 * CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('props-card', () => {
      /** 对齐/分布按钮(多选 ≥2 张时才出现;后两个要 ≥3 张)。 */
      const ALIGN_ACTIONS = [
        { kind: 'left', label: '左齐', tip: '左对齐:几张图的左边缘对齐' },
        { kind: 'hcenter', label: '横中', tip: '水平居中对齐' },
        { kind: 'right', label: '右齐', tip: '右对齐:几张图的右边缘对齐' },
        { kind: 'top', label: '顶齐', tip: '顶对齐:几张图的上边缘对齐' },
        { kind: 'vcenter', label: '纵中', tip: '垂直居中对齐' },
        { kind: 'bottom', label: '底齐', tip: '底对齐:几张图的下边缘对齐' },
        { kind: 'hdist', label: '横分', tip: '水平等距分布:首尾两张不动,中间的等间距铺开', need3: true },
        { kind: 'vdist', label: '纵分', tip: '垂直等距分布:首尾两张不动,中间的等间距铺开', need3: true },
      ];
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素(没选中任何图片时返回 null —— 整块不出现)。
       */
      function renderPropsCard(p) {
        const {
          addTextLayer,
          alignSelected,
          compareSelectedTwo,
          copyImageToClipboard,
          deleteSelected,
          downloadSelected,
          fontList,
          importFontFile,
          layerSize,
          removeTextLayer,
          saveImageLayered,
          saveSelectedToWorkspace,
          selected,
          selectedIds,
          selectedMarks,
          selectedText,
          selectedTextId,
          setLayerSize,
          setGeometry,
          setSelectedTextId,
          setShowText,
          setSubmitTexts,
          showText,
          submitTexts,
          toggleRef,
          updateText,
        } = p;
        // 选了 2 张以上时,「存 / 下载」按整批走(单张仍是老路:存主选中那张)
        const multi = selectedIds.length > 1 ? selectedIds.length : 0;
        if (!selected && multi < 2) return null;
        /**
         * 属性卡上的一个几何数字框(X/Y/宽/高)。
         *
         * 只在回车或失焦时提交:每敲一个字符就写一次 doc 会把撤销栈塞满。
         * `key` 绑当前值 —— 用键盘方向键挪图、或 Ctrl+Z 之后,输入框里的数字跟着变。
         * @param {'x'|'y'|'w'|'h'} key - 字段。
         * @param {string} label - 框前的小标签。
         * @returns {object} React 元素。
         */
        const geoInput = (key, label) =>
          h(
            'label',
            { key: `geo-${key}-${Math.round(Number(selected[key]) || 0)}`, style: Object.assign({}, S.hint, { display: 'inline-flex', alignItems: 'center', gap: 2 }) },
            label,
            h('input', {
              style: Object.assign({}, S.input, { width: key === 'w' || key === 'h' ? 68 : 62, padding: '1px 3px' }),
              type: 'number',
              min: key === 'w' || key === 'h' ? 8 : undefined,
              step: 1,
              defaultValue: Math.round(Number(selected[key]) || 0),
              title: `${label}:改完按回车或点别处生效(Ctrl+Z 可撤销)`,
              onBlur: (e) => setGeometry({ [key]: e.target.value }),
              onKeyDown: (e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = String(Math.round(Number(selected[key]) || 0));
                  e.currentTarget.blur();
                }
              },
            }),
          );
        return h(
          'div',
          { style: S.props },
          selected
            ? h(
                'div',
                { style: Object.assign({}, S.card, S.row, { padding: '4px 7px', flexWrap: 'wrap' }) },
                h('span', { style: S.badge, title: String(selected.name || '图片') }, `${String(selected.name || '图片').length > 14 ? `${String(selected.name || '图片').slice(0, 12)}…` : String(selected.name || '图片')} · ${selected.naturalW || selected.w}×${selected.naturalH || selected.h}`),
                selected && selectedMarks.length ? h('span', { style: S.badge }, `${selectedMarks.length} 处标注`) : null,
                h('span', { style: S.grow }),
                h('button', { style: Object.assign({}, S.tiny, selected.isRef ? { color: '#3b82f6' } : null), title: '标记为参考图:提交时会一起发给模型(画布角标会显示它的参考编号,提示词里写「参考图1」就能指到它)', onClick: toggleRef }, selected.isRef ? '参考✓' : '参考'),
                h('button', { style: S.tiny, title: '复制这张图到剪贴板(Ctrl+C):粘到聊天/PPT/PS 直接用', onClick: () => copyImageToClipboard(selected) }, '复制'),
                h('button', { style: S.tiny, title: multi ? `保存选中的 ${multi} 张图到工作区(一张失败不影响其余)` : '保存这张图到工作区', onClick: () => saveSelectedToWorkspace() }, multi ? `存工作区${multi}张` : '存工作区'),
                h('button', { style: S.tiny, title: multi ? `下载选中的 ${multi} 张图` : '下载这张图', onClick: () => downloadSelected() }, multi ? `下载${multi}张` : '下载'),
                h(
                  'button',
                  {
                    style: S.tiny,
                    title: `导出底图与文字(本地分层,非 AI 拆层)三个文件:成品图 + 无文字底图 + 文字参数(JSON)。底图能换尺寸重出,文字永远清晰${layerSize.trim() ? `(按 ${layerSize.trim()})` : '(按原图分辨率)'}`,
                    onClick: () => saveImageLayered(selected),
                  },
                  '导出底图与文字',
                ),
                h('button', { style: S.tiny, title: '从画布删除', onClick: deleteSelected }, '删除'),
              )
            : null,
          // 精确位置/尺寸:手拖对不齐的时候直接填数字(按像素排版时最省事)
          selected
            ? h(
                'div',
                { style: Object.assign({}, S.card, { padding: '4px 7px', display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }) },
                geoInput('x', 'X'),
                geoInput('y', 'Y'),
                geoInput('w', '宽'),
                geoInput('h', '高'),
                h('span', { style: S.hint, title: '画布像素。宽高只改这张图的显示尺寸(会拉伸画面),不改原图数据' }, 'px'),
              )
            : null,
          // 多选时才出现的对齐/分布条:一次把几张图排齐,省得一张张拖
          multi === 2 && h('div', { style: Object.assign({}, S.card, { padding: '4px 7px', display: 'flex', gap: 3, alignItems: 'center' }) },
            h('span', { style: S.hint }, '选了两张:'),
            h('button', { style: S.tiny, title: '并排/滑杆对比这两张图(只读视图,关掉不改画布;按图层顺序 A 在前)', onClick: compareSelectedTwo }, '对比这两张'),
          ),
          multi
            ? h(
                'div',
                { style: Object.assign({}, S.card, { padding: '4px 7px', display: 'flex', flexWrap: 'wrap', gap: 3 }) },
                h('span', { style: S.hint }, `对齐 ${multi} 张`),
                ALIGN_ACTIONS.map((a) => {
                  const blocked = Boolean(a.need3) && selectedIds.length < 3;
                  return h(
                    'button',
                    {
                      key: a.kind,
                      style: Object.assign({}, S.tiny, blocked ? { opacity: 0.4, cursor: 'default' } : null),
                      title: blocked ? `${a.tip}(还差一张:至少要选 3 张)` : a.tip,
                      onClick: () => {
                        if (!blocked) alignSelected(a.kind);
                      },
                    },
                    a.label,
                  );
                }),
              )
            : null,
          // ── 文字图层:本机字体、本地绘制,导出时按原图分辨率烧进去 ───────────
          selected
            ? h(
                'div',
                { style: Object.assign({}, S.card, S.col, { padding: '4px 7px' }) },
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.tiny, showText ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null),
                      title: '文字用本机字体在本地画,导出/下载时按原图分辨率烧进去 —— 比让模型写清楚得多',
                      onClick: () => setShowText(!showText),
                    },
                    `${showText ? '▾' : '▸'} 文字${(selected.texts || []).length ? `(${(selected.texts || []).length})` : ''}`,
                  ),
                  h('button', { style: S.tiny, title: '在这张图上加一条文字', onClick: addTextLayer }, '＋文字'),
                  h('span', { style: S.grow }),
                  h(
                    'label',
                    { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }), title: '默认不带:模型看到字容易去"重画"它,反而更糊' },
                    h('input', { id: 'grsai-submit-texts', type: 'checkbox', checked: submitTexts, onChange: (e) => setSubmitTexts(e.target.checked) }),
                    '提交时带上文字',
                  ),
                ),
                showText
                  ? h(
                      'div',
                      { style: Object.assign({}, S.col, { display: 'flex', gap: 5, padding: '7px 0', borderTop: `1px solid ${line}` }) },
                      h(
                        'div',
                        { style: S.hint },
                        `本机检测到 ${fontList ? fontList.length : '…'} 个候选字体;文字是矢量绘制,导出时按原图分辨率烧入(${selected.naturalW || selected.w}×${selected.naturalH || selected.h})`,
                      ),
                      h(
                        'div',
                        { style: S.row },
                        h('span', { style: S.hint }, '导出尺寸'),
                        h('input', {
                          id: 'grsai-layer-size',
                          style: Object.assign({}, S.input, S.grow),
                          placeholder: `留空 = 原图 ${selected.naturalW || selected.w}×${selected.naturalH || selected.h}`,
                          value: layerSize,
                          title: '分层导出用,和「尺寸」框一样能写人话:1080x1440 / 小红书 / A4 / 210x297mm。比例(3:4)和方向词(竖版)定不出像素,会被当成留空',
                          onChange: (e) => setLayerSize(e.target.value),
                        }),
                        h(
                          'button',
                          {
                            style: S.tiny,
                            title: '导出底图与文字(本地分层,非 AI 拆层)三个文件:① 成品图(底图+文字) ② 无文字底图 ③ 文字参数 JSON —— 底图能换尺寸重出,文字永远清晰',
                            onClick: () => saveImageLayered(selected),
                          },
                          '导出底图与文字',
                        ),
                      ),
                      (selected.texts || []).length
                        ? h(
                            'div',
                            { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                            (selected.texts || []).map((tx) =>
                              h(
                                'button',
                                {
                                  key: tx.id,
                                  style: Object.assign({}, S.tiny, tx.id === selectedTextId ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null),
                                  title: tx.value,
                                  onClick: () => setSelectedTextId(tx.id === selectedTextId ? '' : tx.id),
                                },
                                `${tx.id === selectedTextId ? '✓ ' : ''}${String(tx.value).split('\n')[0].slice(0, 8) || '(空)'}`,
                              ),
                            ),
                          )
                        : h('div', { style: S.hint }, '还没有文字 —— 点「＋文字」加一条,然后在图上拖到想要的位置'),
                      selectedText
                        ? h(
                            'div',
                            { style: S.col },
                            h('textarea', {
                              id: 'grsai-text-value',
                              style: Object.assign({}, S.textarea, { height: 54 }),
                              placeholder: '写要出现在图上的文字(支持换行)',
                              value: selectedText.value,
                              onChange: (e) => updateText(selectedText.id, { value: e.target.value }),
                            }),
                            h(
                              'div',
                              { style: S.row },
                              h('span', { style: S.hint }, '字体'),
                              h(
                                'select',
                                {
                                  id: 'grsai-text-font',
                                  style: Object.assign({}, S.input, { maxWidth: 156 }),
                                  value: selectedText.font,
                                  title: '本机已装的字体(检测到的排前面);也可以直接改文字面板里的字体名',
                                  onChange: (e) => updateText(selectedText.id, { font: e.target.value }),
                                },
                                Array.from(new Set([...(fontList || []), ...FONT_CANDIDATES, selectedText.font].filter(Boolean))).map((font) =>
                                  h('option', { key: font, value: font }, font),
                                ),
                              ),
                              h('label', { style: Object.assign({}, S.tiny, { display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }), title: '载入一个 .ttf/.otf/.woff2 字体文件(系统里没装的也能用)' },
                                '导入字体',
                                h('input', {
                                  id: 'grsai-font-file',
                                  type: 'file',
                                  accept: '.ttf,.otf,.woff,.woff2,font/*',
                                  style: { display: 'none' },
                                  onChange: (e) => {
                                    importFontFile(e.target.files && e.target.files[0]);
                                    e.target.value = '';
                                  },
                                }),
                              ),
                            ),
                            h(
                              'div',
                              { style: S.row },
                              h('span', { style: S.hint }, '字号'),
                              h('input', {
                                id: 'grsai-text-size',
                                type: 'range',
                                min: 2,
                                max: 30,
                                step: 0.5,
                                style: { flex: 1, minWidth: 90 },
                                title: '占图片高度的百分比',
                                value: Math.round((Number(selectedText.size) || TEXT_DEFAULTS.size) * 1000) / 10,
                                onChange: (e) => updateText(selectedText.id, { size: Number(e.target.value) / 100 }),
                              }),
                              h('span', { style: S.hint }, `${Math.round((Number(selectedText.size) || TEXT_DEFAULTS.size) * 1000) / 10}%`),
                              h(
                                'select',
                                { id: 'grsai-text-weight', style: Object.assign({}, S.input, { maxWidth: 78 }), value: String(selectedText.weight || 700), onChange: (e) => updateText(selectedText.id, { weight: Number(e.target.value) }) },
                                ['400', '700', '900'].map((w) => h('option', { key: w, value: w }, w === '400' ? '常规' : w === '700' ? '粗体' : '特粗')),
                              ),
                              h(
                                'select',
                                { id: 'grsai-text-align', style: Object.assign({}, S.input, { maxWidth: 72 }), value: selectedText.align || 'center', onChange: (e) => updateText(selectedText.id, { align: e.target.value }) },
                                [['center', '居中'], ['left', '左对齐'], ['right', '右对齐']].map((pair) => h('option', { key: pair[0], value: pair[0] }, pair[1])),
                              ),
                            ),
                            h(
                              'div',
                              { style: S.row },
                              h('span', { style: S.hint }, '颜色'),
                              COLORS.map((color) =>
                                h('button', {
                                  key: color,
                                  style: { width: 20, height: 20, borderRadius: 4, background: color, border: (selectedText.color || TEXT_DEFAULTS.color) === color ? '2px solid var(--dsw-alias-label-primary, #3b82f6)' : `1px solid ${line}`, cursor: 'pointer', padding: 0 },
                                  title: color,
                                  onClick: () => updateText(selectedText.id, { color }),
                                }),
                              ),
                              h(
                                'label',
                                { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }) },
                                h('input', { id: 'grsai-text-shadow', type: 'checkbox', checked: selectedText.shadow !== false, onChange: (e) => updateText(selectedText.id, { shadow: e.target.checked }) }),
                                '黑描边(在浅背景上也看得清)',
                              ),
                              h('span', { style: S.grow }),
                              h('button', { style: S.tiny, onClick: () => removeTextLayer(selectedText.id) }, '删掉这条'),
                            ),
                            h('div', { style: S.hint }, '位置:在选择工具下直接把文字拖到想要的地方;字号是"占图高的比例",所以换尺寸/导出都不会跑位'),
                          )
                        : null,
                    )
                  : null,
              )
            : null,
        );
      }

      return { renderPropsCard };
    });
