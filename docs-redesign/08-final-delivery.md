# 最终交付 — dsh-grsai-canvas 第一期(0.20.0 → 0.21)

日期:2026-10-11。执行顺序:审计+D 布局骨架(04)→ A 持久生成记录(05)→ B 对比视图(06)→ C 图层管理(07)→ D 清理收尾(本文档)。全部通过 `check-deps`、`check-preflight 15/15`、`check-canvas-regressions 8/8`、`check-history 11/11`、`check-compare 全绿`、`check-layers 15/15`、`check-layers-browser 7 段`、`check-canvas-browser 7/7`。

## 一、已实现(A/B/C/D 对照与入口)

| 期 | 任务书要求 | 实现 | 用户入口 |
| --- | --- | --- | --- |
| D | UI 重构与清理 | 八分区:顶导航/左工具栏/视图控制(34)/生成区(25 瘦身)/生成高级选项(展开式)/选中对象属性区(35)/受控停靠区(36:记录/图层/工作区/Skills 互斥)/设置更多(27/32/33);按钮 50→47;死代码与失效链移除;语义改名 | 顶导航 8 钮;左侧 13 工具钮;左下视图条;右侧属性卡+生成卡;右停靠区 |
| A | 持久生成记录与参数复用 | 正常+续查同路入库、taskId 去重;缩略图/时间/模型/尺寸/摘要;完整提示词/复制/恢复参数(只回填)/仅最终提示词/放入画布/下载;筛选/收藏/删除/确认清空;刷新恢复+跨工作区隔离;清单 JSON+独立 PNG;安全写入;0 次 /generate 重收费 | 停靠区「记录」标签 |
| B | 对比视图 | 两图 A/B 设定、并排+滑杆两模式、交换、同步缩放平移、导出当前结果、Esc 关闭不动画布、异常态文案、z9 顶层、URL 释放 | 属性卡「对比」(选中 2 图时)或对比视图内交换 |
| C | 图片图层管理 | 紧凑列表(缩略图/名称/参考徽章/显隐/锁定/删)、多选同步、双击改名、拖动排序、隐藏不绘制不命中不作参考、锁定全入口保护、普通删除跳锁反馈、清空二次确认、混合撤销一步、旧文档兼容 | 停靠区「图层」标签 |

## 二、改动文件(lib/parts/,构建产物 lib/client.js)

- 新建:`34-viewbar.js`、`35-props-card.js`、`36-dock.js`、`37-history-persist.js`、`38-layers-panel.js`(A/C 零件);删除:`30-text-input.js`。
- 重写/大改:`12-canvas-tab.js`、`20-toolbar.js`、`21-topright.js`、`25-gen-card.js`、`26-skills-panel.js`、`27-settings-panel.js`、`28-history-panel.js`、`29-workspace-panel.js`、`32-layer-key-panel.js`、`41-generate.js`、`42-images.js`、`06-utils.js`(STATE_ORDER)、`11-style.js`。
- 宿主:`lib/index.js`(FEATURES 加 'history'/'layering-test';新路由 /history 原子写)、`lib/upscale.js`(删死函数 engineStatus)。
- 设计文档:`docs-redesign/01..07` + 本文档;审计:`docs-ui-audit.md`(已附处理结果)。
- 测试:`tools/check-history.mjs`(11)、`tools/check-compare.mjs`、`tools/check-layers.mjs`(15)、`tools/check-layers-browser.mjs`(7)、`tools/check-a11y.mjs`(5,静态)、`tools/check-a11y-browser.mjs`(12 视图状态)、`tools/shot-final.mjs`(UI 对照截图);既有回归全部保留并通过。

## 三、数据设计(要点)

- **历史清单**:`画布/history.json`(宿主固定路径,客户端不可指定),`{v:1, records:[...]}`;每条记录 id=uid('rec')、taskId 去重键、at、promptUser/promptFinal 分离、skillId+skillText 快照、model/ratio/quality/background/imageSize/exactSize、sourceId/refCount/refNames/frame/cropped、marksCount/textsCount、file(画布/results/<id>.png)+w/h、fav;白名单清洗,缺字段不编造;>400 条丢最旧(收藏优先),>2MB 报错;tmp+rename 原子写,损坏不覆盖。
- **图层**:图片对象新增可选 `hidden`/`locked` 布尔(旧文档缺省=false,载入归一化);随 /state 现有 images 数组序列化,无新键;面板顺序=数组顺序。
- **对比视图**:纯运行时(对象 URL+解码缓存),不持久化,关闭即释放。
- 不新增任何第三方运行时/构建依赖;不触碰 `dsh.grsai-canvas.tasks` 等既有 localStorage 键。

## 四、验证结果(命令+退出码+截图)

