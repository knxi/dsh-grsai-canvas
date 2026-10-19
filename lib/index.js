/**
 * dsh-grsai-canvas —— 宿主(Node)侧半边。
 *
 * 只做三件事,全部挂在 `/grsai-canvas/*` 这组 HTTP 路由上:
 *
 * 1. GrsAI 接口代理:把浏览器的请求原样转给 `https://grsai.dakka.com.cn`,
 *    这样浏览器端不受 CORS 限制,APIKEY 也只在每次请求里经本机回环转发,
 *    不落任何日志、不写进代码。
 * 2. 工作区图片:列出 / 读取会话工作区里的图片,供画布直接取用。
 * 3. 结果落盘:把画布上的图(PNG dataURL)写回工作区文件夹。
 *
 * 不依赖任何 harness 内部服务,只需要 `ctx.webServer`(由
 * `@deepseek-ai/dsh-host-webserver` 提供)。
 *
 * @module dsh-grsai-canvas
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_MANIFEST_BYTES,
  MAX_PACKAGE_BYTES,
  applyUpdate,
  compareVersions,
  download,
  isPrivateHost,
  listBackups,
  parseManifest,
  readPackage,
  rollbackUpdate,
} from './update.js';
import {
  DEFAULT_ENGINE_BASE,
  ENGINE_DIR_NAME,
  TIERS as UPSCALE_TIERS,
  ensureTier,
  fetchManifest as upscaleFetchManifest,
  inspectTier,
  runUpscale,
  tierFiles,
} from './upscale.js';

/** Cordis 插件名。 */
export const name = 'dsh-grsai-canvas';

/** 宿主半边版本,客户端用 `/ping` 拿它判断要不要启用存档(见 MIN_HOST_VERSION)。 */
export const VERSION = '0.27.3';

/**
 * 宿主当前提供的能力清单,`/ping` 会原样报给客户端。
 * 客户端据此**优雅降级**:客户端能被 DSH 的 HMR 换成新版、而宿主必须重启才会换,
 * 所以"客户端比宿主新"是常态 —— 缺哪项就禁用哪项并提示重启,而不是抛一句"未知路由"。
 */
export const FEATURES = ['ping', 'state', 'skills', 'models', 'debug', 'generate', 'result', 'image', 'ws-list', 'ws-file', 'ws-save', 'history', 'update', 'layering-config', 'layering-test', 'layering-models', 'upscale'];

/**
 * 本插件自己的安装目录(更新时替换的就是这里的文件)。
 * `lib/index.js` 的上一级,补丁层挂法与 bundle 挂法都对。
 */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 需要的服务:`webServer` 提供路由注册。 */
export const inject = ['webServer'];

/** GrsAI 默认后端(image.grsai.ai 页面用的就是它);客户端可以在「设置」里改成别的兼容地址。 */
const DEFAULT_API_BASE = 'https://grsai.dakka.com.cn';

/**
 * 上游交互的环形记录(只留最近 40 条,给排错用:客户端没拿到图时,
 * 打开 /grsai-canvas/debug 就能看到上游到底回了什么)。**不记 APIKEY**。
 */
const upstreamLog = [];

/**
 * 记一条上游交互,同时打到宿主控制台(会进 dsh 的 web-output.log)。
 * @param {string} kind - `generate` 或 `result`。
 * @param {number} status - 上游 HTTP 状态。
 * @param {string} text - 上游响应体(只留前 300 字)。
 * @returns {void}
 */
function recordUpstream(kind, status, text) {
  const preview = String(text || '').slice(0, 300).replace(/\s+/g, ' ');
  const entry = { at: new Date().toISOString(), kind, status, body: preview };
  upstreamLog.push(entry);
  if (upstreamLog.length > 40) upstreamLog.shift();
  // 打一行到控制台(web-output.log 里能看到)
  console.log(`[grsai-canvas] ${kind} -> HTTP ${status} ${preview.slice(0, 200)}`);
}

/**
 * 本次请求该用哪个上游地址:客户端用 `x-grsai-base` 覆盖,不带就用默认。
 * 只接受 http/https,免得被当成任意协议的跳板。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {string} 上游基地址(已去掉尾部斜杠)。
 */
function upstreamBase(req) {
  const raw = String(req.headers['x-grsai-base'] || '').trim();
  if (!raw) return DEFAULT_API_BASE;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`接口地址不是合法 URL:${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`接口地址只支持 http/https,收到 ${parsed.protocol}`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** 本插件占用的路由前缀。 */
const ROUTE = '/grsai-canvas';

/** 认作图片的后缀。 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);

/** 单个请求体的上限(64 MB:参考图 base64 也够用)。 */
const MAX_BODY = 64 * 1024 * 1024;

/** 超限之后的"硬闸":到这个量直接掐掉连接,不再把整个 body 读完。 */
const MAX_BODY_HARD = MAX_BODY * 2;

/** `/image` 取图代理的体积上限 —— 上游文件多大是别人说了算的。 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** 工作区扫描的默认参数。 */
const WALK_MAX_DEPTH = 4;
const WALK_MAX_FILES = 800;

/** 画布状态的落盘位置(相对工作区)与体积上限。 */
const STATE_REL = '画布/state.json';
const MAX_STATE_BYTES = 48 * 1024 * 1024;

/** 画布「Skills 模板」的落盘位置与体积上限(存在工作区里,随项目走)。 */
const SKILLS_REL = '画布/skills.json';
const MAX_SKILLS_BYTES = 1024 * 1024;
/**
 * 生成模型清单(面板上「⟳ 获取新模型」读它)。
 *
 * 上游**没有任何模型列表接口**:`/v1/api/models`、`/v1/models`、`/v1/api/model/list`、
 * `/v1/api/modelList` 等 9 条候选路径实测全是 404(服务在跑,只是没这个路由)。
 * 所以"更新模型"只能靠这份本地清单:插件读它,拿不到就交给 Agent 去查了重写它。
 */
const MODELS_REL = '画布/models.json';

/**
 * 画布「生成记录」清单的落盘位置与体积上限(固定路径,客户端传不了 —— 和 Skills 一样,
 * 路径由宿主决定,天然没有越界写风险)。结果图片本体不在清单里:
 * 客户端先把图片 POST 到 /ws-save 存成 `画布/results/<记录ID>.png`,清单只记相对路径。
 */
const HISTORY_REL = '画布/history.json';
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
/** 清单最多保留的记录条数(超出整单拒绝 —— 客户端负责裁剪并提示,不静默删收藏)。 */
const MAX_HISTORY_RECORDS = 400;

/**
 * 「图片分层(Agent)」用的 skill 配置位置。
 *
 * `image-layering` 技能自带一份 `config/apimart_config.json`(base_url + api_key),
 * 这里让「设置」面板能直接改它 —— 否则每次都得去终端跑 skill 的 `configure.py`。
 * 密钥只经这一条路由落盘,**从不回给浏览器**(读接口只回掩码)。
 *
 * 目录解析:`DSH_IMAGE_LAYERING_DIR` 显式覆盖 → `$DSH_HOME/skills/image-layering`
 * → `~/.dsh/skills/image-layering`。客户端传不了路径,只认这一个文件。
 */
const LAYERING_DIR_ENV = 'DSH_IMAGE_LAYERING_DIR';
const LAYERING_CONFIG_REL = 'config/apimart_config.json';
const LAYERING_DEFAULT_BASE = 'https://api.apimart.ai';
/**
 * 提交 / 查询端点的**兜底路径**。
 *
 * 单独提出来是为了让三处永远一致:面板显示、配置落盘、技能脚本读取。
 * 端点可以被用户整段覆盖(有的中转把路径改成别的形状),也可以写成完整 URL;
 * 拼的时候一律走 `joinApiUrl`,免得 `https://xxx/v1` + `/v1/models` 拼成 `/v1/v1/...`。
 */
const LAYERING_DEFAULT_SUBMIT = '/v1/images/generations';
const LAYERING_DEFAULT_STATUS = '/v1/tasks';
/**
 * 模型名的**兜底值**(配置里没写、或写空了才会用它)。
 *
 * 模型 ID 不写死:面板上可以「🔍 取可用模型」从上游 `/v1/models` 里挑,也可以直接手写任意模型名
 * (图层分解各家叫法不一样:APIMart `seedream-5-0-pro`、EvoLink
 * `doubao-seedream-5.0-pro-layerize`、kie `seedream/5-pro-layer-decomposition`),
 * 写进技能配置 `config/apimart_config.json` 的 `model` 字段,由 `scripts/split_image.py` 读。
 * 这一条只是"谁都没说过"时的最后保险,不要把它当成唯一可用的模型。
 */
const LAYERING_DEFAULT_MODEL = 'seedream-5-0-pro';

/**
 * 「取可用模型」的短期缓存。
 *
 * 上游对 `/v1/models` 有频率限制(实测连点两次就 429),所以同一个地址 60 秒内复用上次结果;
 * 另外接口一次性把**全部**模型返回(带 rank),按钮上的「只看像的 / 显示全部」在客户端本地切,
 * 切换本身不再打上游 —— 既省请求,也不会让用户撞限流。
 */
let layeringModelsCache = { at: 0, base: '', models: null, payload: null };

/**
 * image-layering skill 的目录(解析顺序见上面的常量注释)。
 * @returns {string} 绝对路径。
 */
function layeringSkillDir() {
  const override = String(process.env[LAYERING_DIR_ENV] || '').trim();
  if (override) return path.resolve(override);
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'skills', 'image-layering');
}

