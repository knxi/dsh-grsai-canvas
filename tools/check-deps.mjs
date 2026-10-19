/**
 * dsh-grsai-canvas —— 「界面零件的依赖清单」自检。
 *
 * 界面零件(工具栏 / 生成区块 / 设置面板…)的依赖由调用处显式传:
 *   const toolbar = rt['toolbar'].renderToolbar(deps('toolbar', { tool, chooseTool, … }));
 * 漏传一个,要到那一刻才炸(`deps()` 会抛「零件 X 缺依赖:YYY」),没人愿意靠点界面来发现。
 * 这个脚本做**静态**对照:
 *
 *   零件源码里用到的自由标识符 ∩ CanvasTab 里的名字(状态/动作/ref/局部量) == 调用处实际传的依赖
 *
 * 左边多出来的是**漏传**(危险),右边多出来的是**多传**(无害,顺手提示)。
 * 只在零件自己作用域里就有的名字(`h`/`S`/`TOOLS`… 全是全局零件作用域里的常量函数)不算自由标识符。
 *
 * 用法(在插件目录):node tools/check-deps.mjs [--debug]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const PARTS_DIR = path.join(PLUGIN_DIR, 'lib', 'parts');
const TAB_PATH = path.join(PARTS_DIR, '12-canvas-tab.js');

/** 零件作用域里已有的东西(不算"要注入的依赖")。 */
const BUILTIN = new Set([
  'h', 'S', 'line', 'rt', 'deps', 'part', 'definePart', 'React', 'useState', 'useRef', 'useEffect', 'useCallback',
  'window', 'document', 'console', 'localStorage', 'navigator', 'fetch', 'Image', 'FileReader', 'Blob', 'URL',
  'URLSearchParams', 'ClipboardItem', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
  'Map', 'Set', 'Promise', 'Error', 'RegExp', 'parseInt', 'parseFloat', 'isNaN', 'setTimeout', 'clearTimeout',
  'requestAnimationFrame', 'cancelAnimationFrame', 'atob', 'btoa', 'decodeURIComponent', 'encodeURIComponent',
  'structuredClone',
]);

const KEYWORDS = new Set([
  'await', 'async', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else',
  'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'of', 'return', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void',
  'while', 'yield',
]);

/** 去掉注释与字符串(模板串整体去掉,里面通常只有局部变量)。 */
function strip(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * 取"自由标识符"候选:跳过 `a.b` 里的 b,跳过对象字面量的键(`{ key: x }` 里的 key —— 它后面跟冒号)。
 * 三元里的 `a : b` 会被一并跳过(宁可漏报,不可误报"漏传")。
 */
function identifiers(source) {
  const out = [];
  for (const hit of strip(source).matchAll(/(\.)?\b([A-Za-z_$][\w$]*)\b(\s*:)?/g)) {
    if (hit[1]) continue;
    if (hit[3]) continue;
    out.push(hit[2]);
  }
  return out;
}

/** 文件里自己声明/接收的名字(这些不算"自由变量")。 */
function declared(source) {
  const text = strip(source);
  const names = new Set();
  const add = (name) => {
    const clean = String(name || '').trim().replace(/[^\w$]/g, '');
    if (clean) names.add(clean);
  };
  for (const hit of text.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) add(hit[1]);
  // 数组 / 对象解构声明的局部量(`const [cx, cy] = screenToWorld(…)`)
  for (const hit of text.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) hit[1].split(',').forEach(add);
  for (const hit of text.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)) hit[1].split(',').forEach(add);
  for (const hit of text.matchAll(/\(?\b([A-Za-z_$][\w$]*)\b\)?\s*=>/g)) add(hit[1]);
  for (const hit of text.matchAll(/\(([^()]*)\)\s*=>/g)) hit[1].split(',').forEach(add);
  for (const hit of text.matchAll(/(?:async\s+)?function\s*[A-Za-z_$]*\s*\(([^)]*)\)/g)) hit[1].split(',').forEach(add);
  return names;
}

/** 从 `… = p;` / `… = p)` 的解构里取名字(这些正是依赖,不能当"已声明"排掉)。 */
function destructured(source) {
  const names = new Set();
  for (const hit of strip(source).matchAll(/\{([^{}]*)\}\s*=\s*p\b/g)) {
    for (const piece of hit[1].split(',')) {
      const clean = piece.trim().replace(/[^\w$]/g, '');
      if (clean) names.add(clean);
    }
  }
  return names;
}

/** CanvasTab 里的名字:state / setter / ref / 函数 / 局部量。 */
function canvasNames() {
  const text = strip(fs.readFileSync(TAB_PATH, 'utf8'));
  const names = new Set();
  for (const hit of text.matchAll(/const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]/g)) {
    names.add(hit[1]);
    names.add(hit[2]);
  }
  for (const hit of text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)/g)) names.add(hit[1]);
  // 对象解构也算(`const { canUpdate, checkUpdate } = rt['update-center'].createUpdateCenter(…)`)
  for (const hit of text.matchAll(/\b(?:const|let)\s*\{([^{}]*)\}\s*=/g)) {
    for (const piece of hit[1].split(',')) {
      const clean = piece.trim().split(':').pop().trim().replace(/[^\w$]/g, '');
      if (clean) names.add(clean);
    }
  }
  for (const hit of text.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(hit[1]);
  return names;
}