全 0 退出码:`node --check lib/client.js lib/index.js` 全部改动文件;`build-client`(36 零件,425903 字节);`check-deps`;`check-preflight 15/15`;`check-canvas-regressions 8/8`;`check-history 11/11`;`check-compare`(36 断言);`check-layers 15/15`;`check-a11y 5/5`;`check-a11y-browser`(12 视图状态);`check-canvas-browser 7/7`(4 视口);`check-layers-browser 7 段`。

> 追加(2026-10-11,详见 `09-a11y-hardening.md`):针对用户发来的 DevTools Issues 三项告警做了归因与加固 —— eval 告警经查证属 DSH 前端的配置表达式求值器(`new Function("ctx","expr","with (ctx) { return eval(expr) }")`,仅当值带 `__jsExpr` 标记才触发),非本插件;lazy 图告警非本插件(插件内两张 dataURL 缩略图未用 `loading="lazy"` 且已显式声明宽高);表单缺 id 属插件,已补齐 38 个表单元素的 id/name 与 2 张缩略图的 width/height/alt,并新增静态 + 浏览器两级回归。

截图:`browser-check/ui-final-1200.png`(默认态)、`ui-final-1200-dock.png`(图层停靠区)、`ui-final-390.png`、`ui-final-360-dock.png`(窄屏);`ui-compare/before|after`(步骤1 对照);`compare-side.png`/`compare-slider.png`(B 期);`layers-*.png`(C 期)。图像断言均为像素/截图级。

## 五、已知限制

1. **需重启 DSH 生效的宿主改动**:/history 路由、FEATURES 两项。未重启时:记录面板橙色提示「重启一次 DSH 后才会自动存进工作区」,入库跳过;分层测试连接禁用。文档保存/Agent 分层在旧宿主已改为显式提示而非静默失败。
2. Esc 关闭对比视图/面板的人工验收未自动化(B/C 期均注明)。
3. B 期:窗口 resize 不重绘(下次交互恢复);导出=当前结果原图,不含滑杆位置。
4. A 期:删记录/清空不删工作区 PNG(无 /ws-delete,不删用户数据);清单损坏时首次覆盖需 confirm;打开画布到清单读完之间生成成功的极小竞态窗口可能丢该条记录。
5. C 期:图层不做组树/PS 引擎/分页(任务书明确不做);重命名 blur 提交与行点击同发时 blur 先行。
6. 属性区展开文字层且视口矮时底部可滚不可见(overflow auto)。

## 六、使用与回滚

- 使用:把本目录插件目录整个替换 0.20.0 安装(改了 lib/index.js,必须**重启 DSH**一次,否则新增能力降级为提示模式,数据不会丢);旧工作区/旧存档/旧偏好全部兼容载入(载入归一化,不丢 frames/marks/texts/偏好/图片自然尺寸)。
- 回滚:还原 0.20.0 原目录即可;历史清单 `画布/history.json` 与 `画布/results/*.png` 为新增文件,0.20.0 不读取不影响;画布 state 中 hidden/locked 字段旧版本解析器忽略(可选字段),无需清洗。

## 七、未完成项(不做声明,无「基本完成」)

- 本期不做(任务书明确):Skills 模板编辑、参考图用途标签、多页画布、区域回贴、本地抠图、任务中心、结果暂存、节点编辑器。
- 运行时待真实宿主验证(无真实宿主,人工验收脚本 11 步未跑):popOut float 行为、agentBridge 注入的两动作、ClipboardItem 写入、生成→重启→记录还在、对比视图双指手势、触屏滚动、真实 APIKEY 全流程计费路径。

## 八、UI 审计(处理+证据)

见 `docs-ui-audit.md` 头部「处理结果(2026-10-11)」。摘要:移除=text/pen 失效链+30-text-input.js+DRAW_TOOLS+TOOL_ICONS.text/.pen+engineStatus(证据:零引用 grep+check-deps 对齐);修复=6 项调用链(证据:04 文档表+32:120 守卫+index.js FEATURES);合并/改名=「存工作区」「取消勾选」「导出底图与文字」「记录」停靠标签;迁移=图片操作/对齐/保存清空/文字图层→35 属性区与 27 设置(证据:25-gen-card deps 与渲染段,grep saveImageToWorkspace 于 25 为 0)。

## 九、UI 对照

- 数量:默认可见按钮 **50 → 47**(tools/ui-snapshot.mjs 计数;C 期未新增默认入口,图层标签由占位变实面板)。
- 截图:`browser-check/ui-final-1200.png` / `ui-final-1200-dock.png` / `ui-final-390.png` / `ui-final-360-dock.png`;重构前对照 `ui-compare/before`。
- 窄屏:390×700 与 360×640 下顶导航换行、生成卡/属性卡全宽可滚、停靠区全宽抽屉、主按钮可达(截图为证);1200×900 默认无重叠,dock 打开时右列整体让位 right:314。
- 主工作流直达:导入→选图→写提示词→调模型尺寸→生成→看结果,全部默认可见单层操作;默认不展开文字编辑器/分层配置/超分安装/模板管理/批量选项;唯一受控辅助面板=右侧停靠区。

