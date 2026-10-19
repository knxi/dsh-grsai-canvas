# 第一期 B:对比视图 — 实现对照表

对应任务书「第一期 B 对比视图」。入口、约束、验收逐条对照;验证命令与退出码见文末。

## 1. 任务书要求 → 实现

| 任务书要求 | 实现 | 位置 |
| --- | --- | --- |
| 两图画布图设 A/B | 多选两张时属性区出现「对比这两张」;按图层顺序 A 前 B 后 | `lib/parts/35-props-card.js`(multi===2 行)→ `12-canvas-tab.js` `compareSelectedTwo()` |
| 从记录打开,优先匹配来源图 | 记录行「对比」:B=记录结果图(本地 `file` 优先,`sourceUrl` 兜底经图片代理),A=画布上 `sourceId` 匹配的来源图;缺 A 明确报错并指路(先「放入画布」或改用双选入口) | `28-history-panel.js` 行按钮 → `12-canvas-tab.js` `compareRecord(record)` |
| 左右并排 + 滑杆叠加两模式 | 顶栏分段钮「并排 / 滑杆叠加」;并排=左右半区,滑杆=中心叠放+clip 裁剪+分割线手柄 | `lib/parts/37-compare-view.js` `drawCompareCanvas()` `drawSide()`/slider 分支 |
| 可交换 | 「⇄ 交换」按钮,只对调绘制角色,不改画布数据 | `37-compare-view.js` 顶栏 → `compareSwap` state |
| 并排同步缩放/平移 | 单一 zoom 语义(图像像素→CSS 像素倍率)+单一 pan,同时作用于两图 | `drawCompareCanvas()` 同参绘制;`compareWheel`/`comparePointer*` |
| 适应视口 + 100% | 适应=两图并排半区都完整可见 `min(fitA,fitB)`;100%=1/dpr(DPR 考虑) | `12-canvas-tab.js` `fitCompare()` `zoom100Compare()` |
| 可导出当前结果 | 「导出结果图」= 下载 B 角色原图(`a.download`,不重编码) | `12-canvas-tab.js` `exportCompareResult()` |
| 关闭不改画布 | 关闭只清 compareA/B 与解码缓存;不写撤销、不提交生成、不改原图;渲染为 z9 覆盖层 | `closeCompare()`;覆盖层 `zIndex:9` |
| 异常态可理解 | 缺来源图(记录入口)→报错指路;取图失败→报错;尺寸不同→黄色提示「像素对比,不是配准」,不拉伸对齐 | `compareRecord()`;`37-compare-view.js` 提示条 |
| 100% 考虑 DPR | `zoom100Compare()` 设 `1/(devicePixelRatio\|\|1)`;绘制按 dpr 缩放画布 | `12-canvas-tab.js`;`drawCompareCanvas()` `setTransform(dpr,…)` |
| 滑杆不穿透画布事件 | 滑杆是 DOM `input[type=range]`,覆盖层内兄弟节点,指针事件不会落到主画布(浏览器回归断言 hits===0) | `37-compare-view.js` slider 行;`tools/check-compare-browser.mjs` |
| 结束清理 | 关闭清 `compareImgARef/compareImgBRef/compareDragRef`;window keydown(capture)监听随 effect 清理;解码 Image 释放引用交给 GC | `closeCompare()`;`12-canvas-tab.js` Esc effect |
| 不写撤销、不改原图、不提交生成 | 对比视图全程不触 `historyRef`/`/generate`(离线+浏览器回归覆盖) | — |
| 比较原始图片像素、不无限缓存 | 只缓存当前打开的 2 个解码 Image,关闭即置 null | `12-canvas-tab.js` 加载 effect |

## 2. 改动文件

