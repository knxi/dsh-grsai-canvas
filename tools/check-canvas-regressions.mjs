import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const part = (name) => fs.readFileSync(path.join(root, 'lib', 'parts', name), 'utf8');
const parts = new Map();
let pending = [];
let seq = 0;
let createdBodies = [];
let failResult = false;
let onCreate = null;
const context = vm.createContext({
  console,
  // 清空画布的二次确认在离线环境里一律「确定」(真浏览器里才是 window.confirm)
  window: { confirm: () => true },
  document: {
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => `data:image/png;base64,${'a'.repeat(80)}`,
    }),
  },
  definePart: (name, factory) => parts.set(name, factory()),
  readPendingTasks: () => pending,
  writePendingTasks: (list) => { pending = list; },
  uid: () => `image-${++seq}`,
  stamp: () => 'test',
  sleep: async () => {},
  decodeImage: async (data) => {
    const [naturalWidth, naturalHeight] = data.split(':').pop().split('x').map(Number);
    return { naturalWidth, naturalHeight };
  },
  resizeDataUrl: (_el, w, h) => `test:${w}x${h}`,
  proxyImageDataUrl: async (url) => url,
  api: async (route, init) => {
    if (route === '/generate') {
      const body = JSON.parse(init.body);
      createdBodies.push(body);
      if (onCreate) onCreate();
      return { id: `task-${createdBodies.length}` };
    }
    if (failResult) throw new Error('temporary network error');
    const index = Number(/task-(\d+)/.exec(route)[1]) - 1;
    return { status: 'success', url: `test:${['1080x1920', '1024x1024', '1920x1080'][index % 3]}` };
  },
  classifyStatus: () => 'done',
  pickImageUrl: (data) => data.url,
});
const stubs = { ...context };
for (const name of ['01-constants.js', '02-model-sizes.js', '03-sizes.js', '06-utils.js', '08-geometry.js', '09-marks.js', '41-generate.js', '42-images.js']) {
  vm.runInContext(part(name), context, { filename: name });
}
Object.assign(context, stubs);
vm.runInContext('function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }', context);
context.resizeDataUrl = (_el, w, h) => `test:${w}x${h}`;

function fixture(overrides = {}) {
  const errors = [];
  const p = {
    activeSkill: null, aliveRef: { current: true }, apikey: 'offline-test', apiBase: 'https://example.invalid',
    appendHint: false, background: 'auto', batchSizes: [], busy: false,
    camRef: { current: { x: 0, y: 0, zoom: 1 } }, cancelRef: { current: false },
    cropToMark: false, customSize: '', docRef: { current: { images: [], marks: [], frames: [] } },
    finishChange() {}, imageSize: '1K', imgCacheRef: { current: new Map() },
    model: 'gpt-image-2', prompt: 'offline test prompt', quality: 'auto', ratio: 'source',
    selected: null, selectedFrameId: null, sessionRef: { current: 'test-session' },
    sizeRef: { current: { w: 1000, h: 800 } }, submitTexts: false,
    // 生成中的占位框(画布上那块「生成中」的框):离线测试照样能看见它进出
    pendingRef: { current: [] }, expandFrameRef: { current: null }, scheduleDraw() {},
    // 任务表 + 落图锁:并发/排队/按框打断那一套靠它们(和 12-canvas-tab.js 里同构)
    jobsRef: { current: [] }, placeLockRef: { current: Promise.resolve() },
    selectedIds: [], layerSize: '', savePath: '', dpi: 300,
    setError: (message) => { if (message) errors.push(message); },
  };
  for (const name of ['setBusy', 'setLastUpstream', 'setNotice', 'setPhase', 'setProgress', 'setRatio',
    'setResults', 'setSelectedId', 'setSelectedIds', 'setShowSettings', 'setShowWs',
    'setTextDraft', 'setWsBusy', 'setWsFiles']) p[name] = () => {};
  Object.assign(p, overrides);
  pending = [];
  createdBodies = [];
  failResult = false;
  onCreate = null;
  return { p, errors, generate: parts.get('generate').createGenerate(p) };
}

let passed = 0;
/**
 * run() 现在是"入队即返回"(按钮立刻能再点) —— 真正的提交/轮询/落图都在后面几步微任务里,
 * 所以测完 run 之后要放几轮微任务,才能看到结果与清理。
 */
