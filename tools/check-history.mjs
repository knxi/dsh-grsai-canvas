/**
 * 生成记录(第一期 A)回归:44-history-store 的快照/去重/裁剪/持久化契约,
 * 以及 41-generate 入库钩子(正常路径)的快照完整性。
 *
 * 与 check-canvas-regressions 同一套 vm+stub 手法:加载零件源码,替身 api 记录
 * /generate、/ws-save、/history 的每一次调用。
 *
 * 宿主侧 /history 路由(白名单清洗/原子写)没有独立宿主可起,不在本文件覆盖,
 * 交付文档注明「无真实宿主验收」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const part = (name) => fs.readFileSync(path.join(root, 'lib', 'parts', name), 'utf8');
const parts = new Map();
let seq = 0;
let pending = [];
let createdBodies = [];
let historyGets = 0;
let historyPosts = [];
let saveCalls = [];
let failHistoryPost = false;
let failHistoryGet = false;
let failSave = false;
let historyGetPayload = { records: [] };
const context = vm.createContext({
  console,
  document: {
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => `data:image/png;base64,${'a'.repeat(80)}`,
    }),
  },
  definePart: (name, factory) => parts.set(name, factory()),
  readPendingTasks: () => pending,
  writePendingTasks: (list) => { pending = list; },
  uid: (prefix) => `${prefix}-${++seq}`,
  stamp: () => 'test',
  sleep: async () => {},
  decodeImage: async (data) => {
    const [naturalWidth, naturalHeight] = data.split(':').pop().split('x').map(Number);
    return { naturalWidth, naturalHeight };
  },
  resizeDataUrl: (_el, w, h) => `test:${w}x${h}`,
  proxyImageDataUrl: async (url) => url,
  api: (route, init, session) => apiStub(route, init, session),
  classifyStatus: () => 'done',
  pickImageUrl: (data) => data.url,
});
/** api 替身:记录所有调用,按需注入失败(装载零件后经 context.api 重新钉回)。 */
async function apiStub(route, init, session) {
    if (route === '/history') {
      if (init && init.method === 'POST') {
        if (failHistoryPost) throw new Error('disk full');
        historyPosts.push({ body: JSON.parse(init.body), session });
        return { ok: true, count: JSON.parse(init.body).records.length };
      }
      historyGets += 1;
      if (failHistoryGet) throw new Error('read error');
      return historyGetPayload;
    }
    if (route === '/ws-save') {
      if (failSave) throw new Error('save failed');
      saveCalls.push({ body: JSON.parse(init.body), session });
      return { ok: true, path: JSON.parse(init.body).path };
    }
    if (route === '/generate') {
      const body = JSON.parse(init.body);
      createdBodies.push(body);
      return { id: `task-${createdBodies.length}` };
    }
    const index = Number(/task-(\d+)/.exec(route)[1]) - 1;
    return { status: 'success', url: `test:${['1080x1920', '1024x1024', '1920x1080'][index % 3]}` };
}
for (const name of ['01-constants.js', '02-model-sizes.js', '03-sizes.js', '06-utils.js', '08-geometry.js', '09-marks.js', '41-generate.js', '44-history-store.js']) {
  vm.runInContext(part(name), context, { filename: name });
}
// 零件里的全局函数声明会盖掉 context 上的替身,装载后重新钉回替身(同回归脚本做法)
Object.assign(context, {
  uid: (prefix) => `${prefix}-${++seq}`,
  stamp: () => 'test',
  sleep: async () => {},
  readPendingTasks: () => pending,
  writePendingTasks: (list) => { pending = list; },
  decodeImage: async (data) => {
    const [naturalWidth, naturalHeight] = data.split(':').pop().split('x').map(Number);
    return { naturalWidth, naturalHeight };
  },
  resizeDataUrl: (_el, w, h) => `test:${w}x${h}`,
  proxyImageDataUrl: async (url) => url,
  classifyStatus: () => 'done',
  pickImageUrl: (data) => data.url,
});
context.api = apiStub; // api 是闭包(替身),零件装载后重新钉回

/** 复位替身状态(每个用例之间)。 */
function reset() {
  seq = 0; pending = []; createdBodies = []; historyGets = 0; historyPosts = []; saveCalls = [];
  failHistoryPost = false; failHistoryGet = false; failSave = false;
  historyGetPayload = { records: [] };
}
reset();

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}
function freshStore(session = 's1') {
  const errors = [];
  const sessionRef = { current: session };
  const store = parts.get('history-store').createHistoryStore({
    sessionRef,
    onError: (message) => errors.push(message),
  });
  return { store, sessionRef, errors };
}

