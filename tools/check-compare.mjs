#!/usr/bin/env node
/* 对比视图(第一期 B)离线回归:
 * 用 vm 装载 lib/parts/37-compare-view.js,用替身 h() 检查渲染输出结构,
 * 用假 2d 上下文逐条断言 drawCompareCanvas 的绘制(不拉伸/同步缩放/滑杆裁剪/交换)。
 * 与浏览器回归(tools/check-canvas-browser.mjs)互补:这里管逻辑与结构,那边管事件隔离与视口。
 */
'use strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const vm = require('vm');

import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const partsDir = path.join(ROOT, 'lib', 'parts');

/* ── 替身 ── */
function makeH() {
  return function h(tag, props, ...children) {
    return { tag, props: props || {}, children: children.filter((c) => c !== null && c !== undefined && c !== false) };
  };
}
const S_STUB = { tiny: {}, btnOn: {}, grow: {}, hint: {}, card: {}, btn: {} };

function loadCompareViewPart() {
  const parts = {};
  const sandbox = {
    definePart: (name, factory) => { parts[name] = factory(); },
    h: makeH(),
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(partsDir, '37-compare-view.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: '37-compare-view.js' });
  if (!parts['compare-view']) throw new Error('compare-view 零件没注册');
  return parts['compare-view'];
}

/* 假 2d 上下文:记录调用,供断言。 */
function makeFakeCtx() {
  const calls = { setTransform: [], fillRect: [], drawImage: [], moveTo: [], lineTo: [], arc: [], rect: [], fillText: [], save: 0, restore: 0, clip: 0, beginPath: 0, stroke: 0, fill: 0 };
  return {
    calls,
    setTransform: (...a) => calls.setTransform.push(a),
    fillRect: (...a) => calls.fillRect.push(a),
    drawImage: (...a) => calls.drawImage.push(a),
    beginPath: () => { calls.beginPath += 1; },
    moveTo: (...a) => calls.moveTo.push(a),
    lineTo: (...a) => calls.lineTo.push(a),
    stroke: () => { calls.stroke += 1; },
    arc: (...a) => calls.arc.push(a),
    fill: () => { calls.fill += 1; },
    fillText: (...a) => calls.fillText.push(a),
    save: () => { calls.save += 1; },
    restore: () => { calls.restore += 1; },
    clip: () => { calls.clip += 1; },
    rect: (...a) => calls.rect.push(a),
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
  };
}
function makeFakeCanvas(w, h) {
  const ctx = makeFakeCtx();
  return { clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: () => ctx };
}
function makeImg(name, nw, nh) { return { name, naturalWidth: nw, naturalHeight: nh }; }

/* deps 包:A/B 快照是「画布图/记录」的轻量表示(与 12-canvas-tab 里 setCompareA 的形状一致)。 */
function makeDeps(over) {
  return Object.assign({
    S: S_STUB,
    closeCompare: () => {},
    compareA: { name: 'A.png', dataUrl: 'data:image/png;base64,AA', naturalW: 100, naturalH: 80 },
    compareB: { name: 'B.png', dataUrl: 'data:image/png;base64,BB', naturalW: 100, naturalH: 80 },
    compareCanvasRef: { current: null },
    compareMode: 'side',
    comparePointerDown: () => {},
    comparePointerMove: () => {},
    comparePointerUp: () => {},
    compareSlider: 0.5,
    compareSwap: false,
    compareWheel: () => {},
    compareZoom: 0.5,
    exportCompareResult: () => {},
    fitCompare: () => {},
    setCompareMode: () => {},
    setCompareSlider: () => {},
    setCompareSwap: () => {},
    zoom100Compare: () => {},
  }, over || {});
}

/* 找 children 里第 depth 层的按钮(平铺收集)。 */
function collectButtons(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.tag === 'button') out.push(node);
  if (Array.isArray(node.children)) for (const c of node.children) collectButtons(c, out);
  return out;
}
function collectText(node, out) {
  if (out === undefined) out = [];
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const c of node) collectText(c, out); return out; }
  if (typeof node === 'object' && node.tag) { collectText(node.children, out); return out; }
  return out;
}
function countTag(node, tag) {
  if (!node || typeof node !== 'object') return 0;
  let n = node.tag === tag ? 1 : 0;
  if (Array.isArray(node.children)) for (const c of node.children) n += countTag(c, tag);
  return n;
}