async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

await test('mixed aspect batch results use actual preceding heights', async () => {
  const f = fixture({ batchSizes: ['1080x1920', '1024x1024', '1920x1080'] });
  const target = { id: 'source', name: 'source', x: 10, y: 20, w: 500, h: 300, dataUrl: 'test:500x300', naturalW: 500, naturalH: 300, isRef: true };
  f.p.selected = target;
  f.p.docRef.current.images = [target];
  f.p.imgCacheRef.current.set(target.id, { complete: true, naturalWidth: 500, naturalHeight: 300 });
  const generator = parts.get('generate').createGenerate(f.p);
  await generator.run();
  await flush();
  assert.deepEqual(f.errors, []);
  const results = f.p.docRef.current.images.slice(1);
  assert.equal(results.length, 3);
  for (let i = 1; i < results.length; i += 1) {
    assert.equal(results[i].x, results[0].x);
    assert.equal(results[i].y, results[i - 1].y + results[i - 1].h + 60);
  }
});

await test('stopped recovery polling leaves the pending task untouched', async () => {
  const f = fixture();
  await assert.rejects(f.generate.pollTask('task-1', 'offline', { isActive: () => false }), /续查已停止/);
  assert.equal(createdBodies.length, 0);
});

await test('empty canvas batch keeps a stable column', async () => {
  const f = fixture({ batchSizes: ['1080x1920', '1024x1024', '1920x1080'] });
  await f.generate.run();
  await flush();
  assert.deepEqual(f.errors, []);
  const results = f.p.docRef.current.images;
  for (let i = 1; i < results.length; i += 1) {
    assert.equal(results[i].x, results[0].x);
    assert.equal(results[i].y, results[i - 1].y + results[i - 1].h + 60);
  }
});

await test('selected older frame wins over the latest frame and old output size', async () => {
  const frames = [{ id: 'old', x: 10, y: 20, w: 300, h: 400 }, { id: 'new', x: 600, y: 0, w: 800, h: 200 }];
  const f = fixture({ selectedFrameId: 'old', customSize: '1024x1024', docRef: { current: { images: [], marks: [], frames } } });
  onCreate = () => { frames[0].x = 999; frames[0].w = 999; };
  await f.generate.run();
  await flush();
  assert.deepEqual(f.errors, []);
  const made = f.p.docRef.current.images[0];
  assert.equal(made.x, 10);
  assert.equal(made.w, 300);
  assert.equal(made.h, 400);
  assert.equal(createdBodies[0].aspectRatio, vm.runInContext("nearestSize('gpt-image-2', 0.75)", context));
  assert.equal(f.p.docRef.current.frames[0].id, 'new');
});

/**
 * 扩图那条路的护栏:点「▶ 生成扩图」时要等下一次渲染才真的 run(),中间用户点一下画布空白
 * 就会把 selectedFrameId 清掉 —— 那时若只靠 selectedFrameId + frames[last] 兜底,就会挑到
 * 别的框(或者挑不到、把结果甩到主图右侧,看着像"另起一行")。钉在 ref 上的框必须优先。
 */
await test('the pinned expand frame wins even after the selection is cleared', async () => {
  const frames = [
    { id: 'expand-1', x: 40, y: 60, w: 600, h: 600, expand: true, sourceId: 'source' },
    { id: 'stray', x: 900, y: 0, w: 200, h: 200 },
  ];
  const f = fixture({
    selectedFrameId: null,
    customSize: '1024x1024',
    expandFrameRef: { current: 'expand-1' },
    docRef: { current: { images: [], marks: [], frames } },
  });
  await f.generate.run();
  await flush();
  assert.deepEqual(f.errors, []);
  const made = f.p.docRef.current.images[0];
  assert.equal(made.x, 40);
  assert.equal(made.y, 60);
  assert.equal(made.w, 600);
  assert.equal(made.h, 600);
  // 扩图落图后画布上的框全部收掉:结果图已经把这片区域占住,旧框(哪怕不是这次提交的那个)
  // 留在原地会和结果重叠、还挡点击 —— 这是用户明确反馈过的「原先的生成框还戳在原地」。
  assert.equal(f.p.docRef.current.frames.length, 0);
});

