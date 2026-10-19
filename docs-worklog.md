# dsh-grsai-canvas 任务书第一期 · 工作日志（接手恢复用）

> 最后更新：2026-10-10。任务书：`DeepSeek开发任务书-画布功能增强.md`（同目录，455 行，全文可重读）。
> 配套文档：`docs-ui-audit.md`（UI 审计表完整版）、`docs-history-design.md`（A 存储方案设计稿）、`交接文档.md`（§6.0 本地修补 8 项必须保留）。

## 任务状态总览

- [x] 基线核实：§6.0 本地修补 8 项已在源码（submissionRegion 09-marks.js:290；41-generate.js:62；12-canvas-tab.js:223）；tools 齐（check-canvas-regressions.mjs / check-canvas-browser.mjs / check-preflight.mjs）
- [x] 基线检查全绿：build 31 零件 361986 字符、--check、check-deps、node --check ×2、check-preflight exit=0、check-canvas-regressions 8 项 exit=0、check-canvas-browser 四视口全过（Playwright 在 C:\Users\su\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright，浏览器 Edge）
- [x] UI 入口审计 3/3 完成 → `docs-ui-audit.md`
- [x] A 存储方案设计稿 → `docs-history-design.md`
- [ ] D 布局骨架（信息架构重构）
- [ ] A 持久生成记录与参数复用
- [ ] B 对比视图
- [ ] C 图片图层管理
- [ ] D 清理与回归 + 新增测试
- [ ] 交付（任务书 §11 格式）

## 审计核心结论（完整版见 docs-ui-audit.md）

- 失效工具链 2 条（D 期移除）：text 画布文字标注（入口被摘 TOOLS 无 text，30-text-input.js:13 永不渲染；渲染 09-marks.js:129-146/删除:259 保留兼容旧存档）、pen 钢笔（12:1935，与 brush 重叠）
- 死代码 4：togglePanel('ws')（12:1030）、DRAW_TOOLS（01:67）、TOOL_ICONS.text+pen（06:8-9）、upscale.js:391 engineStatus()
- 需修复调用链：32-layer-key-panel.js:119-124「测试连接」disabled 补 !layerHostReady + FEATURES(index.js:54) 补 'layering-test'；保存画布 hostStale 静默拒（25:667+12:479）；applySkill toggle 坑（25:594-600+12:1043）；删框 lastFrame 兜底（25:212,235）；「上游最近:」裸 JSON（25:129-135）；saveDraft(12:1701)/runAgentLayering(12:1133) 补 ws-save feature 守卫
- 语义/重复：主按钮 4 态合 1（拆生成/停止）；「存」×2 撞名（gen-card 批量 vs history 单张→统一「存工作区」）；「清空」×2（25:614 取消勾选改名）；分层导出双入口（25:177/25:343 同函数合并）；未使用注入 saveImageToWorkspace（12:2446→25:77）
- 迁移候选（生成区移出）：图片操作行 5 钮（25:166-182 复制/存/下载/分层/删除）、对齐条 8 钮（25:186-207）、保存画布/清空（25:667-668）、文字图层整块（25:290-455）
- 宿主路由 21 条健康（客户端 404 为 0）；FEATURES 漏列 'layering-test'

## 关键工程事实

- 装配：cd E:\ds-h\_dl\publish\dsh-grsai-canvas && node tools/build-client.mjs（--check 校验；client.js 是产物勿手改）
- 检查：node tools/check-deps.mjs；node --check lib/client.js；node --check lib/index.js；node tools/check-preflight.mjs；node tools/check-canvas-regressions.mjs
- 浏览器回归：$env:PLAYWRIGHT_MODULE='C:\Users\su\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'；$env:CANVAS_BROWSER='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'；node tools/check-canvas-browser.mjs（四视口 1200x900/390x700/360x640/640x420，截图写 browser-check/）
- 宿主改 lib/index.js 必须重启 DSH（重启DSH.cmd / DSH.exe --restart）；客户端装配+刷新即生效
- 零件机制：definePart/rt/deps（deps Proxy 缺依赖访问即抛"零件 X 缺依赖:Y"）；新 useState 同步 06-utils.js STATE_ORDER（75 项）
- /ws-save：POST {path,dataUrl}，仅 image/* 或 .json，mkdir recursive 支持子目录；/ws-file 仅读图片；/ws-list 仅列图片 → A 方案需新增 GET /history-manifest 读 画布/history/index.json + FEATURES 加 'history' 能力位
- 本会话禁止：付费生成、发布、改版本号、重启 DSH、提交 Git、新增依赖
- A 方案要点（docs-history-design.md）：存储 画布/history/index.json + rec/<recordId>.png；写走 /ws-save（先资源后清单）；读走新路由 GET /history-manifest（缺失/损坏→空清单+corrupted 标记，不覆盖原文件）；FEATURES 加 'history' 旧宿主降级；去重键 (工作区, taskId||recordId)；限额 200 条；恢复参数只回填不自动生成；userInput 与 finalPrompt 分开存
