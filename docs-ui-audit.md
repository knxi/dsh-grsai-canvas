# dsh-grsai-canvas UI 入口审计表（任务书第一期 D 前置审计）

> 审计日期：2026-10-10。审计方式：静态通读 + 链路核对 + 宿主路由全表对照（3 个并行审计）。
> 判定口径：「缺配置/暂不可用」≠「已废弃」；「代码存在」≠「功能有效」。行号可直接定位。
> **处理结果（2026-10-11，D 期收尾）**：第二节 6 项全部落地（text/pen 整链已删，30-text-input.js 已删；DRAW_TOOLS、TOOL_ICONS.text/.pen、engineStatus 已删；openWorkspace 已改走停靠区 setDockOpen('workspace')，togglePanel 死分支随簇分发重写消失）。第三节 6 项全部修复（32 测试连接补 !layerHostReady + FEATURES 加 'layering-test'；保存画布 hostStale 禁用+提示；applySkill forceOn 置值；lastFrame→shownFrame 明确删选中框；lastUpstream details 折叠；saveDraft/runAgentLayering 补 featuresRef 守卫）。第四节 5 项语义处理全部落地（主按钮保持 4 态合一但按上下文命名；「存工作区」统一；「取消勾选」改名；「导出底图与文字」改名两处；saveImageToWorkspace 未使用注入已从 gen-card deps 移除）。第五节迁移清单前 4 项落地：图片操作行/对齐条/保存清空/文字图层整块已迁入 35-props-card.js（选中对象属性区，仅选中时出现），gen-card 仅保留生成流程；第 5 项（Skills Agent 动作）按计划保留。验证：check-deps/check-preflight 15/15/check-canvas-regressions 8/8/check-layers 15/15/check-layers-browser 7 段/check-history 11/11/check-compare 全绿；截图 browser-check/ui-final-*.png。第七节 3 项运行时验证仍待真实宿主（见交付文档已知限制）。

## 一、汇总

- 客户端入口约 116（工具栏/顶栏/键盘手势 54 + 生成区/面板 62）+ 纯展示 22
- **失效 2**：text 画布文字标注工具链、pen 钢笔工具链（入口被摘、下游全在）
- **待验证 2**：两个 Agent 动作依赖宿主注入 agentBridge（函数存在、链路通、缺桥兜底正确）
- **条件可用 6+**：复制（ClipboardItem 降级）、保存画布（hostStale 静默拒）、Skills 自定义模板 3 控件（旧宿主）、图层顺序 4 键（未选中灰置）、popOut（float 运行时）
- **死代码 4**：togglePanel('ws')（12:1030）、DRAW_TOOLS（01:67）、TOOL_ICONS.text+pen（06:8-9）、upscale.js:391 engineStatus()
- **宿主路由 21 条**：客户端 404 为 0；孤儿 /debug（有意，保留）；FEATURES 漏列 /layering-test
- **设置面板分层残留 0**（已完整迁至 🔑 浮层）

## 二、失效与死代码（处理决定）

| 项 | 证据 | 决定 |
| --- | --- | --- |
| text 画布文字标注工具链 | 唯一写入口 12-canvas-tab.js:1922（tool==='text'→setTextDraft）不可达：TOOLS(01-constants.js:57-66) 无 text、setTool 仅 3 处(2143/2228/2294)；下游 30-text-input.js:13 永不渲染、commitText:2165 不可达；渲染 09-marks.js:129-146、describeMarks:211、删除:259、图标 06-utils.js:8 全在 | **D 期移除整链**（文字图层 addTextLayer:1485 是活功能已覆盖加字；旧存档 text mark 仍能显示/删除，保留渲染与删除分支） |
| pen 钢笔工具链 | 绘制 12:1935-1936、拖动 2048、渲染 09-marks.js:64-86、describeMarks:208-210、图标 06-utils.js:9 全在但 TOOLS 无 pen 不可达 | **D 期移除整链**（与 brush 高度重叠） |
| togglePanel('ws') | 12-canvas-tab.js:1030 全库零调用；工作区实际由 openWorkspace(42:435) 直控 setShowWs 且不收起其他浮层 | **修复**：openWorkspace 改走 togglePanel('ws') 统一互斥逻辑 |
| DRAW_TOOLS | 01-constants.js:67 零引用 | **移除** |
| TOOL_ICONS.text / .pen | 06-utils.js:8-9 | 随 text/pen 工具链移除 |
| upscale.js:391 engineStatus() | 全库零调用（/upscale-status 用 inspectTier+tierFiles 组装） | **移除** |

