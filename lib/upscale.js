/**
 * dsh-grsai-canvas —— 「AI 高清放大」的引擎侧逻辑(宿主半边)。
 *
 * 为什么单独一个文件、而不是塞进 index.js:
 *   · 这里全是**可以脱离 cordis 单独跑**的纯逻辑(下清单、验校验和、下载、调 exe),
 *     `node lib/upscale.js --self-test` 就能自测,不必重启 DSH 去试;
 *   · index.js 只负责把它挂成 HTTP 路由,保持薄。
 *
 * 设计要点(和 `update.js` 一样按"下载并运行别人的程序"来对待):
 *   1. 引擎**不随插件打包**(会从 386 KB 涨到 7.4~40 MB),首次使用时才下载;
 *   2. 清单里每个文件都带 `sha256`,**对不上就删掉重来**,绝不留半成品;
 *   3. 先写 `.part` 临时文件,校验通过再改名 —— 这样断在半路下次能接着用;
 *   4. 只认 http/https;下载有体积上限与超时;
 *   5. 调用 exe 用 `spawn`(不经过 shell),参数是数组,天然免疫命令注入。
 *
 * @module dsh-grsai-canvas/upscale
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

/** 默认引擎分发点(把引擎文件放在这个目录下,清单是 `manifest.json`)。 */
export const DEFAULT_ENGINE_BASE = 'https://b.mumu.bio/huabu/upscale';

/** 引擎装在 `<DSH home>/tools/` 下的哪个子目录。 */
export const ENGINE_DIR_NAME = 'upscale';

/** 清单地址的路径(拼在 base 后面)。 */
export const MANIFEST_NAME = 'manifest.json';

/** 单个文件的下载上限(100 MB,防止清单被改成指向一个巨型文件)。 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** 单次下载的默认超时(毫秒)。 */
export const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 档位定义:每个档位用哪些模型、给界面的名字。
 * 具体下哪些**文件**由远端清单说了算,这里只描述"档位"这层语义。
 */
export const TIERS = {
  fast: {
    id: 'fast',
    label: '快速放大',
    model: 'realesr-animevideov3-x4',
    desc: '轻量模型,约 10 MB,一张 1200px 图约 5 秒',
  },
  quality: {
    id: 'quality',
    label: '高清放大',
    model: 'realesrgan-x4plus',
    desc: '高质量模型,需再下约 32 MB,一张 1200px 图约 40 秒',
  },
};

/**
 * 算一段字节的 sha256(十六进制小写)。
 * @param {Buffer} buf - 数据。
 * @returns {string} 摘要。
 */
export function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 读一个文件的 sha256(流式,不吃内存)。
 * @param {string} file - 绝对路径。
 * @returns {Promise<string>} 摘要;文件不存在时给空串。
 */