- 新增 `lib/parts/37-compare-view.js`(definePart `compare-view`:纯渲染函数 `renderCompareView` + 绘制函数 `drawCompareCanvas`,无 hook,避免污染 CanvasTab hook 链)
- `lib/parts/12-canvas-tab.js`:compare* state ×8、ref ×4、动作函数 ×10(`compareSelectedTwo/compareRecord/closeCompare/fitCompare/zoom100Compare/exportCompareResult/compareWheel/comparePointerDown/Move/Up`)、effect ×3(解码加载/重绘/Esc capture)、渲染接线
- `lib/parts/35-props-card.js`:双选时「对比这两张」入口
- `lib/parts/28-history-panel.js`:记录行「对比」入口
- `lib/parts/06-utils.js`:STATE_ORDER 同步 8 个新 state(并修正 records/wsFiles 块与真实声明顺序的历史错位——该错位导致 set('compareA') 写错槽位,已在 `check-compare-browser` 首跑暴露)
- `lib/client.js`:重新装配(35 零件)
- 新增 `tools/check-compare.mjs`(离线 36 项)、`tools/check-compare-browser.mjs`(浏览器 3 项 + 2 截图)

## 3. 设计决策

- **入口只有两个**(双选 / 记录行),不做单图入口:单图没有天然的「另一张」,会造成半开状态机。
- **zoom 语义单一**:`图像像素→CSS 像素` 倍率,clamp `[1/(dpr*16), 64]`;「100%」=1 物理像素/图像像素,Retina 不虚标。
- **滑杆模式不拉伸对齐**:两图按同一倍率中心叠放,分割线处硬切换;尺寸不同时顶部常驻黄色提示,明确「不是配准」。
- **对比视图是纯查看层**:不进撤销栈、不产生持久化、不参与下一次生成;`closeCompare` 后画布 DOM 与数据零改动(浏览器回归断言)。

## 4. 验证结果

| 命令 | 结果 |
| --- | --- |
| `node --check`(12/37/35/28/06 + client.js + lib/index.js) | 退出码 0 |
| `node tools\build-client.mjs` | ✅ 35 零件 409001 字节 |
| `node tools\check-deps.mjs` | ✅ 依赖清单全部对齐 |
| `node tools\check-compare.mjs`(新增) | ✅ 36/36(关闭态/顶栏/提示条/滑杆映射/交换/不拉伸/同步缩放平移/clip/手柄/dpr) |
| `node tools\check-compare-browser.mjs`(新增) | ✅ 3/3 + 截图 `browser-check\compare-side.png`、`compare-slider.png` |
| `node tools\check-canvas-browser.mjs` | ✅ 7/7(修复 B 期 ref 插入位置破坏 `refs[5]`=docRef 契约的问题——compare refs 移到核心 refs 之后) |
| `node tools\check-canvas-regressions.mjs` | ✅ 8/8 |
| `node tools\check-history.mjs` | ✅ 11/11 |
| `node tools\check-preflight.mjs` | ✅ 15/15 |

## 5. 已知限制

- Esc 关闭依赖真 `useEffect`(window keydown capture);离线 fakeReact 不跑 effect,该项由人工验收覆盖(浏览器回归已覆盖按钮关闭路径)。
- 窗口 resize 不自动重绘对比画布(重绘 effect 依赖不含 resize);拖动一下滑杆/平移即恢复。
- 记录入口的 B 图取回依赖宿主 `/ws-file` 与图片代理;旧宿主(无 FEATURES)行为与 A 期记录面板一致。
- 对比视图导出的是「结果原图」文件,不是当前视口截图(任务书口径:导出当前结果=结果图,不重编码)。

## 6. 人工验收建议(需真实宿主)

1. 画布上传两张不同尺寸图 → 全选 → 属性区「对比这两张」→ 并排/滑杆/交换/适应/100%/滚轮/拖拽。
2. 生成记录 → 行展开 →「对比」:来源图在画布时打开;不在时出现指路报错。
3. 打开对比后 Esc 关闭;再 Ctrl+Z 确认撤销栈里没有对比产生的步骤。
4. 滑杆拖动时画布不能被误拖/误框选;关闭后画布交互一切如常。
