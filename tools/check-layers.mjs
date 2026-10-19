// 图层管理(第一期 C)离线回归:动作逻辑(删除/开关/改名/排序/清空)+ 面板渲染结构。
// 用法:node tools/check-layers.mjs(无第三方依赖,vm 装载零件源码)。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const part = (name) => fs.readFileSync(path.join(root, 'lib', 'parts', name), 'utf8');
const parts = new Map();
let seq = 0;

const context = vm.createContext({
  console,
  window: { confirm: () => confirmed },
  document: {
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => `data:image/png;base64,${'a'.repeat(80)}`,
    }),
  },
  definePart: (name, factory) => parts.set(name, factory()),
  uid: () => `image-${++seq}`,
  stamp: () => 'test',
  drawImageTexts: () => 'data:image/png;base64,x',
  decodeImage: async (data) => {
    const [naturalWidth, naturalHeight] = data.split(':').pop().split('x').map(Number);
    return { naturalWidth, naturalHeight };
  },
  parseExportSize: () => null,
  isFontAvailable: () => true,
  TEXT_DEFAULTS: {},
  clipboardPngBlob: async () => true,
  proxyImageDataUrl: async (url) => url,
  fetchAsDataUrl: async () => 'data:image/png;base64,x',
  routeUrl: (url) => url,
  api: async () => ({}),
});
for (const name of ['01-constants.js', '02-model-sizes.js', '03-sizes.js', '06-utils.js', '08-geometry.js', '09-marks.js', '42-images.js', '38-layers-panel.js']) {
  vm.runInContext(part(name), context, { filename: name });
}

let confirmed = true;
let changes = 0;
const notices = [];
const errors = [];

function fixture(images, overrides = {}) {
  notices.length = 0;
  errors.length = 0;
  changes = 0;
  const doc = { images: images.map((im) => ({ ...im })), marks: [], frames: [] };
  const p = {
    addImageFromDataUrl: () => {},
    camRef: { current: { x: 0, y: 0, zoom: 1 } },
    docRef: { current: doc },
    dpi: 300,
    finishChange: () => { changes += 1; },
    imgCacheRef: { current: new Map() },
    layerSize: '',
    savePath: '',
    selected: doc.images[1] || null,
    selectedIds: [],
    sessionRef: { current: 's' },
    setDockOpen: () => {},
    setError: (message) => { if (message) errors.push(message); },
    setNotice: (message) => { if (message) notices.push(message); },
    setSelectedId: () => {},
    setSelectedIds: () => {},
    setWsBusy: () => {},
    setWsFiles: () => {},
    wsFiles: [],
    ...overrides,
  };
  // 注意:deleteSelected/moveImageTo/clearCanvas 会整体替换 docRef.current,
  // 所以断言一律走 ref.current,不要持有旧 doc。
  return { p, ref: p.docRef, actions: parts.get('images').createImages(p) };
}