await test('pending tasks preserve output size and placement for recovery', async () => {
  const f = fixture({ customSize: '1080x1440' });
  failResult = true;
  await f.generate.run();
  await flush();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].exactSize, '1080x1440');
  assert.ok(f.errors.length);
  const made = await f.generate.placeResultImage('test:512x512', null, pending[0].frame, pending[0]);
  assert.equal(made.naturalW, 1080);
  assert.equal(made.naturalH, 1440);
});

await test('cropping preview uses the same geometry as the submission', () => {
  const out = vm.runInContext(`submissionRegion(1000, 800, [{kind:'rect',rect:{x0:0.2,y0:0.2,x1:0.6,y1:0.4}}], true)`, context);
  assert.equal(out.width, 440);
  assert.equal(out.height, 192);
  assert.equal(out.sx, 180);
  assert.equal(out.sy, 144);
  assert.equal(out.cropped, true);
});

await test('mask overrides cropping and crop never exceeds a small source', () => {
  const masked = vm.runInContext(`submissionRegion(1000, 800, [{kind:'mask',points:[[0.5,0.5]],width:0.1}], true)`, context);
  assert.equal(masked.cropped, false);
  assert.equal(masked.width, 1000);
  const tiny = vm.runInContext(`submissionRegion(8, 8, [{kind:'rect',rect:{x0:0.95,y0:0.95,x1:1,y1:1}}], true)`, context);
  assert.ok(tiny.sx + tiny.width <= 8 && tiny.sy + tiny.height <= 8);
});

await test('clear canvas removes frames even without images', () => {
  const f = fixture({ docRef: { current: { images: [], marks: [], frames: [{ id: 'only-frame' }] } } });
  parts.get('images').createImages(f.p).clearCanvas();
  assert.equal(f.p.docRef.current.frames.length, 0);
});

await test('a placeholder box appears while generating and disappears afterwards', async () => {
  const f = fixture();
  const target = { id: 'source', name: 'source', x: 10, y: 20, w: 500, h: 300, dataUrl: 'test:500x300', naturalW: 500, naturalH: 300, isRef: true };
  f.p.selected = target;
  f.p.docRef.current.images = [target];
  f.p.imgCacheRef.current.set(target.id, { complete: true, naturalWidth: 500, naturalHeight: 300 });
  let seen = null;
  onCreate = () => { seen = f.p.pendingRef.current.slice(); };
  // 和既有用例一样:selected 是 createGenerate 时解构走的,得先设好再建实例
  const generator = parts.get('generate').createGenerate(f.p);
  await generator.run();
  await flush();
  assert.deepEqual(f.errors, []);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].x, target.x + target.w + 60);
  assert.equal(seen[0].y, target.y);
  assert.equal(seen[0].w, target.w);
  assert.ok(seen[0].h > 0 && Number.isFinite(seen[0].h));
  assert.equal(f.p.pendingRef.current.length, 0);
});

await test('placeholder box matches the selected frame, and a failed run clears it', async () => {
  const frames = [{ id: 'f1', x: 100, y: 200, w: 640, h: 480 }];
  const f = fixture({ selectedFrameId: 'f1', docRef: { current: { images: [], marks: [], frames } } });
  let seen = null;
  onCreate = () => { seen = f.p.pendingRef.current.slice(); };
  failResult = true;
  await f.generate.run();
  await flush();
  assert.ok(f.errors.length);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].x, 100);
  assert.equal(seen[0].y, 200);
  assert.equal(seen[0].w, 640);
  assert.equal(seen[0].h, 480);
  assert.equal(f.p.pendingRef.current.length, 0);
});

await test('batch placeholders carry the queue label and never stack up', async () => {
  const f = fixture({ batchSizes: ['1080x1920', '1024x1024'] });
  const seen = [];
  onCreate = () => { seen.push(f.p.pendingRef.current.map((item) => item.label)); };
  await f.generate.run();
  await flush();
  assert.deepEqual(f.errors, []);
  assert.equal(seen.length, 2);
  // 并发上去了:两张的框**同时**挂在画布上(不是一张一张轮着来),各带自己的队列号
  for (const labels of seen) {
    assert.equal(labels.length, 2);
    assert.match(labels[0], /^1\/2 · /);
    assert.match(labels[1], /^2\/2 · /);
  }
  assert.equal(f.p.pendingRef.current.length, 0);
});

