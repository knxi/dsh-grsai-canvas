# 步骤 1 落地记录:审计修复 + D 布局骨架 + 属性区拆分(0.20.0 → 0.21 骨架)

日期:2026-10-11。对应任务书第一期 D(UI 重构与清理);执行顺序按用户指示「审计+D 布局骨架 → A → B → C → D 清理收尾」,本文件记录第一步。

## 一、审计修复(docs-ui-audit.md 全部成立项)

| 审计结论 | 处理 | 证据 |
| --- | --- | --- |
| DRAW_TOOLS 死代码(01-constants.js:67) | 删除 | 全库零引用 |
| TOOL_ICONS.text/.pen 零引用(06-utils.js:8-9) | 删除 | 同上 |
| upscale engineStatus 死函数(upscale.js:391) | 删除 | 调用链实际走 inspectTier+tierFiles(index.js:1155) |
| text/pen 工具链整体失效 | 整链移除:12-canvas-tab 写入口/pen 分支/commitText/光标分支、30-text-input.js 整文件 | setTool 仅剩可达分支;30-text-input.js 已删除 |
| togglePanel('ws') 死代码 | togglePanel 重写为簇分发(见下) | 12-canvas-tab.js |
| saveDraft / runAgentLayering 缺 featuresRef 守卫 | 补 `featuresRef.current.includes('ws-save')` / `'layering-test'` 守卫,旧宿主给「重启 DSH」提示 | 12-canvas-tab.js:1676/:1112 |
| FEATURES 缺 'layering-test'(index.js:54) | 补上;**需重启 DSH 宿主生效** | lib/index.js |
| 32-layer-key-panel 测试连接缺 layerHostReady 判断 | disabled 补 `!layerHostReady`,title 补旧宿主提示 | 32-layer-key-panel.js:120 |
| 语义重复:「清空」撞名 | 跨平台「清空」→「取消勾选」 | 25-gen-card.js |
| 「分层」语义混淆 | 按钮「分层」→「导出底图与文字」(两处),与 Agent PSD 拆层区分 | 25/35 |
| saveImageToWorkspace 传给 gen-card 未使用 | 已随依赖清理移除 | 25-gen-card deps |

## 二、D 布局骨架(八分区)

- **顶部紧凑导航**(21-topright.js 重写):＋图片 / 工作区 / Skills / 记录 | 分层 / 放大 | popOut / 设置;`left:6 right:6 top:6` flexWrap。
- **左侧工具栏**(20-toolbar.js):`left:6 top:42`,编辑工具+颜色粗细。
- **画布视图控制**(新零件 34-viewbar.js,definePart('viewbar')):左下 `left:6 bottom:40`,−/缩放值/＋/适应/100%。
- **受控停靠区**(新零件 36-dock.js,definePart('dock')):右侧 `right:6 top:42` 宽 302,四标签 记录/图层(本期占位)/工作区/Skills 互斥单开,再点同标签收起;`dockOpen: ''|'history'|'layers'|'workspace'|'skills'`。26/28/29 三个面板改为无外壳内容块装进 dock。
- **设置簇**(27/32/33):独立弹层 `right:6 top:42`,互斥,不占停靠区;models/sizes 仍锚定生成卡内弹出。
- **生成区**(25-gen-card 瘦身):只留生成相关(主图/参考摘要、场景框、提示词、模型尺寸、preflight、跨平台、主按钮);保存画布/清空画布迁到 27-settings-panel 底部「低频维护」(清空加 confirm)。
- **选中对象属性区**(新零件 35-props-card.js,definePart('props-card')):图片操作行(参考/复制/存工作区/下载/导出底图与文字/删除)+ 对齐分布条(多选)+ 文字图层块;仅选中时出现(未选不渲染),与生成卡同列(S.stack,right:6 bottom:40 纵向 flex)。
- S.gen 改 relative 并入 S.stack 容器;窄屏(<640)dock 占满宽。STATE_ORDER:删 showWs/showHistory/showSkills,加 dockOpen。

## 三、UI 对照(ui-compare\before|after,tools/ui-snapshot.mjs 生成)

- 同 harness、同场景(样图+文字层)、4 视口截图 + 默认可见入口计数。
- **按钮数(默认可见):重构前 50 → 重构后 47**(text/pen 死按钮移除、保存画布/清空/生成记录浮层入口收进导航与设置)。
- 差异清单(before→after):「生成记录(0)」→「记录」(停靠区标签);「存」→「存工作区」;「分层」→「导出底图与文字」;「保存画布/清空」→设置面板;「参考:sample… ✕」chip 与 preflight 1 条误报消失 —— 这是 0.20.0 zip 里主选图被当成自己的参考图的既有 bug,工作区已有修复(12-canvas-tab.js:213 `refCount` 排除 `selectedId`),非本次重构引入。

## 四、验证(全部通过)

- `node tools/build-client.mjs` → 33 零件;`node tools/check-deps.mjs` → 依赖清单全部对齐;`node --check lib/client.js lib/index.js`。
- `check-preflight` 15/15;`check-canvas-regressions` 8/8。
- `check-canvas-browser`(Edge):蒙版像素/空场景框/尺寸输入清理 + 1200×900、390×700、360×640、640×420 四视口浮层不越界、主按钮可达、模型菜单可点。展开文字层场景右列 props/gen 各自滚动、无重叠(几何已核)。

## 五、本步遗留

- 属性区展开文字层且视口矮时,propsCard 底部被滚动裁切(overflow auto,可滚,showText 默认收起时无此现象)——记录为已知限制。
- 「低频维护」的清空确认属 C 期「清空画布二次确认」条目,已提前实现,待 C 期一并回归。
- 本地修补未发布:工作区相对 v0.20.0.zip 另有 refCount/参考 chip 修复(见三),交付时注明。
