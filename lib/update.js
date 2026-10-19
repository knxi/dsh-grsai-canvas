/**
 * dsh-grsai-canvas —— 插件自我更新(宿主侧)。
 *
 * 「更新按钮」的全部脏活都在这里,因为它必须由 Node 半边干:
 * 浏览器跨域拿不到别人的站点、也没法写自己的安装目录。
 *
 * 设计上按"**这是在下载并替换自己的代码**"来对待,所以:
 *
 * 1. **默认关闭**:没填更新地址就什么都不做;
 * 2. **必须有校验和**:清单里没有 `sha256` 一律拒绝安装(宁可麻烦,也不要"下载什么就跑什么");
 * 3. **只写自己的安装目录**:zip 里的路径先规范化,绝对路径 / `..` / 盘符 / 白名单外的顶层名字全部拒绝(zip-slip);
 * 4. **先备份再覆盖**:老文件进 `update-backup/<版本>/`,随时能回滚;
 * 5. **只认 http/https,且有体积与条目数上限**。
 *
 * 零第三方依赖:zip 解析用 `node:zlib` 自己解(stored / deflate 两种都支持)。
 *
 * @module dsh-grsai-canvas/update
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 单个下载文件的上限:清单 256 KB,安装包 32 MB。 */
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
/** zip 里最多多少个条目(防炸弹)。 */
export const MAX_ZIP_ENTRIES = 500;
/** 解压后单个文件的上限(防 zip 炸弹)。 */
export const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

/**
 * 允许被更新覆盖的顶层名字(其余一律拒绝)。根目录的**文件**另按后缀白名单放行。
 *
 * `lib/parts` 是客户端源码(客户端半边 0.13.0 起拆成零件,见 `lib/parts/00-runtime.js`),
 * `tools` 是装配/自检脚本(`build-client.mjs`、`check-deps.mjs`)—— 两者都在 `lib` / `tools`
 * 之下,所以只要放行这两个顶层名字,里面的文件就能随更新一起换新。
 */
export const ALLOWED_TOP_LEVEL = ['lib', 'deploy', 'tools', 'package.json', 'cordis.patch.yml'];

/**
 * 根目录允许出现的文件后缀。
 *
 * 为什么要有这一条:`Compress-Archive` 打出来的包里,根目录除了文档还有
 * `install.cmd` / `uninstall.cmd` / `cordis.patch.yml` —— 早先只放行 `.md`/`.txt`,
 * 结果**真包会被自己拒掉**(合成 zip 测不出来,因为里面没放这些文件)。
 */
export const ALLOWED_ROOT_EXT = ['.md', '.txt', '.cmd', '.ps1', '.yml', '.yaml', '.json'];

/** 备份目录名(在插件目录里)。 */
export const BACKUP_DIR = 'update-backup';

/** 本插件自己的包名 —— 下载下来的包必须同名,免得指错地址把别的东西装进来。 */
export const PACKAGE_NAME = 'dsh-grsai-canvas';

// ── 版本比较 ───────────────────────────────────────────────────────────────

/**
 * 比较两个版本号(只看数字段,`0.4.0-beta` 里的 `-beta` 忽略)。
 * @param {string} a - 版本 A。
 * @param {string} b - 版本 B。
 * @returns {number} A>B 给 1,A<B 给 -1,相等给 0。
 */
export function compareVersions(a, b) {
  const parts = (v) =>
    String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((piece) => Number.parseInt(piece, 10))
      .filter((n) => Number.isFinite(n));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// ── CRC32(zip 校验用)──────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/**
 * 算一段字节的 CRC32(zip 每条都有,用来确认解压没出错)。
 * @param {Buffer} buffer - 数据。
 * @returns {number} 无符号 32 位 CRC。
 */
export function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── zip 解析 ───────────────────────────────────────────────────────────────

/**
 * 找出 zip 的中央目录(从尾部往前找 EOCD 签名)。
 * @param {Buffer} buf - zip 数据。
 * @returns {{count: number, offset: number, size: number}} 中央目录信息。
 */
function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 65557); // 注释最长 64 KB
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const count = buf.readUInt16LE(i + 10);
    const size = buf.readUInt32LE(i + 12);
    const offset = buf.readUInt32LE(i + 16);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new Error('这个 zip 是 ZIP64 格式,插件不支持 —— 用普通 zip(Compress-Archive 默认就是)重新打包');
    }
    return { count, offset, size };
  }
  throw new Error('这不像是 zip 文件(找不到 zip 结尾标记)');
}

