/**
 * dsh-grsai-canvas —— 发布包自检(打包后、上传前跑一次)。
 *
 * 打包是 `Compress-Archive` 手动做的,容易出几类只有装上才发现的错:
 *   · 忘了先装配 → 包里的 lib/client.js 是旧的,用户更新后跑的还是旧代码;
 *   · 关键文件漏了(lib/parts、tools 之类) → 装上起不来;
 *   · version.json 的 sha256 和 zip 对不上 → 插件直接拒绝安装。
 *
 * 这个脚本用**插件自己的**零依赖 zip 读取(`lib/update.js` 的 `readZip`,顺带验 CRC),
 * 逐项挡住上面这些坑。
 *
 * 用法(在插件目录):
 *   node tools/verify-package.mjs <zip路径> [version.json路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readZip } from '../lib/update.js';
import { buildBundle, collectParts } from './build-client.mjs';

const zipPath = process.argv[2];
const manifestPath = process.argv[3];

if (!zipPath) {
  console.error('用法: node tools/verify-package.mjs <zip路径> [version.json路径]');
  process.exit(2);
}

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

const buf = fs.readFileSync(zipPath);
const entries = readZip(buf); // 解不出来 / CRC 对不上会直接抛

// 归一化条目名:反斜杠转正斜杠 + 剥掉 Compress-Archive 的包目录前缀
const byPath = new Map();
const names = [];
for (const entry of entries) {
  const rel = entry.name.replace(/\\/g, '/').replace(/^dsh-grsai-canvas\//, '');
  byPath.set(rel, entry.data);
  names.push(rel);
}

console.log(`包:${path.basename(zipPath)}(${buf.length} 字节,${entries.length} 个文件)`);

// ── 关键文件 ──
const required = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/update.js',
  'lib/parts/00-runtime.js',
  'lib/parts/12-canvas-tab.js',
  'tools/build-client.mjs',
  'tools/check-deps.mjs',
  'tools/verify-package.mjs',
  'deploy/install.ps1',
  'deploy/install.cmd',
  'deploy/uninstall.ps1',
  'deploy/make-update-manifest.ps1',
  'deploy/update-site.html',
];
for (const rel of required) check(`包含 ${rel}`, byPath.has(rel));

// ── 版本 ──
const pkg = JSON.parse(byPath.get('package.json').toString('utf8'));
console.log(`  包内 package.json version = ${pkg.version}`);

// ── 关键:包里的产物必须等于零件重新装配的结果(忘了装配会被这里抓住)──
const bundled = byPath.get('lib/client.js').toString('utf8');
const expected = buildBundle({ parts: collectParts() });
check('包内 lib/client.js 与 lib/parts 装配结果一致', bundled === expected, `包内 ${bundled.length} 字节 / 期望 ${expected.length} 字节`);

// ── 零件数量 ──
const partFiles = names.filter((rel) => rel.startsWith('lib/parts/') && rel.endsWith('.js'));
check(`包内 lib/parts 零件齐全(${partFiles.length} 个)`, partFiles.length >= 29, partFiles.join(', ').slice(0, 200));

// ── 意外文件(打进去但不属于这个包的东西)──
const KNOWN_DIRS = ['lib/', 'lib/parts/', 'deploy/', 'tools/'];
const KNOWN_ROOT = ['package.json', 'cordis.patch.yml', 'install.cmd', 'uninstall.cmd'];
const stray = names.filter((rel) => {
  if (KNOWN_ROOT.includes(rel)) return false;
  if (KNOWN_DIRS.some((dir) => rel.startsWith(dir))) return false;
  if (/\.(md|txt)$/i.test(rel)) return false; // 根目录文档照收
  return true;
});
check('包里没有意外文件', stray.length === 0, stray.join(', '));

// ── 清单一致性 ──
if (manifestPath) {
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  check('version.json.sha256 == zip 实际 sha256', manifest.sha256 === sha, sha);
  check('version.json.version == 包内版本', manifest.version === pkg.version, `清单 ${manifest.version} / 包内 ${pkg.version}`);
  check('version.json.url == zip 文件名(相对地址)', manifest.url === path.basename(zipPath), `清单 ${manifest.url} / 文件 ${path.basename(zipPath)}`);
}

console.log(failures === 0 ? '\n✅ 发布包校验通过,可以上传' : `\n❌ ${failures} 项不过,先修再传`);
process.exit(failures ? 1 : 0);
