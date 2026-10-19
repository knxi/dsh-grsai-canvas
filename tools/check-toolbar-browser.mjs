import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Optional development tool; the plugin itself still has no third-party dependencies.
// 用途:验证左侧「工具栏」在真实 DOM 里可用 —— 每个工具按钮点得动、切得过去,
// 并且切过去之后在画布上真的能画出标注(画笔/蒙版/箭头/矩形/椭圆)、橡皮能擦、
// 场景框能起框、隐藏/锁定的图会被拦下。这是「工具栏工具用不了」类反馈的回归位。
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readdirSync(path.join(root, 'lib', 'parts')).filter((name) => name.endsWith('.js') && name !== '99-entry.js')
  .sort().map((name) => fs.readFileSync(path.join(root, 'lib', 'parts', name), 'utf8')).join('\n');
const output = process.env.CANVAS_TEST_OUTPUT || path.join(root, 'browser-check');
fs.mkdirSync(output, { recursive: true });

// 工具按钮的标题前缀 → 状态里的 tool id(与 01-constants.js 的 TOOLS 对齐)
const TOOLS = [
  ['选择/移动', 'select'],
  ['画笔(自由涂抹)', 'brush'],
  ['蒙版(只改涂到的地方)', 'mask'],
  ['箭头', 'arrow'],
  ['矩形框', 'rect'],
  ['椭圆', 'ellipse'],
  ['场景框(生成)', 'shape'],
  ['橡皮(擦除标注)', 'eraser'],
];
// 能画出标注的四个(蒙版是同一套点集语义,矩形/椭圆走 rect)
const DRAW_KINDS = [
  ['画笔(自由涂抹)', 'brush'],
  ['蒙版(只改涂到的地方)', 'mask'],
  ['箭头', 'arrow'],
  ['矩形框', 'rect'],
  ['椭圆', 'ellipse'],
];

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
    const imageA = { id: 'img-a', name: 'A.png', x: 40, y: 60, w: 300, h: 200, naturalW: 300, naturalH: 200, isRef: false, hidden: false, locked: false, dataUrl: solid('#d64545', 300, 200), texts: [] };
    const doc = { images: [imageA], marks: [], frames: [] };
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
    let docRef = null;
    function render(overrides = {}) {
      for (const [name, value] of Object.entries(overrides)) set(name, value);
      si = 0;
      ri = 0;
      const tree = app.CanvasTab({ sessionId: 'offline' });
      document.getElementById('host').replaceChildren(mount(tree));
      if (!docRef) {
        docRef = refs.find((r) => r.current && Array.isArray(r.current.images)) || null;
        if (docRef) docRef.current = doc;
      }
      return tree;
    }
    const canvas = () => document.querySelector('#host canvas');
    const buttons = () => [...document.querySelectorAll('#host button')];
    const titleOf = (el) => String(el.getAttribute('title') || '');
    const findButton = (prefix) => buttons().find((el) => titleOf(el).startsWith(prefix));
    function clickTool(prefix) {
      const btn = findButton(prefix);
      if (!btn) throw new Error('找不到工具按钮: ' + prefix);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return titleOf(btn);
    }
    function clickTitled(title) {
      const btn = buttons().find((el) => titleOf(el) === title);
      if (!btn) throw new Error('找不到按钮: ' + title);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    function fire(type, x, y, buttonsDown) {
      const c = canvas();
      if (!c) throw new Error('画布元素不存在');
      c.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, buttons: buttonsDown, button: 0 }));
    }
    function drag(from, to) {
      fire('pointerdown', from[0], from[1], 1);
      fire('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 1);
      fire('pointermove', to[0], to[1], 1);
      fire('pointerup', to[0], to[1], 0);
    }
    function press(x, y) {
      fire('pointerdown', x, y, 1);
      fire('pointerup', x, y, 0);
    }
    function resetDoc() {
      docRef.current = { images: docRef.current.images, marks: [], frames: [] };
    }
    function toolButtons() {
      return buttons().filter((el) => /\([VBKAROGE]\)$/.test(titleOf(el)));
    }
    render();
    set('apikey', 'offline-test');
    set('loaded', true);
    render();
    window.harness = {
      app, render, set, get, refs, doc,
      getDoc: () => docRef.current,
      resetDoc, clickTool, clickTitled, drag, press, toolButtons, canvas,
    };
  }, source);
  assert.deepEqual(errors, [], 'no page errors during mount');

  // 1) 工具栏渲染齐全:8 个工具按钮,每个都有图标、都没有被禁用
  const bar = await page.evaluate(() => {
    const btns = window.harness.toolButtons();
    return {
      count: btns.length,
      titles: btns.map((el) => el.getAttribute('title')),
      iconless: btns.filter((el) => !el.querySelector('svg')).map((el) => el.getAttribute('title')),
      disabled: btns.filter((el) => el.disabled).map((el) => el.getAttribute('title')),
      extras: [...document.querySelectorAll('#host button')].map((el) => el.getAttribute('title')).filter((t) => t && /撤销|重做|清空这张图/.test(t)),
    };
  });
  assert.equal(bar.count, TOOLS.length, '工具按钮数量应为 ' + TOOLS.length);
  assert.deepEqual(bar.iconless, [], '工具按钮缺图标');
  assert.deepEqual(bar.disabled, [], '工具按钮被禁用');
  assert.equal(bar.extras.length, 3, '撤销/重做/清空按钮应齐全');
  console.log(`PASS 工具栏渲染:${bar.count} 个工具按钮(都有图标、都可点)+ ${bar.extras.length} 个辅助按钮`);

  // 2) 逐个点击都能切过去(点了没反应 = 这里就红)
  for (const [prefix, id] of TOOLS) {
    const report = await page.evaluate(([prefix]) => {
      const title = window.harness.clickTool(prefix);
      window.harness.render();
      return { title, tool: window.harness.get('tool') };
    }, [prefix]);
    assert.equal(report.tool, id, `点「${prefix}」后 tool 应为 ${id},实际 ${report.tool}`);
  }
  console.log(`PASS 工具切换:${TOOLS.map(([, id]) => id).join(' / ')} 全部点得动、切得过去`);

  // 3) 切过去之后真的画得出标注(画笔/蒙版/箭头/矩形/椭圆)
  for (const [prefix, id] of DRAW_KINDS) {
    const report = await page.evaluate(([prefix]) => {
      window.harness.resetDoc();
      window.harness.clickTool(prefix);
      window.harness.render();
      window.harness.drag([120, 140], [230, 200]);
      const doc = window.harness.getDoc();
      const mark = doc.marks[0] || null;
      return {
        marks: doc.marks.length,
        kind: mark ? mark.kind : '',
        targetId: mark ? mark.targetId : '',
        moved: mark ? (mark.points ? mark.points.length : (mark.rect ? mark.rect.x1 !== mark.rect.x0 : mark.to && (mark.to[0] !== mark.from[0] || mark.to[1] !== mark.from[1]))) : false,
      };
    }, [prefix]);
    assert.equal(report.marks, 1, `「${prefix}」拖动后应产生 1 个标注`);
    assert.equal(report.kind, id, `「${prefix}」产生的标注 kind 应为 ${id}`);
    assert.equal(report.targetId, 'img-a', `「${prefix}」的标注应挂在图片上`);
    assert.ok(report.moved, `「${prefix}」拖动后标注应有实际尺寸/轨迹`);
    console.log(`PASS 「${prefix}」→ 画布上生成 ${report.kind} 标注(带轨迹/尺寸)`);
  }

  // 4) 撤销 / 重做按钮:画两笔,撤销回一笔,重做再回到两笔
  // 注意:真实载入路径靠 useEffect 给历史栈播种,而离线 harness 的 useEffect 是空实现,
  // 所以这里用"两笔"来表达(第一次 finishChange 自己成为基线)。
  const undoRedo = await page.evaluate(() => {
    window.harness.resetDoc();
    window.harness.clickTool('矩形框');
    window.harness.render();
    window.harness.drag([120, 140], [200, 190]);
    const afterFirst = window.harness.getDoc().marks.length;
    window.harness.drag([220, 150], [290, 210]);
    const afterSecond = window.harness.getDoc().marks.length;
    window.harness.clickTitled('撤销(Ctrl+Z)');
    window.harness.render();
    const afterUndo = window.harness.getDoc().marks.length;
    window.harness.clickTitled('重做(Ctrl+Shift+Z)');
    window.harness.render();
    const afterRedo = window.harness.getDoc().marks.length;
    return { afterFirst, afterSecond, afterUndo, afterRedo };
  });
  assert.equal(undoRedo.afterFirst, 1, '第一笔应画出 1 个标注');
  assert.equal(undoRedo.afterSecond, 2, '第二笔应画出 2 个标注');
  assert.equal(undoRedo.afterUndo, 1, '撤销后应回到 1 个标注');
  assert.equal(undoRedo.afterRedo, 2, '重做后应回到 2 个标注');
  console.log('PASS 撤销/重做按钮:2 笔 → 撤销回 1 笔 → 重做回 2 笔');

  // 5) 橡皮:点回已有标注上把它擦掉
  const erased = await page.evaluate(() => {
    window.harness.resetDoc();
    window.harness.clickTool('矩形框');
    window.harness.render();
    window.harness.drag([120, 140], [230, 200]);
    const before = window.harness.getDoc().marks.length;
    window.harness.clickTool('橡皮(擦除标注)');
    window.harness.render();
    window.harness.press(120, 140);
    return { before, after: window.harness.getDoc().marks.length };
  });
  assert.equal(erased.before, 1, '橡皮测试前应有 1 个标注');
  assert.equal(erased.after, 0, '橡皮点上去应擦掉标注');
  console.log('PASS 橡皮:点回标注上把它擦掉(1 → 0)');

  // 6) 场景框:点一下起框(不拖拽,进输入态)
  const frame = await page.evaluate(() => {
    window.harness.resetDoc();
    window.harness.clickTool('场景框(生成)');
    window.harness.render();
    window.harness.press(180, 170);
    const draft = window.harness.get('frameDraft');
    return { hasDraft: Boolean(draft && typeof draft === 'object'), frames: window.harness.getDoc().frames.length };
  });
  assert.ok(frame.hasDraft, '场景框工具点一下应进入尺寸输入态(frameDraft)');
  assert.equal(frame.frames, 0, '未填尺寸前不应直接生成场景框');
  console.log('PASS 场景框:点一下进入尺寸输入态,未填尺寸不落地');

  // 7) 隐藏 / 锁定的图:工具点了也画不上去,并给出明确提示
  const guard = await page.evaluate(() => {
    const doc = window.harness.getDoc();
    const image = doc.images[0];
    window.harness.resetDoc();
    window.harness.set('selectedId', 'img-a');
    window.harness.set('selectedIds', ['img-a']);
    window.harness.clickTool('矩形框');
    image.hidden = true;
    window.harness.render();
    window.harness.drag([120, 140], [230, 200]);
    const hiddenNotice = window.harness.get('notice');
    const hiddenMarks = window.harness.getDoc().marks.length;
    image.hidden = false;
    image.locked = true;
    window.harness.render();
    window.harness.drag([120, 140], [230, 200]);
    const lockedNotice = window.harness.get('notice');
    const lockedMarks = window.harness.getDoc().marks.length;
    image.locked = false;
    return { hiddenNotice, hiddenMarks, lockedNotice, lockedMarks };
  });
  assert.equal(guard.hiddenMarks, 0, '隐藏的图不应能被画标注');
  assert.match(String(guard.hiddenNotice), /隐藏/, '画到隐藏图应提示「先显示」,实际: ' + guard.hiddenNotice);
  assert.equal(guard.lockedMarks, 0, '锁定的图不应能被画标注');
  assert.match(String(guard.lockedNotice), /锁定/, '画到锁定图应提示「先解锁」,实际: ' + guard.lockedNotice);
  console.log('PASS 隐藏/锁定保护:画不上去,且分别提示「隐藏」「锁定」');

  // 证据截图:空工具栏态 + 画着标注的态
  await page.evaluate(() => {
    window.harness.resetDoc();
    window.harness.clickTool('选择/移动');
    window.harness.set('selectedId', '');
    window.harness.set('selectedIds', []);
    window.harness.render();
  });
  await page.screenshot({ path: path.join(output, 'toolbar-default.png') });
  await page.evaluate(() => {
    window.harness.resetDoc();
    window.harness.set('selectedId', 'img-a');
    window.harness.set('selectedIds', ['img-a']);
    window.harness.clickTool('矩形框');
    window.harness.render();
    window.harness.drag([120, 140], [230, 200]);
    window.harness.clickTool('画笔(自由涂抹)');
    window.harness.render();
    window.harness.drag([150, 170], [260, 230]);
    window.harness.render();
  });
  await page.screenshot({ path: path.join(output, 'toolbar-draw.png') });

  assert.deepEqual(errors, [], 'no page errors during checks');
  console.log(`Toolbar browser checks passed (${TOOLS.length} 工具切切换 + ${DRAW_KINDS.length} 种标注可画 + 撤销/橡皮/场景框/隐藏锁定保护)。Screenshots: ${output}`);
} finally {
  await browser.close();
}
