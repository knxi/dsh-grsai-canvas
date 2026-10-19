// 无障碍/审计加固回归:插件源码里的表单元素必须有 id 或 name,图片元素必须有显式宽高与 alt。
// 纯静态扫描(读 lib/parts/*.js 源码),不需要浏览器。
// 用法: node tools/check-a11y.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const partsDir = join(here, '..', 'lib', 'parts');

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`PASS ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// 从 `{` 开始做括号配对,跳过字符串字面量,返回对象字面量的文本
function extractObject(src, openIdx) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

const TAG_RE = /h\(\s*'(input|textarea|select|img)'\s*,\s*\{/g;
const files = readdirSync(partsDir).filter((f) => f.endsWith('.js')).sort();

const formFields = [];
const images = [];

for (const file of files) {
  const src = readFileSync(join(partsDir, file), 'utf8');
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src)) !== null) {
    const tag = m[1];
    const openIdx = m.index + m[0].length - 1;
    const obj = extractObject(src, openIdx);
    if (obj === null) { failures.push(`${file}:${lineOf(m.index)} ${tag} 对象未闭合`); continue; }
    (tag === 'img' ? images : formFields).push({ file, line: lineOf(m.index), tag, obj });
  }
}

// 1) 表单元素:id 或 name
const missingId = formFields.filter((f) => !/\bid\s*:|\bname\s*:/.test(f.obj));
check(`表单元素都有 id 或 name(${formFields.length} 个 input/textarea/select)`, missingId.length === 0,
  missingId.map((f) => `${f.file}:${f.line} ${f.tag}`).join(', '));

// 2) 图片元素:显式 width/height(属性或 style 内同名 key 都算)
const missingSize = images.filter((im) => !/\bwidth\s*:/.test(im.obj) || !/\bheight\s*:/.test(im.obj));
check(`图片元素都有显式宽高(${images.length} 个 img)`, missingSize.length === 0,
  missingSize.map((im) => `${im.file}:${im.line}`).join(', '));

// 3) 图片元素:alt
const missingAlt = images.filter((im) => !/\balt\s*:/.test(im.obj));
check('图片元素都有 alt', missingAlt.length === 0, missingAlt.map((im) => `${im.file}:${im.line}`).join(', '));

// 4) 字面 id 不重复(表达式 id 如 'grsai-batch-' + item.value 跳过,循环内唯一化由值保证)
const literalIds = [];
for (const f of formFields) {
  const ids = f.obj.match(/\bid\s*:\s*'([^']+)'/g) || [];
  for (const raw of ids) literalIds.push(raw.replace(/.*'([^']+)'.*/, '$1'));
}
const seen = new Map();
const dupes = [];
for (const id of literalIds) {
  if (seen.has(id)) dupes.push(`${id}(${seen.get(id)} & ${id})`);
  seen.set(id, id);
}
check(`字面 id 不重复(${literalIds.length} 个)`, dupes.length === 0, dupes.join(', '));

// 5) 插件运行时不得使用 eval / new Function(CSP 硬约束)
const RUNTIME_FILES = ['client.js', 'index.js', 'upscale.js'].map((f) => join(here, '..', 'lib', f));
const runtimeHits = [];
for (const p of RUNTIME_FILES) {
  let src;
  try { src = readFileSync(p, 'utf8'); } catch { continue; }
  if (/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"]|setInterval\s*\(\s*['"]/.test(src)) {
    runtimeHits.push(p.replace(/.*[\\/](lib[\\/].*)$/, '$1'));
  }
}
check('插件运行时无 eval / new Function(CSP 不报错)', runtimeHits.length === 0, runtimeHits.join(', '));

if (failures.length) {
  console.log(`\n${failures.length} 项未通过:`);
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
console.log(`\n无障碍/审计加固检查全部通过(${pass} 项)。`);
