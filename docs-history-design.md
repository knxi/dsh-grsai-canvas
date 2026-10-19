# A「持久生成记录」存储方案设计草稿（0.20.x 第一期）

> 状态：设计稿，供实施对照。依据任务书 `DeepSeek开发任务书-画布功能增强.md` §3。
> 本文档只写设计与核实过的事实，不写未验证的猜测。

## 1. 现有宿主文件 API 核实（lib/index.js 实读结论）

| 路由 | 行为 | 对 A 的可用性 |
| --- | --- | --- |
| `POST /ws-save` (lib/index.js:689) | body `{path, dataUrl}` → decodeDataUrl → 只允许 `image/*` 或 `application/json`（JSON 必须 `.json` 后缀）→ `resolveInside` 越界检查 → `fsp.mkdir(dirname,{recursive:true})` 自动建子目录 → writeFile → 返回 `{ok, path, absolute, bytes}` | ✅ 写图片资源与清单 JSON 都可行，且支持子目录 |
| `GET /ws-file` (lib/index.js:672) | `?path=` → resolveInside → **只允许读图片文件**（IMAGE_EXT 白名单，非图片抛 `只允许读图片文件(...)`） | ⚠️ 可读图片资源；**清单 JSON 无法用此路由读取** |
| `GET /ws-list` (lib/index.js:662) | `?dir=` 子目录 → collectImages 递归**只列图片**（IMAGE_EXT），返回 `{files:[{path,size,mtime}],truncated}` | ✅ 可用于"资源丢失检测"（按目录核对图片是否存在） |
| `resolveInside` (lib/index.js:571) | path.resolve + 前缀比较（win32 大小写不敏感），越界抛 `路径超出工作区范围:${relative}` | ✅ 新路由必须复用 |
| `guardRequest` (lib/index.js:644) | 跨站防护（只收 application/json 类预检安全请求） | ✅ 新路由自动受益（handle 入口统一调用） |

结论：**写路径零新增**（/ws-save 已满足）；**读清单需要新增一个最小宿主路由**。

## 2. 存储布局

```
<工作区>/画布/history/
├── index.json              ← 清单（记录元数据数组，安全写入）
└── rec/<recordId>.png      ← 结果图片资源（recordId 为内部生成的稳定 ID）
```

- 不把历史图片 base64 塞进 `画布/state.json`（任务书 §3.3）。
- `recordId`：`rec-<base36 时间>-<随机>`，由客户端生成；文件名只用 recordId，不信任远程 URL 或用户命名（任务书 §3.3）。
- 清单 JSON 顶层：`{ version: 1, workspace: <不做绑定，路径本身隔离>, records: [...] }`。
- 单条记录字段（任务书 §3.2 语义，白名单存储）：
  - `id`（recordId）、`taskId`（上游任务 id，可空）、`format: 1`（记录格式版本）
  - `createdAt`、`finishedAt`
  - `userInput`（用户原始输入）、`skillId`、`skillText`（当时模板文本快照）、`finalPrompt`（最终提交提示词，完整不截断）
  - `model`、`ratioSel`（用户选择比例）、`ratioSent`（实际提交比例）、`quality`、`background`、`imageSize`、`outputSize`（精确成品尺寸，可空）
  - `sourceImageId`、`sourceRel`（来源图在 history 资源中的相对路径，可空）、`refIds`（参考图标识及顺序，可空数组）、`frame`（场景框/裁剪信息，可空）
  - `marksCount`、`withTexts`（本次提交标注与本地文字选项的摘要布尔/计数；完整标注快照第一期不存——任务书未要求回放标注，只要求参数复用）
  - `resource`（`{ rel, width, height, bytes }`，结果图本地引用与实际宽高）、`star`（收藏布尔）
  - 旧记录无法获得的字段一律**缺省不造**（不写 null 冒充历史事实）。

## 3. 写入流程（含异常语义）

1. 生成成功（或续查取回）拿到 dataUrl 后：
   1. `POST /ws-save` 写 `画布/history/rec/<recordId>.png`；
   2. 成功后才把记录 append 进清单并 `POST /ws-save` 写 `index.json`（"先资源后清单"，任务书 §3.3）；
   3. 任一步失败：记录标记 `pendingPersist`，UI 显示「未保存，可重试」，**绝不显示"已保存"**；不触发重新 `/generate`（不重复收费）。
2. 清单写入的防损坏策略：客户端保留上一次成功清单的内存副本；新清单写入失败时 UI 提示重试，**不在损坏文件上直接覆盖成空清单**；`GET /history-manifest` 读到损坏 JSON 时返回 `{ok:true, records:[], corrupted:true}` 并保留原文件不动（由用户显式"修复/重建清单"处理）。
3. 去重：入库键 = `(工作区 root, taskId || recordId)`；续查恢复与正常生成重复到达只入库一次（客户端清单合并时按 id 去重，后到覆盖缺失字段）。
4. 删除单条：只从清单移除；**不删** `画布/history/rec/` 下图片、不动画布对象与用户导出成品（任务书 §3.3）。清空记录需确认（任务书 §3.1.4）且同样只动清单。
5. 限额：清单条数上限 200、资源目录大小提示阈值（如 200 MB，超限提示但不清静默删除）；分页：清单一次全量（JSON 体积小），图片资源懒加载（缩略图用 /ws-file 按需取）。

## 4. 新增宿主路由（最小接口）与能力协商

- `GET /grsai-canvas/history-manifest`：
  - 复用 `resolveInside(root, '画布/history/index.json')`（固定文件名，不接受用户路径参数 → 无越界面）；
  - 文件缺失 → `{ok:true, records:[], missing:true}`；JSON.parse 失败 → `{ok:true, records:[], corrupted:true}`（不覆盖原文件）；
  - 大小上限：文件超过 4 MB 拒绝并提示（防异常膨胀）。
- `FEATURES` 增加 `'history'`；客户端 `featuresRef.current.includes('history')` 为 false 时：
  - 历史面板显示「宿主半边是旧版：重启一次 DSH 后可用」，并保留现有 results 会话内记录展示（降级不空白）。
- 不新增写路由（写走 /ws-save），不新增能力位之外的接口。

## 5. 与现有 results / 续查的整合

- `results` state 保留（会话内即时反馈），但每条 results 落图成功后同步走入库流程；
- 续查恢复路径（`12-canvas-tab.js` 续查 effect）取回结果后走**同一个入库函数**（统一入库，任务书 §3.1.1）；
- 入库函数签名（拟）：`persistRecord({ taskId, dataUrl, width, height, meta })`，meta 从当次 run/plan 快照取（跨平台 plan 已冻结参数，天然可用）；
- 恢复参数 = 只回填：`setPrompt(userInput)`、`setSkill(skillId)`（模板文本不从历史叠回——用当前模板库按 id 匹配，匹配不到提示模板已删除）、`setRatio/setQuality/setBackground/setImageSize/setCustomSize`；**不自动生成**；来源图/参考图已删除时列出缺失并允许仅恢复文本参数。

## 6. 兼容与迁移

- 不改 `DOC_VERSION`（history 独立于 state.json，不进画布存档）；
- 旧 version 的 index.json（无 `version` 字段）按 format 0 宽容读取，只读已知字段；
- 不同工作区天然隔离（路径基于 root），localStorage 的 pendingTasks 键**不**用于历史（任务书 §7）。
