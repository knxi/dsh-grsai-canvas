/**
 * dsh-grsai-canvas —— 客户端 bundle 装配脚本。
 *
 * 背景:`dsh.client` 只认一个 `exports["./client"]` bundle,浏览器只会加载
 * `lib/client.js` 这一个文件。所以源码按职责拆成 `lib/parts/*.js` 之后,
 * 必须再装配回那一个文件 —— 这个脚本就是装配机:把零件**原样**按文件名顺序
 * 拼进成品 bundle 的外壳里。
 *
 * 为什么不做真正的打包(解析 import/export、摇树、压缩):
 *   · 插件承诺**零运行时依赖、零构建依赖**,这个脚本只用 `node:fs`/`node:path`;
 *   · 零件之间靠 `definePart`/`rt.xxx`(见 `lib/parts/00-runtime.js`)显式取用,
 *     不需要打包器解析模块图;
 *   · 产物要能一眼看懂 —— 每个零件前有一行分隔注释,出错时能直接定位到源文件。
 *
 * 用法(在插件目录):
 *   node tools/build-client.mjs            重新装配 lib/client.js
 *   node tools/build-client.mjs --check    只校验"产物是不是最新的"(改了零件忘了装配时用)
 *   node tools/build-client.mjs --list     列出参与装配的零件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 插件根目录(本脚本在 `<插件>/tools/` 下)。 */
export const PLUGIN_DIR = path.resolve(HERE, '..');
/** 零件目录。 */
export const PARTS_DIR = path.join(PLUGIN_DIR, 'lib', 'parts');
/** 成品 bundle 的落点 —— DSH 加载的就是它,路径不能改。 */
export const BUNDLE_PATH = path.join(PLUGIN_DIR, 'lib', 'client.js');

const HEADER = `/**
 * dsh-grsai-canvas —— 浏览器侧半边(成品 bundle)。
 *
 * ⚠ **这是构建产物,不要直接改这里** —— 改完会被下一次装配覆盖。
 * 源码按职责拆在 \`lib/parts/*.js\`(工具栏、右下角生成区块、右上角设置、画布交互、
 * 尺寸换算、标注渲染、文字图层、样式表…),改完在插件目录跑:
 *
 *     node tools/build-client.mjs
 *
 * 为什么非要"装配":\`dsh.client\` 只认一个 \`exports["./client"]\` bundle,
 * 浏览器只会加载这一个文件(见 \`_test/client-bundle.mjs\` 的一致性校验)。
 *
 * 交互模型参考 Cowart(tldraw 无限画布):
 *   · 图片是画布上的对象,放在世界坐标里,可拖动、拉角缩放;
 *   · 画布可平移/缩放(滚轮以光标为中心、空格或中键拖动、适应/100%);
 *   · 标注是独立对象,按图片归一化坐标粘在图上,可撤销/重做,不烧进像素;
 *   · 「按标注改图」把「原图 + 标注」合成一张提交,出图放在原图旁边,原图和标注都保留;
 *   · 画布自动存到工作区 \`<工作区>/画布/state.json\`,刷新/重开都还在。
 *
 * 构建期无依赖:产物只 require 平台自带的 \`react\`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-grsai-canvas',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

`;

const FOOTER = `    return module.exports;
  },
});
`;

/** 零件分隔行:产物里能一眼看出这一段来自哪个文件。 */
function divider(fileName) {
  const label = `零件 ${fileName} `;
  const pad = Math.max(4, 76 - label.length);
  return `    // ── ${label}${'─'.repeat(pad)}`;
}

/**
 * 收集零件(按文件名排序:`00-runtime.js` 打头,后面的顺序靠数字前缀决定)。
 * @param {string} [dir] - 零件目录,默认 `lib/parts`。
 * @returns {{ file: string, text: string }[]} 零件清单。
 */
export function collectParts(dir = PARTS_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .sort();
  if (!files.length) throw new Error(`没有零件:${dir} 是空的`);
  return files.map((file) => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!text.trim()) throw new Error(`零件是空的:${file}`);
    return { file, text: text.replace(/\s*$/, '') };
  });
}

/**
 * 把零件装配成成品 bundle 的源码。
 * @param {{ parts?: { file: string, text: string }[] }} [options] - 可注入零件(测试用)。
 * @returns {string} `lib/client.js` 的完整内容。
 */
export function buildBundle(options = {}) {
  const parts = options.parts || collectParts();

  // 零件之间靠 definePart/rt 取用,重名会在构造期才炸 —— 这里先静态查一遍
  const seen = new Map();
  for (const part of parts) {
    for (const hit of part.text.matchAll(/definePart\(\s*['"]([^'"]+)['"]/g)) {
      const name = hit[1];
      if (seen.has(name)) throw new Error(`零件名重复:${name}(${seen.get(name)} 与 ${part.file} 都注册了它)`);
      seen.set(name, part.file);
    }
  }

  const body = parts.map((part) => `${divider(part.file)}\n${part.text}\n`).join('\n');
  return `${HEADER}${body}\n${FOOTER}`;
}

/** 读现在的成品 bundle(没有就返回空串)。 */
export function readBundle() {
  try {
    return fs.readFileSync(BUNDLE_PATH, 'utf8');
  } catch {
    return '';
  }
}

/** 装配并落盘。 @returns {{ text: string, changed: boolean, parts: number }} */
export function writeBundle() {
  const parts = collectParts();
  const text = buildBundle({ parts });
  const changed = readBundle() !== text;
  fs.writeFileSync(BUNDLE_PATH, text);
  return { text, changed, parts: parts.length };
}

function main(argv) {
  const check = argv.includes('--check');
  const list = argv.includes('--list');

  if (list) {
    const parts = collectParts();
    for (const part of parts) console.log(`${String(part.text.split('\n').length).padStart(5)} 行  ${part.file}`);
    console.log(`共 ${parts.length} 个零件`);
    return 0;
  }

  if (check) {
    const text = buildBundle();
    if (readBundle() === text) {
      console.log('✅ lib/client.js 与零件一致(没有忘记装配)');
      return 0;
    }
    console.error('❌ lib/client.js 与 lib/parts/*.js 不一致 —— 改了零件没装配。跑:node tools/build-client.mjs');
    return 1;
  }

  const result = writeBundle();
  console.log(`✅ 已装配 lib/client.js:${result.parts} 个零件,${result.text.length} 字节${result.changed ? '' : '(内容没变)'}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