## 三、需修复的调用链（本期保留功能的失效项）

1. **「测试连接」缺宿主守卫**：32-layer-key-panel.js:119-124 disabled 只有 `busy||!layerCfg.hasKey`，同面板其他按钮(:110/:139/:153)都有 `!layerHostReady`；且 `/layering-test` 不在 FEATURES(index.js:54)。→ 修复：disabled 补 `!layerHostReady` + FEATURES 增 `'layering-test'`。
2. **保存画布 hostStale 静默拒**：25-gen-card.js:667 按钮 `保存画布`→saveNow(12:479)，hostStale 时 setSaved('宿主旧版:没存') 但按钮不灰、无弹错。→ 修复：hostStale 时禁用+提示。
3. **applySkill toggle 语义坑**：25:594-600「套用留白配图」→applySkill(12:1043)；若该模板已激活，toggle 语义变成"取消模板"。→ 修复：跳过 toggle 直接置值。
4. **删框 lastFrame 兜底**：25:212,235 多框时删的未必是用户心里那个。→ 修复：明确删选中框。
5. **「上游最近:」裸 JSON**：25:129-135 上游 JSON 前 260 字原样展示。→ 修复：人话摘要或折叠。
6. **saveDraft/runAgentLayering 无逐次 feature 守卫**：12:1701、12:1133 与 saveSkills(12:1076) 模式不一致。→ 统一补守卫。

## 四、语义与重复（D 重构处理）

- 主提交按钮 4 态合 1（生成新图/按标注改图/跨平台出图(N 张)/⏹ 打断）——重构拆「生成/停止」两钮，按上下文命名。
- 「存」×2 撞名：gen-card「存N张」=saveSelectedToWorkspace(批量)，history「存」=saveImageToWorkspace(单张) → 统一改名「存工作区」。
- 「清空」×2 撞名：跨平台「清空」(25:614,取消勾选) vs 画布「清空」(25:668) → 前者改名「取消勾选」。
- 「分层」(25:177) 与「分层导出」(25:343) 同函数 saveImageLayered 两处按钮 → 合并留一（或改可区分名称：「导出底图与文字」）。
- 未使用注入：saveImageToWorkspace 在 12:2446 传入 gen-card 但 25:77 解构后未使用 → 清理。
- 快捷键冗余（有意保留）：重做×3、撤销×2、适应×2、100%×2、8 工具按钮+单键、平移 4 手势；Alt+拖平移是隐藏手势（文档化）。

## 五、混入生成区的非生成功能（D 重构迁移清单）

| 现位置 | 内容 | 去向（任务书 §6.2） |
| --- | --- | --- |
| 25-gen-card 图片操作行（25:166-182） | 复制/存/下载/分层/删除 5 项 | 选中对象属性区 |
| 25-gen-card 对齐条（25:186-207，8 钮） | 对齐/分布 | 画布工具区或图层/属性区 |
| 25-gen-card（25:667-668） | 保存画布/清空画布 | 设置/更多或画布菜单（破坏性操作远离主按钮） |
| 25-gen-card 文字图层整块（25:290-455） | 加文字/字体/字号/描边/导入字体/分层导出/导出尺寸 | 选中对象属性区（选中含文字时出现） |
| 26-skills-panel 两个 Agent 动作（26:97-140） | 图片分层/帮我写提示词 | 保留（Agent 助手与图像模板分区组织） |

## 六、宿主路由全表（21 条，lib/index.js handle()）

/ping(650) /debug(656,孤儿有意) /ws-list(662) /ws-file(672,仅图片) /ws-save(689,图片或.json) /skills GET+POST(709/741) /layering-config GET+POST(760/781) /layering-test(835) /layering-models(858,60s缓存) /state GET+POST(959/991,48MB) /generate(代理 GrsAI) /result /image(1045,SSRF防护) /update/status|check|apply|rollback /upscale-status|ensure|run。底层 lib/update.js、lib/upscale.js 函数链路完整。客户端 404 路由 0。

## 七、待验证（运行时）

- popOut 的 ctx.sidebarRight.float 运行时行为（99-entry.js:134，代码完整）
- agentBridge 注入（runAgentLayering/askAgentPrompt 依赖 props.agentBridge，缺桥兜底正确）
- 剪贴板 ClipboardItem 写入（42:400，降级提示已实现）