/**
 * 该 skill 的 APIMart 配置文件绝对路径。
 * @returns {string} 绝对路径。
 */
function layeringConfigPath() {
  return path.join(layeringSkillDir(), ...LAYERING_CONFIG_REL.split('/'));
}

/**
 * 把 `base_url` 与端点路径拼成一个 URL,**重复的 `/v1` 只留一段**。
 *
 * 为什么要有它:端点默认自带 `/v1`(`/v1/images/generations`、`/v1/tasks`、`/v1/models`),
 * 而很多人填地址时习惯连 `/v1` 一起填 —— 不少中转站直接给的就是 `https://xxx/v1`。
 * 字符串硬加就变成 `.../v1/v1/images/generations`,换平台时的表现是"地址没错却怎么都连不上、
 * 像是插件自己乱加目录"。端点若本身写成完整 URL(`http(s)://…`)则不再拼 base,
 * 这样"提交在 A 域名、查询在 B 域名"的中转也能用。
 *
 * @param {string} base - 接口地址(尾部斜杠无所谓)。
 * @param {string} endpoint - 端点路径或完整 URL。
 * @returns {string} 可直接 fetch 的 URL。
 */
function joinApiUrl(base, endpoint) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  const e = String(endpoint == null ? '' : endpoint).trim();
  if (!e) return b;
  if (/^https?:\/\//i.test(e)) return e.replace(/\/+$/, '');
  const suffix = e.startsWith('/') ? e : `/${e}`;
  const tail = b.match(/\/(v\d+)$/i);
  if (tail && new RegExp(`^/${tail[1]}(?:/|$)`, 'i').test(suffix)) {
    return `${b}${suffix.slice(tail[1].length + 1)}`;
  }
  return `${b}${suffix}`;
}

/**
 * 插件包里随带的 `image-layering` 技能(deploy/skill/image-layering)。
 *
 * 为什么挂在 `deploy/` 下、而不是新开一个顶层目录:`lib/update.js` 的安装白名单
 * 只放行 `lib / deploy / tools / package.json / cordis.patch.yml`,顶层多出一个名字
 * 会让**旧版本**在自我更新时直接拒收整个包(0.17.0 的 `tools/` 就踩过这个坑)。
 * 放在 `deploy/` 下面,更新时自动跟着走,老版本也不会被卡。
 */
const LAYERING_SKILL_SRC = path.join(PLUGIN_DIR, 'deploy', 'skill', 'image-layering');

/** 技能里属于「用户自己配」的文件:铺设 / 升级时一律不覆盖。 */
const LAYERING_SKILL_KEEP = ['config/apimart_config.json', 'config/recraft_config.json'];

/**
 * 递归把技能文件铺过去;`keep` 里的相对路径若目标已存在,就保留目标那份。
 * @param {string} from - 源目录。
 * @param {string} to - 目标目录。
 * @param {string[]} keep - 不覆盖的相对路径(`/` 分隔)。
 * @param {string} [prefix] - 递归用的相对前缀。
 * @returns {Promise<void>} 铺完即返回。
 */
async function copySkillTree(from, to, keep, prefix = '') {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copySkillTree(src, dst, keep, rel);
      continue;
    }
    if (keep.includes(rel) && (await fileExists(dst))) continue;
    await fsp.copyFile(src, dst);
  }
}

/**
 * 把插件自带的 `image-layering` 技能铺到本机(`$DSH_HOME/skills/image-layering`)。
 *
 * 幂等:技能在位且不比包里旧就什么都不做;升级前把旧目录整份备份到
 * `<skills>/.backup/`;用户填好的 APIMart / Recraft 配置**永不覆盖**。
 *
 * 由 `apply()` 在插件加载时调用 —— 插件的自我更新只覆盖文件、不跑安装脚本,
 * 所以「更新插件顺带把技能也换上」只能靠这一段。
 *
 * @returns {Promise<{action: string, dir?: string, to?: string, backup?: string, reason?: string}>} 结果。
 */
async function ensureLayeringSkill() {
  if (String(process.env[LAYERING_DIR_ENV] || '').trim()) {
    // 用户显式指定了技能目录:那是他自己的地盘,不自动铺设
    return { action: 'skipped', reason: `${LAYERING_DIR_ENV} 已指定技能目录` };
  }
  if (!(await fileExists(path.join(LAYERING_SKILL_SRC, 'SKILL.md')))) {
    return { action: 'skipped', reason: '插件包里没有随带的技能' };
  }
  const dir = layeringSkillDir();
  /** 读某个技能目录的 VERSION(读不到给空串)。 */
  const readVersion = async (where) =>
    String(await fsp.readFile(path.join(where, 'VERSION'), 'utf8').catch(() => '')).trim();
  const sourceVersion = await readVersion(LAYERING_SKILL_SRC);
  const installed = await fileExists(path.join(dir, 'SKILL.md'));
  if (installed) {
    const currentVersion = await readVersion(dir);
    if (sourceVersion && currentVersion && compareVersions(sourceVersion, currentVersion) <= 0) {
      return { action: 'skipped', reason: '已是最新', dir, to: currentVersion };
    }
  }
  // 用户填过的配置先读出来,铺完再原样写回
  const keepData = [];
  for (const rel of LAYERING_SKILL_KEEP) {
    const file = path.join(dir, ...rel.split('/'));
    const text = await fsp.readFile(file, 'utf8').catch(() => null);
    if (text !== null) keepData.push([rel, text]);
  }
  let backup = '';
  if (installed) {
    const stamp = `${(await readVersion(dir)) || 'unknown'}-${Date.now().toString(36)}`;
    backup = path.join(path.dirname(dir), '.backup', `image-layering-${stamp}`);
    await fsp.mkdir(path.dirname(backup), { recursive: true });
    await fsp.rm(backup, { recursive: true, force: true });
    await fsp.rename(dir, backup);
  }
  await copySkillTree(LAYERING_SKILL_SRC, dir, []);
  for (const [rel, text] of keepData) {
    const file = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, 'utf8');
  }
  return { action: installed ? 'updated' : 'installed', dir, to: sourceVersion, backup };
}

/**
 * 把密钥打成掩码(`sk-1****ab12`)—— **原文永远不回浏览器**。
 * @param {string} value - 原始密钥。
 * @returns {string} 掩码;空值给空串。
 */
function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return '****';
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

/** 「AI 高清放大」引擎的安装目录(`<DSH home>/tools/upscale`)。 */
function upscaleEngineDir() {
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'tools', ENGINE_DIR_NAME);
}

/**
 * 引擎清单的内存缓存。
 *
 * 为什么要缓存:状态查询会被界面反复调,每次都联网取一份清单太浪费;
 * 缓存 10 分钟内复用,下载/安装时再强制刷新。
 */
let upscaleManifestCache = { at: 0, manifest: null, base: '' };

/**
 * 取引擎清单(带缓存)。
 * @param {boolean} [force] - 强制刷新。
 * @returns {Promise<{manifest: object, base: string}>} 清单与分发点。
 */
async function upscaleManifest(force) {
  const fresh = Date.now() - upscaleManifestCache.at < 10 * 60 * 1000;
  if (!force && fresh && upscaleManifestCache.manifest) {
    return { manifest: upscaleManifestCache.manifest, base: upscaleManifestCache.base };
  }
  const got = await upscaleFetchManifest(DEFAULT_ENGINE_BASE);
  upscaleManifestCache = { at: Date.now(), manifest: got.manifest, base: got.base };
  return got;
}