## 十、追加(2026-10-11 第二次):装上真机 + 工具栏回归

### 10.1 为什么要追加:此前 3080 上跑的不是本仓库

用户反馈「工具栏工具用不了」后排查发现:**开发目录的成果一直没被安装**。

- 运行中的宿主:`E:\nodejs\node.exe …@deepseek-ai\dsh\lib\bin.js web --port 3080 --no-open`(PID 28788),加载的是 `C:\Users\su\.dsh\profiles\node_modules\dsh-grsai-canvas`(旧版 0.20.0,31 个 parts,无 34/35/36/37/38/44 六个新零件,仍有 30-text-input.js)。
- 证据:`lib\index.js` 无 `/history` 路由,`GET /grsai-canvas/history → 404`;`client.js` 里 `grsai-prompt = 0 / layersPanel = 0 / renderDock = 0`。
- 开发目录反证:`grace` 无,`lib\index.js` 有 `/history`(3 处),`client.js` 里 `grsai-prompt = 1 / layersPanel = 6 / renderDock = 3 / renderViewbar = 3 / renderPropsCard = 3 / renderCompareView = 3`。

### 10.2 安装动作与结果

- 先备份:`C:\Users\su\.dsh\profiles\dsh-grsai-canvas.bak-20261011-145755`(110 个文件)。
- 执行 `deploy\install.ps1 -Source E:\ds-h\_dl\publish\dsh-grsai-canvas` → 复制到 `C:\Users\su\.dsh\profiles\node_modules\dsh-grsai-canvas`(36 个 parts),`dsh.profile.bundles` 已含该包(未改动),image-layering 技能更新到 v2.0.1(旧技能备份在 `C:\Users\su\.dsh\skills\.backup\image-layering-20261011-145805`)。
- 安装后校验:六个新零件就位;`client.js` 六个标记齐全;`index.js` `/history` = 3 处。
- **需要重启 DSH**(新路由与能力位要重启才生效)。重启前 `/grsai-canvas/history` 仍是 404、`/ping` 200。

### 10.3 新增回归:`tools/check-toolbar-browser.mjs`(11 项,全过)

针对「工具栏工具用不了」这一类反馈,在真实 DOM 里逐步验证:

1. 工具栏渲染:8 个工具按钮全部有图标、全部可点,撤销/重做/清空 3 个辅助按钮齐全。
2. 工具切换:select / brush / mask / arrow / rect / ellipse / shape / eraser 逐个点击后 `tool` 状态都对(点了没反应会在这里红)。
3. 画得出标注:画笔 / 蒙版 / 箭头 / 矩形 / 椭圆 各自拖动后都在画布上生成对应 kind 的标注,且挂在正确的图上、带实际轨迹或尺寸。
4. 撤销 / 重做:2 笔 → 撤销回 1 笔 → 重做回 2 笔。
5. 橡皮:点回已有标注上把它擦掉(1 → 0)。
6. 场景框:点一下进入尺寸输入态,未填尺寸不落地。
7. 隐藏 / 锁定保护:画不上去,且分别提示「隐藏」「锁定」。

截图:`browser-check/toolbar-default.png`、`browser-check/toolbar-draw.png`(画着矩形+画笔标注的实拍)。
注意:离线 harness 的 `useEffect` 是空实现,而真实载入靠它给撤销栈播种,所以用例 4 用"两笔"表达。

### 10.4 关于用户截图里那两条 404

- `POST http://127.0.0.1:3080/dsh-pet-7340/state → 404`、`POST http://127.0.0.1:3080/api/costMeter/getLocalState → 404` 都**不是画布插件的路由**:画布插件所有请求都带 `ROUTE = '/grsai-canvas'` 前缀(lib\parts\01-constants.js:3,经 routeUrl()/api() 发出,lib\parts\06-utils.js:54/62)。前者属于 dsh-pet,后者属于成本计量插件——它们的服务端那一半没加载(与画布无关)。
- 画布自己的后端是活的:`GET /grsai-canvas/ping → 200`、`GET /grsai-canvas/state → 200`。
- 另:CSP 里那条 `eval` 告警与本插件无关(插件运行时代码零 eval),来源是 DSH 前端 bundle 的配置表达式求值器(`__jsExpr` 标记才走 eval),要宿主侧处理;详见 `docs-redesign/09-a11y-hardening.md`。