export async function sha256File(file) {
  const hash = createHash('sha256');
  const handle = await fsp.open(file, 'r').catch(() => null);
  if (!handle) return '';
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * 从分发点读清单。
 * @param {string} [base] - 分发点根地址(默认 `DEFAULT_ENGINE_BASE`)。
 * @returns {Promise<{manifest: object, base: string}>} 清单与规范化后的 base。
 */
export async function fetchManifest(base) {
  const root = String(base || DEFAULT_ENGINE_BASE).replace(/\/+$/, '');
  const url = `${root}/${MANIFEST_NAME}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`引擎清单地址不是合法 URL:${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`引擎清单地址只支持 http/https,收到 ${parsed.protocol}`);
  }
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  } catch (error) {
    throw new Error(`取引擎清单失败(连不上 ${root}):${error && error.message}`);
  }
  if (!res.ok) throw new Error(`取引擎清单失败:HTTP ${res.status}`);
  const text = await res.text();
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`引擎清单不是合法 JSON:${error && error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.tiers) {
    throw new Error('引擎清单结构不对(缺 tiers)');
  }
  return { manifest, base: root };
}

/**
 * 把清单里某个档位的文件整理成"计划"(带校验信息)。
 * @param {object} manifest - 清单。
 * @param {string} tier - 档位 id(fast / quality)。
 * @returns {Array<{path: string, sha256: string, bytes: number}>} 文件计划。
 */
export function tierFiles(manifest, tier) {
  const entry = manifest && manifest.tiers ? manifest.tiers[tier] : null;
  if (!entry || !Array.isArray(entry.files) || !entry.files.length) {
    throw new Error(`引擎清单里没有档位「${tier}」`);
  }
  return entry.files.map((file) => {
    const rel = String(file.path || '').replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || rel.includes('..')) {
      throw new Error(`引擎清单里的路径不合法:${file.path}`);
    }
    const bytes = Number(file.bytes) || 0;
    if (bytes > MAX_FILE_BYTES) throw new Error(`引擎文件太大(${rel})`);
    return { path: rel, sha256: String(file.sha256 || '').toLowerCase(), bytes };
  });
}

/**
 * 看某个档位在本机装到什么程度了(**只读本地,不联网**)。
 *
 * 逐个文件算 sha256 做判断:对得上才算"已就绪",这样半途中断、
 * 被别的程序改坏、甚至硬盘错误都能被发现。
 *
 * @param {string} dir - 引擎目录。
 * @param {Array<{path: string, sha256: string, bytes: number}>} files - 文件计划。
 * @returns {Promise<{ready: boolean, installed: number, total: number, missing: string[], bytes: number}>} 状态。
 */
export async function inspectTier(dir, files) {
  const missing = [];
  let installed = 0;
  let bytes = 0;
  for (const file of files) {
    const target = path.join(dir, ...file.path.split('/'));
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) {
      missing.push(file.path);
      continue;
    }
    if (file.bytes && stat.size !== file.bytes) {
      missing.push(file.path);
      continue;
    }
    const got = await sha256File(target);
    if (file.sha256 && got !== file.sha256) {
      missing.push(file.path);
      continue;
    }
    installed += 1;
    bytes += stat.size;
  }
  return { ready: missing.length === 0, installed, total: files.length, missing, bytes };
}

/**
 * 下载一个文件到目标路径,边下边算 sha256,校验失败就删掉。
 *
 * 已经存在且校验通过的文件**不会被重下**(`inspectTier` 已经把它们挑掉了)。
 *
 * @param {{url: string, target: string, sha256?: string, bytes?: number, onProgress?: Function, timeoutMs?: number}} input - 参数。
 * @returns {Promise<{path: string, bytes: number, skipped: boolean}>} 结果。
 */
export async function downloadFile(input) {
  const { url, target, sha256, bytes } = input;
  const timeoutMs = Number(input.timeoutMs) || DOWNLOAD_TIMEOUT_MS;
  const existing = await fsp.stat(target).catch(() => null);
  if (existing && existing.isFile()) {
    if (bytes && existing.size !== bytes) {
      // 大小不对:直接删,走重下
      await fsp.rm(target, { force: true });
    } else if (!sha256 || (await sha256File(target)) === sha256) {
      return { path: target, bytes: existing.size, skipped: true };
    } else {
      await fsp.rm(target, { force: true });
    }
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  await fsp.rm(part, { force: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const hash = createHash('sha256');
  let written = 0;
  const handle = await fsp.open(part, 'w');
  try {
    let res;
    try {
      res = await fetch(url, { cache: 'no-store', signal: controller.signal, redirect: 'follow' });
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error(`下载超时(${Math.round(timeoutMs / 1000)} 秒):${url}`);
      throw new Error(`下载失败(连不上):${error && error.message}`);
    }
    if (!res.ok) throw new Error(`下载失败:HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') || 0);
    const limit = bytes || MAX_FILE_BYTES;
    if (declared && declared > limit) throw new Error(`文件比清单写的大(${declared} > ${limit})`);

    for await (const chunk of res.body) {
      written += chunk.length;
      if (written > limit) throw new Error(`下载超出清单声明的大小(${limit} 字节)`);
      hash.update(chunk);
      await handle.write(chunk);
      if (typeof input.onProgress === 'function') input.onProgress({ written, total: bytes || declared || 0, file: path.basename(target) });
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(part, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
  await handle.close();

  const got = hash.digest('hex');
  if (sha256 && got !== sha256) {
    await fsp.rm(part, { force: true });
    throw new Error(`${path.basename(target)} 校验失败(清单 ${sha256.slice(0, 12)}…,下载到 ${got.slice(0, 12)}…) —— 已丢弃,可重试`);
  }
  if (bytes && written !== bytes) {
    await fsp.rm(part, { force: true });
    throw new Error(`${path.basename(target)} 大小不对(清单 ${bytes},下载到 ${written})`);
  }
  await fsp.rm(target, { force: true });
  await fsp.rename(part, target);
  return { path: target, bytes: written, skipped: false };
}

/**
 * 确保某个档位的引擎在本机就绪(缺什么下什么,已就绪的直接跳过)。
 *
 * @param {{dir: string, tier: string, base?: string, manifest?: object, onProgress?: Function, onLog?: Function}} input - 参数。
 * @returns {Promise<{tier: string, dir: string, exe: string, model: string, downloaded: number, skipped: number, bytes: number}>} 结果。
 */
export async function ensureTier(input) {
  const tier = String(input.tier || 'fast');
  const spec = TIERS[tier];
  if (!spec) throw new Error(`未知档位:${tier}`);
  const { manifest, base } = input.manifest ? { manifest: input.manifest, base: String(input.base || DEFAULT_ENGINE_BASE).replace(/\/+$/, '') } : await fetchManifest(input.base);
  const files = tierFiles(manifest, tier);
  const dir = input.dir;
  await fsp.mkdir(dir, { recursive: true });

  const state = await inspectTier(dir, files);
  const log = typeof input.onLog === 'function' ? input.onLog : () => {};
  if (state.ready) {
    log(`引擎档位「${spec.label}」已就绪(${ (state.bytes / 1048576).toFixed(1) } MB)`);
  } else {
    log(`引擎档位「${spec.label}」缺 ${state.missing.length}/${state.total} 个文件,开始下载`);
  }

  let downloaded = 0;
  let skipped = 0;
  let totalBytes = state.bytes;
  let doneBytes = 0;
  const totalAll = state.bytes + state.missing.reduce((sum, rel) => sum + (files.find((f) => f.path === rel)?.bytes || 0), 0);

  for (const file of files) {
    const target = path.join(dir, ...file.path.split('/'));
    const url = `${base}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
    const result = await downloadFile({
      url,
      target,
      sha256: file.sha256,
      bytes: file.bytes,
      onProgress: (p) => {
        if (typeof input.onProgress === 'function') {
          input.onProgress({
            tier,
            file: file.path,
            fileWritten: p.written,
            fileTotal: file.bytes,
            written: doneBytes + p.written,
            total: totalAll,
          });
        }
      },
    });
    if (result.skipped) skipped += 1;
    else {
      downloaded += 1;
      log(`已下载 ${file.path}(${(result.bytes / 1048576).toFixed(2)} MB)`);
    }
    doneBytes += result.bytes;
    totalBytes += result.skipped ? 0 : result.bytes;
  }

  const exe = path.join(dir, 'realesrgan-ncnn-vulkan.exe');
  if (!(await fsp.stat(exe).catch(() => null))) throw new Error('引擎下载完了但没找到主程序 exe,清单可能不对');
  return { tier, dir, exe, model: spec.model, downloaded, skipped, bytes: state.bytes };
}

/**
 * 跑一次放大。
 *
 * 参数用数组传给 `spawn`(不经过 shell),路径里的空格/中文都不会出问题。
 *
 * @param {{exe: string, input: string, output: string, model: string, scale?: number, gpu?: number, tile?: number, timeoutMs?: number, onLog?: Function}} input - 参数。
 * @returns {Promise<{ok: boolean, output: string, ms: number, log: string}>} 结果。
 */
export async function runUpscale(input) {
  const args = [
    '-i', input.input,
    '-o', input.output,
    '-n', input.model,
    '-s', String(input.scale || 4),
  ];
  if (Number.isInteger(input.gpu)) args.push('-g', String(input.gpu));
  if (Number.isInteger(input.tile) && input.tile > 0) args.push('-t', String(input.tile));

  const started = Date.now();
  const logLines = [];
  const timeoutMs = Number(input.timeoutMs) || 30 * 60 * 1000;

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(input.exe, args, { cwd: path.dirname(input.exe), windowsHide: true });
    } catch (error) {
      reject(new Error(`启动引擎失败:${error && error.message}`));
      return;
    }
    const timer = setTimeout(() => {
      logLines.push(`[超时] 超过 ${Math.round(timeoutMs / 1000)} 秒,已中止`);
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
    }, timeoutMs);

    const collect = (buf) => {
      const text = String(buf);
      logLines.push(text);
      if (logLines.length > 400) logLines.shift();
      if (typeof input.onLog === 'function') input.onLog(text);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`引擎进程出错:${error && error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - started;
      if (code !== 0) {
        reject(new Error(`引擎退出码 ${code}:${logLines.join('').slice(-400) || '(没有输出)'}`));
        return;
      }
      resolve({ ok: true, output: input.output, ms: elapsed, log: logLines.join('').slice(-2000) });
    });
  });
}