/**
 * 当前正在跑的放大任务描述(空串 = 空闲)。
 *
 * 为什么要串行:两个 exe 同时抢同一块 4GB 显存,会双双变慢甚至一起失败;
 * 而且用户也不会真的需要同时放两张 —— 排队等 40 秒比两个都跑崩强。
 */
let upscaleBusy = '';

/**
 * 读一个 JSON 文件,坏文件/缺失都当空对象(调用方按"未配置"处理)。
 * @param {string} file - 绝对路径。
 * @returns {Promise<{data: object, exists: boolean}>} 结果。
 */
async function readJsonObject(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    // 只有"文件不存在"才算未配置 —— 权限/IO 错误必须说出来,
    // 否则调用方会拿空对象去覆写用户配置,原有字段就悄悄丢了。
    if (error && error.code === 'ENOENT') return { data: {}, exists: false };
    throw new Error(`读不了 ${path.basename(file)}:${error && error.message}`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    // 坏档保留现场(改名),别让下一次 POST 拿着空对象把它覆盖掉
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.rename(file, `${file}.corrupt-${stamp}`).catch(() => {});
    throw new Error(`${path.basename(file)} 不是合法 JSON(已备份成 .corrupt-${stamp}),请修正或删掉它再重试`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return { data: value, exists: true };
  return { data: {}, exists: true };
}

/**
 * 文件是否存在(不抛异常)。
 * @param {string} file - 绝对路径。
 * @returns {Promise<boolean>} 是否存在。
 */
async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 后缀 → MIME。 */
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/** 允许直接回给浏览器的图片 MIME —— 不含 svg:svg 里能带 `<script>`,同源下等于 XSS。 */
const IMAGE_MIME = new Set(Object.values(MIME));

/**
 * 按文件头嗅探图片类型,认不出给空串。
 *
 * 为什么要它:`/image` 上游的 `Content-Type` 是第三方说了算的,原样透传就是
 * "让攻击者的 HTML 跑在 127.0.0.1:3080 同源下";`/ws-save` 的 dataURL mime 也是请求体自报的。
 * 只有真实字节不会撒谎。
 *
 * @param {Buffer} buffer - 文件内容。
 * @returns {string} 图片 MIME,认不出给空串。
 */
function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (buffer.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buffer.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return '';
}

/**
 * 取一个可选服务。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} name - 服务名。
 * @returns {any} 服务实例,或 undefined。
 */
function service(ctx, name) {
  return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
}

/**
 * 工作区根目录,按优先级解析:
 *
 * 1. 环境变量 `DSH_GRSAI_CANVAS_DIR`(显式覆盖,测试/折腾用);
 * 2. 该会话 header 里的 `cwd`(和 `dsh-api-workspace-files` 用的是同一个来源);
 * 3. 沙箱策略里的工作区根;
 * 4. 进程工作目录。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {string} sessionId - 客户端带上来的会话 id,可为空。
 * @returns {Promise<string>} 已解析的绝对路径。
 */
async function resolveRoot(ctx, sessionId) {
  const override = process.env.DSH_GRSAI_CANVAS_DIR;
  if (override) return path.resolve(override);
  if (sessionId) {
    try {
      const sessions = service(ctx, 'sessions');
      const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId)?.header : undefined;
      let header = live;
      if (header === undefined) {
        const persistence = service(ctx, 'sessionPersistence');
        if (persistence && typeof persistence.stat === 'function') {
          header = (await persistence.stat(sessionId))?.header;
        }
      }
      const cwd = header && header.cwd;
      if (typeof cwd === 'string' && cwd.trim()) return path.resolve(cwd);
    } catch {
      /* 会话信息拿不到就往下走 */
    }
  }
  const policy = service(ctx, 'sandboxPolicy');
  const policyRoot = policy && policy.workspaceRoot;
  if (typeof policyRoot === 'string' && policyRoot.trim()) return path.resolve(policyRoot);
  return path.resolve(process.cwd());
}

/**
 * 把请求体读成 Buffer。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Buffer>} 请求体。
 */
async function readBody(req) {
  // 先看声明的长度:浏览器发大 body 时会带 Content-Length,能提前拒掉就不用读 100 MB
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) {
    const error = new Error(`请求体过大(${(declared / 1048576).toFixed(1)} MB,上限 ${Math.round(MAX_BODY / 1048576)} MB)`);
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += chunk.length;
    // 硬闸:到了上限还继续发,就别再"读干净"了 —— 否则这条连接能被长期占住,socket 与内存都跟着涨。
    // (正常的大 body 在 Content-Length 那一步就已经被拒了;能走到这里是 chunked 或不报长度。)
    if (size > MAX_BODY_HARD) {
      req.destroy();
      const error = new Error(`请求体过大(超过 ${Math.round(MAX_BODY_HARD / 1048576)} MB),已断开`);
      error.statusCode = 413;
      throw error;
    }
    if (size > MAX_BODY) {
      // 读干净再报错:中途 throw 会让 socket 被销毁,浏览器只能看到 Failed to fetch
      overflow = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (overflow) {
    const error = new Error(`请求体过大(${(size / 1048576).toFixed(1)} MB,上限 ${Math.round(MAX_BODY / 1048576)} MB)`);
    error.statusCode = 413;
    throw error;
  }
  return Buffer.concat(chunks);
}

/**
 * 读 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<any>} 解析后的对象。
 */
async function readJson(req) {
  const raw = (await readBody(req)).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/**
 * 回一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - 要序列化的内容。
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body ?? null);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

/**
 * 带超时的上游请求 —— 生成/查询这两条最关键的路由以前用的是裸 fetch,没有超时。
 *
 * 上游不回包时请求会一直挂着,而 `/result` 是客户端按秒轮询的:
 * 每一次轮询都挂一个永不结束的 socket,fd 与内存随轮询一起涨,界面上只看到"一直生成中"。
 * 超时统一换成人能看懂的文案(504/502),别让面板显示一句 `fetch failed`。
 *
 * @param {string} input - 地址。
 * @param {RequestInit} init - fetch 参数。
 * @param {number} timeoutMs - 超时(毫秒)。
 * @param {string} what - 动作名(拼进错误文案)。
 * @returns {Promise<Response>} 上游响应。
 */
async function fetchUpstream(input, init, timeoutMs, what) {
  try {
    return await fetch(input, Object.assign({}, init, { signal: AbortSignal.timeout(timeoutMs) }));
  } catch (error) {
    const timedOut = Boolean(error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
    const wrapped = new Error(
      timedOut
        ? `${what}超时(${Math.round(timeoutMs / 1000)} 秒):上游没有响应,过一会儿再试`
        : `${what}没发出去:${(error && error.message) || error}`,
    );
    wrapped.statusCode = timedOut ? 504 : 502;
    throw wrapped;
  }
}

/**
 * 「不需要 CORS 预检就能跨站发出」的 Content-Type —— 也就是 CSRF 的主力。
 * 跨站 `fetch` 想带 `application/json` 会先触发预检,而本插件不返回任何 CORS 头,
 * 预检必然失败、请求根本发不出去;但这三种类型属于"简单请求",浏览器直接发。
 */
const CROSS_SITE_TYPES = new Set(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']);

/**
 * 请求安全守卫 —— 本插件最重要的一道防线。
 *
 * **为什么必须有它**:这些路由是用 `ctx.webServer.register({kind:'prefix'})` 注册的,
 * 而这条注册路径**不经过 DSH 自己的登录校验**(实测:DSH 的 `/`、`/index.html`、`/api/*`
 * 不带凭据一律 401,而 `/grsai-canvas/*` 全部 200)。于是任何用户访问的网页、本机上任何
 * 进程都能直接调这些接口 —— 其中 `/update/apply` 足以让宿主下载并覆盖插件自己的代码
 * (下次重启 DSH 即在宿主进程里执行任意代码)。
 *
 * 两道**不依赖 DSH 内部凭据**、成本极低、且不影响正常用法的防线:
 *
 * 1. **Origin 必须与 Host 同源**。浏览器发起的跨站请求一定带 `Origin`,直接拒;
 *    非浏览器调用没有 `Origin` 可查,不适用这一条(它们本来就能在本机读写文件,威胁模型不同)。
 * 2. **拒绝跨站简单请求类型**(见 {@link CROSS_SITE_TYPES})。这样 `<form>` 提交、
 *    `navigator.sendBeacon`、`<img>`/`<script>` 触发的写入类请求统统进不来。
 *
 * 画布客户端是同源页面、所有 POST 都带 `Content-Type: application/json`,所以完全不受影响;
 * 旧版客户端(浏览器里缓存着上一版 bundle)也照样能用 —— 只按 Origin 判,不认版本。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {void} 不合法就抛错(带 `statusCode`)。
 */
function guardRequest(req) {
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(String(origin)).host;
    } catch {
      originHost = '';
    }
    const host = String(req.headers.host || '');
    if (!originHost || !host || originHost !== host) {
      const error = new Error(
        `跨站请求已拒绝:Origin「${origin}」与本机服务「${req.headers.host || '(空)'}」不同源`,
      );
      error.statusCode = 403;
      throw error;
    }
  }

  // DNS 重绑定绕得过上面那条(源站和 Host 会一起变成攻击者域名),
  // 但绕不过浏览器自己打的 Sec-Fetch-Site:cross-site。没有这个头的(curl、脚本)不受影响。
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    const error = new Error('跨站请求已拒绝:Sec-Fetch-Site 是 cross-site');
    error.statusCode = 403;
    throw error;
  }

  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const type = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (CROSS_SITE_TYPES.has(type)) {
      const error = new Error(
        `跨站请求已拒绝:Content-Type「${type}」不用预检就能跨站发出,本插件只接受 application/json`,
      );
      error.statusCode = 403;
      throw error;
    }
  }
}

// `isPrivateHost` 在 lib/update.js 里(更新下载与取图代理共用一份实现),
// 见文件顶部的 import —— 这里不再重复定义。

/**
 * 把相对路径解析到工作区内,越界就报错。
 * @param {string} root - 工作区根目录。
 * @param {string} relative - 用户给的相对路径。
 * @returns {string} 绝对路径。
 */
function resolveInside(root, relative) {
  const target = path.resolve(root, relative ?? '.');
  const a = process.platform === 'win32' ? target.toLowerCase() : target;
  const b = process.platform === 'win32' ? root.toLowerCase() : root;
  if (a !== b && !a.startsWith(b + path.sep)) throw new Error(`路径超出工作区范围:${relative}`);
  return target;
}

/**
 * 拆一个图片 dataURL。
 * @param {string} dataUrl - `data:image/png;base64,...`。
 * @returns {{ mime: string, buffer: Buffer }} MIME 与字节。
 */
function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl ?? ''));
  if (!match) throw new Error('不是合法的 dataURL');
  const mime = match[1] || 'application/octet-stream';
  const buffer = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  return { mime, buffer };
}

