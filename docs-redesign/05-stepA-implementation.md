# 步骤 2 落地记录:A 持久生成记录与参数复用(0.21 骨架 → A 期)

日期:2026-10-11。对应任务书第一期 A;前置见 04-step1-implementation.md。

## 一、实现内容(对照任务书 A 期验收)

| 任务书要求 | 实现 | 位置 |
| --- | --- | --- |
| 成功生成形成持久记录(正常+续查同一路径) | 两路都汇入 `onRecord`(正常:41-generate 成功路径;续查:12-canvas-tab 续查 effect),同 `handleRecordResult` 入库,同 taskId 去重 | 41-generate.js:493、12-canvas-tab.js(续查段) |
| 缩略图/时间/模型/尺寸/提示词摘要 | 列表行 46×46 缩略图+`今天 hh:mm · 模型 · 实际宽高`+80 字摘要 | 28-history-panel.js |
| 完整提示词/复制 | 行展开显示 promptFinal 全文+「复制提示词」(clipboard) | 28 |
| 恢复参数(只回填不自动生成) | `restoreRecordParams`:回填模型/比例/质量/背景/imageSize/exactSize(仅 parsePixelSize 成功才进 customSize)+promptUser+按 skillId 重挂模板;notice 明示「不会自动生成」 | 12-canvas-tab.js |
| 「仅用最终提示词」独立模式 | 「仅最终提示词」按钮:取消模板挂载+promptFinal 原样回填(独立模式,避免模板/标注说明重复叠加) | 12/28 |
| 放入画布/保存下载 | 「放入画布」(file→/ws-file,fallback sourceUrl→代理)、「下载」(同优先级) | 12/28 |
| 关键词筛选/收藏/删除/确认清空 | 搜索框(promptUser/promptFinal/model/sourceName)、★收藏过滤、行内删除、清空 confirm(收藏数明示) | 28/12 |
| 刷新恢复/跨工作区隔离 | 打开画布读 `画布/history.json`;persister 全程 session 守卫,切工作区后回来的旧请求整体丢弃 | 12/44 |
| 保留自动落图 | 生成成功→placeResultImage 流程未动 | 41 |
| 稳定记录 ID/上游任务 ID/时间/格式版本 | `id:uid('rec')`、`taskId`、`at`、`v:1` | 44 |
| 原始输入与最终提示词分开存 | `promptUser`/`promptFinal` 两字段;续查任务只有 promptFinal(缺失不回填,恢复走「仅最终提示词」提示) | 41/44/12 |
| 模板 ID+文本快照 | `skillId`+`skillText` | 41 |
| 模型/比例/质量/背景/分辨率档/精确尺寸 | model/ratio/quality/background/imageSize/exactSize/outputSize | 41 |
| 来源图/参考图标识及顺序/场景框/裁剪 | sourceId/sourceName、refCount/refNames(按参考顺序)、frame、cropped | 41 |
| 标注与文字选项快照 | marksCount/textsCount/submitTexts | 41 |
| 结果本地资源引用+实际宽高 | `file`(画布/results/<id>.png)+`w/h`(naturalW/H) | 44/41 |
| 收藏状态 | `fav` | 44 |
| 旧记录缺字段标缺失不编造 | normalizeRecord 只收白名单,缺的字段就不存在,渲染「—」;测试断言 `'promptUser' in old === false` | 44/check-history |
| 图片实际存工作区,远程 URL 仅来源 | 先 /ws-save 落 `画布/results/<记录ID>.png`;`sourceUrl` 仅来源信息,读取时是 fallback | 44 |
| 清单 JSON+独立图片资源 | 宿主 /history 固定 `画布/history.json`(2MB 上限);图片独立 PNG 文件 | index.js/44 |
| 资源文件名由内部 ID 生成 | 文件名=record.id,不碰远程 URL | 44 |
| 清单安全写入(损坏不覆盖成空) | 宿主 writeTextAtomic(tmp+rename);GET 损坏→`{corrupted:true}` 不抛;客户端首次覆盖前 window.confirm | index.js/12 |
| 先保资源再标持久化 | handleRecordResult 顺序:saveResource→persister.push;资源失败仍写清单但 setError 提示「只留了来源链接」 | 12 |
| 去重(工作区+任务/结果 ID) | taskId 去重+id 去重(normalizeList+入库双重) | 44 |
| 元数据失败不重新生成不重复收费 | persister.push 失败仅 onError 提示,不重试;测试断言全程 /generate 调用数=0 | 44/check-history |
| 有界分页+限额提示不静默删收藏 | 分页每屏 20 条;超 400 丢最旧、收藏优先,touchedFav 时 notice 明示含收藏数 | 28/44/12 |
| 删记录不删画布图片 | removeRecord 只动清单 | 12 |
| 请求快照白名单,无密钥/凭证/调试日志 | 41 快照逐字段列白名单;测试断言 `'apikey' in snap === false` | 41/check-history |

## 二、宿主侧(lib/index.js,需重启 DSH 生效)

- FEATURES 加 `'history'`;旧宿主(未重启)无此能力:面板顶部橙色提示「记录只在当前页面有效,重启一次 DSH 后才会自动存进工作区」,入库动作静默跳过(内存仍有)。
- 新路由 `/history`:GET 读 `画布/history.json`(不存在→空清单;损坏→`{records:[],corrupted:true}`);POST 白名单清洗+>400 截断+>2MB 报「清单太大」+原子写。路径由宿主固定,客户端不可指定,无越界面。

## 三、验证(全过,退出码 0)

- `node tools/check-history.mjs` → **11 项新测试全过**:白名单清洗/缺字段不编造、taskId 去重+排序、buildRecord 稳定 ID、trimRecords(收藏优先+超限计数)、资源路径内部 ID、push 串行/失败不重试、损坏需确认才覆盖、load 规范化+corrupted 透传+会话 stale 丢弃、生成快照完整性、持久化全程 0 次 /generate。
- build-client(34 零件)/ check-deps 全对齐 / node --check / check-preflight 15/15 / check-canvas-regressions 8/8 / check-canvas-browser 7/7(4 视口)。

## 四、已知限制

- 宿主 /history 路由(清洗/原子写)无独立宿主测试进程,本机 DSH 重启后需人工验收一次(生成→重启→记录还在)。
- 删除记录/清空不删工作区里的结果 PNG(无 /ws-delete 路由):文件保留为孤儿,属预期(不删用户数据)。
- 画布打开瞬间(清单尚未读完)就完成一次生成的竞态窗口极小;此时新记录会先于旧清单展示,下一动作触发保存时以内存全量覆盖(旧清单条目仍在 recordsRef 之外的窗口内可能丢失)——记录为已知限制,后续可在 load 完成前禁止入库(代价是丢那一刻的记录提示)。
- 续查入库的记录只有 taskId/url/尺寸/模型/promptFinal(续查任务本身只存了这些),其余显示「—」。
