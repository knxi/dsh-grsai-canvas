// Development tool: capture final UI comparison screenshots (default 1200x900 + narrow 390x700).
// Run with PLAYWRIGHT_MODULE + CANVAS_BROWSER set (same as check-canvas-browser.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readdirSync(path.join(root, 'lib', 'parts')).filter((name) => name.endsWith('.js') && name !== '99-entry.js')
  .sort().map((name) => fs.readFileSync(path.join(root, 'lib', 'parts', name), 'utf8')).join('\n');
const outDir = path.join(root, 'browser-check');
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CANVAS_BROWSER ? { executablePath: process.env.CANVAS_BROWSER } : {}),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<style>
    html,body{margin:0;height:100%;font-family:Arial,"Microsoft YaHei",sans-serif;background:#e7e9ec;color:#25282d}
    *{box-sizing:border-box}#host{position:relative;height:100%;width:100%}
    :root{--dsw-alias-bg-elevated:#fff;--dsw-alias-label-primary:#25282d;
      --dsw-alias-label-secondary:#59616b;--dsw-alias-border-l3:#d5d9de;
      --dsw-alias-label-primary-inverted:#fff}
  </style><div id="host"></div>`);
  await page.evaluate((source) => {
    const state = [];
    const refs = [];
    let si = 0;
    let ri = 0;
    const fakeReact = {
      createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity) }),
      useState: (init) => {
        const index = si++;
        if (!(index in state)) state[index] = typeof init === 'function' ? init() : init;
        return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
      },
      useRef: (init) => {
        const index = ri++;
        if (!(index in refs)) refs[index] = { current: init };
        return refs[index];
      },
      useEffect() {},
      useCallback: (fn) => fn,
    };
    const app = new Function('require', `${source}\nreturn {CanvasTab,STATE_ORDER};`)(() => fakeReact);
    const solid = (color, w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      return c.toDataURL();
    };
    const imageA = { id: 'img-a', name: 'A.png', x: 40, y: 60, w: 300, h: 200, naturalW: 300, naturalH: 200, isRef: false, hidden: false, locked: false, dataUrl: solid('#d64545', 300, 200) };
    const imageB = { id: 'img-b', name: 'B.png', x: 500, y: 80, w: 240, h: 180, naturalW: 240, naturalH: 180, isRef: true, hidden: false, locked: false, dataUrl: solid('#438986', 240, 180) };
    const doc = { images: [imageA, imageB], marks: [], frames: [] };
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
        else if (key.startsWith('on') && typeof value === 'function') {
          el.addEventListener(key === 'onChange' ? 'input' : key.slice(2).toLowerCase(), value);
        } else if (key !== 'key' && value !== undefined) {
          if (['value', 'checked', 'disabled'].includes(key)) el[key] = value;
          else el.setAttribute(key, value);
        }
      }
      for (const child of node.children) el.appendChild(mount(child));
      return el;
    }
    function render(overrides = {}) {
      for (const [name, value] of Object.entries(overrides)) set(name, value);
      si = 0;
      ri = 0;
      const tree = app.CanvasTab({ sessionId: 'offline' });
      document.getElementById('host').replaceChildren(mount(tree));
      return tree;
    }
    window.harness = { app, render, set, refs, doc };
    render();
  }, source);
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);

  const shoot = async (viewport, size, dockOpen, file) => {
    await page.setViewportSize(viewport);
    await page.evaluate(({ size, dockOpen }) => {
      const h = window.harness;
      h.set('size', size);
      h.set('apikey', 'offline-test');
      h.set('loaded', true);
      h.set('selectedId', 'img-a');
      h.set('selectedIds', ['img-a']);
      h.set('dockOpen', dockOpen);
      h.set('showGen', true);
      h.refs[5].current = h.doc;
      h.render();
      const drawRef = h.refs.find((r) => typeof r.current === 'function' && r.current.name === 'draw');
      if (drawRef) drawRef.current();
    }, { size, dockOpen });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(outDir, file) });
    console.log(`saved ${file}`);
  };

  await shoot({ width: 1200, height: 900 }, { w: 1200, h: 900 }, '', 'ui-final-1200.png');
  await shoot({ width: 1200, height: 900 }, { w: 1200, h: 900 }, 'layers', 'ui-final-1200-dock.png');
  await shoot({ width: 390, height: 700 }, { w: 390, h: 700 }, '', 'ui-final-390.png');
  await shoot({ width: 360, height: 640 }, { w: 360, h: 640 }, 'history', 'ui-final-360-dock.png');
} finally {
  await browser.close();
}
