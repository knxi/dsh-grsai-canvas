# 追加记录 — DevTools Issues 三项告警的归因与插件侧加固(2026-10-11)

触发:用户发来 Edge DevTools「Issues」面板截图(画布插件页),三条告警:

1. 【错误】Content Security Policy of your site blocks the use of `eval` in JavaScript(`script-src` 1 个指令 Blocked)
2. 【警告】31 A form field element should have an id or name attribute
3. 【警告】1 Lazy-loaded images should have explicit dimensions

## 一、归因结论(查证过程与证据)

### 1. eval 告警:不是插件

- 插件运行时代码零 `eval` / `new Function`:`grep` 于 `E:\ds-h\_dl\publish\dsh-grsai-canvas\lib` 零命中;唯一的 `new Function` 出现在 `tools/` 的 Node 测试脚手架(`ui-snapshot.mjs:36`、`shot-final.mjs:50`、`check-preflight.mjs:22`、`check-canvas-browser.mjs:50`、`check-compare-browser.mjs:56`、`check-layers-browser.mjs:59`、`check-a11y-browser.mjs`),只在 Node 里加载源码用,不进浏览器。
- DSH 前端主 bundle 有一处**条件触发**的 eval:`C:\Users\su\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\index-5SrrfWpU.js` 中
  `const L4 = new Function("ctx","expr",\`\n with (ctx) {\n return eval(expr)\n }\n\`);`
  配合 `Xa(e,n){ return Ec(n) ? L4(e, n.__jsExpr) : ... }` 与 `Ec(e){ return e instanceof Object && "__jsExpr" in e }` —— 这是**配置表达式求值器**,只有值带 `__jsExpr` 标记才走 eval。
- 页面侧无 CSP 头:`dist/index.html` 无 CSP meta;`curl -s -D - http://127.0.0.1:3080/` 返回 401(未认证拿不到头)。宿主里唯一一段 `default-src 'none'; script-src 'none'; ...` 属于 `dsh-client-ui-sidebar-documentpreview\lib\client.js`(文档预览 iframe 的沙箱策略,故意锁脚本),与画布无关。
- 结论:该条**无法归因到画布插件**,属宿主/前端侧行为。插件侧的保证是「不引入任何 eval」,已固化为 `check-a11y.mjs` 第 5 项断言。

### 2. 表单字段缺 id:是插件

插件用 `h()`(= `React.createElement`,`lib/parts/00-runtime.js:85`)直接建 DOM,此前大部分输入框没写 `id`/`name`,浏览器即报此条。已全部补齐(见下)。

### 3. lazy 图缺显式尺寸:非插件

插件内两处 `<img>` 都是本地 dataURL 缩略图,均**未**使用 `loading="lazy"`,且都已显式声明 `width`/`height`。该条来自页面其他部分(宿主/其他面板),不属于画布插件;插件侧保证已固化为 `check-a11y.mjs` 第 2、3 项断言。

## 二、插件侧加固(改动清单)

共 38 个表单元素(32 个 input/textarea + 6 个 select)与 2 个 img 全部合规。

| 文件 | 新增 id |
| --- | --- |
| lib/parts/25-gen-card.js | `grsai-gen-frame-size`、`grsai-prompt`、`grsai-model-input`、`grsai-size-draft`、`grsai-crop-to-mark`、`grsai-append-hint`、`grsai-batch-<尺寸>`(循环内按值唯一化)、`grsai-image-size-select` |
| lib/parts/27-settings-panel.js | `grsai-apikey`、`grsai-api-base`、`grsai-history-limit`、`grsai-draft-sync`、`grsai-update-url`、`grsai-update-auto`、`grsai-quality-select`、`grsai-background-select` |
| lib/parts/26-skills-panel.js | `grsai-skill-name`、`grsai-skill-prompt` |
| lib/parts/29-workspace-panel.js | `grsai-save-path` |
| lib/parts/28-history-panel.js | `grsai-history-search`、`grsai-history-fav-only`、缩略图 `grsai-history-thumb-<记录 id>`(按记录唯一)+ `width:46`、`height:46`、`alt` |
| lib/parts/32-layer-key-panel.js | `grsai-layer-base`、`grsai-layer-token`、`grsai-layer-model` |
| lib/parts/35-props-card.js | `grsai-submit-texts`、`grsai-layer-size`、`grsai-text-value`、`grsai-text-font`、`grsai-font-file`、`grsai-text-size`、`grsai-text-shadow`、`grsai-text-weight`、`grsai-text-align` |
| lib/parts/38-layers-panel.js | `grsai-layer-rename`、缩略图补 `width:34`、`height:34`、`alt` |
| lib/parts/20-toolbar.js | `grsai-tool-markwidth`(颜色粗细滑块) |
| lib/parts/21-topright.js | `grsai-file-import`(隐藏的图片导入 input) |
| lib/parts/31-frame-input.js | `grsai-frame-size-input` |
| lib/parts/37-compare-view.js | `grsai-compare-slider`(滑杆,`aria-label` 同步补) |

## 三、新增回归

- `tools/check-a11y.mjs`(静态,5 项):①`h('input'|'textarea'|'select', {...})` 都有 id 或 name(38 个);②`h('img', {...})` 都有显式 width/height(2 个);③img 都有 alt;④字面 id 无重复(38 个);⑤`lib/client.js` / `lib/index.js` / `lib/upscale.js` 无 `eval` / `new Function`。
- `tools/check-a11y-browser.mjs`(真实 DOM,12 个视图状态):默认、选中图片+批量+裁剪、文字层选中、停靠区四标签(记录/图层含改名框/工作区/Skills)、设置面板、分层设置、超分面板、对比视图(滑杆模式)、场景框草稿输入。每个状态断言:所有 input/textarea/select 都有 id 或 name;所有 img 都有显式宽高与 alt;`#host` 内无重复 id。另点名断言深层控件(`grsai-compare-slider`、`grsai-frame-size-input`、`grsai-layer-rename`、`grsai-history-search`、`grsai-batch-*`)确实渲染过——避免"没渲染所以没报错"的假通过。累计 163 个表单元素渲染样本、38 个 `grsai-*` id 全覆盖;证据截图 `browser-check/a11y-default.png`、`a11y-history.png`、`a11y-settings.png`。

## 四、验证结果(全部退出码 0)

`node --check lib/client.js`;`build-client`(36 零件,425903 字节);`check-deps`;`check-preflight 15/15`;`check-canvas-regressions 8/8`;`check-history 11/11`;`check-compare`;`check-layers 15/15`;`check-a11y 5/5`;`check-canvas-browser`;`check-compare-browser`;`check-layers-browser`;`check-a11y-browser`(12 状态全过)。

## 五、影响与回滚

- 纯属性新增(添加 `id`/`name`/`width`/`height`/`alt`/`aria-label`),不改布局、不改状态、不改数据格式、不新增依赖;`id` 命名统一前缀 `grsai-`,不与宿主冲突(宿主用自身命名空间)。
- 回滚:还原 `lib/parts/*.js` 后重跑 `build-client` 即可;临时批量插入脚本 `tools/_add-form-ids.mjs` 已删除,操作前备份在 `%TEMP%\grsai-parts-bak-20261011-144634`(可整体回退本次加固)。

## 六、遗留

- eval 告警需宿主侧处理(属 `dsh-web-frontend` 的配置表达式求值器,非本插件);本插件已用断言保证不自引入。
- lazy 图告警不属本插件;若用户希望进一步减少此类告警,需要定位渲染那张 lazy 图的宿主组件。
