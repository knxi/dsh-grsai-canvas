// UI 前后对照截图:渲染画布(同 check-canvas-browser 的 fakeReact 挂载方式),按 4 个视口各截一张。
// 用 CANVAS_PARTS_ROOT 指向任意一份 lib/parts(比如 v0.20.0.zip 解压出来的旧版)做"重构前"基线;
// 默认用当前工作区 lib/parts 做"重构后"。输出到 CANVAS_TEST_OUTPUT(默认 browser-check-snapshot)。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const partsRoot = process.env.CANVAS_PARTS_ROOT || path.join(root, 'lib', 'parts');
const output = process.env.CANVAS_TEST_OUTPUT || path.join(root, 'browser-check-snapshot');
fs.mkdirSync(output, { recursive: true });
const source = fs.readdirSync(partsRoot).filter((n) => n.endsWith('.js') && n !== '99-entry.js')
  .sort().map((n) => fs.readFileSync(path.join(partsRoot, n), 'utf8')).join('\n');
const browser = await chromium.launch({ headless: true, ...(process.env.CANVAS_BROWSER ? { executablePath: process.env.CANVAS_BROWSER } : {}) });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(`<style>
    html,body{margin:0;height:100%;font-family:Arial,"Microsoft YaHei",sans-serif;background:#e7e9ec;color:#25282d}
    *{box-sizing:border-box}#host{position:relative;height:100%;width:100%}
    :root{--dsw-alias-bg-elevated:#fff;--dsw-alias-label-primary:#25282d;
      --dsw-alias-label-secondary:#59616b;--dsw-alias-border-l3:#d5d9de;
      --dsw-alias-label-primary-inverted:#fff}
  </style><div id="host"></div>`);
  await page.evaluate((source) => {
    const state = []; const refs = []; let si = 0; let ri = 0;
    const fakeReact = {
      createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity) }),
      useState: (init) => { const i = si++; if (!(i in state)) state[i] = typeof init === 'function' ? init() : init; return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }]; },
      useRef: (init) => { const i = ri++; if (!(i in refs)) refs[i] = { current: init }; return refs[i]; },
      useEffect() {}, useCallback: (fn) => fn,
    };
    const app = new Function('require', `${source}\nreturn {CanvasTab,STATE_ORDER};`)(() => fakeReact);
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 1000; sourceCanvas.height = 800;
    const c = sourceCanvas.getContext('2d');
    c.fillStyle = '#e07045'; c.fillRect(0, 0, 1000, 800);
    c.fillStyle = '#438986'; c.fillRect(0, 0, 350, 800);
    c.fillStyle = '#fafafa'; c.font = 'bold 70px sans-serif'; c.fillText('CANVAS', 80, 240);
    const image = { id: 'source', name: 'sample.png', x: 80, y: 100, w: 500, h: 400,
      naturalW: 1000, naturalH: 800, isRef: true, dataUrl: sourceCanvas.toDataURL(),
      texts: [{ id: 'text-1', value: 'A local text layer', font: 'Arial', size: 0.05, nx: 0.5, ny: 0.7, color: '#ffffff', weight: 700 }] };
    const doc = { images: [image], marks: [], frames: [] };
    const set = (name, value) => { state[app.STATE_ORDER.indexOf(name)] = value; };
    function mount(node) {
      if (node === null || node === undefined || node === false) return document.createTextNode('');
      if (typeof node !== 'object') return document.createTextNode(String(node));
      if (typeof node.tag === 'function') return mount(node.tag(node.props));
      const el = ['svg', 'path', 'rect', 'circle'].includes(node.tag)
        ? document.createElementNS('http://www.w3.org/2000/svg', node.tag) : document.createElement(node.tag);
      for (const [key, value] of Object.entries(node.props)) {
        if (key === 'style') {
          for (const [name, val] of Object.entries(value)) el.style[name] = typeof val === 'number' && !['opacity', 'zIndex', 'flex', 'flexShrink', 'fontWeight', 'lineHeight'].includes(name) ? `${val}px` : val;
        } else if (key === 'ref') value.current = el;
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key === 'onChange' ? 'input' : key.slice(2).toLowerCase(), value);
        else if (key !== 'key' && value !== undefined) {
          if (['value', 'checked', 'disabled'].includes(key)) el[key] = value;
          else el.setAttribute(key, value);
        }
      }
      for (const child of node.children) el.appendChild(mount(child));
      return el;
    }
    function render(overrides = {}) {
      for (const [name, value] of Object.entries(overrides)) set(name, value);
      si = 0; ri = 0;
      document.getElementById('host').replaceChildren(mount(app.CanvasTab({ sessionId: 'offline' })));
    }
    render();
    refs[5].current = doc;
    set('apikey', 'offline-test');
    set('loaded', true);
    set('selectedId', image.id);
    set('selectedIds', [image.id]);
    window.harness = { render, set, doc, image };
  }, source);
  // 数一数默认可见的按钮/入口,连同截图一起输出(对照"默认可见操作数量")
  for (const [name, width, height] of [['desktop', 1200, 900], ['sidebar', 390, 700], ['mobile', 360, 640], ['short', 640, 420]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(({ width, height }) => {
      const { render, doc, image } = window.harness;
      doc.frames = []; doc.marks = [];
      render({ size: { w: width, h: height }, selectedId: image.id, selectedIds: [image.id],
        selectedFrameId: null, showGen: true, showText: false, selectedTextId: '', showModels: false });
    }, { width, height });
    const stats = await page.evaluate(() => {
      const host = document.getElementById('host');
      const buttons = [...host.querySelectorAll('button')].filter((el) => el.offsetParent !== null);
      const inputs = [...host.querySelectorAll('input,textarea,select')].filter((el) => el.offsetParent !== null);
      return { buttons: buttons.length, inputs: inputs.length, labels: buttons.map((b) => (b.textContent || b.title || '').trim()).filter(Boolean) };
    });
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    fs.writeFileSync(path.join(output, `${name}-entries.json`), JSON.stringify(stats, null, 2));
    console.log(`${name}: ${stats.buttons} buttons, ${stats.inputs} inputs -> ${name}.png`);
  }
  if (errors.length) { console.log('PAGE ERRORS:', JSON.stringify(errors)); process.exitCode = 1; }
  else console.log(`Done. Screenshots + entry counts: ${output}`);
} finally { await browser.close(); }