/**
 * 读一个 zip,把每个条目的内容解出来。
 *
 * 只支持 stored(0)与 deflate(8)—— 这覆盖 `Compress-Archive`、`zip`、`tar -a -c -f` 等常见工具。
 * 目录条目(以 `/` 结尾)会跳过。
 *
 * @param {Buffer} buf - zip 数据。
 * @returns {Array<{name: string, data: Buffer}>} 条目(按 zip 里的顺序)。
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('安装包是空的');
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd.count > MAX_ZIP_ENTRIES) throw new Error(`安装包里文件太多(${eocd.count} 个,上限 ${MAX_ZIP_ENTRIES})`);
  const entries = [];
  let at = eocd.offset;
  for (let i = 0; i < eocd.count; i += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('安装包结构坏了(中央目录读不下去)');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const expectCrc = buf.readUInt32LE(at + 16);
    const compSize = buf.readUInt32LE(at + 20);
    const rawSize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // 目录
    if (flags & 0x1) throw new Error(`安装包里的「${name}」是加密的,插件读不了`);
    if (rawSize > MAX_ENTRY_BYTES) throw new Error(`安装包里的「${name}」太大(${(rawSize / 1048576).toFixed(1)} MB)`);
    if (buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`安装包结构坏了(「${name}」的头部对不上)`);
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataAt, dataAt + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        // maxOutputLength 是**解压过程中**的硬闸:没有它,32 MB 的包能解出几十 GB,
        // 一次性在堆上分配直接打爆宿主(前面按中央目录 rawSize 的检查拦不住伪造的包)。
        data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (error) {
        if (error && (error.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength/i.test(String(error.message)))) {
          throw new Error(`「${name}」解压后超过 ${Math.round(MAX_ENTRY_BYTES / 1048576)} MB 上限,已中止`);
        }
        throw new Error(`解压「${name}」失败:${error && error.message}`);
      }
    } else throw new Error(`安装包里的「${name}」用了不支持的压缩方式(${method}),请用普通 zip 重新打包`);
    if (data.length !== rawSize) throw new Error(`「${name}」解出来的大小不对`);
    if (crc32(data) !== expectCrc) throw new Error(`「${name}」校验失败(CRC 对不上,文件可能损坏)`);
    entries.push({ name, data });
  }
  if (!entries.length) throw new Error('安装包里没有文件');
  return entries;
}

// ── 路径安全 ───────────────────────────────────────────────────────────────

/**
 * 把一个 zip 条目名变成"相对插件目录的安全路径",不安全就抛错。
 * 规则:去掉开头的 `./`、把 `\` 当 `/`;可剥掉一层包目录名(如 `dsh-grsai-canvas/`);
 * 拒绝绝对路径、盘符、`..`、空字节;落点必须是 `lib`/`deploy` 之下,或根目录的白名单文件
 * (顶层名字见 `ALLOWED_TOP_LEVEL`,根目录文件按 `ALLOWED_ROOT_EXT`)。
 *
 * 注意:写入位置永远在插件目录里 —— "剥一层目录"只是照顾各家打包习惯,不是放行越界。
 *
 * @param {string} rawName - zip 里的条目名。
 * @returns {string} 形如 `lib/client.js` 的相对路径。
 */