/** 调用处声明的依赖:`deps('part', { a, b })`。 */
function provided() {
  const text = fs.readFileSync(TAB_PATH, 'utf8');
  const map = new Map();
  for (const hit of text.matchAll(/deps\(\s*'([\w-]+)'\s*,\s*\{([^}]*)\}/g)) {
    map.set(
      hit[1],
      new Set(
        hit[2]
          .split(',')
          .map((piece) => piece.trim().replace(/[^\w$]/g, ''))
          .filter(Boolean),
      ),
    );
  }
  return map;
}

/** 零件名 → 源码。 */
function partSources() {
  const map = new Map();
  for (const file of fs.readdirSync(PARTS_DIR).filter((name) => name.endsWith('.js')).sort()) {
    const text = fs.readFileSync(path.join(PARTS_DIR, file), 'utf8');
    for (const hit of text.matchAll(/definePart\(\s*'([\w-]+)'/g)) map.set(hit[1], { file, text });
  }
  return map;
}

const debug = process.argv.includes('--debug');
const internal = canvasNames();
const sources = partSources();
const declarations = provided();

let problems = 0;
for (const [name, bag] of [...declarations].sort()) {
  const source = sources.get(name);
  if (!source) {
    console.log(`❌ ${name}:找不到对应的零件(definePart 没写?)`);
    problems += 1;
    continue;
  }
  const pNames = destructured(source.text);
  const owned = new Set([...declared(source.text)].filter((id) => !pNames.has(id)));
  const used = new Set(
    identifiers(source.text).filter((id) => internal.has(id) && !owned.has(id) && !BUILTIN.has(id) && !KEYWORDS.has(id)),
  );
  const missing = [...used].filter((id) => !bag.has(id)).sort();
  const extra = [...bag].filter((id) => !used.has(id)).sort();
  // 调用处传了、零件却没解构出来 —— 传了也白传(零件里那个名字会是 undefined/未定义)
  const notDestructured = [...bag].filter((id) => !pNames.has(id)).sort();
  if (notDestructured.length) {
    problems += 1;
    console.log(`❌ ${name}(${source.file})的 \`const { … } = p\` 里没解构:${notDestructured.join(', ')}(调用处传了也拿不到)`);
  }
  if (missing.length) {
    problems += 1;
    console.log(`❌ ${name}(${source.file})漏传依赖:${missing.join(', ')}`);
  } else {
    console.log(`✅ ${name}(${source.file})依赖清单齐全(用到 ${used.size} 项,声明 ${bag.size} 项)`);
  }
  if (extra.length) console.log(`   · 多传(无害,可删):${extra.join(', ')}`);
  if (debug) console.log(`   debug used=${[...used].sort().join(',')}`);
}

const declaredParts = new Set(declarations.keys());
for (const [name, source] of sources) {
  if (!declaredParts.has(name) && /function render[A-Z]/.test(source.text)) {
    console.log(`❌ ${name}(${source.file})是界面零件,但 12-canvas-tab.js 里没有对应的 deps(...) 调用`);
    problems += 1;
  }
}

/**
 * 同一份配置宿主与客户端各写了一遍(Node 端兜底 / 浏览器端默认值)。
 * 改域名只改一处会表现成"设置里清空地址后又连到老站",很难当场发现 —— 这里对一下。
 */
const CONST_PAIRS = [
  ['默认接口地址', 'lib/index.js', 'DEFAULT_API_BASE', 'lib/parts/01-constants.js', 'DEFAULT_API_BASE'],
  ['默认分层接口', 'lib/index.js', 'LAYERING_DEFAULT_BASE', 'lib/parts/01-constants.js', 'LAYER_DEFAULT_BASE'],
];
/** 取某个文件里 `const NAME = '值'` 的字面量(找不到返回 null)。 */
function constValue(file, name) {
  const text = fs.readFileSync(path.join(PLUGIN_DIR, file), 'utf8');
  const found = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*['"]([^'"]*)['"]`).exec(text);
  return found ? found[1] : null;
}
for (const [label, hostFile, hostName, clientFile, clientName] of CONST_PAIRS) {
  const host = constValue(hostFile, hostName);
  const client = constValue(clientFile, clientName);
  if (host && host === client) {
    console.log(`✅ ${label}一致:${host}`);
    continue;
  }
  problems += 1;
  console.log(`❌ ${label}不一致:${hostFile} 的 ${hostName}=${host ?? '(没找到)'},${clientFile} 的 ${clientName}=${client ?? '(没找到)'}`);
}

console.log(problems ? `\n${problems} 处需要修` : '\n依赖清单全部对齐 ✅');
process.exit(problems ? 1 : 0);