await test('two quick submissions both queue up instead of swallowing the second', async () => {
  const f = fixture({ customSize: '1024x1024' });
  // 连点两次:原来的 `if (busy) return` 会把第二次静默吃掉,现在第二张必须真的进队列
  f.generate.run();
  f.generate.run();
  await flush();
  assert.deepEqual(f.errors, []);
  assert.equal(createdBodies.length, 2);
  assert.equal(f.p.docRef.current.images.length, 2);
  assert.equal(f.p.jobsRef.current.length, 0);
  assert.equal(f.p.pendingRef.current.length, 0);
});

await test('a third job waits in the queue while two are on the wire', async () => {
  const f = fixture({ batchSizes: ['1080x1920', '1024x1024', '1920x1080'] });
  f.generate.run();
  // 并发上限是 2:run() 返回时前两张已经发出去,第三张还乖乖排队(不能一次全提交)
  assert.equal(createdBodies.length, 2);
  const waiting = f.p.jobsRef.current.filter((job) => job.state === 'queued');
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].pct, 0);
  await flush();
  assert.deepEqual(f.errors, []);
  assert.equal(createdBodies.length, 3);
  assert.equal(f.p.docRef.current.images.length, 3);
  assert.equal(f.p.jobsRef.current.length, 0);
});

await test('cancelling one job clears only its own placeholder box', async () => {
  const f = fixture({ batchSizes: ['1080x1920', '1024x1024'] });
  f.generate.run();
  const boxes = f.p.pendingRef.current;
  assert.equal(boxes.length, 2);
  assert.equal(typeof boxes[0].cancel, 'function');
  boxes[0].cancel();
  // 框与任务同时亮灯:框标 "正在打断",任务那一行也立刻改成"正在打断…"
  assert.equal(boxes[0].state, 'cancelling');
  assert.equal(f.p.jobsRef.current[0].phase, '正在打断…');
  await flush();
  // 被打断那张不进轮询、不落图、不留待续查;另一张照常出来
  assert.equal(f.p.docRef.current.images.length, 1);
  assert.equal(f.p.pendingRef.current.length, 0);
  assert.equal(pending.length, 0);
});