export function safeEntryPath(rawName) {
  const name = String(rawName || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!name || name.includes('\0')) throw new Error('安装包里有空文件名');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`安装包里有绝对路径:「${rawName}」`);
  const parts = name.split('/').filter((piece) => piece && piece !== '.');
  if (parts.some((piece) => piece === '..')) throw new Error(`安装包里有越界路径:「${rawName}」`);
  // 剥掉一层包目录(dsh-grsai-canvas/xxx,或任意单层目录/xxx)
  const isRootFile = (piece) => /\.(md|txt)$/i.test(piece) || ALLOWED_ROOT_EXT.includes(path.extname(piece).toLowerCase());
  if (parts.length > 1 && !ALLOWED_TOP_LEVEL.includes(parts[0]) && !isRootFile(parts[0])) parts.shift();
  if (!parts.length) throw new Error(`安装包里的路径不合法:「${rawName}」`);
  if (parts.length === 1) {
    if (!ALLOWED_ROOT_EXT.includes(path.extname(parts[0]).toLowerCase())) {
      throw new Error(`安装包里有个插件目录外的文件,已拒绝:「${rawName}」`);
    }
    return parts[0];
  }
  if (!ALLOWED_TOP_LEVEL.includes(parts[0])) throw new Error(`安装包里有个插件目录外的文件,已拒绝:「${rawName}」`);
  return parts.join('/');
}

// ── 下载 ───────────────────────────────────────────────────────────────────

/**
 * 判断是不是本机/内网地址。
 *
 * `/image` 取图代理与更新下载都用它挡 SSRF —— 否则一个
 * `<img src="…/image?url=http://192.168.1.1/…">`、或者一条指向内网的"更新清单",
 * 就能借宿主的网络位置去探内网端口、读云元数据。
 *
 * 只做**字面**判断,不解析 DNS:域名解析到私网仍然挡不住(所以调用方还要禁自动跟随重定向)。
 *
 * @param {string} hostname - URL 里的主机名(允许带方括号)。
 * @returns {boolean} 是本机/内网给 true。
 */
export function isPrivateHost(hostname) {
  let host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return true;
  // IPv4-mapped IPv6(::ffff:127.0.0.1 或 ::ffff:7f00:1)先归一成点分 IPv4,
  // 否则 `http://[::ffff:127.0.0.1]/` 能绕过下面所有字面判断,实际却连本机。
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const rest = mapped[1];
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(rest)) host = rest;
    else {
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
      if (hex) {
        const n = ((parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)) >>> 0;
        host = [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
      }
    }
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  // 100.64.0.0/10(CGNAT,云主机内网常见)与 198.18.0.0/15(测速网段)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  if (/^198\.(1[89])\./.test(host)) return true;
  const m = /^172\.(\d{1,3})\./.exec(host);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 唯一本地地址
  if (/^fe80:/.test(host)) return true; // 链路本地
  return false;
}

/**
 * 下一个地址的内容(只认 http/https,带体积上限与超时)。
 *
 * 重定向手动跟(最多 3 跳),每一跳都重新过 `isPrivateHost`:
 * 用 `redirect:'follow'` 的话,第一跳公网、第二跳内网是检查不到的。
 *
 * @param {string} url - 地址。
 * @param {number} limit - 体积上限(字节)。
 * @param {number} [timeoutMs] - 超时(默认 30 秒)。
 * @returns {Promise<Buffer>} 内容。
 */
export async function download(url, limit, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    throw new Error(`更新地址不是合法 URL:${url}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    let current = parsed;
    for (let hops = 0; ; hops += 1) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error(`更新地址只支持 http/https,收到 ${current.protocol}`);
      }
      if (isPrivateHost(current.hostname)) {
        throw new Error(`拒绝访问本机/内网地址:${current.hostname}(更新地址必须是公网)`);
      }
      const res = await fetch(current.href, { signal: controller.signal, cache: 'no-store', redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location) throw new Error('下载失败:重定向缺少 Location');
        if (hops >= 3) throw new Error('下载失败:重定向次数过多');
        current = new URL(location, current);
        continue;
      }
      if (!res.ok) throw new Error(`下载失败:HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared && declared > limit) throw new Error(`文件太大(${(declared / 1048576).toFixed(1)} MB,上限 ${(limit / 1048576).toFixed(1)} MB)`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > limit) throw new Error(`文件太大(${(buf.length / 1048576).toFixed(1)} MB,上限 ${(limit / 1048576).toFixed(1)} MB)`);
      return buf;
    }
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('下载超时(30 秒)—— 检查网络或换个地址');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析更新清单。清单可以是一个 JSON,也可以是一段纯文本只写版本号。
 * @param {Buffer} buf - 下载到的内容。
 * @param {string} baseUrl - 清单地址(用来把相对路径拼成绝对地址)。
 * @returns {{version: string, url: string, sha256: string, notes: string, minHost: string}} 清单。
 */
