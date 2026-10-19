# 线框规格 · 画布 UI 重构 D 期布局骨架 · v0.1

> 基于实测盘点:CanvasTab(12-canvas-tab.js:8,2688 行)根 div(S.root relative)下全是 absolute 悬浮层;无 flex/grid、无断点;togglePanel(12:1027)硬编码互斥;z-index 阶梯 4/5/6/7/8。
> R5 规则:全部数值参数,不用形容词。基准 pane 宽 380px,校验 320/420/520px。

## 1. 目标布局(ASCII 线框,基准 380×640)

```
┌────────────────────────────────────┐
│ [＋图] [记录] [图层] [资源] [模板] [⚙] │ ← 顶部导航 S.float top:6 left:6 right:6,高 30
├────────────────────────────────────┤
│      ┌──────────────┐              │
│ [工] │              │              │ ← 左工具栏 left:6 top:42 宽 34
│ [具] │              │   ┌────────┐ │
│ [栏] │    画布       │   │停靠区   │ │ ← 停靠区 right:6 top:42 bottom:46 宽 300(开时)
│ 34px │  (canvas      │   │标签条   │ │    覆盖 z6,画布仍可交互(关闭后)
│      │   absolute    │   │内容区   │ │
│      │   inset:0)    │   │滚动     │ │
│      │              │   └────────┘ │
│      │              │ ┌──────────┐ │
│      │              │ │属性区(选中时)│ │ ← 右下:属性卡+生成卡栈
│      │              │ ├──────────┤ │
│ [视图控制]           │ │生成区主卡  │ │ ← 生成卡 right:6 bottom:40 宽 348
│ [状态栏]             │ └──────────┘ │
└────────────────────────────────────┘
```

## 2. 分区数值规格

### 2.1 顶部导航(改 21-topright.js)
- 定位:S.float,top:6,left:6,right:6;按钮 30×30;图标按钮为主,文字仅「＋图」
- 内容(顺序):＋图片 | ⏱记录(角标=results.length) | ▤图层 | 🗂资源 | ✦模板 | ⚙更多
- 移除:适应/100%/－/＋/popOut/🔑分层/⬆放大(去向:视图控制/⚙更多)
- 入口开停靠区:dockOpen 相同值再点=收起(互斥状态机见 §4)

### 2.2 左侧工具栏(20-toolbar.js 微调)
- 定位改 left:6 top:42;宽 34(按钮 30×30);内部 maxHeight:calc(100% - 200px)
- 图层顺序 4 键保留于此(C 期再评估迁属性区);颜色/粗细仅标注类工具显示(现有行为)

### 2.3 画布视图控制(新零件 34-viewbar.js)
- 定位:S.float,left:6,bottom:40;横排小卡:适应(0)|100%(1)|－|＋|百分比文本
- 状态栏(22-statusbar)保留 left:6 bottom:6,pointerEvents:none

### 2.4 生成区(25-gen-card.js 重构)
- 定位:S.gen 改 right:6 bottom:40 width:348 maxWidth:calc(100% - 60px) maxHeight:calc(100% - 150px)
- 结构(上→下):错误卡(有错时)/进度卡(busy 时)/输入摘要行/prompt textarea(height 64,展开 ≤200)/模型+尺寸行/主按钮行(生成|⏹停止 + 提交预览 hint)/高级选项折叠行
- 高级选项折叠:默认收起;摘要=「质量:{quality} · 背景:{background} · 裁剪:{on/off} · 批量:{n}」;展开含质量/背景/跨平台尺寸/标注 checkbox/preflight;收起不重置(各 state 不动)
- 主按钮拆分:主按钮(run/cancel)+ 无独立停止键(busy 时主按钮即停止,保留现状文案区分「⏹ 停止轮询」;上游取消与否见提示文案)

### 2.5 选中对象属性区(新零件 35-props-card.js,gen-card 上方)
- 定位:absolute right:6,bottom: 由生成卡高度决定 → 简化:与生成卡同列 flex 容器(新 36-rightstack 包裹两卡,gap 6,right:6 bottom:40,内部 col)
- 仅 selected 或 selectedText 存在时渲染;无选中不渲染
- 内容(现有 gen-card 迁入):图片信息行(name·W×H badge)/参考标记钮/操作行(复制|存工作区|下载|导出底图与文字|删除)/对齐分布条(multi≥2)/文字属性块(选中文字时)
- 场景框行迁入属性区(选中框时)

