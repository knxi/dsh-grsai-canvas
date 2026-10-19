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
    // Capture /state POST payloads so we can assert hidden/locked reach persistence.
    const stateBodies = [];
    const realFetch = window.fetch ? window.fetch.bind(window) : () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    window.fetch = (url, opts) => {
      if (opts && opts.method === 'POST' && String(url).includes('/state')) {
        try { stateBodies.push(JSON.parse(opts.body)); } catch { stateBodies.push(null); }
      }
      return realFetch(url, opts).catch(() => ({ ok: true, json: () => Promise.resolve({}) }));
    };
    const app = new Function('require', `${source}\nreturn {CanvasTab,STATE_ORDER,rt,submissionRegion,decodeImage,nearestSize};`)(() => fakeReact);
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
    render();
    refs[5].current = doc;
    set('apikey', 'offline-test');
    set('loaded', true);
    set('selectedId', 'img-a');
    set('selectedIds', ['img-a']);
    set('dockOpen', 'layers');
    render();
    window.harness = { app, render, set, get, refs, doc, stateBodies };
    // 供像素断言用:找到 imgCacheRef(useRef 的 Map)与 drawRef(名为 draw 的函数 ref)
    window.harness.cacheRef = refs.find((r) => r.current instanceof Map) || null;
    window.harness.drawRef = refs.find((r) => typeof r.current === 'function' && r.current.name === 'draw') || null;
  }, source);
  assert.deepEqual(errors, [], 'no page errors during mount');
  console.log('PASS mounts with a two-image doc and the layers dock open');

  const rowFor = (name) => page.evaluate((name) => {
    const spans = [...document.querySelectorAll('#host *')].filter((el) => el.children.length === 0 && el.textContent === name);
    const row = spans.length && spans[0].closest('div[draggable]');
    if (!row) throw new Error(`layer row not found for ${name}`);
    return true;
  }, name);
  const clickRowButton = (name, label) => page.evaluate(([name, label]) => {
    const spans = [...document.querySelectorAll('#host *')].filter((el) => el.children.length === 0 && el.textContent.includes(name));
    const row = spans.map((el) => el.closest('div[draggable]')).find(Boolean);
    if (!row) {
      const rows = [...document.querySelectorAll('#host div[draggable]')];
      throw new Error(`row text ${name} not found; rows=${rows.length}; texts=${rows.map((r) => JSON.stringify(r.innerText)).join('|')}`);
    }
    const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
    if (!btn) throw new Error(`button ${label} not found on row ${name}`);
    btn.click();
  }, [name, label]);

  // 1) Dock lists both images bottom-up, badge shows the count.
  {
    const host = await page.locator('#host').innerText();
    assert.ok(/图层\s*2/.test(host), `layers badge should show 2, got: ${host.slice(0, 400)}`);
    const count = await page.locator('#host div[draggable]').count();
    assert.equal(count, 2, 'two layer rows');
    await rowFor('A.png');
    await rowFor('B.png');
    await page.screenshot({ path: path.join(output, 'layers-dock.png') });
    console.log('PASS dock shows the layers tab with a badge and two rows');
  }

  // 2) Hide B: canvas pixels disappear, hit-testing skips it, refCount excludes it.
  {
    // 预热解码缓存(draw 只画 imgCacheRef 里有的图),手动触发一次绘制作基线
    const base = await page.evaluate(async () => {
      const { app, doc, cacheRef, drawRef } = window.harness;
      for (const image of doc.images) {
        cacheRef.current.set(image.id, await app.decodeImage(image.dataUrl));
      }
      drawRef.current();
      const canvas = document.querySelector('#host canvas');
      const px = (x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
      return { wh: [canvas.width, canvas.height], b: px(620, 170), a: px(190, 160) };
    });
    assert.ok(base.wh[0] > 400, `draw must size the canvas, got ${JSON.stringify(base.wh)}`);
    assert.ok(base.a[3] === 255 && base.a[0] > 150 && base.a[1] < 120, `baseline A must be red, got ${JSON.stringify(base.a)}`);
    assert.ok(base.b[3] === 255 && base.b[1] > 100, `baseline B must be green, got ${JSON.stringify(base.b)}`);
    await clickRowButton('B.png', '隐');
    await page.evaluate(() => { window.harness.render(); window.harness.drawRef.current(); });
    const canvasPixel = await page.evaluate(() => {
      const canvas = document.querySelector('#host canvas');
      const px = (x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
      return { b: px(620, 170), a: px(190, 160) };
    });
    assert.equal(canvasPixel.b[3], 0, `hidden B region must be transparent, got ${JSON.stringify(canvasPixel.b)}`);
    assert.ok(canvasPixel.a[3] === 255 && canvasPixel.a[0] > 150 && canvasPixel.a[1] < 120,
      `A stays visible red, got ${JSON.stringify(canvasPixel.a)}`);
    assert.equal(await page.evaluate(() => window.harness.doc.images[1].hidden), true);
    const status = await page.locator('#host').innerText();
    assert.ok(!/1 参考/.test(status), 'hidden ref must not count in the status bar');
    const after = await page.evaluate(() => {
      const canvas = document.querySelector('#host canvas');
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 620, clientY: 170, bubbles: true, pointerId: 1, button: 0, isPrimary: true, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 620, clientY: 170, bubbles: true, pointerId: 1, isPrimary: true, buttons: 0 }));
      return [...window.harness.get('selectedIds')];
    });
    assert.ok(!after.includes('img-b'), 'hidden image must not be hit-tested');
    console.log('PASS hiding B removes pixels, hit-testing and ref count');
  }

  // 3) Show again, then lock A: dragging does not move it, panel delete is refused.
  {
    await clickRowButton('B.png', '显');
    await clickRowButton('A.png', '锁');
    await page.evaluate(() => window.harness.render());
    const before = await page.evaluate(() => {
      const canvas = document.querySelector('#host canvas');
      const seq = ['pointerdown', 'pointermove', 'pointermove', 'pointerup'];
      const pts = [[190, 160], [240, 210], [280, 250], [280, 250]];
      seq.forEach((type, i) => canvas.dispatchEvent(new PointerEvent(type, {
        clientX: pts[i][0], clientY: pts[i][1], bubbles: true, pointerId: 1,
        button: type === 'pointerup' ? 0 : 0, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1,
      })));
      const doc = window.harness.doc;
      return { x: doc.images[0].x, y: doc.images[0].y, w: doc.images[0].w };
    });
    assert.equal(before.x, 40, 'locked image must not move');
    assert.equal(before.y, 60, 'locked image must not move');
    assert.equal(before.w, 300, 'locked image must not resize');
    const del = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('#host *')].filter((el) => el.children.length === 0 && el.textContent.includes('A.png'));
      const aRow = spans.map((el) => el.closest('div[draggable]')).find(Boolean);
      [...aRow.querySelectorAll('button')].find((b) => b.textContent.trim() === '删').click();
      return { count: window.harness.doc.images.length, name: window.harness.doc.images[0].name };
    });
    assert.equal(del.count, 2, 'locked image survives plain delete');
    assert.equal(del.name, 'A.png');
    await page.screenshot({ path: path.join(output, 'layers-locked.png') });
    console.log('PASS locking A blocks drag, resize and plain delete');
  }

  // 4) Persistence: /state POST bodies carry hidden/locked for every image.
  {
    const bodies = await page.evaluate(async () => {
      const doc = window.harness.doc;
      doc.images[1].isRef = false; // make the change meaningful
      // finishChange is private; trigger save through the state module path by another change
      const canvas = document.querySelector('#host canvas');
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 190, clientY: 160, bubbles: true, pointerId: 1, button: 0, isPrimary: true, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 190, clientY: 160, bubbles: true, pointerId: 1, isPrimary: true, buttons: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return window.harness.stateBodies;
    });
    assert.ok(bodies.length >= 1, 'at least one /state POST captured');
    const last = bodies[bodies.length - 1];
    assert.ok(Array.isArray(last.images) && last.images.length === 2, 'payload carries both images');
    for (const img of last.images) {
      assert.equal(typeof img.hidden, 'boolean', `hidden must serialize: ${img.name}`);
      assert.equal(typeof img.locked, 'boolean', `locked must serialize: ${img.name}`);
    }
    const byName = Object.fromEntries(last.images.map((i) => [i.name, i]));
    assert.equal(byName['B.png'].hidden, false, 'B shown again');
    assert.equal(byName['A.png'].locked, true, 'A stays locked');
    console.log('PASS /state payload serializes hidden/locked');
  }

  // 5) Hidden main image: generate refuses with a clear message.
  {
    await clickRowButton('B.png', '隐');
    await page.evaluate(() => {
      window.harness.set('selectedId', 'img-b');
      window.harness.set('selectedIds', ['img-b']);
      window.harness.set('selectedFrameId', null);
      window.harness.render();
    });
    await page.getByText('按标注改图', { exact: true }).click();
    await page.evaluate(() => window.harness.render());
    const text = await page.locator('#host').innerText();
    assert.match(text, /隐藏状态/, 'generate must refuse hidden main image');
    console.log('PASS generate refuses a hidden main image');
  }

  // 6) Legacy doc without hidden/locked still loads and renders.
  {
    await page.evaluate(() => {
      const { doc, render } = window.harness;
      const tiny = document.createElement('canvas');
      tiny.width = 100; tiny.height = 80;
      const ctx = tiny.getContext('2d');
      ctx.fillStyle = '#2255aa';
      ctx.fillRect(0, 0, 100, 80);
      doc.images.push({ id: 'img-c', name: 'C.png', x: 300, y: 420, w: 100, h: 80, naturalW: 100, naturalH: 80, isRef: false, dataUrl: tiny.toDataURL() });
      render({ selectedId: 'img-c', selectedIds: ['img-c'] });
    });
    const count = await page.locator('#host div[draggable]').count();
    assert.equal(count, 3, 'legacy image without hidden/locked renders a row');
    const host = await page.locator('#host').innerText();
    assert.ok(host.includes('C.png'));
    await page.screenshot({ path: path.join(output, 'layers-legacy.png') });
    console.log('PASS legacy doc without hidden/locked fields renders');
  }

  assert.deepEqual(errors, []);
  console.log(`Layer browser checks passed. Screenshots: ${output}`);
} finally {
  await browser.close();
}