export function parseManifest(buf, baseUrl) {
  const text = buf.toString('utf8').trim();
  let json = null;
  if (text.startsWith('{')) {
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(`更新清单不是合法 JSON:${error && error.message}`);
    }
  } else {
    json = { version: text.split(/\s+/)[0] };
  }
  const version = String(json.version || '').trim();
  if (!/^\d+(\.\d+)*/.test(version)) throw new Error(`更新清单里没有可用的版本号:${JSON.stringify(version)}`);
  const rawUrl = String(json.url || json.package || json.zip || '').trim();
  let zipUrl = rawUrl;
  if (rawUrl && !/^https?:/i.test(rawUrl)) zipUrl = new URL(rawUrl, baseUrl).href;
  return {
    version,
    url: zipUrl,
    sha256: String(json.sha256 || json.sha || '').trim().toLowerCase(),
    notes: String(json.notes || json.changelog || '').trim(),
    minHost: String(json.minHost || '').trim(),
    packageBytes: Number(json.bytes) || 0,
  };
}

// ── 安装 / 回滚 ────────────────────────────────────────────────────────────

/** 读插件目录里的 package.json。 */
export async function readPackage(pluginDir) {
  const raw = await fsp.readFile(path.join(pluginDir, 'package.json'), 'utf8');
  return JSON.parse(raw);
}

/**
 * 把一份安装包写到插件目录里(先备份旧文件)。
 *
 * @param {{pluginDir: string, zip: Buffer, sha256?: string, version?: string}} input - 参数。
 * @returns {Promise<{from: string, to: string, written: string[], backup: string, skipped: string[]}>} 结果。
 */
export async function applyUpdate(input) {
  const pluginDir = input.pluginDir;
  const current = await readPackage(pluginDir).catch(() => null);
  if (!current || current.name !== PACKAGE_NAME) {
    throw new Error(`这个目录不是 ${PACKAGE_NAME} 的安装目录,不敢动:${pluginDir}`);
  }
  if (input.sha256) {
    const { createHash } = await import('node:crypto');
    const got = createHash('sha256').update(input.zip).digest('hex');
    if (got !== String(input.sha256).toLowerCase()) {
      throw new Error(`安装包校验失败:清单里的 sha256 是 ${input.sha256},下载到的是 ${got} —— 已中止,什么都没改`);
    }
  }
  const entries = readZip(input.zip);
  // 先全部过一遍路径校验与包名核对,确认没问题再落盘(免得写一半才发现不对)
  const plan = entries.map((entry) => ({ rel: safeEntryPath(entry.name), data: entry.data }));
  const manifestEntry = plan.find((item) => item.rel === 'package.json');
  if (!manifestEntry) throw new Error('安装包里没有 package.json,不像是插件包');
  let incoming;
  try {
    incoming = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    throw new Error('安装包里的 package.json 不是合法 JSON');
  }
  if (incoming.name !== PACKAGE_NAME) throw new Error(`安装包是「${incoming.name}」,不是 ${PACKAGE_NAME} —— 更新地址可能填错了`);
  const to = String(incoming.version || input.version || '').trim();
  if (!to) throw new Error('安装包里没写版本号');

  // 备份:只备份"将被覆盖且已存在"的文件
  const stamp = `${current.version || 'unknown'}-${Date.now().toString(36)}`;
  const backupDir = path.join(pluginDir, BACKUP_DIR, stamp);
  const written = [];
  const skipped = [];
  const backedUp = [];
  try {
    for (const item of plan) {
      const target = path.join(pluginDir, item.rel);
      if (!target.startsWith(pluginDir + path.sep)) throw new Error(`路径越界,已拒绝:${item.rel}`);
      const exists = await fsp
        .stat(target)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        const keep = path.join(backupDir, item.rel);
        await fsp.mkdir(path.dirname(keep), { recursive: true });
        await fsp.copyFile(target, keep);
        backedUp.push(item.rel);
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, item.data);
      written.push(item.rel);
    }
  } catch (error) {
    // 写一半失败(磁盘满、文件被占用、权限)就还原已覆盖的文件 ——
    // 否则会留下 lib/index.js 新、lib/client.js 旧这种起不来的半成品目录。
    let restored = 0;
    for (const rel of written) {
      const target = path.join(pluginDir, rel);
      const keep = path.join(backupDir, rel);
      const back = await fsp
        .copyFile(keep, target)
        .then(() => true)
        .catch(() => false);
      if (back) restored += 1;
      else await fsp.rm(target, { force: true }).catch(() => {}); // 原本不存在的新文件直接删
    }
    throw new Error(`${error && error.message}(写入中途失败,已还原 ${restored} 个文件;还原不干净可点「回滚」)`);
  }
  if (!backedUp.length) await fsp.rm(backupDir, { recursive: true, force: true });
  // 备份只留最近 3 份:一份含 lib/client.js(约 600 KB),不清理会一直涨,还会拖慢 /update/status
  await pruneBackups(pluginDir).catch(() => {});
  return { from: String(current.version || ''), to, written, skipped, backup: backedUp.length ? path.join(BACKUP_DIR, stamp) : '' };
}

