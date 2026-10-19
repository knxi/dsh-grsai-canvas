/* Skills 模板内容块:内置模板按分组摆成几栏 + 自定义模板的增删。连同它用的两个局部辅助(`skillChip` 一颗模板按钮、`builtinSkillGroups` 分组)一起收进来。
 *
 * 0.21 起本零件只出内容块(不带浮层外壳),装进右侧停靠区(36-dock)的「Skills」标签;
 * 开合由 `dockOpen` 控制,这里不再判断。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`BUILTIN_SKILLS`/`SKILL_GROUPS` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('skills-panel', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderSkillsPanel(p) {
        const {
          activeSkill,
          activeSkillId,
          addSkill,
          agentBusy,
          applySkill,
          askAgentPrompt,
          featuresRef,
          hostFeatures,
          runAgentLayering,
          saveSkills,
          setActiveSkillId,
          setSkillDraft,
          skillDraft,
          skills,
        } = p;

        /** Skills 模板的一颗按钮(选中的高亮;自定义的带删除)。 */
        const skillChip = (preset, custom) =>
          h(
            'span',
            { key: preset.id, style: { display: 'inline-flex', alignItems: 'center', gap: 1 } },
            h(
              'button',
              {
                style: Object.assign(
                  {},
                  S.wideBtn,
                  { textAlign: 'left' },
                  activeSkillId === preset.id ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null,
                ),
                title: preset.desc || String(preset.prompt).slice(0, 60),
                onClick: () => applySkill(preset.id),
              },
              `${activeSkillId === preset.id ? '✓ ' : ''}${preset.name}`,
            ),
            custom
              ? h(
                  'button',
                  {
                    style: S.tiny,
                    title: '删除这个自定义模板',
                    onClick: async () => {
                      if (await saveSkills(skills.filter((item) => item.id !== preset.id))) {
                        if (activeSkillId === preset.id) setActiveSkillId('');
                      }
                    },
                  },
                  '✕',
                )
              : null,
          );

        /** 按分组把内置模板摆成几栏(漏分组的自动归到「其他」,不会掉出面板)。 */
        const builtinSkillGroups = (() => {
          const groupedIds = SKILL_GROUPS.reduce((acc, g) => acc.concat(g.ids), []);
          const ungrouped = BUILTIN_SKILLS.filter((preset) => !groupedIds.includes(preset.id));
          const groups = ungrouped.length
            ? SKILL_GROUPS.concat([{ label: '其他', ids: ungrouped.map((s) => s.id) }])
            : SKILL_GROUPS;
          return groups
            .map((group) => ({ label: group.label, items: BUILTIN_SKILLS.filter((preset) => group.ids.includes(preset.id)) }))
            .filter((group) => group.items.length);
        })();

        /** Skills 模板内容块:选一个套路,或自己加一个。 */
        return h(
              'div',
              { style: Object.assign({}, S.col, { gap: 6 }) },
              h(
                  'div',
                  { style: Object.assign({}, S.col, { gap: 4 }) },
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.wideBtn, {
                        textAlign: 'left',
                        fontWeight: 600,
                        opacity: agentBusy ? 0.6 : 1,
                        cursor: agentBusy ? 'default' : 'pointer',
                      }),
                      disabled: agentBusy === true,
                      title: AGENT_LAYERING.desc,
                      onClick: () => {
                        if (!agentBusy) runAgentLayering();
                      },
                    },
                    agentBusy ? '⏳ 正在交给 Agent…' : `▶ ${AGENT_LAYERING.name}`,
                  ),
                  h(
                    'div',
                    { style: S.hint },
                    '上面这批是图像模型模板;这条走 DSH agent:把选中的图(没选就用最后导入/生成的那张)落盘后交给对话,由 image-layering 技能拆成可编辑图层,先出 PSD,不跑矢量。',
                  ),
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.wideBtn, {
                        textAlign: 'left',
                        fontWeight: 600,
                        opacity: agentBusy ? 0.6 : 1,
                        cursor: agentBusy ? 'default' : 'pointer',
                      }),
                      disabled: agentBusy === true,
                      title: '把选中的图连同你写的草稿交给对话里的 agent,让它回一条能直接用的提示词',
                      onClick: () => {
                        if (!agentBusy) askAgentPrompt();
                      },
                    },
                    agentBusy ? '⏳ 正在交给 Agent…' : '✎ 帮我写提示词',
                  ),
                  h(
                    'div',
                    { style: S.hint },
                    '不用自己憋词:把你想到的几句草稿丢进去,agent 看着图帮你写成完整提示词 —— 只走对话,不发出图任务、不花额度。',
                  ),
                  h('div', { style: { height: 1, background: line, margin: '4px 0' } }),
                ),
                h('div', { style: S.hint }, '选一个套路就按它改,不选就是普通改图(再点一次取消)。模板文字会排在你写的要求前面一起发出去。'),
                hostFeatures !== null && !featuresRef.current.includes('skills')
                  ? h(
                      'div',
                      { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                      '⚠ 宿主半边是旧版:内置模板现在就能用,但「自定义模板」(读取/保存)要**重启一次 DSH** 才生效。',
                    )
                  : null,
                h(
                  'div',
                  { style: S.col },
                  builtinSkillGroups.map((group) =>
                    h(
                      'div',
                      { key: group.label, style: S.col },
                      h('div', { style: Object.assign({}, S.hint, { fontWeight: 600, marginTop: 2 }) }, group.label),
                      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, group.items.map((preset) => skillChip(preset, false))),
                    ),
                  ),
                ),
                h('div', { style: S.hint }, skills.length ? `自定义(${skills.length})` : '还没有自定义模板'),
                skills.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, skills.map((preset) => skillChip(preset, true))) : null,
                activeSkill
                  ? h(
                      'div',
                      { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-label-primary, #3b82f6)' }) },
                      `当前:${activeSkill.name} —— ${activeSkill.desc || String(activeSkill.prompt).slice(0, 60)}`,
                    )
                  : null,
                hostFeatures === null || featuresRef.current.includes('skills')
                  ? h(
                      'div',
                      null,
                      h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
                      h('div', { style: S.hint }, '＋ 自己加一个(存在工作区里,换台机器 / 换个人也跟着走)'),
                      h('input', {
                        id: 'grsai-skill-name',
                        style: Object.assign({}, S.input, { width: '100%' }),
                        placeholder: '名称,例如「证件照」',
                        value: skillDraft.name,
                        onChange: (e) => setSkillDraft(Object.assign({}, skillDraft, { name: e.target.value })),
                      }),
                      h('textarea', {
                        id: 'grsai-skill-prompt',
                        style: Object.assign({}, S.textarea, { height: 68 }),
                        placeholder: '这个模板要实现什么?例如:把照片做成白底证件照,正面免冠、头肩比例规范…',
                        value: skillDraft.prompt,
                        onChange: (e) => setSkillDraft(Object.assign({}, skillDraft, { prompt: e.target.value })),
                      }),
                      h(
                        'div',
                        { style: S.row },
                        h('button', { style: S.wideBtn, onClick: addSkill }, '保存为模板'),
                        h('span', { style: S.grow }),
                        h('span', { style: S.hint }, '存到 <工作区>/画布/skills.json'),
                      ),
                    )
                  : null,
            );
      }

      return { renderSkillsPanel };
    });