function mk(id, name, extra = {}) {
  return { id, name, x: 0, y: 0, w: 100, h: 80, naturalW: 100, naturalH: 80, isRef: false, dataUrl: 'data:image/png;base64,aaa', ...extra };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// ── 普通删除与锁定 ──────────────────────────────────────────────
test('delete skips locked images and says so', () => {
  const { ref, actions, p } = fixture([mk('a', 'A.png'), mk('b', 'B.png', { locked: true })], { selectedIds: ['a', 'b'], selected: null });
  const removed = [];
  p.setSelectedId = (v) => removed.push(['id', v]);
  actions.deleteSelected();
  assert.deepEqual(ref.current.images.map((im) => im.id), ['b'], '锁定图必须留下');
  assert.match(notices[0], /跳过/);
});
test('delete reports and keeps everything when every picked image is locked', () => {
  const { ref, actions } = fixture([mk('b', 'B.png', { locked: true })], { selectedIds: ['b'], selected: null });
  actions.deleteSelected();
  assert.equal(ref.current.images.length, 1);
  assert.match(notices[0], /锁着/);
});
test('delete works after unlock and removes matching marks', () => {
  const { ref, actions } = fixture(
    [mk('b', 'B.png', { locked: true }), mk('a', 'A.png', { locked: false })],
    { selectedIds: ['a'], selected: null },
  );
  ref.current.marks = [{ id: 'm1', targetId: 'a' }];
  ref.current.images[1].locked = false;
  actions.deleteSelected();
  assert.deepEqual(ref.current.images.map((im) => im.id), ['b']);
  assert.deepEqual(ref.current.marks, []);
});

// ── 显式开关 setImageFlag ───────────────────────────────────────
test('setImageFlag toggles hidden/locked/isRef and notices', () => {
  const { ref, actions } = fixture([mk('a', 'A.png')], { selectedIds: [], selected: null });
  actions.setImageFlag('a', 'hidden', true);
  assert.equal(ref.current.images[0].hidden, true);
  assert.match(notices[0], /已隐藏/);
  actions.setImageFlag('a', 'locked', true);
  assert.equal(ref.current.images[0].locked, true);
  actions.setImageFlag('a', 'isRef', true);
  assert.equal(ref.current.images[0].isRef, true);
  assert.match(notices[2], /参考图/);
});
test('setImageFlag on a locked image still allows hiding (explicit panel action)', () => {
  const { ref, actions } = fixture([mk('a', 'A.png', { locked: true })], { selectedIds: [], selected: null });
  actions.setImageFlag('a', 'hidden', true);
  assert.equal(ref.current.images[0].hidden, true, '锁定挡的是改内容和位置,不是面板开关');
});
test('setImageFlag is a no-op when the value does not change', () => {
  const { ref, actions } = fixture([mk('a', 'A.png', { hidden: true })], { selectedIds: [], selected: null });
  actions.setImageFlag('a', 'hidden', true);
  assert.equal(changes, 0, '同值重复设置不产生撤销步骤');
  assert.equal(ref.current.images[0].hidden, true);
});

// ── 重命名 ─────────────────────────────────────────────────────
test('rename rejects locked images', () => {
  const { ref, actions } = fixture([mk('a', 'A.png', { locked: true })], { selectedIds: [], selected: null });
  actions.renameImage('a', '新名字');
  assert.equal(ref.current.images[0].name, 'A.png');
  assert.match(notices[0], /解锁/);
});
test('rename ignores empty and unchanged names', () => {
  const { ref, actions } = fixture([mk('a', 'A.png')], { selectedIds: [], selected: null });
  actions.renameImage('a', '   ');
  actions.renameImage('a', 'A.png');
  actions.renameImage('missing', 'X');
  assert.equal(changes, 0);
  assert.equal(ref.current.images[0].name, 'A.png');
});
test('rename trims and applies', () => {
  const { ref, actions } = fixture([mk('a', 'A.png')], { selectedIds: [], selected: null });
  actions.renameImage('a', '  主图  ');
  assert.equal(ref.current.images[0].name, '主图');
});

// ── 面板拖动排序 moveImageTo ────────────────────────────────────
test('moveImageTo inserts before the target image', () => {
  const { ref, actions } = fixture([mk('a'), mk('b'), mk('c')], { selectedIds: [], selected: null });
  actions.moveImageTo('c', 'b'); // c 插到 b 前:数组 [a, c, b],c 从顶层变中层
  assert.deepEqual(ref.current.images.map((im) => im.id), ['a', 'c', 'b']);
});
test('moveImageTo(null) moves to the top layer', () => {
  const { ref, actions } = fixture([mk('a'), mk('b'), mk('c')], { selectedIds: [], selected: null });
  actions.moveImageTo('a', null);
  assert.deepEqual(ref.current.images.map((im) => im.id), ['b', 'c', 'a']);
});
test('moveImageTo refuses locked images and dropping onto itself', () => {
  const { ref, actions } = fixture([mk('a', 'A.png', { locked: true }), mk('b')], { selectedIds: [], selected: null });
  actions.moveImageTo('a', 'b');
  assert.deepEqual(ref.current.images.map((im) => im.id), ['a', 'b']);
  assert.match(notices[0], /解锁/);
  actions.moveImageTo('b', 'b');
  assert.equal(changes, 0, '拖到自己身上 = 没动');
});

// ── 清空画布确认 ────────────────────────────────────────────────
test('clearCanvas wipes everything only after confirm', () => {
  const doc = { images: [mk('a', 'A.png', { hidden: true }), mk('b', 'B.png', { locked: true })], marks: [{ id: 'm' }], frames: [{ id: 'f' }] };
  const cache = { current: new Map([['a', {}]]) };
  // imgCacheRef 必须进 overrides:createImages 只在调用时解构一次,事后换 p.imgCacheRef 闭包拿不到
  const { ref, actions, p } = fixture(doc.images, { imgCacheRef: cache });
  p.docRef.current = doc;
  confirmed = false;
  actions.clearCanvas();
  assert.equal(ref.current.images.length, 2, '用户取消就不清');
  confirmed = true;
  actions.clearCanvas();
  // vm realm 的普通对象不能用 deepStrictEqual(跨 realm 原型不等),按字段断言
  assert.equal(ref.current.images.length, 0);
  assert.equal(ref.current.marks.length, 0);
  assert.equal(ref.current.frames.length, 0);
  assert.equal(cache.current.size, 0);
  assert.match(notices.at(-1), /Ctrl\+Z/);
});

// ── 图层面板渲染(fake h)────────────────────────────────────────
vm.runInContext('var h = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }); var S = { row: {}, col: {}, hint: {}, grow: {}, input: {}, badge: {}, tiny: {} }; var line = "#ccc";', context, { filename: 'test-globals.js' });

function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
}

