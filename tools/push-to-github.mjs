#!/usr/bin/env node
// ============================================================================
//  一键把本仓库推送到 GitHub
//
//  为什么不用 git push：这台机器直连 github.com 的 443 会被重置
//  （schannel 报 SEC_E_NO_CREDENTIALS，换 OpenSSL 后端则 Recv failure），
//  而 api.github.com 能通，所以改走 REST 的 Git Data 接口。
//
//  用法（PowerShell）：
//      $env:GH_TOKEN = 'github_pat_xxx'          # 只需要 Contents: Read/Write
//      node tools/push-to-github.mjs -m "改了啥"
//
//  行为：
//    · 只上传有变化的文件（按 git blob sha1 比对，没变的不重传）
//    · 用 base_tree 增量提交，一次提交生成一个 commit
//    · 空仓库也能用（第一次会自动建初始 commit）
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('[x] 先设置环境变量 GH_TOKEN（fine-grained PAT，需要 Contents 读写权限）');
  process.exit(1);
}

// ---- 仓库坐标：默认从 package.json 的 repository 解析 ----------------------
let OWNER = process.env.GH_OWNER || 'knxi';
let REPO = process.env.GH_REPO || 'dsh-grsai-canvas';
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(pkg.repository?.url || '');
  if (m) { OWNER = m[1]; REPO = m[2]; }
} catch { /* 没有 package.json 就用默认值 */ }

const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const BRANCH = process.env.GH_BRANCH || 'main';
const H = {
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'dsh-grsai-canvas-push',
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
};

// ---- 参数 -----------------------------------------------------------------
const argv = process.argv.slice(2);
const msgIdx = argv.findIndex((a) => a === '-m' || a === '--message');
let MESSAGE = msgIdx >= 0 ? argv[msgIdx + 1] : '';
if (!MESSAGE) MESSAGE = `chore: sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

// ---- 工具函数 -------------------------------------------------------------
const SKIP_DIRS = new Set(['.git', 'node_modules', '_dl', '_gh', 'pubtest', 'pubtest2']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** git 对象的 blob sha1 = sha1("blob <len>\0" + content)，用来和远端比对 */
function blobSha(buf) {
  const h = createHash('sha1');
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest('hex');
}

async function api(path, method = 'GET', body) {
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch(API + path, {
        method,
        headers: H,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const txt = await r.text();
      if (r.status >= 500 && i < 4) { await new Promise((z) => setTimeout(z, 900 * i)); continue; }
      let json = null;
      try { json = txt ? JSON.parse(txt) : null; } catch { /* 非 JSON */ }
      return { status: r.status, json, text: txt };
    } catch (e) {
      if (i === 4) throw e;
      await new Promise((z) => setTimeout(z, 900 * i));
    }
  }
}

// ---- 1. 远端现状 ----------------------------------------------------------
const br = await api(`/branches/${BRANCH}`);
let parentSha = null;
let baseTree = null;
let remote = new Map();

if (br.status === 200) {
  parentSha = br.json.commit.sha;
  baseTree = br.json.commit.commit.tree.sha;
  const tr = await api(`/git/trees/${BRANCH}?recursive=1`);
  if (tr.status === 200) {
    for (const e of tr.json.tree) if (e.type === 'blob') remote.set(e.path, e.sha);
  }
  console.log(`[i] 远端 HEAD ${parentSha.slice(0, 8)} · 已有 ${remote.size} 个文件`);
} else if (br.status === 404) {
  console.log('[i] 空仓库，先建初始提交');
  const readme = join(ROOT, 'README.md');
  const put = await api('/contents/README.md', 'PUT', {
    message: 'chore: init repository',
    content: readFileSync(readme).toString('base64'),
  });
  if (put.status !== 201 && put.status !== 200) {
    console.error('[x] 初始提交失败', put.status, put.text.slice(0, 300));
    process.exit(1);
  }
  parentSha = put.json.commit.sha;
  baseTree = put.json.commit.tree.sha;
  remote.clear();
} else {
  console.error('[x] 读分支失败', br.status, br.text.slice(0, 300));
  process.exit(1);
}

// ---- 2. 本地扫描，算出变化 ------------------------------------------------
const files = walk(ROOT)
  .map((abs) => ({ abs, rel: relative(ROOT, abs).split(sep).join('/') }))
  .filter((f) => !f.rel.startsWith('.git/'));
const changed = [];
for (const f of files) {
  const buf = readFileSync(f.abs);
  const sha = blobSha(buf);
  if (remote.get(f.rel) !== sha) changed.push({ ...f, buf, sha });
}
console.log(`[i] 本地 ${files.length} 个文件，需上传 ${changed.length} 个`);

if (!changed.length) {
  console.log('[ok] 没有变化，无需提交');
  process.exit(0);
}

// ---- 3. 上传 blob（并发 6）------------------------------------------------
const tree = [];
const queue = [...changed];
let done = 0;
async function worker() {
  while (queue.length) {
    const f = queue.shift();
    const r = await api('/git/blobs', 'POST', { content: f.buf.toString('base64'), encoding: 'base64' });
    if (r.status !== 201) {
      console.error('[x] blob 失败', f.rel, r.status, r.text.slice(0, 200));
      process.exit(1);
    }
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: r.json.sha });
    if (++done % 20 === 0) console.log(`    ${done}/${changed.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

// ---- 4. tree → commit → 移动分支 -----------------------------------------
const t = await api('/git/trees', 'POST', { base_tree: baseTree, tree });
if (t.status !== 201) { console.error('[x] tree 失败', t.status, t.text.slice(0, 300)); process.exit(1); }

const c = await api('/git/commits', 'POST', { message: MESSAGE, tree: t.json.sha, parents: [parentSha] });
if (c.status !== 201) { console.error('[x] commit 失败', c.status, c.text.slice(0, 300)); process.exit(1); }

const ref = await api(`/git/refs/heads/${BRANCH}`, 'PATCH', { sha: c.json.sha, force: true });
if (ref.status !== 200) { console.error('[x] 更新分支失败', ref.status, ref.text.slice(0, 300)); process.exit(1); }

console.log(`[ok] 已推送 ${changed.length} 个文件 → https://github.com/${OWNER}/${REPO}`);
console.log(`     commit ${c.json.sha.slice(0, 8)} · ${MESSAGE.split('\n')[0]}`);