// ── 快照与清洗 ─────────────────────────────────────────────────────────────

await test('normalizeRecord keeps only whitelisted fields and marks missing ones as missing', () => {
  const { store } = freshStore();
  // 旧记录:只有 4 个字段,其余一律不给默认值(缺就是缺,渲染层显示「—」)
  const old = store.normalizeRecord({ id: 'rec-old', taskId: 'task-9', model: 'old-model', fav: true });
  assert.equal(old.id, 'rec-old');
  assert.equal(old.taskId, 'task-9');
  assert.equal(old.model, 'old-model');
  assert.equal(old.fav, true);
  assert.equal('promptUser' in old, false);
  assert.equal('promptFinal' in old, false);
  assert.equal('file' in old, false);
  assert.equal('w' in old, false);
  assert.equal('ratio' in old, false);
  // 垃圾输入:非对象 / 没有稳定 ID → 丢弃
  assert.equal(store.normalizeRecord(null), null);
  assert.equal(store.normalizeRecord('x'), null);
  assert.equal(store.normalizeRecord({ taskId: 'task-1' }), null);
  assert.equal(store.normalizeRecord({ id: '   ' }), null);
  // 类型清洗:fav 只有 === true 才算;数字字段必须是有限数;refNames 滤掉非字符串
  const washed = store.normalizeRecord({ id: 'r2', fav: 'yes', w: '800', h: NaN, refNames: ['a.png', 42, '  '], promptUser: 12345 });
  assert.equal(washed.fav, undefined);
  assert.equal(washed.w, 800);
  assert.equal('h' in washed, false);
  assert.deepEqual(washed.refNames, ['a.png']);
  assert.equal('promptUser' in washed, false);
});

await test('normalizeList dedupes by taskId, sorts newest first and counts dropped', () => {
  const { store } = freshStore();
  const list = store.normalizeList([
    { id: 'a', taskId: 't1', at: 300 },
    { id: 'b', taskId: 't1', at: 100 }, // 同任务旧记录 → 丢
    { id: 'c', at: 200 },
    { id: 'c', at: 50 }, // 同 id → 丢
    'garbage',
    { id: 'd' },
  ]);
  assert.deepEqual(Array.from(list.records.map((item) => item.id)), ['a', 'c', 'd']);
  assert.equal(list.dropped, 3);
  // 非数组输入安全
  const empty = store.normalizeList(undefined);
  assert.deepEqual(Array.from(empty.records), []);
  assert.equal(empty.dropped, 0);
});

await test('buildRecord assigns a stable id and keeps snapshot fields verbatim', () => {
  const { store } = freshStore();
  const record = store.buildRecord({ taskId: 'task-2', model: 'm', promptUser: 'hello', promptFinal: 'hello final', w: 1080, h: 1920 });
  assert.ok(record.id.startsWith('rec-'));
  assert.equal(typeof record.at, 'number');
  assert.equal(record.taskId, 'task-2');
  assert.equal(record.promptUser, 'hello');
  assert.equal(record.promptFinal, 'hello final');
  // 续查快照只有 promptFinal:promptUser 保持缺失(不回填,恢复时才走"仅最终提示词")
  const recovered = store.buildRecord({ taskId: 'task-3', promptFinal: 'final only' });
  assert.equal('promptUser' in recovered, false);
});

await test('trimRecords keeps all favourites under the cap and drops oldest non-fav first', () => {
  const { store } = freshStore();
  const make = (n, at, fav) => ({ id: `r${n}`, at, fav: !!fav });
  // 402 条:400 非 fav(新→旧,at 399..0)+ 2 fav 在尾部
  const list = [];
  for (let i = 0; i < 400; i += 1) list.push(make(i, 399 - i));
  list.push(make(400, 1000, true), make(401, 1001, true));
  const out = store.trimRecords(list);
  assert.equal(out.records.length, store.MAX_RECORDS);
  assert.equal(out.trimmed, 2);
  assert.equal(out.touchedFav, 0);
  assert.ok(out.records.every((item) => item.fav || item.at >= 2)); // 保住的是最新非 fav + 全部 fav
  // 收藏本身超限:从最旧开始丢,并报出 touchedFav(不静默)
  const allFav = [];
  for (let i = 0; i < 403; i += 1) allFav.push(make(i, i, true));
  const out2 = store.trimRecords(allFav);
  assert.equal(out2.records.length, 400);
  assert.equal(out2.trimmed, 3);
  assert.equal(out2.touchedFav, 3);
  // 未超限:原样返回
  const small = store.trimRecords([make(0, 1)]);
  assert.equal(small.records.length, 1);
  assert.equal(small.trimmed, 0);
  assert.equal(small.touchedFav, 0);
});

