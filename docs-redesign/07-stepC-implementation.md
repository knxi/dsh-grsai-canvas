# 步骤 C 实施记录 — 图片图层管理(第一期 C)

对应任务书「第一期 C 图片图层管理」。前置:步骤 1(审计 + D 布局骨架)、A(持久生成记录)、B(对比视图)均已完成(见 04/05/06 号文档)。

## 一、要求 → 实现对照

| 任务书要求 | 实现 | 证据 |
| --- | --- | --- |
| 紧凑列表(缩略图/名称/参考标记/显示/锁定) | `lib/parts/38-layers-panel.js`(新零件,definePart('layers-panel')):每行 = 34×34 缩略图 + 名称 + 「参考」徽章 + 参/隐/锁三个开关 + 删按钮 | 38-layers-panel.js:107-174 |
| 点击选择与画布同步、多选 | 行 onClick → `selectImageFromPanel(id, event)`(12-canvas-tab.js,useCallback):Ctrl/Meta/Shift = 加选/减选,否则单选并清文字/场景框选择 | 12-canvas-tab.js 渲染段接线 |
| 重命名 | 双击行内改名(input,Enter 提交 / Esc 取消 / blur 提交);`renameImage(id,name)` 锁定挡、空名不改 | 42-images.js |
| 隐藏/锁定开关 | `setImageFlag(id,key,value)` 通用开关(isRef/hidden/locked);锁定图放行显式开关(否则锁定的图无法从提交集合摘出) | 42-images.js:207 |
| 拖动排序 | 行 draggable;上半 = 插到该图前,下半 = 下一图前(末行下半 = 顶层);`moveImageTo(id,beforeId)` 锁定挡、拖到自己 = 不动 | 38-layers-panel.js:92-104, 42-images.js |
| 面板顺序 = doc.images 数组顺序 | rows 直接 map images;首行 = 最底层,与左侧工具栏 reorderSelected 同语义 | 38-layers-panel.js:61 |
| 复用 reorderSelected(上移/下移/置顶/置底) | 左侧工具栏四按钮未动(20-toolbar.js),同一数组语义 | 20-toolbar.js:8-13 |
| 隐藏图:不绘制/不命中/不作参考/不可作主图 | 绘制循环与标注循环 skip hidden(12:343/375);hitImage/hitHandle skip;refCount 排除(12:249);25-gen-card refs 过滤 +「另有 N 张隐藏参考图不参与」;41-generate target.hidden 报错 + refImages 排除 | 12-canvas-tab.js:342-344, 25-gen-card.js:157, 41-generate.js:341 |
| 锁定图:可显示可选中查看,不可编辑 | 锁定图正常绘制,画「已锁定」灰标签、无缩放柄;onPointerDown 命中锁定图选中后 return(不拖);绘制工具 target locked → notice「先解锁」;renameImage/moveImageTo/普通删除全部锁定挡 | 12-canvas-tab.js 选中框段 |
| 普通删除跳过锁定并反馈 | `deleteSelected` 重写:跳过锁定,notice「选中的 N 张图都锁着,已跳过;删了 M 张」;全锁时不产生撤销步骤 | 42-images.js |
| 清空画布二次确认(含隐藏/锁定) | `clearCanvas` 重写:window.confirm 明示总图数 + 隐藏数 + 锁定数 + Ctrl+Z 可撤销 | 42-images.js |
| 混合多选一次操作一个撤销步骤 | 所有动作经 finishChange(一次 cloneDoc 压栈) | 12-canvas-tab.js:501 |
| 修改可撤销重做 + 自动保存;仅选择不产生撤销 | hidden/locked 是 doc.images 上的布尔,cloneDoc 浅拷 + saveNow 原样序列化,撤销/保存自然一致;面板行点击只 set 选中态 | 07-textlayer.js:272, 12:529 |
| 适应视口只算可见 | fitAll 过滤 hidden | 12-canvas-tab.js |
| 旧文档兼容(hidden/locked 缺省) | 载入归一化 `hidden: Boolean(...)`、`locked: Boolean(...)`;addImageFromDataUrl 字面量补默认值;生成结果导入同路径 | 12-canvas-tab.js:1269 附近 |
| 面板入口:历史/图层/资源/Skills 互斥停靠区 | 36-dock.js 的 layers 标签接真实面板(步骤 1 是占位),badge = images.length | 36-dock.js:43-44 |
| 布局避让 | dock 打开时属性卡+生成卡整列 right:314 让位(窄屏 <640 dock 全宽,不避让) | 12-canvas-tab.js 渲染段 rightStack |

