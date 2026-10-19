import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Optional development tool; the plugin itself still has no third-party dependencies.
// 用途:在真实 DOM 里断言渲染后的表单元素都有 id/name、图片都有显式宽高与 alt、id 不重复。
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readdirSync(path.join(root, 'lib', 'parts')).filter((name) => name.endsWith('.js') && name !== '99-entry.js')
  .sort().map((name) => fs.readFileSync(path.join(root, 'lib', 'parts', name), 'utf8')).join('\n');
const output = process.env.CANVAS_TEST_OUTPUT || path.join(root, 'browser-check');
fs.mkdirSync(output, { recursive: true });
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
    const realFetch = window.fetch ? window.fetch.bind(window) : () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    window.fetch = (url, opts) => realFetch(url, opts).catch(() => ({ ok: true, json: () => Promise.resolve({}) }));
    const app = new Function('require', `${source}\nreturn {CanvasTab,STATE_ORDER,rt,submissionRegion,decodeImage,nearestSize};`)(() => fakeReact);
    const solid = (color, w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      return c.toDataURL();
    };
    // 文字层挂在图片对象上(selected.texts),不是文档级 texts 数组
    const imageA = { id: 'img-a', name: 'A.png', x: 40, y: 60, w: 300, h: 200, naturalW: 300, naturalH: 200, isRef: false, hidden: false, locked: false, dataUrl: solid('#d64545', 300, 200), texts: [{ id: 'txt-1', value: '标注', x: 60, y: 90, size: 0.06, font: 'Arial', weight: 700, align: 'center', color: '#d64545', shadow: true }] };
    const imageB = { id: 'img-b', name: 'B.png', x: 500, y: 80, w: 240, h: 180, naturalW: 240, naturalH: 180, isRef: true, hidden: false, locked: false, dataUrl: solid('#438986', 240, 180), texts: [] };
    const doc = {
      images: [imageA, imageB],
      marks: [],
      frames: [],
    };
    const records = [
      { id: 'rec-1', at: Date.now() - 60000, model: 'gpt-image-2', ratio: '1:1', quality: 'high', w: 300, h: 200, promptUser: '第一张', promptFinal: '第一张', fav: false, sourceUrl: solid('#438986', 300, 200) },
      { id: 'rec-2', at: Date.now() - 120000, model: 'gpt-image-2', ratio: '1:1', w: 240, h: 180, promptUser: '第二张', promptFinal: '第二张', fav: true, sourceUrl: solid('#c6892f', 240, 180) },
    ];
    const set = (name, value) => { state[app.STATE_ORDER.indexOf(name)] = value; };
    const get = (name) => state[app.STATE_ORDER.indexOf(name)];
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
    function scan() {
      const forms = [...document.querySelectorAll('#host input, #host textarea, #host select')];
      const imgs = [...document.querySelectorAll('#host img')];
      const missing = forms.filter((el) => !el.getAttribute('id') && !el.getAttribute('name'))
        .map((el) => el.tagName.toLowerCase() + '(' + (el.getAttribute('type') || el.getAttribute('placeholder') || el.textContent.slice(0, 10)) + ')');
      const noSize = imgs.filter((el) => !el.getAttribute('width') || !el.getAttribute('height'))
        .map((el) => el.getAttribute('id') || String(el.getAttribute('src')).slice(0, 24));
      const noAlt = imgs.filter((el) => !el.getAttribute('alt'))
        .map((el) => el.getAttribute('id') || String(el.getAttribute('src')).slice(0, 24));
      const ids = [...document.querySelectorAll('#host [id]')].map((el) => el.getAttribute('id'));
      const dups = [...new Set(ids.filter((value, index) => ids.indexOf(value) !== index))];
      return { formCount: forms.length, imgCount: imgs.length, missing, noSize, noAlt, dups, grsaiIds: [...new Set(ids.filter((value) => value.startsWith('grsai-')))] };
    }
    render();
    refs[5].current = doc;
    set('apikey', 'offline-test');
    set('loaded', true);
    set('records', records);
    render();
    window.harness = { app, render, set, get, refs, doc, records, scan };
  }, source);
  assert.deepEqual(errors, [], 'no page errors during mount');

  const states = [
    ['default', { selectedId: '', selectedIds: [], showGen: true, dockOpen: '', showSettings: false, showLayerKey: false, showUpscale: false, selectedTextId: '', showText: false }],
    ['image selected + batch + crop', { selectedId: 'img-a', selectedIds: ['img-a'], batchSizes: ['1:1', '3:4'], cropToMark: true, appendHint: true, showGen: true }],
    ['text layer selected', { selectedTextId: 'txt-1', showText: true }],
    ['dock: history', { selectedTextId: '', dockOpen: 'history' }],
    ['dock: layers with rename box', { dockOpen: 'layers', layerRenameId: 'img-a' }],
    ['dock: workspace', { dockOpen: 'workspace', layerRenameId: '' }],
    ['dock: skills', { dockOpen: 'skills' }],
    ['settings panel', { dockOpen: '', showSettings: true }],
    ['layer key panel', { showSettings: false, showLayerKey: true }],
    ['upscale panel', { showLayerKey: false, showUpscale: true }],
    ['compare view (slider mode)', { showUpscale: false, compareA: 'img-a', compareB: 'img-b', compareMode: 'slider', selectedId: '', selectedIds: [] }],
    ['scene frame draft input', { compareA: '', compareB: '', frameDraft: { x: 120, y: 140, sx: 140, sy: 160, value: '' }, selectedId: 'img-a', selectedIds: ['img-a'] }],
  ];
  let totalForms = 0;
  let totalImgs = 0;
  const seen = new Set();
  for (const [label, overrides] of states) {
    const report = await page.evaluate((overrides) => {
      window.harness.render(overrides);
      return window.harness.scan();
    }, overrides);
    totalForms += report.formCount;
    totalImgs += report.imgCount;
    report.grsaiIds.forEach((id) => seen.add(id));
    assert.deepEqual(report.missing, [], `[${label}] 表单元素缺 id/name`);
    assert.deepEqual(report.noSize, [], `[${label}] 图片缺显式宽高`);
    assert.deepEqual(report.noAlt, [], `[${label}] 图片缺 alt`);
    assert.deepEqual(report.dups, [], `[${label}] id 重复`);
    console.log(`PASS ${label} — ${report.formCount} 表单元素 / ${report.imgCount} 图片 全部带 id|name、宽高、alt(无重复 id)`);
  }

  // 抽查关键入口 id 确实落到 DOM,并且覆盖到多记录场景下的缩略图唯一 id
  const probe = await page.evaluate(() => {
    window.harness.render({ selectedId: 'img-a', selectedIds: ['img-a'], dockOpen: 'history', showGen: true });
    const historyIds = [...document.querySelectorAll('#host img')].map((el) => el.getAttribute('id'));
    window.harness.render({ dockOpen: '', showSettings: true, selectedTextId: 'txt-1', showText: true });
    const wanted = ['grsai-prompt', 'grsai-model-input', 'grsai-apikey', 'grsai-quality-select', 'grsai-background-select', 'grsai-history-limit', 'grsai-file-import', 'grsai-text-value', 'grsai-text-align', 'grsai-submit-texts'];
    return {
      historyIds,
      missing: wanted.filter((id) => !document.getElementById(id)),
      promptTag: (document.getElementById('grsai-prompt') || {}).tagName || '',
    };
  });
  assert.equal(probe.historyIds.length, 2, '两条记录应各渲染一张缩略图');
  assert.equal(new Set(probe.historyIds).size, 2, '多记录缩略图 id 必须唯一');
  assert.deepEqual(probe.missing, [], '关键入口 id 缺失: ' + probe.missing.join(', '));
  assert.equal(probe.promptTag, 'TEXTAREA', 'grsai-prompt 应指向提示词输入框');
  console.log('PASS 关键入口 id 落到真实 DOM,多记录缩略图 id 唯一(覆盖 ' + seen.size + ' 个 grsai-* id)');

  // 证据截图
  await page.evaluate(() => window.harness.render({ selectedId: 'img-a', selectedIds: ['img-a'], showGen: true }));
  await page.screenshot({ path: path.join(output, 'a11y-default.png') });
  await page.evaluate(() => window.harness.render({ selectedId: '', selectedIds: [], dockOpen: 'history', showSettings: false }));
  await page.screenshot({ path: path.join(output, 'a11y-history.png') });
  await page.evaluate(() => window.harness.render({ dockOpen: '', showSettings: true, selectedTextId: 'txt-1', showText: true, selectedId: 'img-a', selectedIds: ['img-a'] }));
  await page.screenshot({ path: path.join(output, 'a11y-settings.png') });
  assert.deepEqual(errors, [], 'no page errors during checks');
  // 深层入口(只在特定交互态出现的控件)也必须有 id —— 逐个点名,避免"没渲染所以没报错"
  const deep = ['grsai-compare-slider', 'grsai-frame-size-input', 'grsai-layer-rename', 'grsai-history-search'];
  const notSeen = deep.filter((id) => !seen.has(id));
  assert.deepEqual(notSeen, [], '深层交互态控件未被覆盖到: ' + notSeen.join(', '));
  assert.ok([...seen].some((id) => id.startsWith('grsai-batch-')), '跨平台批量尺寸复选框缺 id');
  console.log(`Accessibility DOM checks passed (${states.length} 视图状态,累计 ${totalForms} 表单元素 / ${totalImgs} 图片,${
    seen.size} 个 grsai-* id)。Screenshots: ${output}`);
} finally {
  await browser.close();
}