test('layers panel renders an empty-state hint', () => {
  const panel = parts.get('layers-panel').renderLayersPanel({
    images: [], selectedId: null, selectedIds: [], deleteSelected: () => {}, moveImageTo: () => {},
    renameImage: () => {}, selectImageFromPanel: () => {}, setImageFlag: () => {},
    setLayerRenameId: () => {}, setLayerRenameText: () => {}, layerRenameId: '', layerRenameText: '',
  });
  const text = walk(panel).map((n) => (typeof n.children?.[0] === 'string' ? n.children.join('') : '')).join('');
  assert.match(text, /还没有图片/);
});
test('layers panel lists images bottom-up with per-row switches', () => {
  const calls = { select: [], flag: [], del: [] };
  const panel = parts.get('layers-panel').renderLayersPanel({
    images: [mk('low', '底层.png', { isRef: true }), mk('top', '顶层.png', { hidden: true, locked: true })],
    selectedId: 'top', selectedIds: ['top'],
    deleteSelected: () => calls.del.push(1),
    moveImageTo: () => {},
    renameImage: () => {},
    selectImageFromPanel: (id, event) => calls.select.push([id, Boolean(event && event.shiftKey)]),
    setImageFlag: (id, key, value) => calls.flag.push([id, key, value]),
    setLayerRenameId: () => {}, setLayerRenameText: () => {}, layerRenameId: '', layerRenameText: '',
  });
  const nodes = walk(panel);
  const names = nodes.map((n) => (typeof n.children?.[0] === 'string' ? n.children.join('') : '')).filter((t) => t.includes('.png'));
  assert.ok(names[0].includes('底层.png') && names[1].includes('顶层.png'), '面板顺序 = doc.images 数组顺序(首行最底层)');
  const rows = nodes.filter((n) => n.tag === 'div' && n.props && n.props.draggable !== undefined);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].props.draggable, true, '未锁定的行可拖动');
  assert.equal(rows[1].props.draggable, false, '锁定的行不可拖动');
  assert.match(rows[1].props.title, /已锁定/);
  const buttons = nodes.filter((n) => n.tag === 'button');
  const labels = buttons.map((b) => b.children.join(''));
  assert.ok(labels.includes('参') && labels.includes('隐') && labels.includes('已锁') && labels.includes('删'));
  // 顶层的「隐」按钮(当前 hidden=true,按钮显示「显」)点击 → setImageFlag('top','hidden',false)
  const showBtn = buttons.find((b) => b.children.join('') === '显');
  showBtn.props.onClick();
  assert.deepEqual(calls.flag, [['top', 'hidden', false]]);
  // 行点击 → 面板选择
  rows[0].props.onClick({ shiftKey: true });
  assert.deepEqual(calls.select, [['low', true]]);
});

console.log(`\n${passed} layer checks passed.`);

