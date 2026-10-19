#!/usr/bin/env node
/* 对比视图(第一期 B)浏览器回归:在 fakeReact 挂载里真实点击/输入,
 * 验证覆盖层打开/交换/滑杆切换/关闭,以及滑杆事件不会落到主画布;
 * 并排与滑杆两种模式各出一张视口截图(绘制用 drawCompareCanvas 真画)。
 * Esc capture 监听依赖真 useEffect,fakeReact 不跑 effect —— 由人工验收覆盖。
 */
'use strict';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
    const app = new Function('require', `${source}\nreturn {CanvasTab,STATE_ORDER,rt};`)(() => fakeReact);
    const doc = { images: [], marks: [], frames: [] };
    const set = (name, value) => { state[app.STATE_ORDER.indexOf(name)] = value; };
    const get = (name) => state[app.STATE_ORDER.indexOf(name)];
    function mount(node) {
      if (node === null || node === undefined || node === false) return document.createTextNode('');
      if (typeof node !== 'object') return document.createTextNode(String(node));
      if (typeof node.tag === 'function') return mount(node.tag(node.props));
      const el = document.createElement(node.tag);
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
    // docRef 必须仍是第 6 个 ref(check-canvas-browser 的 refs[5] 契约)
    const docRefIndex = 5;
    render();
    refs[docRefIndex].current = doc;
    set('apikey', 'offline-test');
    set('loaded', true);
    // 两张不同尺寸的图,当对比快照用(dataUrl 由离屏 canvas 现画)
    const makePng = (w, h, color, label) => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const c = cv.getContext('2d');
      c.fillStyle = '#f4f4f4'; c.fillRect(0, 0, w, h);
      c.fillStyle = color; c.fillRect(w * 0.1, h * 0.15, w * 0.8, h * 0.7);
      c.fillStyle = '#111'; c.font = 'bold 28px sans-serif';
      c.fillText(label, 16, 40);
      return cv.toDataURL('image/png');
    };
    window.harness = {
      app, render, set, get, refs, doc,
      snapA: { name: 'A.png', dataUrl: makePng(640, 420, '#438986', 'A 640×420'), naturalW: 640, naturalH: 420 },
      snapB: { name: 'B.png', dataUrl: makePng(520, 380, '#b0603f', 'B 520×380'), naturalW: 520, naturalH: 380 },
    };
  }, source);

  const findButton = (text) => page.evaluate((t) => {
    const hit = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t));
    return !!hit;
  }, text);

  /* 1) 打开对比视图(尺寸不同 → 提示条) */
  await page.evaluate(() => {
    const { render, snapA, snapB } = window.harness;
    render({ compareA: snapA, compareB: snapB });
  });
  assert.ok(await findButton('交换'), '覆盖层打开后应出现交换按钮');
  const bodyText = await page.locator('#host').innerText();
  assert.ok(bodyText.includes('对比视图'), '应有「对比视图」标题');
  assert.ok(bodyText.includes('不是配准'), '尺寸不同应有「不是配准」提示');
  assert.ok(bodyText.includes('640×420') && bodyText.includes('520×380'), '提示条应给出两图尺寸');
  // 用真图画上 canvas 再截图(渲染 effect 不跑,手动绘制一次;等解码完成)
  await page.evaluate(() => new Promise((resolve) => {
    const { app } = window.harness;
    const compareCanvas = [...document.querySelectorAll('canvas')].pop();
    const a = new Image(); const b = new Image();
    let n = 0;
    const done = () => { n += 1; if (n === 2) { app.rt['compare-view'].drawCompareCanvas(compareCanvas, { imgA: a, imgB: b, mode: 'side', swap: false, slider: 0.5, zoom: 0.9, panX: 0, panY: 0, dpr: 1 }); resolve(); } };
    a.onload = done; b.onload = done;
    a.src = window.harness.snapA.dataUrl; b.src = window.harness.snapB.dataUrl;
  }));
  await page.screenshot({ path: path.join(output, 'compare-side.png') });

  /* 2) 交换:徽章文本对调 */
  const before = await page.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((s) => s.textContent.includes('⇄'));
    return el ? el.textContent : '';
  });
  assert.ok(before.includes('A.png') && before.includes('B.png'), '顶栏应显示两图名称');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('交换'));
    btn.click();
    window.harness.render(); // fakeReact setter 不自动重渲染,手动挂载一次
  });
  const after = await page.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((s) => s.textContent.includes('⇄'));
    return el ? el.textContent : '';
  });
  assert.ok(before.indexOf('A.png') < before.indexOf('B.png'), '交换前 A 在左(文本先出现)');
  assert.ok(after.indexOf('A.png') > after.indexOf('B.png'), '交换后 A 在右(角色对调)');
  console.log('PASS swap flips A/B roles');

  /* 3) 滑杆模式:input range 出现;滑杆上的指针事件不落到主画布 */
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('滑杆叠加'));
    btn.click();
    window.harness.render();
  });
  const sliderInfo = await page.evaluate(() => {
    const inOverlay = [...document.querySelectorAll('input[type="range"]')].filter((el) => {
      let n = el.parentElement;
      while (n) { if (n.style && n.style.zIndex === '9') return true; n = n.parentElement; }
      return false;
    });
    return { count: inOverlay.length, el: inOverlay[0] || null };
  });
  assert.equal(sliderInfo.count, 1, '滑杆模式下对比覆盖层内应恰有一个 range 输入');
  // 主画布装指针计数器;在滑杆上按住拖动,主画布不应收到任何 pointer 事件
  const sliderDrag = await page.evaluate(() => {
    const mainCanvas = document.querySelector('canvas'); // 根层主画布是第一个
    let hits = 0;
    ['pointerdown', 'pointermove', 'pointerup'].forEach((t) => mainCanvas.addEventListener(t, () => { hits += 1; }));
    const range = [...document.querySelectorAll('input[type="range"]')].find((el) => {
      let n = el.parentElement;
      while (n) { if (n.style && n.style.zIndex === '9') return true; n = n.parentElement; }
      return false;
    });
    range.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7 }));
    range.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7 }));
    range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
    range.dispatchEvent(new Event('input', { bubbles: true }));
    return { hits };
  });
  assert.equal(sliderDrag.hits, 0, '滑杆上的指针事件不允许穿透到主画布');
  console.log('PASS slider events never reach the canvas');
  // 滑杆拖到 0.8 再手动画一次,出滑杆模式截图
  await page.evaluate(() => new Promise((resolve) => {
    const { app, set } = window.harness;
    set('compareSlider', 0.8);
    window.harness.render();
    const compareCanvas = [...document.querySelectorAll('canvas')].pop();
    const a = new Image(); const b = new Image();
    let n = 0;
    const done = () => { n += 1; if (n === 2) { app.rt['compare-view'].drawCompareCanvas(compareCanvas, { imgA: a, imgB: b, mode: 'slider', swap: false, slider: 0.8, zoom: 0.9, panX: 0, panY: 0, dpr: 1 }); resolve(); } };
    a.onload = done; b.onload = done;
    a.src = window.harness.snapA.dataUrl; b.src = window.harness.snapB.dataUrl;
  }));
  await page.screenshot({ path: path.join(output, 'compare-slider.png') });

  /* 4) 关闭:覆盖层消失,主画布状态不变 */
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('关闭'));
    btn.click();
    window.harness.render();
  });
  assert.ok(await findButton('交换') === false, '关闭后覆盖层应整体消失');
  const afterClose = await page.evaluate(() => ({
    a: window.harness.get('compareA'), b: window.harness.get('compareB'),
  }));
  assert.equal(afterClose.a, null, '关闭应清掉 compareA');
  assert.equal(afterClose.b, null, '关闭应清掉 compareB');
  console.log('PASS close tears down the overlay and clears snapshots');

  assert.deepEqual(errors, [], '页面不允许有未捕获异常');
  console.log('Compare browser checks passed.');
  console.log(`Screenshots: ${output}`);
} finally {
  await browser.close();
}