// ── 资源与清单持久化 ───────────────────────────────────────────────────────

await test('saveResource writes the result image under an internal id path', async () => {
  const { store } = freshStore();
  const path2 = await store.saveResource({ id: 'rec-7' }, 'data:image/png;base64,AAA', 's1');
  assert.equal(saveCalls.length, 1);
  assert.equal(saveCalls[0].body.path, '画布/results/rec-7.png');
  assert.equal(saveCalls[0].session, 's1');
  assert.equal(path2, '画布/results/rec-7.png');
  failSave = true;
  await assert.rejects(store.saveResource({ id: 'rec-8' }, 'data:image/png;base64,AAA', 's1'), /save failed/);
});

await test('persister push posts the full list once per change, serially', async () => {
  reset();
  const { store, sessionRef } = freshStore();
  let records = [{ id: 'r1', at: 1 }];
  const persister = store.makePersister({ sessionRef, getRecords: () => records, onError: () => {} });
  await persister.push('入库');
  records = [{ id: 'r1', at: 1 }, { id: 'r2', at: 2 }];
  await persister.push('收藏');
  assert.equal(historyPosts.length, 2);
  assert.equal(historyPosts[0].body.records.length, 1);
  assert.equal(historyPosts[1].body.records.length, 2);
  assert.equal(historyPosts[1].session, 's1');
  // 连发三次也排队串行、不并发交叠
  records = records.concat([{ id: 'r3', at: 3 }]);
  await Promise.all([persister.push('a'), persister.push('b'), persister.push('c')]);
  assert.equal(historyPosts.length, 5);
  assert.equal(historyPosts[4].body.records.length, 3);
});

await test('persister failure reports once and never retries or regenerates', async () => {
  reset();
  const { store } = freshStore();
  const errors = [];
  const persister = store.makePersister({ sessionRef: { current: 's1' }, getRecords: () => [{ id: 'r1' }], onError: (m) => errors.push(m) });
  failHistoryPost = true;
  await persister.push('入库');
  assert.equal(historyPosts.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /生成记录没有保存到工作区/);
  assert.match(errors[0], /disk full/);
  // 失败后不自动重试:不推新动作就不会再发 POST;/generate 一次都没被打过
  assert.equal(createdBodies.length, 0);
  assert.equal(historyPosts.length, 0);
});

await test('persister refuses to overwrite a corrupted manifest without confirmation', async () => {
  reset();
  const { store } = freshStore();
  const errors = [];
  let allowed = false;
  const persister = store.makePersister({
    sessionRef: { current: 's1' },
    getRecords: () => [{ id: 'r1' }],
    onError: (m) => errors.push(m),
    shouldOverride: () => allowed,
  });
  await persister.push('入库');
  assert.equal(historyPosts.length, 0);
  assert.match(errors[0], /清单已损坏且未确认覆盖/);
  allowed = true;
  await persister.push('入库(已确认)');
  assert.equal(historyPosts.length, 1);
});

await test('persister load normalizes, forwards corruption and drops stale sessions', async () => {
  reset();
  const { store, sessionRef } = freshStore();
  const persister = store.makePersister({ sessionRef, getRecords: () => [], onError: () => {} });
  historyGetPayload = { records: [{ id: 'a', at: 2 }, { id: 'b', taskId: 'x', at: 1 }, { id: 'b', taskId: 'x', at: 9 }] };
  const ok = await persister.load('s1');
  assert.equal(historyGets, 1);
  assert.deepEqual(Array.from(ok.records.map((item) => item.id)), ['a', 'b']);
  assert.equal(ok.corrupted, false);
  assert.equal(ok.stale, false);
  historyGetPayload = { records: [], corrupted: true };
  const bad = await persister.load('s1');
  assert.equal(bad.corrupted, true);
  // 读完之前工作区切走了:整包丢弃,不污染新工作区
  const stalePromise = persister.load('s1');
  historyGetPayload = { records: [{ id: 'zzz' }] };
  sessionRef.current = 's2';
  const stale = await stalePromise;
  assert.equal(stale.stale, true);
  assert.equal(Array.from(stale.records).length, 0);
  // GET 失败且会话没变:抛给调用方(由 UI 提示"本次会话新记录不会持久化")
  failHistoryGet = true;
  sessionRef.current = 's1';
  await assert.rejects(persister.load('s1'), /read error/);
});

