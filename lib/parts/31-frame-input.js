/* 场景框(生成框)放置弹窗:点画布后在点击处输入尺寸/比例(800x600 / 210x297mm / 3:4)。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`clamp` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('frame-input', () => {
      // 场景框放置弹窗:点画布后在这里输入尺寸/比例
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderFrameInput(p) {
        const { confirmFrame, frameDraft, setFrameDraft, size } = p;
        return frameDraft
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  left: clamp(frameDraft.sx, 4, Math.max(4, size.w - 320)),
                  top: clamp(frameDraft.sy - 44, 4, Math.max(4, size.h - 44)),
                  zIndex: 6,
                  display: 'flex',
                  gap: 4,
                  alignItems: 'center',
                  background: panelBg,
                  border: `1px solid ${line}`,
                  borderRadius: 8,
                  padding: 6,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
                },
              },
              h('input', {
                id: 'grsai-frame-size-input',
                autoFocus: true,
                value: frameDraft.value,
                placeholder: '800x600 / 210x297mm / 3:4',
                style: Object.assign({}, S.input, { width: 180 }),
                onChange: (e) => setFrameDraft(Object.assign({}, frameDraft, { value: e.target.value })),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmFrame();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setFrameDraft(null);
                  }
                },
              }),
              h('button', { style: S.primary, onClick: confirmFrame }, '放框'),
              h('button', { style: S.tiny, onClick: () => setFrameDraft(null) }, '取消'),
            )
          : null;
      }

      return { renderFrameInput };
    });