### 2.6 资源停靠区(新零件 36-dock.js)
- 定位:absolute top:42 right:6 bottom:46 width:300 maxWidth:calc(100% - 60px) zIndex:6;内部:标签条(高 28)+内容区(overflowY auto)
- 标签:记录(history)/图层(layers,C 期占位「即将可用」)/资源(workspace)/模板(skills)
- 状态:新 state dockOpen:''|'history'|'layers'|'workspace'|'skills'(默认 '');顶部导航入口切换
- 迁入面板:28-history-panel、29-workspace-panel、26-skills-panel 渲染体原样搬入标签内容区(外框样式去掉重复卡片)

### 2.7 设置与更多(27/32/33 保持独立弹层)
- ⚙ 开 showSettings(27-settings-panel,改 top:42)
- 🔑分层/⬆放大入口移入 27-settings-panel 顶部两颗按钮(保留 togglePanel('layerkey'/'upscale'));APIKEY 缺失时 ⚙ 黄描边(继承现状)
- layerkey/upscale 面板 top 改 42

### 2.8 画布内输入层(30/31 不动)
- textInput zIndex:6、frameInput zIndex:6 保持;停靠区 zIndex 也是 6 → 输入层声明顺序放在 dock 之后(绘制序更高)

## 3. z-index 新阶梯(只加不改语义)

| 层 | z | 内容 |
|---|---|---|
| 状态栏 | 4 | statusbar |
| 悬浮层 | 5 | toolbar/topbar/viewbar/rightstack(gen+props) |
| 停靠区/输入 | 6 | dock、textInput、frameInput(dock 声明在输入层之前) |
| 模型面板 | 7 | modelPanel(锚定生成卡内相对定位,见 §5) |
| 尺寸面板 | 8 | sizePanel |
| 加载浮层 | 9 | !loaded 覆盖层 |

## 4. 面板互斥状态机(重构 togglePanel)

- 现 9 个 showXxx(showSettings/showWs/showHistory/showSkills/showLayerKey/showUpscale/showModels/showSizes/showGen)各自独立 state + togglePanel 硬编码清屏
- 目标:
  - dockOpen:''|'history'|'layers'|'workspace'|'skills' — 一 state 管四标签,天然互斥
  - showSettings/showLayerKey/showUpscale 保留(设置簇,⚙ 内聚);打开设置簇任一关闭 dock,反之亦然
  - showModels/showSizes 保留(生成区内锚定);showGen 保留(生成卡收起态)
  - togglePanel 重写为按簇分发:togglePanel('dock:history') 等 4 dock 项 + 原 5 项映射
- STATE_ORDER:新增 dockOpen 插到 showHistory 位置附近(替换 showWs/showHistory 两个 state 时保持声明序不乱;删除的 state 必须同步删 STATE_ORDER 对应项)

## 5. models/sizes 面板锚定修正

- 现状 zIndex7/8 但定位逻辑依赖 gen 卡位置;rightstack 改 flex 栈后,把 modelPanel/sizePanel 渲染移入生成卡容器内(relative 锚定 bottom:100% 弹出),消除魔法数耦合

## 6. 小屏适配(任务书四视口)

| 视口 | 行为 |
|---|---|
| 1200×900(桌面) | 全分区常态;停靠区 300 宽 |
| 390×700(窄) | 停靠区改全宽抽屉(maxWidth:calc(100% - 12px));右下栈 maxWidth:calc(100% - 60px) 已兼容;工具栏可折叠(≤360 宽时只显示当前工具+展开钮) |
| 360×640 | 同上 + 顶导航图标化(＋图→+);视图控制并入状态栏行 |
| 640×420(矮) | rightstack maxHeight:calc(100% - 150px);停靠区 top:42 bottom:40 不变,内部滚动 |
- 断点实现:不用 CSS 媒体查询(h() 内联 style)——用现有 size state(12:86)在 render 里按 size.w/size.h 条件给样式(与 0.19.x 小屏滚动修补同思路)

## 7. 风险与对策(承接盘点)

1. h() 样式 diff 不清旧 key → 条件样式一律 Object.assign 完整覆盖(含 border 全写)
2. DOM 顺序决定遮挡 → 新零件渲染位置固定插在 genCard 之后、modelPanel/sizePanel 之前,顺序写入 12-canvas-tab.js 组装段注释
3. togglePanel 硬编码 → §4 状态机收敛,8 处 setShowXxx 调用全部改走新映射(审计项「togglePanel('ws') 零调用」一并修复:openWorkspace 改走 togglePanel('dock:workspace'))
4. STATE_ORDER → 新增/删除 state 时同步 tools/check-deps 或 bundle.__stateOrder 校验(构建跑 check-preflight)
5. 无断点 → §6 用 size 条件样式,不引 CSS