await test('image file extension follows the real mime, not a hardcoded .png', async () => {
  const saved = [];
  const original = context.api;
  context.api = async (route, init) => {
    if (route === '/ws-save') {
      const body = JSON.parse(init.body);
      saved.push(body);
      return { path: body.path };
    }
    return original(route, init);
  };
  try {
    const f = fixture();
    const images = parts.get('images').createImages(f.p);
    // 上游给的是 jpeg:没有文字图层、也没换尺寸时 renderExportDataUrl 会原样返回它,
    // 所以文件名必须落 .jpg —— 写死 .png 会被宿主按"内容与后缀不符"拒写。
    const jpeg = { id: 'a', name: '结果.png', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', w: 100, h: 100, texts: [] };
    f.p.selected = jpeg;
    await images.saveImageToWorkspace(jpeg);
    assert.equal(saved.length, 1);
    assert.match(saved[0].path, /\.jpg$/);
    assert.equal(saved[0].dataUrl, 'data:image/jpeg;base64,/9j/4AAQ');

    // 填了 savePath 也要跟着真实格式纠正后缀(零件闭包里读的是当次渲染的 p,所以重建一次)
    const withPath = parts.get('images').createImages({ ...f.p, savePath: '画布输出/海报.png' });
    await withPath.saveImageToWorkspace(jpeg);
    assert.equal(saved[1].path, '画布输出/海报.jpg');

    // png 结果不受影响
    const png = { id: 'b', name: '结果', dataUrl: `data:image/png;base64,${'a'.repeat(80)}`, w: 100, h: 100, texts: [] };
    f.p.selected = png;
    await images.saveImageToWorkspace(png);
    assert.match(saved[2].path, /\.png$/);
    assert.deepEqual(f.errors, []);
  } finally {
    context.api = original;
  }
});

await test('concurrent job limit comes from prefs and stays within 1..4', async () => {
  // 没有任何设置时用默认值(MAX_CONCURRENT_JOBS = 2)
  assert.equal(context.concurrencyLimit(), 2);
  assert.equal(context.clampConcurrency(''), 2);
  assert.equal(context.clampConcurrency('abc'), 2);

  const original = context.localStorage;
  try {
    context.localStorage = { getItem: () => JSON.stringify({ maxJobs: 9 }) };
    assert.equal(context.concurrencyLimit(), 4);
    context.localStorage = { getItem: () => JSON.stringify({ maxJobs: 0 }) };
    assert.equal(context.concurrencyLimit(), 1);
    context.localStorage = { getItem: () => JSON.stringify({ maxJobs: '3' }) };
    assert.equal(context.concurrencyLimit(), 3);
    // 存坏了当没设过:不能让一个坏 prefs 把并发卡成 0 或者放到无限大
    context.localStorage = { getItem: () => 'not json' };
    assert.equal(context.concurrencyLimit(), 2);
  } finally {
    context.localStorage = original;
  }
});

await test('reference numbers follow submit order and the main image takes slot 1', async () => {
  // 画布角标、生成卡的「参考图 N」、提交文本里的编号说明,三处都靠 refNumbers。
  // 规则:提交体是 [主图, 参考图…],主选图不占参考号;隐藏图不提交也不编号。
  const dump = JSON.parse(
    vm.runInContext(
      `JSON.stringify((() => {
        const imgs = [
          { id: 'a', isRef: false },
          { id: 'b', isRef: true },
          { id: 'c', isRef: true, hidden: true },
          { id: 'd', isRef: true },
        ];
        return [
          [...refNumbers(imgs, null).entries()],
          [...refNumbers(imgs, 'b').entries()],
          [...refNumbers(imgs, 'a').entries()],
          refNumbers(null, null).size,
          refNumbers([], 'x').size,
        ];
      })())`,
      context,
    ),
  );
  assert.deepEqual(dump[0], [['b', 1], ['d', 2]]);
  // 选中参考图 b 时它变成主图,不再占参考号
  assert.deepEqual(dump[1], [['d', 1]]);
  // 选中一张非参考图不影响参考编号
  assert.deepEqual(dump[2], [['b', 1], ['d', 2]]);
  assert.equal(dump[3], 0);
  assert.equal(dump[4], 0);
});

await test('prompt that points at 参考图1 gets an explicit number legend', async () => {
  // 用户能写「参考图1」的前提是模型也知道编号怎么排:提交体是 [主图, 参考图…],
  // 所以要在文本末尾补一句「参考图1 = 第 2 张(名字)」;没点名就不补。
  const main = { id: 'main', name: '主图.png', x: 0, y: 0, w: 400, h: 300, dataUrl: 'test:400x300', naturalW: 400, naturalH: 300, isRef: false };
  const ref = { id: 'ref', name: '风格.png', x: 0, y: 0, w: 400, h: 300, dataUrl: 'test:400x300', naturalW: 400, naturalH: 300, isRef: true };
  const cache = (f) => {
    f.p.imgCacheRef.current.set(main.id, { complete: true, naturalWidth: 400, naturalHeight: 300 });
    f.p.imgCacheRef.current.set(ref.id, { complete: true, naturalWidth: 400, naturalHeight: 300 });
  };

  const f = fixture({ prompt: '把主图改成参考图1 的配色', selected: main });
  f.p.docRef.current.images = [main, ref];
  cache(f);
  await parts.get('generate').createGenerate(f.p).run();
  await flush();
  const text = createdBodies[0].prompt;
  assert.ok(text.includes('参考图编号说明'), text);
  assert.ok(text.includes('参考图1 = 第 2 张(风格.png)'), text);

  // 没点名参考编号:不多塞这段话
  const quiet = fixture({ prompt: '只改主图的背景色', selected: main });
  quiet.p.docRef.current.images = [main, ref];
  cache(quiet);
  await parts.get('generate').createGenerate(quiet.p).run();
  await flush();
  assert.ok(!createdBodies[0].prompt.includes('参考图编号说明'), createdBodies[0].prompt);
});

console.log(`\n${passed} canvas regressions passed.`);