/**
 * 原子写一个 UTF-8 文本文件:先写临时文件再 rename。
 * 直接 writeFile 写到一半断电/崩溃,文件会烂在原地;rename 在同一分区上是原子的,
 * 最坏情况是留下一个 .tmp 孤儿,正式文件要么是旧内容要么是完整新内容 —— 不会写烂。
 * @param {string} file - 绝对路径。
 * @param {string} text - 完整内容。
 * @returns {Promise<void>} 写完。
 */
async function writeTextAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * 递归收集工作区里的图片。
 * @param {string} root - 工作区根目录。
 * @param {string} dir - 当前目录(绝对)。
 * @param {number} depth - 剩余深度。
 * @param {{ path: string, size: number, mtime: number }[]} out - 结果累加器。
 * @returns {Promise<void>} 收集完成。
 */
async function collectImages(root, dir, depth, out) {
  if (depth < 0 || out.length >= WALK_MAX_FILES) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= WALK_MAX_FILES) return;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      await collectImages(root, full, depth - 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    out.push({
      path: path.relative(root, full).split(path.sep).join('/'),
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }
}

/**
 * 处理一条 `/grsai-canvas/*` 请求。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @returns {Promise<void>} 响应写完。
 */
async function handle(req, res, ctx) {
  // 先过安全守卫:这些路由不经 DSH 的登录校验,跨站请求一律在这里挡掉
  guardRequest(req);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = url.pathname.slice(ROUTE.length) || '/';
  const sessionId = url.searchParams.get('session') || '';
  const root = await resolveRoot(ctx, sessionId);

  if (route === '/' || route === '/ping') {
    sendJson(res, 200, { ok: true, plugin: name, version: VERSION, features: FEATURES, root, session: sessionId || null, api: DEFAULT_API_BASE });
    return;
  }

  // ── 排错用:最近 40 条上游交互(不含 KEY) ──────────────────────────
  if (route === '/debug' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, plugin: name, version: VERSION, root, count: upstreamLog.length, upstream: upstreamLog });
    return;
  }

  // ── 工作区图片:列表 ────────────────────────────────────────────────
  if (route === '/ws-list' && req.method === 'GET') {
    const sub = url.searchParams.get('dir') ?? '';
    const base = resolveInside(root, sub);
    const out = [];
    await collectImages(root, base, WALK_MAX_DEPTH, out);
    sendJson(res, 200, { ok: true, root, dir: sub, files: out, truncated: out.length >= WALK_MAX_FILES });
    return;
  }

  // ── 工作区图片:读取 ────────────────────────────────────────────────
  if (route === '/ws-file' && req.method === 'GET') {
    const rel = url.searchParams.get('path');
    if (!rel) throw new Error('缺少 path 参数');
    const file = resolveInside(root, rel);
    // 只允许读图片:否则这条路由等于"读工作区里任意文件"(工作区里可能躺着 .grsai-key.txt 这类凭据)
    if (!IMAGE_EXT.has(path.extname(file).toLowerCase())) {
      throw new Error(`只允许读图片文件(${[...IMAGE_EXT].join(' ')}):${rel}`);
    }
    const buffer = await fsp.readFile(file);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buffer);
    return;
  }

  // ── 结果落盘 ───────────────────────────────────────────────────────
  if (route === '/ws-save' && req.method === 'POST') {
    const body = await readJson(req);
    const rel = String(body.path ?? '').trim();
    if (!rel) throw new Error('缺少 path(相对工作区的保存路径)');
    const { mime, buffer } = decodeDataUrl(body.dataUrl);
    // 只允许落图片或 JSON 文本 —— 否则这条路由等于"往工作区写任意内容"。
    // 注意:dataURL 里的 mime 是请求体自报的,**后缀与真实字节才算数**。
    // 以前只看 mime 前缀,`{path:'x.exe', dataUrl:'data:image/png;base64,<PE>'}` 就能写任意二进制;
    // 写 .html/.svg 更是直接落地可执行脚本。
    const ext = path.extname(rel).toLowerCase();
    if (ext === '.json') {
      // JSON 只允许写 .json 后缀:画布的 draft.json、文字参数 JSON 都走这条。
      if (!(mime === 'application/json' || /\+json$/.test(mime))) {
        throw new Error(`内容是 ${mime},不是 JSON —— 写不进 .json 文件`);
      }
    } else {
      if (!IMAGE_EXT.has(ext)) {
        throw new Error(`只允许写入图片(${[...IMAGE_EXT].join(' ')}:${rel})或 .json 文件`);
      }
      const sniffed = sniffImageMime(buffer);
      if (!sniffed) throw new Error(`内容不是认识的图片格式(PNG/JPEG/WebP/GIF/BMP/AVIF),拒绝写入:${rel}`);
      const expectExts = Object.entries(MIME)
        .filter(([, value]) => value === sniffed)
        .map(([suffix]) => suffix);
      if (!expectExts.includes(ext)) {
        throw new Error(`内容和后缀对不上:${rel} 的后缀是 ${ext},内容其实是 ${sniffed}`);
      }
    }
    const file = resolveInside(root, rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buffer);
    sendJson(res, 200, { ok: true, path: rel.split('/').join('/'), absolute: file, bytes: buffer.length });
    return;
  }

  // ── 生成模型清单:读 ───────────────────────────────────────────────
  // 面板上点「⟳ 获取新模型」→ 先读这份文件;读不到(第一回)就把 absolute 一起给出去,
  // 让 Agent 按契约把它写出来,写完再点一下就载入。
  if (route === '/models' && req.method === 'GET') {
    const file = resolveInside(root, MODELS_REL);
    let raw = null;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      raw = null;
    }
    if (raw === null) {
      sendJson(res, 200, { ok: true, path: MODELS_REL, absolute: file, exists: false, updated: '', models: [], aliases: {} });
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`模型清单文件坏了(不是合法 JSON):${MODELS_REL}`);
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.models) ? parsed.models : [];
    const models = [];
    for (const item of list.slice(0, 200)) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || '').trim();
      if (!id) continue;
      const entry = {
        id: id.slice(0, 80),
        sizes: Array.isArray(item.sizes)
          ? item.sizes.map((value) => String(value).trim()).filter(Boolean).slice(0, 200)
          : [],
      };
      const format = String(item.format || '').trim();
      if (format) entry.format = format.slice(0, 20);
      const label = String(item.label || '').trim();
      if (label) entry.label = label.slice(0, 120);
      const note = String(item.note || '').trim();
      if (note) entry.note = note.slice(0, 60);
      const labels = item.labels && typeof item.labels === 'object' ? item.labels : null;
      if (labels) {
        const clean = {};
        let count = 0;
        for (const key of Object.keys(labels)) {
          if (count >= 200) break;
          const value = String(labels[key] || '').trim();
          if (!value) continue;
          clean[String(key).slice(0, 40)] = value.slice(0, 80);
          count += 1;
        }
        if (count) entry.labels = clean;
      }
      models.push(entry);
    }
    const aliases = {};
    const source = parsed && !Array.isArray(parsed) && parsed.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {};
    for (const key of Object.keys(source)) {
      const value = String(source[key] || '').trim();
      if (value) aliases[String(key).slice(0, 80)] = value.slice(0, 80);
    }
    sendJson(res, 200, {
      ok: true,
      path: MODELS_REL,
      absolute: file,
      exists: true,
      updated: String((parsed && !Array.isArray(parsed) && parsed.updated) || '').slice(0, 40),
      models,
      aliases,
    });
    return;
  }

  // ── 画布「Skills 模板」:读 ─────────────────────────────────────────
  if (route === '/skills' && req.method === 'GET') {
    const file = resolveInside(root, SKILLS_REL);
    let raw = null;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      raw = null;
    }
    let presets = [];
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        presets = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.presets) ? parsed.presets : [];
      } catch {
        throw new Error(`Skills 模板文件坏了(不是合法 JSON):${SKILLS_REL}`);
      }
    }
    sendJson(res, 200, { ok: true, path: SKILLS_REL, presets });
    return;
  }

  // ── 画布「Skills 模板」:写 ─────────────────────────────────────────
  if (route === '/skills' && req.method === 'POST') {
    const body = await readJson(req);
    const list = Array.isArray(body.presets) ? body.presets : [];
    const clean = [];
    for (const item of list.slice(0, 200)) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || '').trim();
      const name = String(item.name || '').trim();
      const prompt = String(item.prompt || '').trim();
      if (!id || !name || !prompt) continue;
      const preset = { id, name: name.slice(0, 60), prompt: prompt.slice(0, 4000) };
      for (const key of ['desc', 'model', 'ratio', 'quality', 'background', 'imageSize']) {
        const value = item[key];
        if (typeof value === 'string' && value.trim()) preset[key] = value.trim().slice(0, 200);
      }
      if (item.builtin === true) preset.builtin = true;
      clean.push(preset);
    }
    const text = `${JSON.stringify({ version: 1, presets: clean }, null, 2)}\n`;
    if (text.length > MAX_SKILLS_BYTES) {
      throw new Error(`Skills 模板太大(${(text.length / 1024).toFixed(0)} KB,上限 ${MAX_SKILLS_BYTES / 1024} KB)`);
    }
    const file = resolveInside(root, SKILLS_REL);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, 'utf8');
    sendJson(res, 200, { ok: true, path: SKILLS_REL, count: clean.length, bytes: text.length });
    return;
  }

  // ── 生成记录清单:读 ─────────────────────────────────────────────────
  // 清单坏了两条路:GET 时发现坏了就**原样告诉客户端**(corrupted: true)且不写任何东西 ——
  // 覆盖成空是客户端确认之后的决定,宿主绝不自作主张。
  if (route === '/history' && req.method === 'GET') {
    const file = resolveInside(root, HISTORY_REL);
    let raw = null;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      raw = null;
    }
    if (raw === null) {
      sendJson(res, 200, { ok: true, path: HISTORY_REL, records: [] });
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 200, { ok: true, path: HISTORY_REL, records: [], corrupted: true });
      return;
    }
    const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.records) ? parsed.records : [];
    sendJson(res, 200, { ok: true, path: HISTORY_REL, records });
    return;
  }

  // ── 生成记录清单:写 ─────────────────────────────────────────────────
  // 只认白名单字段:记录是快照,不是任由客户端塞东西的袋子 ——
  // 尤其不能让 header/密钥/调试日志混进来(任务书安全约束)。
  if (route === '/history' && req.method === 'POST') {
    const body = await readJson(req);
    const list = Array.isArray(body.records) ? body.records : [];
    if (list.length > MAX_HISTORY_RECORDS) {
      throw new Error(`生成记录太多(${list.length} 条,上限 ${MAX_HISTORY_RECORDS} 条)—— 先删掉一些旧记录再保存`);
    }
    const str = (value, cap) => {
      const text = typeof value === 'string' ? value.trim() : '';
      return text ? text.slice(0, cap) : undefined;
    };
    const num = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    };
    const clean = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const record = {};
      const id = str(item.id, 80);
      if (!id) continue; // 没有稳定 ID 的记录不收:去重和资源引用都靠它
      record.id = id;
      for (const key of ['taskId', 'promptUser', 'promptFinal', 'skillId', 'skillText', 'model', 'ratio', 'quality', 'background', 'imageSize', 'exactSize', 'sourceId', 'sourceName', 'sourceUrl', 'file']) {
        const value = str(item[key], key === 'promptFinal' ? 8000 : key === 'promptUser' || key === 'skillText' ? 4000 : 300);
        if (value !== undefined) record[key] = value;
      }
      for (const key of ['at', 'w', 'h', 'refCount', 'marksCount', 'textsCount']) {
        const value = num(item[key]);
        if (value !== undefined) record[key] = value;
      }
      for (const key of ['frame', 'cropped', 'submitTexts', 'fav']) {
        if (item[key] === true) record[key] = true;
      }
      if (Array.isArray(item.refNames)) {
        const names = item.refNames.map((name) => str(name, 100)).filter(Boolean).slice(0, 10);
        if (names.length) record.refNames = names;
      }
      clean.push(record);
    }
    const text = `${JSON.stringify({ version: 1, records: clean }, null, 1)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_HISTORY_BYTES) {
      throw new Error(`生成记录清单太大(${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(0)} KB,上限 ${MAX_HISTORY_BYTES / 1024} KB)—— 删掉一些旧记录再保存`);
    }
    await writeTextAtomic(resolveInside(root, HISTORY_REL), text);
    sendJson(res, 200, { ok: true, path: HISTORY_REL, count: clean.length, bytes: Buffer.byteLength(text, 'utf8') });
    return;
  }

  // ── 图片分层(Agent):读 image-layering 技能的 APIMart 配置 ──────────
  if (route === '/layering-config' && req.method === 'GET') {
    const dir = layeringSkillDir();
    const file = layeringConfigPath();
    const { data, exists } = await readJsonObject(file);
    // 端点与"最终会打的 URL"一并回给面板:换平台时用户能一眼看出路径有没有被拼重
    const base = String(data.base_url || LAYERING_DEFAULT_BASE).replace(/\/+$/, '');
    const submit = String(data.submit_endpoint || '').trim() || LAYERING_DEFAULT_SUBMIT;
    const status = String(data.task_status_endpoint || '').trim() || LAYERING_DEFAULT_STATUS;
    sendJson(res, 200, {
      ok: true,
      dir,
      path: file,
      skillInstalled: await fileExists(path.join(dir, 'SKILL.md')),
      exists,
      base_url: String(data.base_url || LAYERING_DEFAULT_BASE),
      submit_endpoint: submit,
      task_status_endpoint: status,
      default_submit_endpoint: LAYERING_DEFAULT_SUBMIT,
      default_task_status_endpoint: LAYERING_DEFAULT_STATUS,
      models_url: joinApiUrl(base, '/v1/models'),
      create_url: joinApiUrl(base, submit),
      status_url: joinApiUrl(base, status),
      // 模型名回**配置里的真实值**(空就是没配过),兜底值单独给一格 —— 面板据此显示
      // "现在存的是空 → 跑起来会用默认",而不是把兜底值伪装成"你选过的"
      model: String(data.model || ''),
      default_base: LAYERING_DEFAULT_BASE,
      default_model: LAYERING_DEFAULT_MODEL,
      configured: Boolean(String(data.api_key || '').trim()),
      // 只回掩码:密钥原文不出宿主进程
      keyMasked: maskSecret(data.api_key),
    });
    return;
  }

  // ── 图片分层(Agent):写配置(只认这一个文件,路径由宿主决定)──────
  if (route === '/layering-config' && req.method === 'POST') {
    const body = await readJson(req);
    const dir = layeringSkillDir();
    const file = layeringConfigPath();
    // 没装技能就明确报错,别悄悄建一个空 skill 目录
    if (!(await fileExists(path.join(dir, 'SKILL.md')))) {
      throw new Error(`没找到 image-layering 技能:${dir}(先装技能,或用环境变量 ${LAYERING_DIR_ENV} 指定它的目录)`);
    }
    const { data } = await readJsonObject(file);
    const base = String(body.base_url ?? data.base_url ?? LAYERING_DEFAULT_BASE).trim().replace(/\/+$/, '');
    if (base) {
      let parsed;
      try {
        parsed = new URL(base);
      } catch {
        throw new Error(`接口地址不是合法 URL:${base}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`接口地址只支持 http/https,收到 ${parsed.protocol}`);
      }
      data.base_url = base;
    }
    // 密钥语义:非空 = 覆盖;空 = 保持原值(面板上写"留空则不改");显式清除用 clear_key
    const key = String(body.api_key ?? '').trim();
    if (key) data.api_key = key;
    else if (body.clear_key === true) data.api_key = '';
    // 模型名:面板上选好了就换掉(空 = 保持原值)—— 换服务商时靠这一步,不用去手改 json
    const pickedModel = String(body.model ?? '').trim();
    if (pickedModel) data.model = pickedModel;
    if (typeof data.model !== 'string' || !data.model.trim()) data.model = LAYERING_DEFAULT_MODEL;
    // 端点路径:面板传了就用它(空 = 保持原值),没配过就落默认 —— 换平台时靠这两格改路径
    const pickedSubmit = String(body.submit_endpoint ?? '').trim();
    if (pickedSubmit) data.submit_endpoint = pickedSubmit;
    const pickedStatus = String(body.task_status_endpoint ?? '').trim();
    if (pickedStatus) data.task_status_endpoint = pickedStatus;
    if (typeof data.submit_endpoint !== 'string' || !data.submit_endpoint.trim()) data.submit_endpoint = LAYERING_DEFAULT_SUBMIT;
    if (typeof data.task_status_endpoint !== 'string' || !data.task_status_endpoint.trim()) data.task_status_endpoint = LAYERING_DEFAULT_STATUS;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log(
      `[grsai-canvas] 图片分层配置已写入 ${file}(${data.base_url},key ${String(data.api_key || '').trim() ? '已设置' : '未设置'})`,
    );
    sendJson(res, 200, {
      ok: true,
      dir,
      path: file,
      base_url: data.base_url,
      model: data.model,
      submit_endpoint: String(data.submit_endpoint || LAYERING_DEFAULT_SUBMIT),
      task_status_endpoint: String(data.task_status_endpoint || LAYERING_DEFAULT_STATUS),
      create_url: joinApiUrl(data.base_url, data.submit_endpoint),
      status_url: joinApiUrl(data.base_url, data.task_status_endpoint),
      configured: Boolean(String(data.api_key || '').trim()),
      keyMasked: maskSecret(data.api_key),
    });
    return;
  }

  // ── 图片分层(Agent):连接自检(只 GET /v1/models,不产生生成费用)──
  if (route === '/layering-test' && req.method === 'GET') {
    const { data } = await readJsonObject(layeringConfigPath());
    const base = String(data.base_url || LAYERING_DEFAULT_BASE).replace(/\/+$/, '');
    const key = String(data.api_key || '').trim();
    if (!key) throw new Error('还没配置分层服务的 API Key(先在设置面板那一格填好并保存)');
    const probeUrl = joinApiUrl(base, '/v1/models');
    let status = 0;
    let note = '';
    try {
      const upstream = await fetch(probeUrl, {
        headers: { Authorization: `Bearer ${key}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(20000),
      });
      status = upstream.status;
      note = String((await upstream.text()) || '')
        .slice(0, 200)
        .replace(/\s+/g, ' ');
    } catch (error) {
      throw new Error(`连不上 ${base}:${error instanceof Error ? error.message : String(error)}`);
    }
    sendJson(res, 200, {
      ok: status >= 200 && status < 300,
      status,
      base_url: base,
      probe_url: probeUrl,
      note,
      hint:
        status === 401 || status === 403
          ? 'Key 被拒绝(401/403):检查是不是粘贴时带了空格或换行'
          : status === 404
            ? '这个地址没有 /v1/models 自检端点 —— 很多分层平台(尤其只做图层分解的)本来就不提供。不代表地址或 key 有问题,直接点「▶ 图片分层(交给 Agent)」跑一张就知道'
            : status >= 200 && status < 300
              ? '连接正常'
              : `上游返回 HTTP ${status}`,
    });
    return;
  }

  // ── 图片分层(Agent):列可用模型(只 GET 上游 /v1/models,不产生费用)──
  //
  // 为什么要有这一条:图层分解各家叫法不一样 —— APIMart 叫 `seedream-5-0-pro`,
  // EvoLink 叫 `doubao-seedream-5.0-pro-layerize`,kie 叫 `seedream/5-pro-layer-decomposition`。
  // 以前换服务商得自己去技能目录手改 json 里的 model,现在点一下就能选。
  if (route === '/layering-models' && req.method === 'GET') {
    const { data } = await readJsonObject(layeringConfigPath());
    const base = String(data.base_url || LAYERING_DEFAULT_BASE).replace(/\/+$/, '');
    const key = String(data.api_key || '').trim();
    if (!key) throw new Error('还没配置分层服务的 API Key(先在面板里填好 key 并点「保存」)');

    // 60 秒内同一个地址直接复用:上游限流挺凶,连点两下就会 429
    if (layeringModelsCache.models && layeringModelsCache.base === base && Date.now() - layeringModelsCache.at < 60000) {
      sendJson(res, 200, Object.assign({}, layeringModelsCache.payload, { cached: true }));
      return;
    }

    let upstream;
    try {
      upstream = await fetch(joinApiUrl(base, '/v1/models'), {
        headers: { Authorization: `Bearer ${key}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new Error(`连不上 ${base}:${error instanceof Error ? error.message : String(error)}`);
    }
    if (!upstream.ok) {
      throw new Error(
        `取模型列表失败:HTTP ${upstream.status}(${upstream.status === 429 ? '上游限流了,等几秒再点' : '检查 key 有没有粘贴时带上空格'})`,
      );
    }

    let json;
    try {
      json = await upstream.json();
    } catch {
      throw new Error('上游的 /v1/models 返回的不是 JSON —— 这个地址可能不是 OpenAI 兼容接口');
    }
    const raw = Array.isArray(json && json.data) ? json.data : Array.isArray(json && json.models) ? json.models : [];
    const ids = raw
      .map((item) => String((item && (item.id || item.name)) || item || '').trim())
      .filter(Boolean);

    /**
     * 一个模型名有多像"图层分解":3 = 明说了,2 = Seedream 系列(可能就是),1 = 图像编辑类(也许能)。
     * @param {string} id - 模型名。
     * @returns {number} 0~3 的相似度。
     */
    const rankOf = (id) => {
      if (/layer|layerize|decomposition|decompose|分层/i.test(id)) return 3;
      if (/seedream/i.test(id)) return 2;
      if (/seededit|image-edit|image_edit|nano-banana|gpt-image/i.test(id)) return 1;
      return 0;
    };
    // 一次把全部模型都返回(带 rank),「只看像的 / 显示全部」交给客户端本地切 —— 免得切一次就打一次上游
    const models = ids
      .map((id) => ({ id, rank: rankOf(id) }))
      .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
      .map((item) => ({
        id: item.id,
        rank: item.rank,
        hint:
          item.rank === 3
            ? '名字里带图层分解'
            : item.rank === 2
              ? 'Seedream 系列'
              : item.rank === 1
                ? '图像编辑类,可能也支持'
                : '',
      }));

    const payload = {
      ok: true,
      base,
      total: ids.length,
      matched: models.filter((item) => item.rank > 0).length,
      current: String(data.model || ''),
      models,
    };
    layeringModelsCache = { at: Date.now(), base, models, payload };
    sendJson(res, 200, payload);
    return;
  }

  // ── 画布状态:读 ───────────────────────────────────────────────────
  if (route === '/state' && req.method === 'GET') {
    const file = resolveInside(root, STATE_REL);
    let raw = null;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      raw = null;
    }
    let state = null;
    if (raw !== null) {
      try {
        state = JSON.parse(raw);
      } catch {
        // 坏档保留现场再报错:直接抛的话用户只能删档重来,而且下一次保存会把它覆盖掉
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.rename(file, `${file}.corrupt-${stamp}`).catch(() => {});
        throw new Error(`画布存档坏了(不是合法 JSON):${STATE_REL} —— 已备份成 ${STATE_REL}.corrupt-${stamp},重新保存会写一份新的`);
      }
    }
    sendJson(res, 200, { ok: true, path: STATE_REL, state });
    return;
  }

  // ── 画布状态:写 ───────────────────────────────────────────────────
  if (route === '/state' && req.method === 'POST') {
    const raw = (await readBody(req)).toString('utf8');
    if (raw.length > MAX_STATE_BYTES) {
      throw new Error(
        `画布状态太大(${(raw.length / 1048576).toFixed(1)} MB,上限 ${Math.round(MAX_STATE_BYTES / 1048576)} MB):先删掉几张图再保存`,
      );
    }
    try {
      JSON.parse(raw);
    } catch {
      throw new Error('画布状态不是合法 JSON');
    }
    const file = resolveInside(root, STATE_REL);
    // 这是全插件最大的一个文件(最坏 48 MB),更要用原子写:
    // 直接 writeFile 写到一半崩溃,画布存档就烂在原地,整张画布随之丢失。
    await writeTextAtomic(file, raw);
    sendJson(res, 200, { ok: true, path: STATE_REL, bytes: raw.length });
    return;
  }

  // ── GrsAI:创建任务 ─────────────────────────────────────────────────
  if (route === '/generate' && req.method === 'POST') {
    const key = req.headers['x-grsai-key'] || '';
    if (!key) throw new Error('还没有填 GrsAI APIKEY');
    const payload = await readJson(req);
    const upstream = await fetchUpstream(
      `${upstreamBase(req)}/v1/api/generate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
        cache: 'no-store',
      },
      120000,
      '生成请求',
    );
    const text = await upstream.text();
    recordUpstream('generate', upstream.status, text);
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(text);
    return;
  }

  // ── GrsAI:查询任务 ─────────────────────────────────────────────────
  if (route === '/result' && req.method === 'GET') {
    const key = req.headers['x-grsai-key'] || '';
    if (!key) throw new Error('还没有填 GrsAI APIKEY');
    const id = url.searchParams.get('id');
    if (!id) throw new Error('缺少 id 参数');
    const upstream = await fetchUpstream(
      `${upstreamBase(req)}/v1/api/result?id=${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        cache: 'no-store',
      },
      20000,
      '查询任务',
    );
    const text = await upstream.text();
    recordUpstream('result', upstream.status, text);
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(text);
    return;
  }

  // ── 远程图片转字节:画布要能 toDataURL,不能跨域污染 ─────────────────
  if (route === '/image' && req.method === 'GET') {
    const target = url.searchParams.get('url');
    if (!target) throw new Error('缺少 url 参数');
    let parsed = new URL(target);
    let upstream;
    const redirectStatuses = new Set([301, 302, 303, 307, 308]);
    const maxRedirects = 5;
    for (let redirects = 0; ; redirects += 1) {
      // 每一跳都必须在 fetch 前验证;自动跟随后检查 response.url 已无法阻止内网请求。
      // 这里只沿用主机名检查,不解决域名解析到私网或 DNS 重绑定的问题。
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http/https 图片地址');
      if (isPrivateHost(parsed.hostname)) throw new Error(`拒绝取本机/内网地址:${parsed.hostname}`);
      upstream = await fetch(parsed.href, { cache: 'no-store', redirect: 'manual' });
      if (!redirectStatuses.has(upstream.status)) break;
      const location = upstream.headers.get('location');
      // 不读取重定向正文,及时释放连接;拒绝无 Location 及超限重定向。
      await upstream.body?.cancel();
      if (!location) throw new Error('取图失败:重定向缺少 Location');
      if (redirects >= maxRedirects) throw new Error('取图失败:重定向次数过多');
      parsed = new URL(location, parsed);
    }
    if (!upstream.ok) throw new Error(`取图失败:HTTP ${upstream.status}`);
    // 流式读 + 硬上限:arrayBuffer() 会把任意大小的上游文件整个吞进内存
    const chunks = [];
    let total = 0;
    for await (const chunk of upstream.body) {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES) {
        await upstream.body.cancel().catch(() => {});
        throw new Error(`图片太大(${(total / 1048576).toFixed(1)} MB,上限 ${Math.round(MAX_IMAGE_BYTES / 1048576)} MB)`);
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    // 只回真正的图片字节:上游 Content-Type 是第三方可控的,原样透传 text/html
    // 就等于把攻击者的页面渲染在 DSH 同源下(它能反过来调 /update/apply 覆盖插件代码)。
    const declared = String(upstream.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const mime = sniffImageMime(buffer);
    if (!mime) {
      const error = new Error(`取图失败:上游返回的不是图片(${declared || '没有 Content-Type'})`);
      error.statusCode = 415;
      throw error;
    }
    if (declared && IMAGE_MIME.has(declared) && declared !== mime) {
      recordUpstream('image', 200, `content-type 声明 ${declared},实际 ${mime}`);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'no-store');
    res.end(buffer);
    return;
  }

  // ── 插件自我更新:本机现状(不发网络请求)──────────────────────────
  if (route === '/update/status' && req.method === 'GET') {
    const disk = await readPackage(PLUGIN_DIR).catch(() => null);
    sendJson(res, 200, {
      ok: true,
      // loaded 是**正在内存里跑的**版本,disk 是磁盘上的版本:更新完这两个会不一样,重启才对上
      loaded: VERSION,
      disk: String((disk && disk.version) || ''),
      name: String((disk && disk.name) || ''),
      dir: PLUGIN_DIR,
      backups: await listBackups(PLUGIN_DIR),
    });
    return;
  }

  // ── 插件自我更新:检查有没有新版本 ─────────────────────────────────
  if (route === '/update/check' && req.method === 'POST') {
    const body = await readJson(req);
    const manifestUrl = String(body.url || '').trim();
    if (!manifestUrl) throw new Error('还没填更新地址(在「设置」里填清单 JSON 的完整地址)');
    const manifest = parseManifest(await download(manifestUrl, MAX_MANIFEST_BYTES), manifestUrl);
    if (!manifest.url) throw new Error('更新清单里没有 url(要指向这次要装的 zip)');
    if (!manifest.sha256) throw new Error('更新清单里没有 sha256 校验和 —— 为了安全,插件不带校验和就不装');
    const disk = await readPackage(PLUGIN_DIR).catch(() => null);
    const current = String((disk && disk.version) || VERSION);
    sendJson(res, 200, {
      ok: true,
      current,
      loaded: VERSION,
      version: manifest.version,
      notes: manifest.notes,
      sha256: manifest.sha256,
      packageUrl: manifest.url,
      packageBytes: manifest.packageBytes,
      newer: compareVersions(manifest.version, current) > 0,
      sameAsLoaded: compareVersions(manifest.version, VERSION) === 0,
    });
    return;
  }

  // ── 插件自我更新:下载并就地安装(先备份,失败不动)──────────────────
  if (route === '/update/apply' && req.method === 'POST') {
    const body = await readJson(req);
    const manifestUrl = String(body.url || '').trim();
    if (!manifestUrl) throw new Error('还没填更新地址');
    const manifest = parseManifest(await download(manifestUrl, MAX_MANIFEST_BYTES), manifestUrl);
    if (!manifest.url || !manifest.sha256) throw new Error('更新清单不完整(需要 url 与 sha256)');
    const zip = await download(manifest.url, MAX_PACKAGE_BYTES, 120000);
    const result = await applyUpdate({ pluginDir: PLUGIN_DIR, zip, sha256: manifest.sha256, version: manifest.version });
    console.log(`[grsai-canvas] 插件已更新:${result.from} → ${result.to}(${result.written.length} 个文件,重启 DSH 后宿主生效)`);
    sendJson(res, 200, {
      ok: true,
      from: result.from,
      to: result.to,
      files: result.written.length,
      backup: result.backup,
      notes: manifest.notes,
      // 客户端半边刷新页面就换了;宿主半边要重启 DSH
      restartNeeded: true,
    });
    return;
  }

  // ── 插件自我更新:回滚到上一个版本 ─────────────────────────────────
  if (route === '/update/rollback' && req.method === 'POST') {
    const result = await rollbackUpdate({ pluginDir: PLUGIN_DIR });
    console.log(`[grsai-canvas] 插件已回滚到 ${result.to}(${result.restored.length} 个文件)`);
    sendJson(res, 200, { ok: true, to: result.to, files: result.restored.length, backup: result.backup, restartNeeded: true });
    return;
  }

  // ── AI 高清放大:引擎状态(本地 + 清单校验;取不到清单就降级成"文件在不在")──
  if (route === '/upscale-status' && req.method === 'GET') {
    const dir = upscaleEngineDir();
    const tiers = [];
    let manifestError = '';
    try {
      const { manifest } = await upscaleManifest(false);
      for (const id of Object.keys(UPSCALE_TIERS)) {
        const spec = UPSCALE_TIERS[id];
        const state = await inspectTier(dir, tierFiles(manifest, id));
        tiers.push({
          id,
          label: spec.label,
          desc: spec.desc,
          model: spec.model,
          ready: state.ready,
          installed: state.installed,
          total: state.total,
          bytes: state.bytes,
        });
      }
    } catch (error) {
      // 离线 / 站点不通:只说本地有没有 exe,不假装知道更多
      manifestError = error instanceof Error ? error.message : String(error);
      for (const id of Object.keys(UPSCALE_TIERS)) {
        const spec = UPSCALE_TIERS[id];
        tiers.push({ id, label: spec.label, desc: spec.desc, model: spec.model, ready: false, installed: 0, total: 0, bytes: 0 });
      }
    }
    sendJson(res, 200, {
      ok: true,
      dir,
      base: DEFAULT_ENGINE_BASE,
      tiers,
      busy: upscaleBusy,
      manifestError,
      exe: await fileExists(path.join(dir, 'realesrgan-ncnn-vulkan.exe')),
    });
    return;
  }

  // ── AI 高清放大:把引擎下下来(缺什么补什么,已就绪的直接跳过)──────────
  if (route === '/upscale-ensure' && req.method === 'POST') {
    const body = await readJson(req);
    const tier = String(body.tier || 'fast').trim();
    if (!UPSCALE_TIERS[tier]) throw new Error(`未知档位:${tier}(可选 ${Object.keys(UPSCALE_TIERS).join(' / ')})`);
    if (upscaleBusy) throw new Error(`引擎正忙(${upscaleBusy}),稍等一下再试`);
    upscaleBusy = `下载引擎(${UPSCALE_TIERS[tier].label})`;
    try {
      const dir = upscaleEngineDir();
      const { manifest, base } = await upscaleManifest(true);
      const result = await ensureTier({
        dir,
        tier,
        manifest,
        base,
        onLog: (message) => console.log(`[grsai-canvas] ${message}`),
      });
      console.log(`[grsai-canvas] 放大引擎就绪:${result.dir}(档位 ${tier},本次下载 ${result.downloaded} 个文件)`);
      sendJson(res, 200, {
        ok: true,
        tier,
        dir: result.dir,
        model: result.model,
        downloaded: result.downloaded,
        skipped: result.skipped,
      });
    } finally {
      upscaleBusy = '';
    }
    return;
  }

  // ── AI 高清放大:跑一张(引擎没就绪会自动先下;结果写回工作区)────────────
  if (route === '/upscale-run' && req.method === 'POST') {
    const body = await readJson(req);
    const tier = String(body.tier || 'fast').trim();
    const spec = UPSCALE_TIERS[tier];
    if (!spec) throw new Error(`未知档位:${tier}(可选 ${Object.keys(UPSCALE_TIERS).join(' / ')})`);
    if (upscaleBusy) throw new Error(`引擎正忙(${upscaleBusy}),稍等一下再试`);

    // 输入:工作区里的相对路径,或者画布直接给的 dataURL
    let inputPath = '';
    let tempInput = '';
    if (body.inputRel) {
      inputPath = resolveInside(root, String(body.inputRel));
      if (!IMAGE_EXT.has(path.extname(inputPath).toLowerCase())) throw new Error('输入只接受图片文件');
    } else if (body.dataUrl) {
      const { buffer } = decodeDataUrl(String(body.dataUrl));
      tempInput = path.join(os.tmpdir(), `grsai-upscale-${Date.now().toString(36)}.png`);
      await fsp.writeFile(tempInput, buffer);
      inputPath = tempInput;
    } else {
      throw new Error('要给它一张图:inputRel(工作区相对路径)或 dataUrl');
    }

    // 输出:必须落在工作区里,且是图片后缀(免得被拿来写任意文件)
    const rel = String(body.outputRel || `画布输出/放大-${Date.now().toString(36)}.png`).trim();
    const outputPath = resolveInside(root, rel);
    if (!IMAGE_EXT.has(path.extname(outputPath).toLowerCase())) throw new Error('输出必须是图片文件名');

    upscaleBusy = `放大 ${path.basename(inputPath)}`;
    try {
      const dir = upscaleEngineDir();
      const { manifest, base } = await upscaleManifest(false);
      const ensured = await ensureTier({
        dir,
        tier,
        manifest,
        base,
        onLog: (message) => console.log(`[grsai-canvas] ${message}`),
      });
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      const scale = Number(body.scale) || 4;
      const result = await runUpscale({
        exe: ensured.exe,
        input: inputPath,
        output: outputPath,
        model: spec.model,
        scale,
        gpu: Number.isInteger(body.gpu) ? body.gpu : undefined,
        onLog: (text) => {
          // exe 的进度是百分比,量很大;只把最后一段留进日志,别刷屏
          const tail = String(text).trim().split(/\s+/).pop();
          if (tail && tail.endsWith('%')) return;
          console.log(`[grsai-canvas] 放大引擎:${String(text).trim().slice(0, 200)}`);
        },
      });
      const seconds = Number((result.ms / 1000).toFixed(1));
      console.log(`[grsai-canvas] AI 放大完成:${spec.label} ${path.basename(inputPath)} → ${rel}(${seconds} 秒)`);
      sendJson(res, 200, {
        ok: true,
        tier,
        model: spec.model,
        scale,
        output: rel.replace(/\\/g, '/'),
        ms: result.ms,
        seconds,
        downloaded: ensured.downloaded,
      });
    } finally {
      upscaleBusy = '';
      if (tempInput) await fsp.rm(tempInput, { force: true }).catch(() => {});
    }
    return;
  }

  sendJson(res, 404, { error: `未知路由:${route}` });
}

/**
 * 插件体:注册路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 携带 `webServer` 的上下文。
 * @returns {void}
 */
export function apply(ctx) {
  // 插件自带的 image-layering 技能:缺了就铺一份、版本旧就升级(幂等,绝不动用户填的密钥)。
  // 放在这里而不是只靠 install.ps1 —— 插件的自我更新只覆盖文件、不跑安装脚本。
  void ensureLayeringSkill()
    .then((result) => {
      if (result.action !== 'skipped') {
        console.log(
          `[grsai-canvas] 图片分层技能${result.action === 'installed' ? '已安装' : '已更新'}到 ${result.dir}(v${result.to})`,
        );
      }
    })
    .catch((error) => {
      console.warn(`[grsai-canvas] 图片分层技能自动铺设失败:${error instanceof Error ? error.message : String(error)}`);
    });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        // 返回 promise:调用方(以及测试)可以直接 await 到响应写完。
        handler: (req, res) =>
          Promise.resolve(handle(req, res, ctx)).catch((error) => {
            const status = Number(error && error.statusCode) || 500;
            if (res.headersSent) {
              res.end();
              return;
            }
            if (status === 413) {
              // 请求体没读完就回绝:让响应先出去,再把这条连接关掉,别让浏览器只看到 Failed to fetch
              res.setHeader('Connection', 'close');
              if (typeof res.on === 'function') {
                res.on('finish', () => {
                  if (typeof req.destroy === 'function') req.destroy();
                });
              }
            }
            sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
          }),
      }),
    'grsai-canvas: HTTP routes',
  );
}