## 二、改动文件

- `lib/parts/38-layers-panel.js` — 新建(图层面板零件)。
- `lib/parts/42-images.js` — deleteSelected/clearCanvas 重写;新增 setImageFlag/renameImage/moveImageTo。
- `lib/parts/36-dock.js` — layers 标签接真实面板 + badge。
- `lib/parts/12-canvas-tab.js` — 绘制/命中/框选/fitAll/载入归一化/选中框/pointer 流程按隐藏锁定规则改;新增 selectImageFromPanel、layerRenameId/layerRenameText state;rightStack 布局避让。
- `lib/parts/25-gen-card.js` — 参考图过滤隐藏 + 隐藏参考计数提示。
- `lib/parts/41-generate.js` — 隐藏主图拦截报错;参考图排除隐藏。
- `lib/parts/06-utils.js` — STATE_ORDER 加 layerRenameId/layerRenameText。
- `lib/client.js` — build-client 重建(36 零件)。
- `tools/check-layers.mjs` — 新建离线回归(15 项)。
- `tools/check-layers-browser.mjs` — 新建浏览器回归(7 段)。

## 三、设计决策(与任务书的取舍)

1. **锁定挡「改内容和位置」,放行「显式开关」**:拖/缩/标注/改名/排序/普通删除被锁定挡;isRef/hidden/locked 三个开关对锁定图放行。理由:锁定的本意是防误改内容,若连「隐藏/取消参考」都挡住,锁定图就永远无法从提交集合摘出。
2. **隐藏图可被面板选中**(行高亮),但画布点不到——便于在面板里点「显」找回。
3. **面板顺序 = 数组顺序,首行 = 最底层**:与工具栏 reorderSelected 和 z 绘制顺序(数组序 = 绘制序)一致,不引入第二顺序源。
4. **拖动落点的「上半/下半」语义**:上半插到该图前 = 该图层之下;下半 = 之上(顶层时为 null)。fake 事件无 offsetY 时兜底上半。
5. **清空画布用 window.confirm**:插件内无模态组件先例,原生 confirm 最小实现且不可被画布事件穿透;文案明示包含隐藏/锁定数量。
6. **锁定图上生成放行**(作为主图或参考均可,结果必是新对象)——任务书原文如此。

## 四、验证结果

命令与退出码(全部 0):

| 命令 | 结果 |
| --- | --- |
| `node tools/check-layers.mjs` | 15/15(删除跳锁/全锁反馈/开关/改名/排序/清空确认/面板渲染与行开关) |
| `node tools/check-layers-browser.mjs` | 7 段全过:dock badge+两行;隐藏 B 像素消失+命中排除+状态栏参考数排除;锁 A 拖不动+行删跳过;/state payload 序列化 hidden/locked;隐藏主图点「按标注改图」被拦;旧存档无字段兼容渲染 |
| `node tools/check-canvas-regressions.mjs` | 8/8 |
| `node tools/check-preflight.mjs` | 15/15 |
| `node tools/check-history.mjs` | 11/11 |
| `node tools/check-compare.mjs` | 全部通过 |
| `node tools/check-deps.mjs` | 依赖清单对齐 |
| `node tools/build-client.mjs` | 36 零件,424205 字节 |
| `node --check lib/client.js` `node --check lib/index.js` | 通过 |

浏览器回归截图:`browser-check/layers-dock.png`(dock 图层标签 + badge「图层 2」+ 两行,状态栏「2 图 / 1 参考」)、`layers-locked.png`、`layers-legacy.png`。

测试基建踩坑(供后人):fake h 的嵌套属性在 `.props` 下;锁定行名称带 `🔒 ` 前缀,断言须用 includes;生成卡的参考 chip 文本也含文件名,行定位要取最近 `div[draggable]` 祖先;canvas 无图区域本来透明(alpha 0),像素断言以 alpha+色相表达;draw 不跑 rAF 时手动调 drawRef(name==='draw' 的函数 ref)作像素基线。

## 五、已知限制

- 图层不做组树/PS 引擎/分页(任务书明确不做)。
- Esc 关闭面板/改名框的人工验收未自动化(同 B 期)。
- 面板重命名 blur 提交与行点击选中同发时,以 blur 先提交再选行为准(原生顺序)。
- 浏览器回归在 1280×720 fake 宿主下运行;真实宿主(重启 DSH 后)的指针/滚轮手感需人工验收 11 步脚本。