/**
 * 只保留最近 `keep` 份更新备份,更旧的删掉。
 * @param {string} pluginDir - 插件目录。
 * @param {number} [keep] - 保留份数(默认 3)。
 * @returns {Promise<void>} 清理完。
 */
export async function pruneBackups(pluginDir, keep = 3) {
  const root = path.join(pluginDir, BACKUP_DIR);
  const names = await fsp.readdir(root).catch(() => []);
  if (names.length <= keep) return;
  const stampOf = (name) => name.split('-').pop() || name;
  const sorted = names.slice().sort((a, b) => (stampOf(a) < stampOf(b) ? -1 : stampOf(a) > stampOf(b) ? 1 : 0));
  for (const name of sorted.slice(0, names.length - keep)) {
    await fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 找回最近一次更新前的备份并恢复。
 * @param {{pluginDir: string}} input - 参数。
 * @returns {Promise<{to: string, restored: string[], backup: string}>} 结果。
 */
export async function rollbackUpdate(input) {
  const pluginDir = input.pluginDir;
  const root = path.join(pluginDir, BACKUP_DIR);
  const names = await fsp.readdir(root).catch(() => []);
  if (!names.length) throw new Error('没有可回滚的备份(只有成功更新过一次才会有)');
  // 按时间戳取最近那次(目录名是 `<版本>-<36 进制时间戳>`)
  names.sort((a, b) => {
    const x = a.split('-').pop() || a;
    const y = b.split('-').pop() || b;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const pick = names[names.length - 1];
  const dir = path.join(root, pick);
  const restored = [];
  const walk = async (rel) => {
    const abs = path.join(dir, rel);
    const items = await fsp.readdir(abs, { withFileTypes: true });
    for (const item of items) {
      const childRel = rel ? path.join(rel, item.name) : item.name;
      if (item.isDirectory()) await walk(childRel);
      else {
        const target = path.join(pluginDir, childRel);
        const data = await fsp.readFile(path.join(dir, childRel));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, data);
        restored.push(childRel.split(path.sep).join('/'));
      }
    }
  };
  await walk('');
  if (!restored.length) throw new Error('备份是空的,没法回滚');
  const pkg = await readPackage(pluginDir).catch(() => null);
  await fsp.rm(dir, { recursive: true, force: true });
  return { to: String((pkg && pkg.version) || ''), restored, backup: pick };
}

/** 有没有可回滚的备份(按时间戳排序,最近的在最后)。 */
export async function listBackups(pluginDir) {
  const root = path.join(pluginDir, BACKUP_DIR);
  const names = await fsp.readdir(root).catch(() => []);
  const list = [];
  for (const entry of names) {
    const pkg = await fsp
      .readFile(path.join(root, entry, 'package.json'), 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
    // 目录名是 `<版本>-<36 进制时间戳>`,按**时间戳**排,别按版本号字符串排
    const stamp = entry.split('-').pop() || entry;
    list.push({ id: entry, version: (pkg && pkg.version) || '', stamp });
  }
  list.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
  return list;
}