/* ── 用例 ── */
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok  ${name}`);
  else { failed += 1; console.error(`  FAIL ${name}`); }
}

const { renderCompareView, drawCompareCanvas } = loadCompareViewPart();

console.log('check-compare: 对比视图(第一期 B)离线回归');

/* 1) 关闭态:没 A 或没 B 时整层不渲染 */
check('关闭态渲染 null(A/B 不齐)', renderCompareView(makeDeps({ compareB: null })) === null);

/* 2) 打开态:顶栏按钮齐全 */
{
  const root = renderCompareView(makeDeps());
  const btns = collectButtons(root, []);
  const labels = btns.map((b) => (b.children || []).filter((c) => typeof c === 'string').join(''));
  check('顶栏有「⇄ 交换」', labels.some((l) => l.includes('交换')));
  check('顶栏有「并排」', labels.some((l) => l === '并排'));
  check('顶栏有「滑杆叠加」', labels.some((l) => l === '滑杆叠加'));
  check('顶栏有「适应」', labels.some((l) => l.includes('适应')));
  check('顶栏有「100%」', labels.some((l) => l === '100%'));
  check('顶栏有「导出结果图」', labels.some((l) => l.includes('导出结果图')));
  check('顶栏有「✕ 关闭」', labels.some((l) => l.includes('关闭')));
  check('关闭按钮 onClick=closeCompare', btns.some((b) => b.props.onClick === makeDeps().closeCompare || String(b.props.title || '').includes('关闭对比')));
  check('覆盖层有 onWheel(缩放)', root.props.onWheel != null);
}

/* 3) 尺寸相同:没有「不是配准」提示条;尺寸不同:有明确提示 */
{
  const same = collectText(renderCompareView(makeDeps()), []).join(' ');
  check('尺寸相同不提示配准', !same.includes('不是配准'));
  const diff = collectText(renderCompareView(makeDeps({ compareB: { name: 'B.png', dataUrl: 'x', naturalW: 200, naturalH: 90 } })), []).join(' ');
  check('尺寸不同提示「不是配准」', diff.includes('不是配准'));
  check('尺寸不同提示给出两图尺寸', diff.includes('100×80') && diff.includes('200×90'));
}

/* 4) 滑杆模式:DOM input range,不穿透;onChange 把 0..1000 映射到 0..1 */
{
  let got = -1;
  const root = renderCompareView(makeDeps({ compareMode: 'slider', setCompareSlider: (v) => { got = v; } }));
  check('滑杆模式有 input[type=range]', countTag(root, 'input') === 1);
  const findInput = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.tag === 'input') return node;
    for (const c of node.children || []) { const r = findInput(c); if (r) return r; }
    return null;
  };
  const input = findInput(root);
  check('input 是 range 且 0..1000', input && input.props.type === 'range' && Number(input.props.max) === 1000);
  check('input 值跟随 compareSlider(0.5→500)', Number(input.props.value) === 500);
  input.props.onChange({ target: { value: '250' } });
  check('onChange 映射 250→0.25', got === 0.25);
  const side = renderCompareView(makeDeps());
  check('并排模式没有 range 滑杆', countTag(side, 'input') === 0);
}

/* 5) 交换按钮调用 setCompareSwap(!swap) */
{
  let swapped = null;
  const root = renderCompareView(makeDeps({ compareSwap: false, setCompareSwap: (v) => { swapped = v; } }));
  const btn = collectButtons(root, []).find((b) => String((b.children || []).join('')).includes('交换'));
  btn.props.onClick();
  check('交换调用 setCompareSwap(true)', swapped === true);
}

/* 6) drawCompareCanvas:空画布直接返回 */
{
  const cv = makeFakeCanvas(0, 0);
  drawCompareCanvas(cv, { imgA: makeImg('a', 10, 10), imgB: makeImg('b', 10, 10), mode: 'side', swap: false, slider: 0.5, zoom: 1, panX: 0, panY: 0, dpr: 1 });
  check('clientWidth 为 0 时不绘制', cv.getContext().calls.drawImage.length === 0);
}

/* 7) 并排:两图同一 zoom 居中于左右半区(同步缩放),不拉伸 */
{
  const cv = makeFakeCanvas(800, 400);
  drawCompareCanvas(cv, { imgA: makeImg('a', 100, 50), imgB: makeImg('b', 200, 50), mode: 'side', swap: false, slider: 0.5, zoom: 2, panX: 0, panY: 0, dpr: 1 });
  const c = cv.getContext().calls;
  check('并排画了两张图', c.drawImage.length === 2);
  const [a, b] = c.drawImage;
  check('A 中心在左半区(200)', Math.abs((a[1] + a[3] / 2) - 200) < 0.001);
  check('B 中心在右半区(600)', Math.abs((b[1] + b[3] / 2) - 600) < 0.001);
  check('A 不拉伸(100×50 × zoom2 = 200×100)', a[3] === 200 && a[4] === 100);
  check('B 不拉伸(200×50 × zoom2 = 400×100)', b[3] === 400 && b[4] === 100);
  check('画了中缝分割线', c.moveTo.some((m) => m[0] === 400 && m[1] === 0));
  check('按 dpr 缩放上下文(dpr=1.5)', (() => {
    const cv2 = makeFakeCanvas(800, 400);
    drawCompareCanvas(cv2, { imgA: makeImg('a', 10, 10), imgB: makeImg('b', 10, 10), mode: 'side', swap: false, slider: 0.5, zoom: 1, panX: 0, panY: 0, dpr: 1.5 });
    const st = cv2.getContext().calls.setTransform[0];
    return st[0] === 1.5 && st[3] === 1.5 && cv2.width === 1200;
  })());
}

/* 8) 并排同步平移:panX 同偏移作用于两图 */
{
  const cv = makeFakeCanvas(800, 400);
  drawCompareCanvas(cv, { imgA: makeImg('a', 100, 50), imgB: makeImg('b', 100, 50), mode: 'side', swap: false, slider: 0.5, zoom: 1, panX: 30, panY: -10, dpr: 1 });
  const [a, b] = cv.getContext().calls.drawImage;
  check('panX/panY 同步平移两图', Math.abs((a[1] + a[3] / 2) - 230) < 0.001 && Math.abs((b[1] + b[3] / 2) - 630) < 0.001 && Math.abs((a[2] + a[4] / 2) - 190) < 0.001);
}

/* 9) 交换:左画的是 B */
{
  const cv = makeFakeCanvas(800, 400);
  drawCompareCanvas(cv, { imgA: makeImg('a', 100, 50), imgB: makeImg('b', 40, 20), mode: 'side', swap: true, slider: 0.5, zoom: 1, panX: 0, panY: 0, dpr: 1 });
  const [first] = cv.getContext().calls.drawImage;
  check('swap 后左半区画的是 imgB(40×20)', first[3] === 40 && first[4] === 20);
}

/* 10) 滑杆模式:中心对齐叠放 + clip 到 slider 宽度 + 手柄 */
{
  const cv = makeFakeCanvas(800, 400);
  drawCompareCanvas(cv, { imgA: makeImg('a', 100, 50), imgB: makeImg('b', 100, 50), mode: 'slider', swap: false, slider: 0.25, zoom: 1, panX: 0, panY: 0, dpr: 1 });
  const c = cv.getContext().calls;
  check('滑杆画了两张图(叠放)', c.drawImage.length === 2);
  const [x1] = c.drawImage;
  check('两图都中心对齐', Math.abs((x1[1] + x1[3] / 2) - 400) < 0.001);
  check('clip 矩形宽 = w*slider(200)', c.rect.some((r) => r[2] === 200));
  check('clip 后 restore(裁剪不外泄)', c.save >= 1 && c.restore >= 1 && c.clip >= 1);
  check('分割线画在 slider 位置(200)', c.moveTo.some((m) => m[0] === 200 && m[1] === 0));
  check('手柄圆点在分割线中点', c.arc.some((a) => Math.abs(a[0] - 200) < 0.001 && Math.abs(a[1] - 200) < 0.001));
}

/* 11) 棋盘底纹先画(透明区可见) */
{
  const cv = makeFakeCanvas(800, 400);
  drawCompareCanvas(cv, { imgA: makeImg('a', 10, 10), imgB: makeImg('b', 10, 10), mode: 'side', swap: false, slider: 0.5, zoom: 1, panX: 0, panY: 0, dpr: 1 });
  const c = cv.getContext().calls;
  check('先铺棋盘格底纹再画图', c.fillRect.length >= 1 && c.drawImage.length === 2 && c.fillRect[0][2] === 800);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过 ✅');
process.exit(failed ? 1 : 0);