// ── 生成入库集成 ───────────────────────────────────────────────────────────

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function genFixture(overrides = {}) {
  const p = {
    activeSkill: null, aliveRef: { current: true }, apikey: 'offline-test', apiBase: 'https://example.invalid',
    appendHint: false, background: 'auto', batchSizes: [], busy: false,
    camRef: { current: { x: 0, y: 0, zoom: 1 } }, cancelRef: { current: false },
    cropToMark: false, customSize: '', docRef: { current: { images: [], marks: [], frames: [] } },
    finishChange() {}, imageSize: '1K', imgCacheRef: { current: new Map() },
    pendingRef: { current: [] }, expandFrameRef: { current: null }, jobsRef: { current: [] }, placeLockRef: { current: Promise.resolve() }, scheduleDraw() {},
    model: 'gpt-image-2', prompt: 'offline test prompt', quality: 'auto', ratio: 'source',
    selected: null, selectedFrameId: null, sessionRef: { current: 's1' },
    sizeRef: { current: { w: 1000, h: 800 } }, submitTexts: false,
    selectedIds: [], layerSize: '', savePath: '', dpi: 300,
    setError: () => {},
  };
  for (const name of ['setBusy', 'setLastUpstream', 'setNotice', 'setPhase', 'setProgress', 'setRatio',
    'setResults', 'setSelectedId', 'setSelectedIds', 'setShowSettings', 'setShowWs',
    'setTextDraft', 'setWsBusy', 'setWsFiles']) p[name] = () => {};
  Object.assign(p, overrides);
  return p;
}

await test('generate success calls onRecord with a complete whitelist snapshot', async () => {
  reset();
  const snaps = [];
  const p = genFixture({ onRecord: (snap) => { snaps.push(snap); } });
  const generator = parts.get('generate').createGenerate(p);
  generator.run(); // 0.23.0 起 run() 只入队,真正的提交在队列里异步跑
  await flush();
  assert.equal(createdBodies.length, 1);
  assert.equal(snaps.length, 1);
  const snap = snaps[0];
  assert.equal(snap.taskId, 'task-1');
  assert.equal(snap.promptUser, 'offline test prompt');
  assert.ok(snap.promptFinal && snap.promptFinal.includes('offline test prompt'));
  assert.equal(snap.model, 'gpt-image-2');
  assert.equal(snap.w, 1080);
  assert.equal(snap.h, 1920);
  assert.equal(snap.refCount, 0);
  assert.equal(snap.frame, false);
  assert.equal(typeof snap.at === 'undefined', true); // at 由 buildRecord 打,快照不带
  assert.equal('apikey' in snap, false);
  // 端到端:快照 → 记录 → 落资源 → 写清单
  const { store } = freshStore();
  const record = store.buildRecord(snap);
  record.file = await store.saveResource(record, snap.dataUrl, 's1');
  assert.equal(record.file, `画布/results/${record.id}.png`);
  const persister = store.makePersister({ sessionRef: { current: 's1' }, getRecords: () => [record], onError: () => {} });
  await persister.push('入库');
  assert.equal(historyPosts.length, 1);
  assert.equal(historyPosts[0].body.records[0].file, record.file);
});

await test('record persistence never triggers /generate (restore path costs nothing)', async () => {
  reset();
  const { store } = freshStore();
  const persister = store.makePersister({ sessionRef: { current: 's1' }, getRecords: () => [{ id: 'r1' }], onError: () => {} });
  await persister.load('s1');
  await persister.push('收藏');
  await persister.push('删除记录');
  await persister.push('清空记录');
  // 全程只有 /history 读 + 3 次写:恢复参数/收藏/删除/清空都不该花一分钱
  assert.equal(historyGets, 1);
  assert.equal(historyPosts.length, 3);
  assert.equal(createdBodies.length, 0);
});

console.log(`\n${passed} history checks passed.`);
