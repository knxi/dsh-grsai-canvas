import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Optional development tool; the plugin itself still has no third-party dependencies.
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
    const app = new Function('require', `${source}\nreturn {CanvasTab,STATE_ORDER,rt,submissionRegion,decodeImage,nearestSize,drawRefBadge,refNumbers};`)(() => fakeReact);
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 1000;
    sourceCanvas.height = 800;
    const c = sourceCanvas.getContext('2d');
    c.fillStyle = '#e07045';
    c.fillRect(0, 0, 1000, 800);
    c.fillStyle = '#438986';
    c.fillRect(0, 0, 350, 800);
    c.fillStyle = '#fafafa';
    c.font = 'bold 70px sans-serif';
    c.fillText('CANVAS', 80, 240);
    const image = { id: 'source', name: 'sample.png', x: 80, y: 100, w: 500, h: 400,
      naturalW: 1000, naturalH: 800, isRef: true, dataUrl: sourceCanvas.toDataURL(),
      texts: [{ id: 'text-1', value: 'A local text layer', font: 'Arial', size: 0.05, nx: 0.5, ny: 0.7, color: '#ffffff', weight: 700 }] };
    const doc = { images: [image], marks: [], frames: [] };
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
          if (['value', 'checked', 'disabled', 'defaultValue'].includes(key)) el[key] = value;
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
    render();
    refs[5].current = doc;
    set('apikey', 'offline-test');
    set('loaded', true);
    set('selectedId', image.id);
    set('selectedIds', [image.id]);
    window.harness = { app, render, set, get, refs, doc, image };
  }, source);

  const pixelResult = await page.evaluate(async () => {
    const { app, image, doc } = window.harness;
    const el = await app.decodeImage(image.dataUrl);
    const mask = { id: 'mask', targetId: image.id, kind: 'mask', points: [[0.45, 0.5], [0.65, 0.5]], width: 0.1 };
    doc.marks = [mask];
    const p = {
      docRef: { current: doc }, imgCacheRef: { current: new Map([[image.id, el]]) },
      cropToMark: true, submitTexts: false,
    };
    const submission = app.rt.generate.createGenerate(p).buildSubmission(image);
    const result = await app.decodeImage(submission.dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = result.naturalWidth;
    canvas.height = result.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(result, 0, 0);
    const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    doc.marks = [];
    return { inside: pixel(550, 400), outside: pixel(850, 400), cropped: submission.cropped };
  });
  assert.equal(pixelResult.inside[3], 255, 'mask region must remain opaque');
  assert.deepEqual(pixelResult.inside.slice(0, 3), [224, 112, 69], 'mask retains original pixels');
  assert.equal(pixelResult.outside[3], 255);
  assert.ok(pixelResult.outside[0] < pixelResult.inside[0] * 0.7, 'unmasked region is darkened');
  assert.equal(pixelResult.cropped, false);
  console.log('PASS actual canvas mask pixels', pixelResult);

  await page.evaluate(() => {
    const { render, doc } = window.harness;
    doc.frames = [{ id: 'frame', x: 80, y: 80, w: 300, h: 400 }];
    render({ selectedId: null, selectedIds: [], selectedFrameId: 'frame' });
  });
  assert.ok((await page.locator('#host').innerText()).includes('场景框比例:300×400'));
  console.log('PASS frame without source image renders without a null dereference');

  for (const draft of ['原图比例', 'auto']) {
    await page.evaluate((draft) => {
      const { render, doc } = window.harness;
      doc.frames = [];
      render({ customSize: '1080x1440', sizeDraft: draft });
      document.querySelector('input[placeholder^="原图比例"]').dispatchEvent(new FocusEvent('blur'));
    }, draft);
    assert.equal(await page.evaluate(() => window.harness.get('customSize')), '');
    assert.equal(await page.evaluate(() => window.harness.get('ratio')), draft === 'auto' ? 'auto' : 'source');
  }
  console.log('PASS typing source/auto clears stale output size');

  // 属性卡的「精确位置/尺寸」:四个数字框要带当前值,改了失焦后要真的写进 doc
  await page.evaluate(() => {
    const { render, image } = window.harness;
    render({ selectedId: image.id, selectedIds: [image.id], showGen: false, size: { w: 1200, h: 900 } });
  });
  const geo = await page.evaluate(() => [...document.querySelectorAll('#host input[type="number"]')].map((el) => el.value));
  assert.deepEqual(geo.slice(0, 4), ['80', '100', '500', '400'], `geometry inputs prefilled: ${JSON.stringify(geo)}`);
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('#host input[type="number"]')][2];
    input.value = '640';
    input.dispatchEvent(new FocusEvent('blur'));
  });
  assert.equal(await page.evaluate(() => window.harness.doc.images[0].w), 640);
  await page.evaluate(() => {
    // 清空再失焦:不能把 NaN 写进 doc(那会让图从画布上消失),必须保持原值
    const input = [...document.querySelectorAll('#host input[type="number"]')][2];
    input.value = '';
    input.dispatchEvent(new FocusEvent('blur'));
  });
  assert.equal(await page.evaluate(() => window.harness.doc.images[0].w), 640);
  console.log('PASS property card geometry inputs write through and reject empty');

  // 参考图编号:不选中任何图也要看得见(画布角标 + 生成卡编号),且两边跟提交顺序一致
  await page.evaluate(() => {
    const { render, doc, image } = window.harness;
    doc.images = [
      image,
      { id: 'ref-1', name: '风格参考.png', x: 620, y: 120, w: 300, h: 240, dataUrl: image.dataUrl, naturalW: 500, naturalH: 400, isRef: true },
      { id: 'ref-2', name: '配色参考.png', x: 620, y: 400, w: 300, h: 240, dataUrl: image.dataUrl, naturalW: 500, naturalH: 400, isRef: true },
    ];
    render({ selectedId: null, selectedIds: [], selectedFrameId: null, showGen: true, size: { w: 1200, h: 900 } });
  });
  const refCard = await page.locator('#host').innerText();
  // 未选中时三张参考图都要编号(浏览器 fixture 里原图本身就是 isRef)
  for (const no of ['参考图1:', '参考图2:', '参考图3:']) {
    assert.ok(refCard.includes(no), `gen card missing ${no}: ${refCard.slice(0, 500)}`);
  }
  assert.ok(refCard.includes('参考 3 张'), refCard.slice(0, 500));
  const badge = await page.evaluate(() => {
    const { app } = window.harness;
    const paint = (label, isMain) => {
      const cv = document.createElement('canvas');
      cv.width = 220;
      cv.height = 70;
      const ctx = cv.getContext('2d');
      app.drawRefBadge(ctx, 12, 12, 220, 70, label, isMain);
      const d = ctx.getImageData(0, 0, 220, 70).data;
      let blue = 0;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 160) continue;
        if (Math.abs(d[i] - 59) < 10 && Math.abs(d[i + 1] - 130) < 10 && Math.abs(d[i + 2] - 246) < 10) blue += 1;
        if (Math.abs(d[i] - 15) < 8 && Math.abs(d[i + 1] - 23) < 8 && Math.abs(d[i + 2] - 42) < 8) dark += 1;
      }
      return { blue, dark };
    };
    // 越界收拢:传一个远超画布的坐标,角标必须还在画布里
    const edge = document.createElement('canvas');
    edge.width = 220;
    edge.height = 70;
    app.drawRefBadge(edge.getContext('2d'), 9999, 9999, 220, 70, '参考 1', false);
    const d = edge.getContext('2d').getImageData(0, 0, 220, 70).data;
    let inside = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 160) inside += 1;
    return { ref: paint('参考 1', false), main: paint('主图', true), inside };
  });
  assert.ok(badge.ref.blue > 100, `ref badge must be blue: ${JSON.stringify(badge)}`);
  assert.ok(badge.main.dark > 100, `main badge must be dark: ${JSON.stringify(badge)}`);
  assert.ok(badge.inside > 100, `badge must stay inside the viewport: ${JSON.stringify(badge)}`);
  console.log('PASS reference badges visible without selection, numbered by submit order');

  for (const [name, width, height] of [['desktop', 1200, 900], ['sidebar', 390, 700], ['mobile', 360, 640], ['short', 640, 420]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(({ width, height }) => {
      const { render, doc, image } = window.harness;
      doc.frames = [];
      doc.marks = [];
      render({ size: { w: width, h: height }, selectedId: image.id, selectedIds: [image.id],
        selectedFrameId: null, showGen: true, showText: true, selectedTextId: 'text-1', showModels: false });
    }, { width, height });
    const bounds = await page.evaluate(() => {
      const root = document.getElementById('host').firstElementChild;
      const panels = [...root.children].filter((el) => el.tagName === 'DIV' && el.style.position === 'absolute');
      return panels.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      });
    });
    for (const box of bounds) {
      assert.ok(box.x >= -1 && box.y >= -1 && box.right <= width + 1 && box.bottom <= height + 1,
        `${name}: floating control clipped: ${JSON.stringify(box)}`);
    }
    await page.getByText('按标注改图', { exact: true }).scrollIntoViewIfNeeded();
    const runBox = await page.getByText('按标注改图', { exact: true }).boundingBox();
    assert.ok(runBox.y >= 0 && runBox.y + runBox.height <= height);
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    await page.evaluate(() => window.harness.render({ showModels: true }));
    await page.getByText('gpt-image-2-vip(大图/高清)', { exact: true }).click();
    assert.equal(await page.evaluate(() => window.harness.get('model')), 'gpt-image-2-vip');
    await page.evaluate(() => window.harness.render());
    console.log(`PASS ${name} ${width}x${height}: controls reachable, model menu clickable`);
  }
  assert.deepEqual(errors, []);
  console.log(`Browser checks passed. Screenshots: ${output}`);
} finally {
  await browser.close();
}
