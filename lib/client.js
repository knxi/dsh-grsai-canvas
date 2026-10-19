/**
 * dsh-grsai-canvas —— 浏览器侧半边(成品 bundle)。
 *
 * ⚠ **这是构建产物,不要直接改这里** —— 改完会被下一次装配覆盖。
 * 源码按职责拆在 `lib/parts/*.js`(工具栏、右下角生成区块、右上角设置、画布交互、
 * 尺寸换算、标注渲染、文字图层、样式表…),改完在插件目录跑:
 *
 *     node tools/build-client.mjs
 *
 * 为什么非要"装配":`dsh.client` 只认一个 `exports["./client"]` bundle,
 * 浏览器只会加载这一个文件(见 `_test/client-bundle.mjs` 的一致性校验)。
 *
 * 交互模型参考 Cowart(tldraw 无限画布):
 *   · 图片是画布上的对象,放在世界坐标里,可拖动、拉角缩放;
 *   · 画布可平移/缩放(滚轮以光标为中心、空格或中键拖动、适应/100%);
 *   · 标注是独立对象,按图片归一化坐标粘在图上,可撤销/重做,不烧进像素;
 *   · 「按标注改图」把「原图 + 标注」合成一张提交,出图放在原图旁边,原图和标注都保留;
 *   · 画布自动存到工作区 `<工作区>/画布/state.json`,刷新/重开都还在。
 *
 * 构建期无依赖:产物只 require 平台自带的 `react`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-grsai-canvas',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    // ── 零件 00-runtime.js ───────────────────────────────────────────────────────────
/* ── 零件机(运行时的最小模块系统)───────────────────────────────────────────
 *
 * 为什么要有它:`dsh.client` 只认一个 `exports["./client"]` bundle,浏览器只加载
 * `lib/client.js` 这一个文件 —— 所以"分模块"只能靠构建期把 `lib/parts/*.js` 拼进来。
 * 拼进来以后,各零件若都用同一个作用域,就成了"换行的单文件",既不能显式声明依赖,
 * 也挡不住重名。这里给它们一层薄薄的隔离:
 *
 *   definePart('marks', (rt) => { const { clamp } = rt.utils; … return { renderMarks }; });
 *
 * 取用是**惰性**的:第一次访问 `rt.marks` 才构造 marks 零件,构造结果被缓存,
 * 所以零件之间可以随意引用(只要不成环 —— 成环会在构造时立刻抛错,不会静默死循环)。
 *
 * 注意:本文件(以及所有零件)整体嵌在 `__ModuleLoader__.load` 的 factory 里,
 * 所以顶层缩进是 4 空格 —— 构建脚本是**原样拼接**,不重排缩进。
 */
    const PART_FACTORIES = new Map();
    const PART_EXPORTS = new Map();
    const PART_STACK = [];

    /**
     * 注册一个零件。
     * @param name - 零件名(全局唯一,零件之间就用它互相取用)。
     * @param factory - `(rt) => 导出对象`;rt 是依赖包,`rt.foo` 就是零件 foo 的导出。
     */
    function definePart(name, factory) {
      if (PART_FACTORIES.has(name)) throw new Error(`[grsai-canvas] 零件重名:${name}`);
      PART_FACTORIES.set(name, factory);
    }

    /**
     * 构造(或取用已构造的)零件。
     * @param name - 零件名。
     * @returns 该零件的导出对象。
     */
    function part(name) {
      if (PART_EXPORTS.has(name)) return PART_EXPORTS.get(name);
      const factory = PART_FACTORIES.get(name);
      if (!factory) throw new Error(`[grsai-canvas] 没有这个零件:${name}(先 definePart 再取用)`);
      if (PART_STACK.includes(name)) throw new Error(`[grsai-canvas] 零件互相依赖成环:${PART_STACK.concat(name).join(' → ')}`);
      PART_STACK.push(name);
      let made;
      try {
        made = factory(rt) || {};
      } finally {
        PART_STACK.pop();
      }
      PART_EXPORTS.set(name, made);
      return made;
    }

    /** 零件的依赖包:`rt.foo` = 零件 foo 的导出(惰性构造)。 */
    const rt = new Proxy(
      {},
      {
        get(_target, key) {
          if (typeof key !== 'string') return undefined;
          return part(key);
        },
      },
    );

    /**
     * 给「界面零件」的依赖包加一道守卫。
     *
     * 界面零件(工具栏 / 生成区块 / 设置面板…)靠调用处显式传依赖,好处是接口一眼可见;
     * 坏处是漏传一个就是静默的 `undefined` —— 界面上表现为某个按钮点了没反应,
     * 排起来很费劲。包一层 Proxy 之后,漏传会在**用到的那一刻**抛出带零件名的错。
     * @param name - 零件名(报错信息里用)。
     * @param bag - 依赖对象(键名与零件内部解构的名字一致)。
     * @returns 包好的依赖包。
     */
    function deps(name, bag) {
      return new Proxy(bag, {
        get(target, key) {
          if (typeof key !== 'string' || key in target) return target[key];
          throw new Error(`[grsai-canvas] 零件 ${name} 缺依赖:${key}`);
        },
        has() {
          return true;
        },
      });
    }

    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect, useCallback } = React;

    // ── 零件 01-constants.js ─────────────────────────────────────────────────────────
    const CANVAS_ID = 'dsh-grsai-canvas';
    const CANVAS_KIND = 'grsai-canvas';
    const ROUTE = '/grsai-canvas';
    /** 第一个带画布存档接口(/state)的宿主版本 —— 低于它就别去存/读。 */
    const MIN_HOST_VERSION = '0.2.0';
    const LS_KEY = 'dsh.grsai-canvas.apikey';
    const LS_PREFS = 'dsh.grsai-canvas.prefs.v2';
    /** 默认接口地址(image.grsai.ai 用的后端);「设置」里可以改成别的兼容地址。 */
    const DEFAULT_API_BASE = 'https://grsai.dakka.com.cn';
    /**
     * 默认更新源:发布页上那份清单的地址(见 `更新发布说明.md`)。
     *
     * 「设置 → ③ 插件更新」里**留空就用它** —— 所以装好插件、打开画布约 2.5 秒后
     * 会自动检查一次有没有新版本(有新版本时只在设置按钮上冒 `设置 ⬆x.y.z`,并写一行状态)。
     * 它**只用于检查**:插件从不会自动安装,必须你点「立即更新」;
     * 不想让它联网,把「启动时自动检查」勾掉即可(想换源就在那一格填自己的地址)。
     */
    const DEFAULT_UPDATE_URL = 'https://b.mumu.bio/huabu/version.json';
    /**
     * 「图片分层(Agent)」的默认接口地址。
     *
     * 这条链路**不是 GrsAI**:它调 APIMart 上的 Seedream 图层分解(一次返回 base + 最多 16 个
     * 带 alpha 的图层 + 每层 bbox),再由 image-layering 技能在本地组装成可编辑 PSD。
     * 地址与密钥在「设置 → ④ 图片分层(Agent)」里填,写进该技能自己的 config/*.json。
     * 换别家(只要提供同款图层分解接口)改这一格即可。
     */
    const LAYER_DEFAULT_BASE = 'https://api.apimart.ai';
    const DOC_VERSION = 2;

    const MIN_ZOOM = 0.04;
    const MAX_ZOOM = 20;
    /**
     * 同时在**上游**跑的任务数**默认值**(不是画布上占位框的个数)。
     *
     * 连点「生成」或勾「跨平台出图」会一次建好几个任务:这里限制同时提交几个,
     * 多出来的先在画布上画框写「排队中」,等前面有位置了再提交。
     * 用户可在「设置 → 同时生成」里改(存本机 prefs,见 06 的 concurrencyLimit),上限是下面那个常量。
     * 调大要留意上游限流与**同时扣费**(每个任务都是一次真实的生成)。
     */
    const MAX_CONCURRENT_JOBS = 2;
    /** 「同时生成」能调到多大:再大既容易被上游限流,也是一次次真实扣费。 */
    const MAX_CONCURRENT_JOBS_MAX = 4;
    /** 新图超过这个长边就缩到这个尺寸再摆上画布(原始像素另存,画布只放小的)。 */
    const MAX_PLACE_SIZE = 1100;
    /**
     * 提交给模型的合成图长边上限。
     * 原图尺寸可能非常夸张(见过 9419×15000 的):按原始分辨率合成会做出上百 MB 的 PNG,
     * 浏览器 canvas 内存和请求体都撑不住,连接会被掐断 —— 表现就是 `Failed to fetch`。
     * 上游模型本来也吃不下那么大,缩到这个上限既有质量又发得出去。
     */
    const SUBMIT_MAX_SIDE = 2048;
    /** 单次提交(合成图 + 参考图)的体量上限,超了就地拦下并说清楚。 */
    const MAX_SUBMIT_BYTES = 24 * 1024 * 1024;
    /**
     * 毫米/厘米/英寸 → 像素的换算基准(可在「设置」里改,默认 300)。
     *
     * 为什么需要它:做印刷/实物交付的人习惯用毫米报尺寸(A4 = 210×297mm),
     * 而上游模型与画布只认像素。300 DPI 是印刷交付的通用标准。
     */
    const DEFAULT_DPI = 300;
    /** 1 英寸 = 25.4 毫米。 */
    const MM_PER_INCH = 25.4;
    /** 两张图之间的间隔(世界单位)。 */
    const GAP = 60;

    const TOOLS = [
      { id: 'select', label: '选择/移动', key: 'V' },
      { id: 'brush', label: '画笔(自由涂抹)', key: 'B' },
      { id: 'mask', label: '蒙版(只改涂到的地方)', key: 'K' },
      { id: 'arrow', label: '箭头', key: 'A' },
      { id: 'rect', label: '矩形框', key: 'R' },
      { id: 'ellipse', label: '椭圆', key: 'O' },
      { id: 'shape', label: '场景框(生成)', key: 'G' },
      { id: 'eraser', label: '橡皮(擦除标注)', key: 'E' },
    ];
    /**
     * 用「圆形笔尖」指针的工具:画布上不显示系统光标,改画一个跟当前粗细一样大的小圆点 ——
     * 笔尖多粗,落笔前就看得见(圆的直径 = 当前 `markWidth` 的**屏幕**像素,和画上去的线一样粗)。
     * 选择/场景框/橡皮不在这里:它们各自有更合适的光标(箭头 / 十字 / 擦除圈)。
     */
    const RING_TOOLS = ['brush', 'mask', 'arrow', 'rect', 'ellipse'];
    const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#111111'];
    /**
     * 模型菜单 —— 覆盖上游尺寸表里的全部型号 + 官方 2.5 别名,顺手标出它认的尺寸格式。
     *
     * 这里不用原生 `<datalist>`:它会按输入框里已有的字**过滤**候选,框里写着
     * `gpt-image-2-vip` 时下拉就只剩这一条,看着像"模型表只剩一个了"。
     * 改成点 ▾ 弹菜单(输入框仍可自由填任意模型名)。
     */
    const MODEL_CHOICES_BUILTIN = [
      { id: 'gpt-image-2', label: 'gpt-image-2(最常用,刷图稳)', note: '像素值' },
      { id: 'gpt-image-2-vip', label: 'gpt-image-2-vip(大图/高清)', note: '像素值' },
      { id: 'gpt-image-2.5', label: 'gpt-image-2.5(同 gpt-image-2)', note: '像素值' },
      { id: 'gpt-image-2.5-flare', label: 'gpt-image-2.5-flare(同 -vip)', note: '像素值' },
      { id: 'gpt-image-2.5-sunburst', label: 'gpt-image-2.5-sunburst(同 -vip)', note: '像素值' },
      { id: 'nano-banana', label: 'nano-banana', note: '比例' },
      { id: 'nano-banana-fast', label: 'nano-banana-fast', note: '比例' },
      { id: 'nano-banana-2', label: 'nano-banana-2', note: '比例' },
      { id: 'nano-banana-2-cl', label: 'nano-banana-2-cl', note: '比例' },
      { id: 'nano-banana-2-2k-cl', label: 'nano-banana-2-2k-cl', note: '比例' },
      { id: 'nano-banana-2-4k-cl', label: 'nano-banana-2-4k-cl', note: '比例' },
      { id: 'nano-banana-pro', label: 'nano-banana-pro', note: '比例' },
      { id: 'nano-banana-pro-vt', label: 'nano-banana-pro-vt', note: '比例' },
      { id: 'nano-banana-pro-cl', label: 'nano-banana-pro-cl', note: '比例' },
      { id: 'nano-banana-pro-vip', label: 'nano-banana-pro-vip', note: '比例' },
      { id: 'nano-banana-pro-4k-vip', label: 'nano-banana-pro-4k-vip', note: '比例' },
      { id: 'minimax-h3', label: 'minimax-h3(视频模型,画布用不上)', note: '方向词' },
    ];

    /**
     * 运行时候选清单:载入工作区模型清单后由 `mergeModelCatalog` 换成"内置 + 自定义"。
     * 内置项永远保留(合并规则见 `02-model-sizes.js`)。
     */
    let MODEL_CHOICES = MODEL_CHOICES_BUILTIN;

    const IMAGE_SIZES = ['auto', '1K', '2K', '4K'];
    const QUALITIES = [{ id: 'auto', label: '默认' }, { id: 'high', label: 'high' }, { id: 'medium', label: 'medium' }, { id: 'low', label: 'low' }];
    const BACKGROUNDS = [{ id: 'auto', label: '默认' }, { id: 'transparent', label: '透明' }, { id: 'opaque', label: '不透明' }];

    // ── 零件 02-model-sizes.js ───────────────────────────────────────────────────────
    /**
     * 每个模型支持的「尺寸」取值 —— 照抄上游站点那张表(image.grsai.ai 里的 rt)。
     *
     * ⚠️ 关键:`aspectRatio` 同一个字段,不同模型吃的格式完全不同:
     *   · gpt-image-2 / gpt-image-2-vip(含 2.5 系列)→ 像素值,如 '1024x1024'
     *     —— 给它 '3:4' 上游会直接判 failed:
     *        "gpt-image-2-vip model does not support 3:4 parameter, please use pixel value input"
     *   · nano-banana*  → 比例,如 '3:4'
     *   · minimax-h3    → portrait / landscape / square
     * 所有模型都认 'auto'。
     */
    const MODEL_SIZES_BUILTIN = {
      'gpt-image-2': ['auto', '1024x1024', '1672x941', '941x1672', '1443x1090', '1090x1443', '1536x1024', '1024x1536', '1408x1120', '1120x1408', '1920x832', '832x1920', '1792x896', '896x1792'],
      'gpt-image-2-vip': ['auto', '1024x1024', '2048x2048', '2880x2880', '1280x720', '2048x1152', '3840x2160', '720x1280', '1152x2048', '2160x3840', '1152x864', '2304x1728', '3264x2448', '864x1152', '1728x2304', '2448x3264', '1536x1024', '2048x1360', '3504x2336', '1024x1536', '1360x2048', '2336x3504', '1120x896', '2240x1792', '3200x2560', '896x1120', '1792x2240', '2560x3200', '1456x624', '2912x1248', '3840x1648', '624x1456', '1248x2912', '1648x3840', '688x2048', '1280x3840', '2048x688', '3840x1280', '1536x768', '3072x1536', '3840x1920', '768x1536', '1536x3072', '1920x3840'],
      'nano-banana-fast': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'],
      'nano-banana': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'],
      'nano-banana-pro': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'],
      'nano-banana-pro-vt': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'],
      'nano-banana-pro-cl': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'],
      'nano-banana-pro-vip': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'],
      'nano-banana-pro-4k-vip': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'],
      'nano-banana-2': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9', '1:4', '4:1', '1:8', '8:1'],
      'nano-banana-2-cl': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9', '1:4', '4:1', '1:8', '8:1'],
      'nano-banana-2-2k-cl': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9', '1:4', '4:1', '1:8', '8:1'],
      'nano-banana-2-4k-cl': ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9', '1:4', '4:1', '1:8', '8:1'],
      'minimax-h3': ['portrait', 'landscape', 'square'],
    };

    /** 像素值的官方标注(站点那张 ri 表)—— 下拉里给人看的,免得一屏都是数字。 */
    const SIZE_LABELS_BUILTIN = {
      'gpt-image-2': {
        '1024x1024': '1024x1024 (1:1)',
        '1672x941': '1672x941 (16:9)',
        '941x1672': '941x1672 (9:16)',
        '1443x1090': '1443x1090 (4:3)',
        '1090x1443': '1090x1443 (3:4)',
        '1536x1024': '1536x1024 (3:2)',
        '1024x1536': '1024x1536 (2:3)',
        '1408x1120': '1408x1120 (5:4)',
        '1120x1408': '1120x1408 (4:5)',
        '1920x832': '1920x832 (21:9)',
        '832x1920': '832x1920 (9:21)',
        '1792x896': '1792x896 (2:1)',
        '896x1792': '896x1792 (1:2)',
      },
      'gpt-image-2-vip': {
        '1024x1024': '1024x1024 (1:1, 1K)',
        '2048x2048': '2048x2048 (1:1, 2K)',
        '2880x2880': '2880x2880 (1:1, 4K)',
        '1280x720': '1280x720 (16:9, 1K)',
        '2048x1152': '2048x1152 (16:9, 2K)',
        '3840x2160': '3840x2160 (16:9, 4K)',
        '720x1280': '720x1280 (9:16, 1K)',
        '1152x2048': '1152x2048 (9:16, 2K)',
        '2160x3840': '2160x3840 (9:16, 4K)',
        '1152x864': '1152x864 (4:3, 1K)',
        '2304x1728': '2304x1728 (4:3, 2K)',
        '3264x2448': '3264x2448 (4:3, 4K)',
        '864x1152': '864x1152 (3:4, 1K)',
        '1728x2304': '1728x2304 (3:4, 2K)',
        '2448x3264': '2448x3264 (3:4, 4K)',
        '1536x1024': '1536x1024 (3:2, 1K)',
        '2048x1360': '2048x1360 (3:2, 2K)',
        '3504x2336': '3504x2336 (3:2, 4K)',
        '1024x1536': '1024x1536 (2:3, 1K)',
        '1360x2048': '1360x2048 (2:3, 2K)',
        '2336x3504': '2336x3504 (2:3, 4K)',
        '1120x896': '1120x896 (5:4, 1K)',
        '2240x1792': '2240x1792 (5:4, 2K)',
        '3200x2560': '3200x2560 (5:4, 4K)',
        '896x1120': '896x1120 (4:5, 1K)',
        '1792x2240': '1792x2240 (4:5, 2K)',
        '2560x3200': '2560x3200 (4:5, 4K)',
        '1456x624': '1456x624 (21:9, 1K)',
        '2912x1248': '2912x1248 (21:9, 2K)',
        '3840x1648': '3840x1648 (21:9, 4K)',
        '624x1456': '624x1456 (9:21, 1K)',
        '1248x2912': '1248x2912 (9:21, 2K)',
        '1648x3840': '1648x3840 (9:21, 4K)',
        '688x2048': '688x2048 (1:3, 2K)',
        '1280x3840': '1280x3840 (1:3, 4K)',
        '2048x688': '2048x688 (3:1, 2K)',
        '3840x1280': '3840x1280 (3:1, 4K)',
        '1536x768': '1536x768 (2:1, 1K)',
        '3072x1536': '3072x1536 (2:1, 2K)',
        '3840x1920': '3840x1920 (2:1, 4K)',
        '768x1536': '768x1536 (1:2, 1K)',
        '1536x3072': '1536x3072 (1:2, 2K)',
        '1920x3840': '1920x3840 (1:2, 4K)',
      },
    };

    /** 模型别名 → 尺寸表里的主名(上游也是这么挂的)。 */
    const MODEL_SIZE_ALIAS_BUILTIN = {
      'gpt-image-2.5': 'gpt-image-2',
      'gpt-image-2.5-flare': 'gpt-image-2-vip',
      'gpt-image-2.5-sunburst': 'gpt-image-2-vip',
    };

    /**
     * 下面三张是**运行时**表:面板上点「⟳ 获取新模型」载入工作区清单后,由
     * `mergeModelCatalog` 换成合并结果(内置的 `*_BUILTIN` 永远不动,一直当兜底)。
     *
     * 为什么用 `let` 就地替换、而不是让每个消费方都改成参数:尺寸换算那一串
     * (`sizeSizes`/`nearestSize`/`normalizeSize`/`buildGenerateBody`)每次调用都现读
     * 这几个名字 —— 换掉即刻全局生效,不用把新表一路透传下去。
     */
    let MODEL_SIZES = MODEL_SIZES_BUILTIN;
    let SIZE_LABELS = SIZE_LABELS_BUILTIN;
    let MODEL_SIZE_ALIAS = MODEL_SIZE_ALIAS_BUILTIN;

    /** 清单里 `format` 字段 → 面板上那句"这个模型的尺寸要填…"。 */
    const SIZE_FORMAT_LABEL = { pixel: '像素值', ratio: '比例', enum: '方向词' };

    /** 按模型格式给的一句话说明(填在「尺寸」框的 title 上)。 */
    const SIZE_TIPS = {
      pixel: '这个模型要填像素值,如 1024x1024(填 3:4 会被上游拒绝)',
      ratio: '这个模型要填比例,如 3:4',
      enum: '这个模型要填 portrait / landscape / square',
      unknown: '认不出这个模型的尺寸格式:写什么都原样发上游,写 auto 最稳',
    };

    /** 认不出的模型时给用户当参考的常见值。 */
    const COMMON_SIZES = ['1024x1024', '1536x1024', '1024x1536', '1:1', '3:4', '4:3', '16:9', '9:16'];

    /** 「尺寸」输入框里能认的常用名(填一个词就换算成对应像素)。 */
    const SIZE_KEYWORDS = [
      { key: '小红书', pixels: [1080, 1440], note: '小红书竖版 3:4' },
      { key: '朋友圈', pixels: [1080, 1350], note: '朋友圈 4:5' },
      { key: '视频号', pixels: [1080, 1920], note: '视频号竖屏 9:16' },
      { key: '抖音', pixels: [1080, 1920], note: '抖音竖屏 9:16' },
      { key: '公众号', pixels: [900, 383], note: '公众号头条封面 2.35:1' },
      { key: '头像', pixels: [1024, 1024], note: '头像方图 1:1' },
      { key: '壁纸', pixels: [1080, 1920], note: '手机壁纸 9:16' },
      { key: '横屏', pixels: [1920, 1080], note: '横屏 16:9' },
      { key: '竖屏', pixels: [1080, 1920], note: '竖屏 9:16' },
      { key: '封面', pixels: [1080, 1440], note: '通用竖版封面 3:4' },
      { key: '证件照', pixels: [1200, 1600], note: '证件照 3:4' },
      { key: 'A4', physical: '210x297mm', note: 'A4 标准纸张' },
      { key: '商品', pixels: [1024, 1024], note: '商品主图 1:1' },
      { key: '海报', pixels: [1080, 1350], note: '竖版海报 4:5' },
      { key: '横幅', pixels: [1920, 1080], note: '横版 16:9' },
    ];

    /** 「尺寸」输入框里能认的方向词。 */
    const SIZE_DIRECTIONS = [
      { keys: ['竖版', '竖图', '竖构图', 'portrait'], aspect: 3 / 4, note: '竖版(3:4)' },
      { keys: ['竖屏', '手机壁纸'], aspect: 9 / 16, note: '竖屏(9:16)' },
      { keys: ['横版', '横图', '横构图', 'landscape'], aspect: 4 / 3, note: '横版(4:3)' },
      { keys: ['横屏', '宽屏'], aspect: 16 / 9, note: '横屏(16:9)' },
      { keys: ['方图', '方形', '正方', '正方形', 'square', '1比1'], aspect: 1, note: '方图(1:1)' },
    ];

    /** 实物单位 → 毫米(都先折成毫米,再统一折成像素)。 */
    const SIZE_UNITS = {
      mm: { label: 'mm', mm: 1 },
      毫米: { label: 'mm', mm: 1 },
      cm: { label: 'cm', mm: 10 },
      厘米: { label: 'cm', mm: 10 },
      in: { label: 'in', mm: MM_PER_INCH },
      inch: { label: 'in', mm: MM_PER_INCH },
      inches: { label: 'in', mm: MM_PER_INCH },
      英寸: { label: 'in', mm: MM_PER_INCH },
    };

    /**
     * 浏览器 canvas 的安全上限 —— 成品尺寸超过它,**本地精确缩放**那一步会建不出画布
     * (Chrome 单边上限 16384,总面积也有上限),而用户要等提交完才发现出问题。
     * 这里留足余量;超了就自动降 DPI(实物尺寸)或等比缩小(裸像素),而不是报错拦下。
     */
    const MAX_OUTPUT_SIDE = 12000;
    const MAX_OUTPUT_PIXELS = 60 * 1000 * 1000;
    /** 自动降 DPI 时的下限(再低就没有交付意义了)。 */
    const MIN_DPI = 36;

    /**
     * 把工作区里的模型清单(面板上「⟳ 获取新模型」载入的那份)合并进内置表。
     *
     * 规则:清单里的同名模型**覆盖**内置(尺寸/标注以清单为准),清单里的新模型**追加**;
     * 内置项永远不丢 —— 清单缺了、只写了一个模型,面板照样能用。
     * 每次都从 `*_BUILTIN` 重新起算,所以反复载入不会越滚越多。
     *
     * @param {object} catalog - 宿主 `/models` 返回的数据:{ models: [...], aliases: {...} }。
     * @returns {{added: number, updated: number, total: number}} 合并统计(提示语用)。
     */
    function mergeModelCatalog(catalog) {
      const list = (catalog && Array.isArray(catalog.models) ? catalog.models : []).filter(
        (item) => item && typeof item === 'object' && String(item.id || '').trim(),
      );
      const sizes = Object.assign({}, MODEL_SIZES_BUILTIN);
      const labels = Object.assign({}, SIZE_LABELS_BUILTIN);
      const alias = Object.assign({}, MODEL_SIZE_ALIAS_BUILTIN);
      const choices = MODEL_CHOICES_BUILTIN.slice();
      const at = new Map();
      choices.forEach((item, index) => at.set(item.id, index));
      let added = 0;
      let updated = 0;
      for (const item of list) {
        const id = String(item.id).trim();
        const values = Array.isArray(item.sizes)
          ? item.sizes.map((value) => String(value).trim()).filter(Boolean)
          : [];
        if (values.length) sizes[id] = values;
        if (item.labels && typeof item.labels === 'object') {
          labels[id] = Object.assign({}, labels[id] || {}, item.labels);
        }
        const choice = {
          id,
          label: String(item.label || '').trim() || id,
          note: String(item.note || '').trim() || SIZE_FORMAT_LABEL[String(item.format || '').trim()] || '见尺寸表',
        };
        const index = at.get(id);
        if (index === undefined) {
          at.set(id, choices.length);
          choices.push(choice);
          added += 1;
        } else {
          choices[index] = choice;
          updated += 1;
        }
      }
      const aliasSource = (catalog && catalog.aliases) || {};
      for (const key of Object.keys(aliasSource)) {
        const value = String(aliasSource[key] || '').trim();
        if (value) alias[key] = value;
      }
      MODEL_SIZES = sizes;
      SIZE_LABELS = labels;
      MODEL_SIZE_ALIAS = alias;
      MODEL_CHOICES = choices;
      return { added, updated, total: list.length };
    }

    // ── 零件 03-sizes.js ─────────────────────────────────────────────────────────────
    /** 目标像素尺寸要乘多少倍才落进上面那两个上限(结果 ≤ 1)。 */
    function fitScale(w, h) {
      const width = Math.max(1, Number(w) || 1);
      const height = Math.max(1, Number(h) || 1);
      const bySide = MAX_OUTPUT_SIDE / Math.max(width, height);
      const byArea = Math.sqrt(MAX_OUTPUT_PIXELS / (width * height));
      return Math.min(1, bySide, byArea);
    }

    /** 把 DPI 掰成能用的值(设置里可能被填成空串 / 0 / 离谱的数)。 */
    function normalizeDpi(value) {
      const n = Number(value);
      return Number.isFinite(n) && n >= MIN_DPI && n <= 2400 ? Math.round(n) : DEFAULT_DPI;
    }

    /**
     * 带单位的**实物尺寸**:`210x297mm` / `21x29.7cm` / `8.5x11in` / `210×297 毫米`。
     *
     * 为什么单独做一条:做印刷/实物交付的人习惯用毫米报尺寸,但裸数字(如 `210x297`)
     * 在这插件里一直是**像素**,不能改(改了就破坏老用法)——所以只有**写了单位**才走这里:
     *   像素 = 数值 × 每单位毫米 ÷ 25.4 × DPI   (cm 先 ×10;英寸直接按 25.4mm 算)
     * @param {string} raw - 输入原话。
     * @param {number} [dpi] - 换算基准,缺省 300。
     * @returns {{mode:'pixel', pixels:number[], aspect:number, note:string, unit:string, dpi:number}|null} 不匹配给 null。
     */
    function parseUnitSize(raw, dpi) {
      const text = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!text) return null;
      const m =
        /^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|in|inch|inches|英寸)$/.exec(text) ||
        /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|in|inch|inches|英寸)$/.exec(text);
      if (!m) return null;
      const unit = SIZE_UNITS[m[3]];
      if (!unit) return null;
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (!(w > 0) || !(h > 0)) return null;
      const requested = normalizeDpi(dpi);
      const toPx = (v, d) => Math.max(1, Math.round((v * unit.mm * d) / MM_PER_INCH));
      let used = requested;
      let pixels = [toPx(w, used), toPx(h, used)];
      // 超出浏览器做得出来的范围 → **降 DPI**,物理尺寸原样保住(海报还是 80×200cm,只是精度低一点)。
      // 只报错不换算的话,用户得等提交完才发现这张图根本导不出来。
      const scale = fitScale(pixels[0], pixels[1]);
      let shrunk = false;
      if (scale < 1) {
        // 取整到 5 的倍数,读起来是「150 DPI」这种整齐的数
        used = Math.max(MIN_DPI, Math.floor((requested * scale) / 5) * 5);
        pixels = [toPx(w, used), toPx(h, used)];
        shrunk = true;
        // 取整之后仍可能压不下上限(极端尺寸),再夹一次
        const again = fitScale(pixels[0], pixels[1]);
        if (again < 1) {
          pixels = [Math.max(1, Math.round(pixels[0] * again)), Math.max(1, Math.round(pixels[1] * again))];
        }
      }
      const wanted = shrunk ? `${toPx(w, requested)}×${toPx(h, requested)}` : '';
      return {
        mode: 'pixel',
        pixels,
        aspect: pixels[0] / pixels[1],
        note: shrunk
          ? `${m[1]}×${m[2]}${unit.label} 按 ${requested} DPI 要 ${wanted} 像素,超过浏览器画布上限 —— 已自动降到 ${used} DPI = ${pixels[0]}×${pixels[1]} 像素(成品实际尺寸不变,只是精度低一点)`
          : `${m[1]}×${m[2]}${unit.label}(按 ${used} DPI)= ${pixels[0]}×${pixels[1]} 像素`,
        unit: unit.label,
        dpi: used,
      };
    }

    /**
     * 「尺寸」框里允许人随便写,插件负责换算成上游那张表里的值。
     *
     * 支持的写法(大小写、空格、全角半角都容忍):
     *   · 像素:`1080x1440` / `1080×1440` / `1080*1440` / `1080 1440` / `1024`(单边 = 方图)
     *   · 比例:`3:4` / `3/4`
     *   · 方向词:`竖版/竖图/portrait`、`竖屏`、`横版/landscape`、`横屏`、`方图/方形/square`
     *   · 常用名:`小红书`、`朋友圈`、`视频号`、`公众号`、`头像`、`壁纸`、`A4`、`封面`、`证件照`…
     *   · 实物尺寸(**写了单位才认**):`210x297mm` / `21x29.7cm` / `8.5x11in` / `210×297 毫米`
     *     —— 按 DPI 折成像素(默认 300,在「设置」里改)。**裸数字仍然是像素**,不受影响。
     * @param {string} text - 用户输入。
     * @param {number} [dpi] - 实物尺寸的换算基准,缺省 300。
     * @returns {{mode: 'pixel'|'ratio'|'orientation'|'none', pixels: number[]|null, aspect: number|null, note: string}} 解析结果。
     */
    function parseHumanSize(text, dpi) {
      const raw = String(text == null ? '' : text).trim();
      const none = { mode: 'none', pixels: null, aspect: null, note: '' };
      if (!raw) return none;

      // 1) 常用名(先匹配:这些词里可能带数字,比如「小红书 3:4」)
      const lower = raw.toLowerCase();
      for (const preset of SIZE_KEYWORDS) {
        if (!lower.includes(preset.key.toLowerCase())) continue;
        if (preset.physical) return parseUnitSize(preset.physical, dpi);
        return { mode: 'pixel', pixels: preset.pixels.slice(), aspect: preset.pixels[0] / preset.pixels[1], note: preset.note };
      }

      // 2) 实物尺寸:`210x297mm` / `21x29.7cm` / `8.5x11in` —— 只有**写了单位**才走这条
      const unitSize = parseUnitSize(raw, dpi);
      if (unitSize) return unitSize;

      // 3) 像素:`1080x1440` / `1080×1440` / `1080*1440`(**分隔符必须有**,否则 "1024" 会被拆成 10×24)
      const px = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/.exec(raw) || /^(\d{2,5})\s+(\d{2,5})$/.exec(raw);
      if (px) {
        const w = Number(px[1]);
        const h = Number(px[2]);
        if (w > 0 && h > 0) return { mode: 'pixel', pixels: [w, h], aspect: w / h, note: `${w}×${h}` };
      }
      // 4) 单边数字:1024 → 方图
      const one = /^(\d{3,5})$/.exec(raw);
      if (one) {
        const n = Number(one[1]);
        return { mode: 'pixel', pixels: [n, n], aspect: 1, note: `${n}×${n}(单边数字按方图算)` };
      }

      // 5) 方向词
      const direction = SIZE_DIRECTIONS.find((item) => item.keys.some((key) => lower.includes(key)));
      if (direction) return { mode: 'orientation', pixels: null, aspect: direction.aspect, note: direction.note };

      // 6) 比例:3:4 / 3/4
      const ratio = /^(\d{1,2})\s*[:/]\s*(\d{1,2})$/.exec(raw);
      if (ratio) {
        const a = Number(ratio[1]);
        const b = Number(ratio[2]);
        if (a > 0 && b > 0) return { mode: 'ratio', pixels: null, aspect: a / b, note: `${a}:${b}` };
      }
      return none;
    }

    /**
     * 把输入框里的写法「换算给上游」:这次会发什么、导出会是多少、给人看的一句话。
     * 认不出来就返回 null(界面照旧黄字提醒)。
     * @param {string} model - 当前模型。
     * @param {string} text - 输入框里的文字。
     * @param {number} [dpi] - 实物尺寸(mm/cm/英寸)的换算基准,缺省 300。
     * @returns {{mode: string, send: string, exact: string, hint: string}|null} 换算结果。
     */
    function convertSizeForModel(model, text, dpi) {
      const parsed = parseHumanSize(text, dpi);
      if (parsed.mode === 'none') return null;
      const send = nearestSize(model, parsed.aspect);
      if (parsed.mode === 'pixel') {
        // 裸像素输入也可能超过浏览器画布上限(实物尺寸那边在 parseUnitSize 里已经降过 DPI 了)。
        // 这里等比缩到做得出来的范围并说明缩到了多少 —— 总比提交完才发现导不出来强。
        let outPixels = parsed.pixels;
        let shrinkTip = '';
        if (!parsed.unit) {
          const fit = fitScale(outPixels[0], outPixels[1]);
          if (fit < 1) {
            outPixels = [Math.max(1, Math.round(outPixels[0] * fit)), Math.max(1, Math.round(outPixels[1] * fit))];
            shrinkTip = `(⚠ ${parsed.pixels[0]}×${parsed.pixels[1]} 超过浏览器画布上限,已等比缩到 ${outPixels[0]}×${outPixels[1]})`;
          }
        }
        const exact = `${outPixels[0]}x${outPixels[1]}`;
        /**
         * 上游只认它自己那张表:挑到的档位比例若和你要的不一致,最后那次"本地精确缩放"
         * 就是**拉伸**(圆会变椭圆)。实物尺寸最容易撞上这件事(A4 = 1:1.414,而常见档位是 2:3 / 3:4),
         * 所以差得明显时必须当场说清楚,别让人拿到变形的东西还不知道为什么。
         */
        const sendAspect = sizeAspect(send);
        const stretch = sendAspect && parsed.aspect > 0 ? Math.abs(Math.log(sendAspect / parsed.aspect)) : 0;
        const stretchTip =
          exact !== send && stretch > 0.02
            ? `(⚠ 上游没有比例正好吻合的档位 —— 这一步会有约 ${Math.max(1, Math.round(Math.abs(Math.exp(stretch) - 1) * 100))}% 的拉伸;要精确比例就用「扩图/留白」类模板)`
            : '';
        // 写了单位(mm/cm/英寸)的:先把换算过程说清楚(多少毫米 → 多少像素),再说上游收什么
        if (parsed.unit) {
          const whyUnit = sizeFormatOf(model) === 'pixel' ? '(它只认自己那张表)' : '';
          return {
            mode: 'pixel',
            send,
            exact,
            hint:
              exact === send
                ? `${parsed.note};上游收「${send}」—— 正好一致`
                : `${parsed.note};上游收「${send}」${whyUnit}${stretchTip},导出时本地精确缩放到 ${outPixels[0]}×${outPixels[1]} 像素`,
          };
        }
        // 裸数字(没写单位)= 像素。但做印刷的人常把 210x297 当毫米写,值偏小时顺手提醒一句
        const maybeMm =
          Math.max(parsed.pixels[0], parsed.pixels[1]) < 500
            ? `(没写单位 = 按像素算;要按毫米算请写 ${parsed.pixels[0]}x${parsed.pixels[1]}mm)`
            : '';
        if (exact === send) {
          return { mode: 'pixel', send, exact, hint: `换算:上游收「${send}」—— 正好一致,导出也是这个尺寸${maybeMm}${shrinkTip}` };
        }
        // 像素模型的措辞要点明"只认自己那张表";比例模型就不提这句(它认的就是比例)
        const why = sizeFormatOf(model) === 'pixel' ? '(它只认自己那张表)' : '';
        return {
          mode: 'pixel',
          send,
          exact,
          hint: `换算:上游收「${send}」${why}${stretchTip};导出时本地精确缩放到 ${outPixels[0]}×${outPixels[1]}${maybeMm}${shrinkTip}`,
        };
      }
      return { mode: parsed.mode, send, exact: '', hint: `换算:${parsed.note} → 上游收「${send}」` };
    }

    /**
     * 「成品尺寸」的常用快捷值(点一下填进输入框;最终会本地精确缩放到这个尺寸)。
     *
     * `value` 可以写**像素**(`1080x1440`),也可以写**实物尺寸**(`210x297mm`)——
     * 后者点的时候按当前 DPI 换算成像素,所以换 DPI 之后这些按钮跟着变。
     */
    /**
     * 从「尺寸关键词表」(02 里那份 `SIZE_KEYWORDS`)取像素:`小红书` → `1080x1440`。
     * 取不到就返回空串,让上层 filter 掉 —— 按钮点了没反应比少一个按钮更难查。
     * @param {string} key - 关键词(和尺寸框里能打的字一致)。
     * @returns {string} `宽x高` 或空串。
     */
    function keywordPixels(key) {
      const table = typeof SIZE_KEYWORDS !== 'undefined' && Array.isArray(SIZE_KEYWORDS) ? SIZE_KEYWORDS : [];
      const hit = table.find((item) => item.key === key);
      return hit && Array.isArray(hit.pixels) && hit.pixels.length === 2 ? `${hit.pixels[0]}x${hit.pixels[1]}` : '';
    }

    const COMMON_OUTPUT_SIZES = [
      // 像素值只在 02 的 `SIZE_KEYWORDS`(尺寸框能认的词)里写一次,这里只挑用哪几个 ——
      // 同一个平台尺寸写两遍的话,改一处忘另一处就会出现"按钮给的值和手打关键词的结果不一样"。
      { label: '小红书 3:4', value: keywordPixels('小红书'), note: '竖版图文封面', batch: true },
      { label: '方图 1:1', value: keywordPixels('头像'), note: '头像 / 商品主图', batch: true },
      { label: '朋友圈 4:5', value: keywordPixels('朋友圈'), note: '竖版海报', batch: true },
      { label: '视频号 9:16', value: keywordPixels('视频号'), note: '竖屏封面 / 壁纸', batch: true },
      { label: '横幅 16:9', value: keywordPixels('横屏'), note: '横版封面 / PPT', batch: true },
      { label: '公众号封面', value: keywordPixels('公众号'), note: '2.35:1 头条封面' },
      { label: 'A4 证件照 3:4', value: keywordPixels('证件照'), note: '打印友好' },
      { label: '名片 90×54mm', value: '90x54mm', note: '标准名片(要出血自己加)' },
      { label: 'A4 210×297mm', value: '210x297mm', note: '印刷底稿(按 DPI 换算)' },
      { label: '5 寸照片 89×127mm', value: '89x127mm', note: '3.5×5 英寸' },
      { label: '6 寸照片 102×152mm', value: '102x152mm', note: '4×6 英寸' },
    ].filter((item) => item.value);

    /**
     * 「尺寸」里代表「跟着图走」的特殊值。
     *
     * 选它时,提交前用**实际要发出去那张图**的宽高比(有主图就用主图,勾了裁剪就用裁出来那块,
     * 只发参考图就用第一张参考图)去就近挑一个模型认识的值。
     *
     * 为什么需要它:`auto` 是"让上游自己定"(gpt-image 系常常给 1:1),而一个具体值
     * (如模板套上的 864x1152)会被写进 prefs 一直粘着 —— 用户上传竖图却总拿到方图/固定比例,
     * 就是这么来的。选「原图比例」则每次都跟着当前这张图算。
     */
    const SOURCE_SIZE = 'source';
    /** 「原图比例」在输入框/候选里的显示文字(存的是 `SOURCE_SIZE`,显示给它看)。 */
    const SOURCE_TEXT = '原图比例';
    /** 「原图比例」在候选项里的完整说明。 */
    const SOURCE_LABEL = '原图比例(跟随提交的那张图)';

    /** `1024x1024` → [1024, 1024];不是像素值给 null。 */
    function parsePixelSize(value) {
      const m = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/.exec(String(value || '').trim());
      if (!m) return null;
      const w = Number(m[1]);
      const h = Number(m[2]);
      return w > 0 && h > 0 ? [w, h] : null;
    }

    /** `3:4` → 0.75;不是比例给 null。 */
    function parseRatio(value) {
      const m = /^(\d{1,2})\s*[:/]\s*(\d{1,2})$/.exec(String(value || '').trim());
      if (!m) return null;
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (!(a > 0) || !(b > 0)) return null;
      return a / b;
    }

    /**
     * 估算「即将出现的那张图」的宽高比 —— 只给画布上的**生成占位框**用。
     *
     * 提交那一刻真实像素还不知道(要等上游出图),但比例基本是定死的:
     * 勾了成品尺寸 → 本地最后会缩到它,比例就是它;
     * 否则就是这次发给上游的那个 `aspectRatio`(像素值 / 比例 / 方向词都认);
     * 再不行退回提交图自己的比例。全认不出才假定方图。
     * @param {{exactSize?: string, aspectRatio?: string, sourceAspect?: number}} input - 本次提交的尺寸信息。
     * @returns {number} 宽高比(>0)。
     */
    function placeholderAspect(input) {
      const exact = parsePixelSize(input && input.exactSize);
      if (exact) return exact[0] / exact[1];
      const fromApi = sizeAspect(input && input.aspectRatio);
      if (fromApi) return fromApi;
      const source = Number(input && input.sourceAspect) || 0;
      return source > 0 ? source : 1;
    }

    /** 把任意尺寸写成宽高比(像素/比例/方向词/直接给数字都认);认不出给 null。 */
    function sizeAspect(value) {
      if (typeof value === 'number') return value > 0 ? value : null;
      const key = String(value == null ? '' : value).trim();
      const px = parsePixelSize(key);
      if (px) return px[0] / px[1];
      const ratio = parseRatio(key);
      if (ratio) return ratio;
      if (key === 'portrait') return 3 / 4;
      if (key === 'landscape') return 4 / 3;
      if (key === 'square') return 1;
      return null;
    }

    /**
     * 模型 → 它的尺寸候选表。
     * 命中主名 → 别名 → 按家族猜(用户还可以手填任意模型名)→ 都没有就只给 auto。
     */
    function sizeTableFor(model) {
      const key = String(model || '').trim();
      if (MODEL_SIZES[key]) return MODEL_SIZES[key];
      if (MODEL_SIZE_ALIAS[key] && MODEL_SIZES[MODEL_SIZE_ALIAS[key]]) return MODEL_SIZES[MODEL_SIZE_ALIAS[key]];
      if (/^gpt-image/i.test(key)) return MODEL_SIZES['gpt-image-2'];
      if (/^nano-banana/i.test(key)) return MODEL_SIZES['nano-banana'];
      if (/^minimax/i.test(key)) return MODEL_SIZES['minimax-h3'];
      return ['auto'];
    }

    /** 这张表吃的是像素、比例,还是一次性方向词。 */
    function sizeFormatOf(model) {
      const list = sizeTableFor(model).filter((v) => v !== 'auto');
      if (!list.length) return 'unknown';
      if (list.every((v) => parsePixelSize(v))) return 'pixel';
      if (list.every((v) => parseRatio(v))) return 'ratio';
      return 'enum';
    }

    /** 下拉候选:值 + 官方标注。第一项永远是「原图比例」。 */
    function sizeOptionsFor(model) {
      const key = String(model || '').trim();
      const alias = MODEL_SIZE_ALIAS[key];
      const labels = SIZE_LABELS[key] || SIZE_LABELS[alias] || {};
      const source = [{ value: SOURCE_TEXT, label: SOURCE_LABEL }];
      if (MODEL_SIZES[key] || (alias && MODEL_SIZES[alias]) || /^(gpt-image|nano-banana|minimax)/i.test(key)) {
        return source.concat(sizeTableFor(model).map((value) => ({ value, label: labels[value] || value })));
      }
      // 认不出的模型(用户自己填的名字):给一份常见值当参考,写什么都原样发上游
      return source.concat(['auto'].concat(COMMON_SIZES).map((value) => ({ value, label: value })));
    }

    /** 这个模型认不认这个值(严格匹配它的清单)。「原图比例」谁都收(提交前才换算)。 */
    function isValidSize(model, value) {
      const key = String(value == null ? '' : value).trim();
      if (key === SOURCE_SIZE) return true;
      return sizeTableFor(model).indexOf(key) >= 0;
    }

    /**
     * 把某个模型的尺寸表整理成**菜单分组**,让人能"挑"而不是"猜着打"。
     *
     * 像素模型按比例分组(3:4 / 1:1 / 16:9 …),组内按 1K→4K 排;比例模型/方向词模型各成一组。
     * @param {string} model - 模型名。
     * @returns {Array<{title: string, items: Array<{value: string, label: string}>}>} 分组。
     */
    function sizeMenuGroups(model) {
      const pixel = [];
      const plain = [];
      for (const option of sizeOptionsFor(model)) {
        if (option.value === SOURCE_TEXT || option.value === 'auto') continue;
        if (parsePixelSize(option.value)) pixel.push(option);
        else plain.push(option);
      }
      const groups = [];
      if (plain.length) {
        groups.push({
          title: sizeFormatOf(model) === 'enum' ? '方向' : '比例',
          items: plain.map((option) => ({ value: option.value, label: option.value })),
        });
      }
      const byRatio = new Map();
      for (const option of pixel) {
        const px = parsePixelSize(option.value);
        const inside = /\(([^)]+)\)/.exec(option.label);
        const parts = inside ? inside[1].split(',').map((piece) => piece.trim()) : [];
        const ratio = parts[0] || `${px[0]}×${px[1]}`;
        const tier = parts[1] || '';
        if (!byRatio.has(ratio)) {
          const group = { title: ratio, items: [] };
          byRatio.set(ratio, group);
          groups.push(group);
        }
        byRatio.get(ratio).items.push({ value: option.value, label: tier ? `${option.value} · ${tier}` : option.value });
      }
      return groups;
    }

    /**
     * 把一张已解码的图**精确缩放**到指定尺寸,返回新的 dataURL。
     *
     * 上游的图像模型只认它自己那张尺寸表(不能随便报任意像素),所以"我要 1080×1440"
     * 这件事只能这样落地:让它按最接近的档位渲染,回来以后在本地缩到你要的精确尺寸 ——
     * 交付出去的文件尺寸就是你要的那个。
     * @param {HTMLImageElement} element - 已解码的图。
     * @param {number} w - 目标宽。
     * @param {number} h - 目标高。
     * @returns {string} 新的 dataURL。
     */
    function resizeDataUrl(element, w, h) {
      // 浏览器单张 canvas 的面积上限约 2^28:超了 getContext 会给 null(下一行就 TypeError),
      // 或者 drawImage 悄悄失败、toDataURL 返回 'data:,' —— 出图的人只会看到一张空图。
      // 这里先拦一道,报个能看懂的原因。
      if (!(Number(w) > 0 && Number(h) > 0)) throw new Error('目标尺寸不合法');
      if (w > 16384 || h > 16384 || w * h > 268435456) {
        throw new Error(`目标尺寸太大(${w}×${h}):单张最多 16384 像素边长 / 2.6 亿像素`);
      }
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const c = off.getContext('2d');
      if (!c) throw new Error(`这台机器给不出 ${w}×${h} 的画布(内存不足)`);
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
      c.drawImage(element, 0, 0, w, h);
      // 原图是 JPEG 就还存 JPEG(体积小);否则 PNG(保住透明通道)
      const isJpeg = /^data:image\/jpe?g/i.test(String(element.src || ''));
      const out = isJpeg ? off.toDataURL('image/jpeg', 0.95) : off.toDataURL('image/png');
      // toDataURL 失败时返回 'data:,'(5 字节),不是空串,别用 !out 判
      if (!out || out.length < 64) throw new Error(`缩放到 ${w}×${h} 失败(浏览器没画出来)`);
      return out;
    }

    /** 兜底值:有 auto 就用 auto,没有就用清单第一项(minimax-h3 就没有 auto)。 */
    function defaultSizeFor(model) {
      const list = sizeTableFor(model);
      if (list.indexOf('auto') >= 0) return 'auto';
      return list.length ? list[0] : 'auto';
    }

    /**
     * 在模型的清单里挑长宽比最接近 target 的那个值。
     * 比例差得一样时取面积小的那档(1K 优先):省额度,也更不容易触发上游的大图限制。
     * @param {string} model - 模型名。
     * @param {number} target - 目标宽高比。
     * @returns {string} 清单里的值。
     */
    function pickClosestSize(model, target) {
      let best = defaultSizeFor(model);
      let bestScore = Infinity;
      let bestArea = Infinity;
      for (const value of sizeTableFor(model)) {
        const aspect = sizeAspect(value);
        if (aspect === null) continue;
        const score = Math.abs(Math.log(aspect / target));
        const px = parsePixelSize(value);
        const area = px ? px[0] * px[1] : Infinity;
        if (score < bestScore - 1e-9 || (score <= bestScore + 1e-9 && area < bestArea)) {
          best = value;
          bestScore = score;
          bestArea = area;
        }
      }
      return best;
    }

    /**
     * 把「比例」换算成某个模型能吃的值 —— 模板里写的是比例(如证件照的 3:4),
     * 碰到只认像素的模型就得翻译过去:
     *   · 比例模型:清单里有就直接用;
     *   · 像素模型:在它的清单里挑长宽比最接近的;同比例取像素最少的那档(1K 优先);
     *   · 方向模型:按宽高比给 portrait / landscape / square;
     *   · 认不出的模型:原样返回(用户可能自己填了个上游认识的怪值)。
     * @param {string} model - 模型名。
     * @param {string|number} wanted - 比例写法(`3:4`)、像素值(`1024x1024`)、方向词、或直接给宽高比数字。
     * @returns {string} 模型认识的值(`SOURCE_SIZE` 与认不出的模型会原样返回)。
     */
    function nearestSize(model, wanted) {
      const list = sizeTableFor(model);
      // 直接给宽高比(「原图比例」那条路:9419/15000 = 0.628)
      if (typeof wanted === 'number') {
        if (!(wanted > 0)) return defaultSizeFor(model);
        if (sizeFormatOf(model) === 'unknown') return defaultSizeFor(model);
        if (sizeFormatOf(model) === 'enum') {
          if (wanted < 0.97 && list.indexOf('portrait') >= 0) return 'portrait';
          if (wanted > 1.03 && list.indexOf('landscape') >= 0) return 'landscape';
          if (list.indexOf('square') >= 0) return 'square';
        }
        return pickClosestSize(model, wanted);
      }
      const want = String(wanted == null ? '' : wanted).trim();
      if (list.indexOf(want) >= 0) return want;
      if (want === SOURCE_SIZE) return want; // 「原图比例」要等提交时拿到真实宽高比,这里不猜
      if (!want || want === 'auto' || !list.length) return defaultSizeFor(model);
      const target = sizeAspect(want);
      if (target === null || !(target > 0)) {
        // 认不出的写法:认不出格式的模型就原样交给上游试,别的模型退回兜底值
        return sizeFormatOf(model) === 'unknown' ? want : defaultSizeFor(model);
      }
      const format = sizeFormatOf(model);
      if (format === 'unknown') return want; // 不认识的模型别乱改用户填的值
      if (format === 'enum') {
        if (target < 0.97 && list.indexOf('portrait') >= 0) return 'portrait';
        if (target > 1.03 && list.indexOf('landscape') >= 0) return 'landscape';
        if (list.indexOf('square') >= 0) return 'square';
      }
      return pickClosestSize(model, target);
    }

    /** 提交/换模型前把值掰合法:合法原样,不合法就就近换算,再不行用模型的兜底值。 */
    function normalizeSize(model, value) {
      const want = String(value == null ? '' : value).trim();
      if (isValidSize(model, want)) return want; // 「原图比例」在这里也会原样留下
      const fixed = nearestSize(model, want);
      // nearestSize 原样退回说明是它认不出的模型(别二次校验又改成兜底值)
      if (fixed === want) return want;
      return isValidSize(model, fixed) ? fixed : defaultSizeFor(model);
    }

    /** 当前值和模型不匹配时,给用户的一句提示;没问题返回空串。 */
    function sizeWarning(model, value) {
      const want = String(value == null ? '' : value).trim();
      if (!want || isValidSize(model, want)) return '';
      // 用户正在打「原图比例」这几个字,别打断他
      if (want === SOURCE_SIZE || SOURCE_TEXT.startsWith(want) || SOURCE_SIZE.startsWith(want)) return '';
      if (sizeFormatOf(model) === 'unknown') return ''; // 不认识的模型:没资格说人家填错了
      const format = sizeFormatOf(model);
      const how = format === 'pixel' ? '只认像素值' : format === 'ratio' ? '只认比例' : format === 'enum' ? '只认 portrait / landscape / square' : '只认 auto';
      return `模型「${model}」${how}:「${want}」发了会被上游拒绝,提交时会自动按「${normalizeSize(model, want)}」发`;
    }

    /**
     * 上游报「这个尺寸不支持」时,给出能照着做的中文提示(+ 自动换算出来的合法值)。
     * @returns {{size: string, hint: string}|null} 不是尺寸问题给 null。
     */
    function sizeErrorFix(model, value, message) {
      const text = String(message || '');
      if (!/(does\s*not\s*support|unsupported|not\s*supported|invalid|不支持)/i.test(text)) return null;
      if (!/(size|aspect|ratio|pixel|resolution|parameter|尺寸|像素|比例)/i.test(text)) return null;
      const want = String(value == null ? '' : value).trim();
      const fixed = normalizeSize(model, want);
      const example = (text.match(/(\d{2,5}\s*[x×]\s*\d{2,5})/) || [])[1] || '';
      if (fixed !== want) {
        return {
          size: fixed,
          hint: `「${want}」这个模型不支持,已自动换成「${fixed}」—— 再点一次「按标注改图」就行${example ? `(上游要的格式类似 ${example.replace(/\s+/g, '')})` : ''}`,
        };
      }
      return {
        size: fixed,
        hint: `模型「${model}」的尺寸只能填它固定清单里的值${example ? `(如 ${example.replace(/\s+/g, '')})` : ''},在「尺寸」框里选一个再试`,
      };
    }

    /**
     * 拼发往上游 `/v1/api/generate` 的请求体。
     *
     * 抽成纯函数是为了能离线测「不同模型的尺寸字段」—— 这是唯一一处
     * 把 UI 上选的尺寸翻译成上游要的格式的地方:
     * `gpt-image-2-vip` 要 '864x1152' 这种像素值,`nano-banana*` 要 '3:4' 这种比例。
     *
     * `ratio === SOURCE_SIZE`(「原图比例」)时用 `sourceAspect`(实际要发出去那张图的宽高比)
     * 就近换算;拿不到宽高比就退回 `auto`。**`outputSize`(成品尺寸)优先级最高**:
     * 用户明确要 `1080x1440` 就按它挑最接近的档位(精确尺寸在本地缩放完成)。
     * @param {{model: string, prompt?: string, images?: string[], ratio?: string, sourceAspect?: number, outputSize?: string, quality?: string, background?: string, imageSize?: string}} input - 当前表单。
     * @returns {object} 请求体。
     */
    function buildGenerateBody(input) {
      const model = String((input && input.model) || '').trim();
      const wanted = String((input && input.ratio) == null ? '' : input.ratio).trim();
      const sourceAspect = Number(input && input.sourceAspect) || 0;
      // 「成品尺寸」优先:用户明确说了要多大,就按那个比例去挑最接近的档位
      const exact = input && input.outputSize ? parsePixelSize(input.outputSize) : null;
      const aspectRatio = exact
        ? nearestSize(model, exact[0] / exact[1])
        : wanted === SOURCE_SIZE
          ? sourceAspect > 0
            ? nearestSize(model, sourceAspect)
            : defaultSizeFor(model) // 没图可跟:退到该模型的兜底值(minimax-h3 没有 auto)
          : normalizeSize(model, wanted);
      const body = {
        model,
        prompt: String((input && input.prompt) || ''),
        images: (input && input.images) || [],
        aspectRatio,
        replyType: 'async',
      };
      const imageSize = input && input.imageSize;
      // 分辨率档位只有 nano-banana 系认(上游也是这么判的)
      if (model.indexOf('nano-banana') === 0 && imageSize && imageSize !== 'auto') body.imageSize = imageSize;
      if (input && input.quality && input.quality !== 'auto') body.quality = input.quality;
      if (input && input.background && input.background !== 'auto') {
        body.background = input.background;
        // 透明底必须**连 output_format 一起**要:JPEG 装不下 alpha,上游会直接回 400
        // "Transparent background is not supported for JPEG output format";而不写 output_format
        // 时,拿回来的常是无 alpha 的 24 位图 —— 看着像透明,其实是把灰白棋盘格画进了像素里。
        // (gpt-image-2 的 background:transparent 是 2026-08-21 才开放的,2.5 系同参数。)
        if (input.background === 'transparent') body.output_format = 'png';
      }
      return body;
    }

    // ── 零件 04-preflight.js ─────────────────────────────────────────────────────────
    /** 画布把「正在编辑的提示词 + 文字图层」同步到这个文件,好让对话里的 AI 能读到并帮忙检查。 */
    const DRAFT_REL = '画布/draft.json';

    /**
     * 提交前自检 —— 把「老忘记写」的要求找出来,并给出可直接追加进提示词的句子。
     *
     * 为什么要它:图像模型只会照提示词做。漏写「保持五官一致」「不要拉伸变形」这类要求时,
     * 它就自由发挥 —— 把人脸改了、把整张图重画一遍、把画面糊掉。这几句几乎每次都要写,
     * 却最容易忘,所以提交前自动列出来,点一下就能补上。
     *
     * 设计原则(改规则时请守住):
     *   1. **宁可少提醒,不可瞎提醒** —— 每次都弹一屏,用户三秒钟就学会无视它;
     *   2. **匹配要宽松** —— 只要沾到边就算"写过了",不做教条式检查;
     *   3. **能一键补的才给 fix** —— 给不出确切句子就别硬凑,prompt 里的废话也是负担;
     *   4. **数组顺序 = 面板上的显示顺序**,把"必然翻车"的放最前面。
     *
     * 纯函数(不碰 DOM / 状态),便于离线测。
     * @param {{prompt?: string, skillPrompt?: string, skillId?: string, marks?: Array<object>,
     *   textCount?: number, refCount?: number, cropToMark?: boolean, submitTexts?: boolean,
     *   hasTarget?: boolean}} input - 当前表单与画布状态。
     * @returns {{issues: Array<{id: string, text: string, fix: string|null, action: string|null}>}} 检查结果。
     */
    function preflightChecks(input) {
      const src = input || {};
      const prompt = String(src.prompt || '');
      const skillPrompt = String(src.skillPrompt || '');
      // 已经套用的 Skills 模板文字也算"写过了",别重复提醒
      const all = `${prompt}\n${skillPrompt}`;
      const marks = Array.isArray(src.marks) ? src.marks : [];
      const textCount = Number(src.textCount) || 0;
      const refCount = Number(src.refCount) || 0;
      const own = prompt.trim();
      const issues = [];
      /** 提示词 + 模板里有没有沾到某个意思(宽松匹配,命中一个词就算)。 */
      const has = (re) => re.test(all);

      // ① 画了标注却一个字没写 —— 标注只圈得出"改哪里",说不出"改成什么",必翻车
      if (marks.length && !own) {
        const kinds = new Set(marks.map((m) => m.kind));
        const what = kinds.has('arrow') ? '箭头' : kinds.has('text') ? '手写文字' : '框选';
        issues.push({
          id: 'marks-no-prompt',
          text: `画了${what},但提示词是空的 —— 标注只说得清"改哪里",说不清"改成什么"`,
          fix: null,
          action: null,
        });
      }

      // ② 什么都没写就点提交 —— 模型只能自己猜你想干嘛
      if (!own && !skillPrompt && !marks.length) {
        issues.push({
          id: 'prompt-empty',
          text: '还没写要求 —— 直接提交的话,模型只能自己猜你想改什么',
          fix: null,
          action: null,
        });
      } else if (own && own.length < 8 && !skillPrompt) {
        // ③ 写了,但短到几乎没有信息量(标点、单字、"改一下"这种)
        issues.push({
          id: 'prompt-thin',
          text: `要求只有「${own}」这么短 —— 模型会自由发挥,出什么全看运气`,
          fix: null,
          action: null,
        });
      }

      // ④ 图上有本地文字图层,却没告诉模型"别画字"
      if (textCount > 0 && src.skillId !== 'no-text-space' && !src.submitTexts) {
        issues.push({
          id: 'local-text',
          text: `图上有 ${textCount} 条文字图层,却没告诉模型"别画字" —— 模型"画"出来的字必然是糊的,还常写错笔画`,
          fix: null,
          action: 'skill:no-text-space',
        });
      }

      // ⑤ 人像场景:AI 改图最常见的翻车就是"换脸",而且换得毫无征兆
      if (
        has(/人像|人物|人脸|肖像|证件照|写真|头像|模特|自拍|脸型|五官|肤质|全身照|半身/) &&
        !has(/不换脸|不要换脸|不许换脸|五官.{0,6}(一致|不变|保持)|长相.{0,6}(一致|不变|保持)|保持.{0,8}(脸|五官|长相|肤色)|同一(个)?人/)
      ) {
        issues.push({
          id: 'face-identity',
          text: '提到了人,但没写"不要换脸" —— 模型很容易改成另一张脸,或者顺手磨成塑料皮',
          fix: '保持人物的五官、长相、脸型、肤色与年龄特征完全一致:不要换脸、不要变成另一个人,不要过度磨皮美颜,保留皮肤的真实纹理。',
          action: null,
        });
      }

      // ⑥ 有目标图,却没写"保持主体不变" —— 模型可能把整张图重画一遍
      if (src.hasTarget && !has(/保持|保留|维持|不变|一致|不要改|别改|原样|原封不动|不许改|照旧/)) {
        issues.push({
          id: 'keep-subject',
          text: '没写"保持主体不变" —— 模型容易顺手把整张图重画一遍',
          fix: '保持主体的外形、姿态、构图、颜色与光影完全不变,只改我指定的地方。',
          action: null,
        });
      }

      // ⑦ 商品 / 包装 / 品牌场景:商标和型号字被"重写"一次,货就废了
      if (
        has(/商品|产品|包装|品牌|商标|logo|标志|标签|外盒|瓶身|罐身|吊牌/) &&
        !has(/(保留|保住|保持|别动|不要动|不要改).{0,20}(商标|logo|标志|文字|标签|包装|字样)|(商标|logo|标志|文字|标签).{0,8}(保留|不变|不要改|别改)|原样.{0,6}(文字|商标|标签)/)
      ) {
        issues.push({
          id: 'protect-brand',
          text: '有商品/包装元素,但没写"保住商标与型号字" —— 模型会把它们重画成另一个字样',
          fix: '完整保留商品与包装上的商标、logo、型号文字、标签和所有印刷细节,字形与位置都保持原样,不要改动、重写或抹掉它们。',
          action: null,
        });
      }

      // ⑧ 输出质量要求
      if (!has(/清晰|锐利|高清|细节|模糊|噪点|压缩|变形|拉伸|宽高比|分辨率/)) {
        issues.push({
          id: 'sharpness',
          text: '没写清晰度要求 —— 容易被糊化或拉伸变形',
          fix: '输出保持清晰锐利、细节完整、不要模糊或出现噪点,不要拉伸变形,不要改变原始宽高比。',
          action: null,
        });
      }

      // ⑨ 别自作主张加东西(模型最爱偷偷加文字、水印、边框)
      if (!has(/不要.*(文字|水印|logo|标志|边框|装饰|贴纸|花纹)|不加|无文字|没有任何文字|保持.{0,4}简洁/)) {
        issues.push({
          id: 'no-extra',
          text: '没写"不要多余元素" —— 模型有时会自己加文字、水印或边框',
          fix: '不要添加任何文字、水印、签名、边框、贴纸或多余装饰,画面保持干净简洁。',
          action: null,
        });
      }

      // ⑩ 带了参考图却没说它们是干嘛的(画布角标和生成卡片上的「参考图 N」就是提示词里能用的编号)
      if (refCount > 0 && !has(/参考|参照|借鉴|融合|以.{0,4}为准|只改.{0,6}主图|第一张|主图是/)) {
        issues.push({
          id: 'ref-usage',
          text: `带了 ${refCount} 张参考图,但没说它们算什么 —— 模型可能把参考图也一起改了`,
          fix: '第一张是要修改的主图,后面的是参考图:只改主图,参考图仅用于参考风格/姿势/配色。也可以直接写「参考图1」「参考图2」指到具体哪张(画布角标上的编号)。',
          action: null,
        });
      }

      // ⑪ 勾了裁剪:提醒"标注在哪儿"这件事本身不会传给模型(这条给不出 fix,只提示)
      if (src.cropToMark && marks.length) {
        const onlyText = marks.every((m) => m.kind === 'text');
        issues.push({
          id: 'crop-marks',
          text: onlyText
            ? '勾了裁剪:手写文字的内容会传给模型,但"写在哪个位置"不会'
            : '勾了裁剪:标注痕迹不画进提交图,"标注在哪儿"也不会 —— 模型只看得到裁出来那块画面',
          fix: null,
          action: null,
        });
      }

      return { issues };
    }

    // ── 零件 05-skills.js ────────────────────────────────────────────────────────────
    /**
     * 内置「Skills 模板」:画布自用的一键套路。
     * **选中才生效,不选就是普通改图**;选中后模板文字会排在你写的要求前面一起提交。
     * 自定义模板存在工作区 `画布/skills.json`(随项目走)。
     */
    const BUILTIN_SKILLS = [
      {
        id: 'ip-turnaround', name: 'IP 三视图设定表', desc: '正面/侧面/背面 + 表情/细节/比例,一张出齐',
        prompt: '把参考角色整理成一张完整的 IP 角色设定表(三视图):横版整张构图,浅色干净背景,像官方角色设计稿那样分区分栏、栏框带细线。画面上出现的所有文字一律用简体中文,字迹工整清楚,不要出现英文、日文、水印、签名或二维码。'
          + '版式分成四块:①顶部标题区,正中放角色名(用我下面写的名字,我没写就写「角色名」),名字下方一行小字副标题,标题左右各放一句短标语;'
          + '②第一行四个等大的全身立绘,从左到右依次为正面视图、侧面视图、背面视图、动作姿势,每个立绘下方各标一行中文标签,四格角色的长相、发型发色、瞳色、服装与配饰必须完全一致;'
          + '③第二行三栏,每栏带中文栏名:「表情」放三格头像特写,分别为平静、开心、大笑并逐格标中文;「细节」放四到六格局部特写,把角色最有辨识度的头饰、耳饰、服装纹样、尾巴或随身配饰、鞋子逐个放大画出并标中文名;「比例」左侧一个完整立绘、右侧用横线标出头长等分,下方注明中文头身比,例如「二头身」;'
          + '④底部一行居中放角色名与一句世界观短语。保持二次元 Q 版风格、线条干净、配色统一;保留参考角色的全部标志性特征,不要改设计、不要新增角色、不要换画风。',
        ratio: '4:3', background: 'opaque', quality: 'high', imageSize: '2K',
      },
      {
        id: 'natural-white-balance', name: '自然校色', desc: '纠正偏色和曝光,保留真实质感',
        prompt: '纠正照片的整体偏色与曝光,让白色中性、暗部可辨、亮部保留层次,保持自然的现场光感。保留原有构图、物体颜色关系与材质纹理;人物五官、长相和肤色特征保持一致,不要换脸、磨皮或夸张增艳。不要添加文字、水印或新物体。',
        ratio: 'source', quality: 'high',
      },
      {
        id: 'product-recolor', name: '商品换色', desc: '默认换为深蓝色,可补充目标颜色',
        prompt: '把主体商品的主要外壳或面料换为深蓝色,具体目标颜色以我后面补充的要求为准。仅改变该材质的颜色,保留商品形状、结构、纹理、缝线、原有商标和文字,保持原来的高光、阴影、透视与背景。不要改变配件或新增装饰,不要添加文字、水印和促销元素。',
        ratio: 'source', quality: 'high',
      },
      {
        id: 'product-retouch', name: '商品精修', desc: '去浮尘指纹,保留材质与产品结构',
        prompt: '精修商品照片,清理表面的浮尘、指纹和拍摄造成的轻微污点,让边缘清楚、反光干净且符合原有光源方向。保持产品结构、颜色、材质纹理、型号文字和商标原样,保留真实使用痕迹和结构接缝,不要把金属、玻璃或皮革磨成塑料。构图与背景不变,不要添加文字、水印或配件。',
        ratio: 'source', quality: 'high',
      },
      {
        id: 'food-retouch', name: '美食修图', desc: '改善食物光色,不改变份量和配料',
        prompt: '把这张美食照片处理成自然的餐饮展示图,调整偏色与明暗,突出食物真实的纹理、汁水和新鲜感,使餐具与桌面干净协调。保留菜品种类、配料、份量、摆盘、餐具及原有构图,不添加原图没有的食材、蒸汽或装饰。不要过度饱和、油亮失真,不要添加文字、价格或水印。',
        ratio: 'source', quality: 'high',
      },
      {
        id: 'portrait-natural', name: '自然人像精修', desc: '轻修临时瑕疵,不瘦脸不换脸',
        prompt: '对人像做自然、克制的精修,改善曝光和肤色偏色,清理临时痘痘与轻微油光,保留毛孔、皮肤纹理、痣和年龄特征。保持五官、真实长相、脸型、体型、姿态、发型、衣服及背景一致,不要换脸、瘦脸、放大眼睛或过度磨皮。不要新增妆容、首饰、文字或水印。',
        ratio: 'source', quality: 'high',
      },
      {
        id: 'photo-lineart', name: '照片转线稿', desc: '白底黑线,保留主体轮廓与结构',
        prompt: '把照片转换为白底黑线的清晰线稿,使用干净、连续且粗细有层次的线条表达主体轮廓、结构和必要细节,背景简化为少量关键轮廓。保留原构图、透视、物体数量与位置;人物五官特征和长相保持一致,不要换脸。不要大面积黑色填充、灰色阴影、文字、边框或水印。',
        ratio: 'source', background: 'opaque',
      },
      {
        id: 'social-cover', name: '竖版封面底图', desc: '上方留标题空间,文字用本地图层加',
        prompt: '制作一张清爽的竖版生活方式封面底图,默认主题为温暖自然的书桌与阅读,具体主题以我后面补充的要求为准。主要视觉元素集中在中下部,上方保留干净、低细节且颜色均匀的标题区域,构图有层次、光线协调。参考图中的主体特征保持一致。不要生成任何文字、字母、数字、商标或水印,标题由我后期添加。',
        ratio: '3:4', background: 'opaque', quality: 'high',
      },
      {
        id: 'presentation-background', name: '演示文稿配图', desc: '左侧留白,右侧主题插画',
        prompt: '制作一张简洁的横版演示文稿背景,默认采用浅色背景与右侧抽象几何插画,具体主题以我后面补充的要求为准。左侧大部分区域保持干净、低对比、便于后期排文字,右侧主体清晰、视觉层级克制,边缘留足安全空间。保持参考主体的关键特征,不要堆砌元素。不要生成文字、字母、数字、商标、水印或边框。',
        ratio: '16:9', background: 'opaque', quality: 'high',
      },
      {
        id: 'id-photo-white',
        name: '证件照 · 白底',
        desc: '纯白背景、正面免冠、规范头肩比例',
        prompt:
          '把这张照片处理成标准证件照:纯白背景(不要阴影、不要渐变),人物正面免冠、居中,头肩比例符合证件照规范,光线均匀、肤色自然。保持人物的五官与真实长相一致 —— 不要换脸、不要过度美颜;衣服整理平整,不要添加任何文字、边框或水印。',
        ratio: '3:4',
        background: 'opaque',
        quality: 'high',
      },
      {
        id: 'id-photo-blue',
        name: '证件照 · 蓝底',
        desc: '同上,换成标准蓝色背景',
        prompt:
          '把这张照片处理成标准证件照:标准蓝色背景(不要渐变、不要阴影),人物正面免冠、居中,头肩比例符合规范,光线均匀、肤色自然。保持五官与真实长相一致,不要换脸、不要过度美颜;不要添加任何文字、边框或水印。',
        ratio: '3:4',
        background: 'opaque',
        quality: 'high',
      },
      {
        id: 'id-photo-red',
        name: '证件照 · 红底',
        desc: '同上,换成标准红色背景',
        prompt:
          '把这张照片处理成标准证件照:标准红色背景(不要渐变、不要阴影),人物正面免冠、居中,头肩比例符合规范,光线均匀、肤色自然。保持五官与真实长相一致,不要换脸、不要过度美颜;不要添加任何文字、边框或水印。',
        ratio: '3:4',
        background: 'opaque',
        quality: 'high',
      },
      {
        id: 'cutout',
        name: '抠图去背景',
        desc: '主体保留,背景变透明(锁 gpt-image-2)',
        // **必须锁模型**:全平台只有 gpt-image-2(与 2.5 系)认 `background:transparent` 这个参数,
        // nano-banana 全系只能在提示词里求它 —— 求不动时模型就画一张灰白棋盘格冒充透明。
        // 换成别的模型,透明参数会被直接忽略,所以这个模板把模型钉死。
        model: 'gpt-image-2',
        prompt:
          '把主体完整抠出来,背景变成完全透明(PNG 透明通道),边缘干净自然:头发、毛发、半透明部分都要保留,不要白边、不要锯齿。主体自身的位置、姿态、比例、颜色与光影保持完全不变。画面里不要出现地面、桌面、墙壁、天空或任何环境元素与投影,只留主体本身 —— isolated subject on a transparent background, no scenery, no ground, no shadow.',
        background: 'transparent',
        quality: 'high',
      },
      {
        id: 'replace-bg',
        name: '换背景',
        desc: '只换背景,主体一点不动',
        prompt:
          '只替换背景,主体(人物或物体)保持完全不变 —— 位置、姿态、比例、颜色、光影都不许改。新背景的光线与色温要和主体协调,主体边缘过渡自然、没有白边。背景换成什么,看我下面写的那句话。',
      },
      {
        id: 'replace-sky',
        name: '换天空',
        desc: '只换天空,地面前景不动',
        prompt:
          '只替换画面里的天空部分,地面、建筑、人物等所有前景保持完全不变 —— 位置、比例、颜色、光影都不许改。新天空(看我下面写的那句话)的光线与色温要和前景协调,天地交界处过渡自然、没有生硬的分界线。',
        ratio: 'source',
      },
      {
        id: 'remove-watermark',
        name: '去水印',
        desc: '清掉水印/logo/日期戳,画面其余不动',
        prompt:
          '去掉这张图上的水印:半透明水印、平铺的重复水印、logo、印章、日期戳、文字角标都要清干净。被盖住的地方用周围的内容自然填补 —— 纹理、光影、透视、色彩过渡都要接得上,不要留下模糊块、涂抹痕迹或色差。画面其余部分保持原样:人物长相、主体位置、构图、比例、颜色与清晰度都不许改;也不要新增任何文字、logo 或新的水印。',
        ratio: 'source',
      },
      {
        id: 'local-repair',
        name: '局部修复',
        desc: '修划痕/破损/穿帮,自然填补',
        prompt:
          '修复图中被标注圈出的破损、划痕、折痕、污渍或穿帮:用周围的内容自然填补,纹理、光影、透视、色彩过渡都要接得上,不要留下修补痕迹或色差。画面其余部分保持原样 —— 人物长相、主体位置、构图、比例、颜色与清晰度都不许改。',
        ratio: 'source',
      },
      {
        id: 'local-redraw',
        name: '局部重绘',
        desc: '圈哪改哪,边界自然融合',
        prompt:
          '只重绘被标注圈出的区域,把它改成我下面写的样子。新内容要和周围画面自然融合:透视、光线方向、色温、材质、清晰度都要一致,边缘看不出接缝。标注范围之外的画面(主体、构图、颜色、光影)保持完全不变,不要重绘整张图。',
        ratio: 'source',
      },
      {
        id: 'enhance',
        name: '高清修复',
        desc: '提升清晰度,内容不变',
        prompt:
          '提升这张图的清晰度与细节:修复模糊、噪点与压缩伪影,让边缘与纹理更锐利自然。构图、内容、人物长相、颜色都必须保持原样,不要重绘、不要改变风格。',
        quality: 'high',
      },
      {
        id: 'descreen',
        name: '去网纹',
        desc: '翻拍/扫描件去摩尔纹',
        prompt:
          '去掉画面里的摩尔纹、网纹与扫描噪点,恢复干净平滑的色调与清晰的细节,但不要过度磨皮、不要丢失真实纹理。构图、内容、颜色都保持原样。',
        ratio: 'source',
      },
      {
        id: 'ecommerce',
        name: '商品白底图',
        desc: '电商主图:纯白底 + 自然投影',
        prompt:
          '把商品抠出来放到纯白背景上,保留真实的材质、颜色与细节(logo、纹理、反光都要在),加一层柔和自然的投影,构图居中、留出合适边距,适合做电商主图。不要添加任何文字或促销元素。',
        ratio: '1:1',
        background: 'opaque',
        quality: 'high',
      },
      {
        id: 'product-scene',
        name: '商品场景图',
        desc: '把商品放进真实生活场景',
        prompt:
          '把主体商品放进一个真实的生活场景里(场景看我下面写的那句话),保持商品本身的材质、颜色、细节与 logo 完全不变,只改变它周围的环境。场景的光线、色调、透视要和商品协调,商品边缘自然、不悬浮、不穿帮。不要添加任何文字或促销元素。',
        ratio: 'source',
      },
      {
        id: 'outfit',
        name: '换装 / 职业装',
        desc: '只换衣服,脸和姿态不动',
        prompt:
          '把人物的服装换成我下面描述的样子,衣服要自然贴合身形、褶皱与光影合理。人物的面部、发型、体型、姿态和背景都保持完全不变,不要换脸、不要改变长相。',
      },
      {
        id: 'photo-restore',
        name: '老照片修复上色',
        desc: '修划痕、去噪、自然上色',
        prompt:
          '修复这张老照片:去掉划痕、折痕、污渍与噪点,补全轻微破损的区域,并做自然、克制的上色(肤色真实、保留年代感)。保持人物长相与照片原有构图不变,不要变成卡通或插画,不要过度磨皮。',
      },
      {
        id: 'face-restore',
        name: '人脸修复',
        desc: '修复模糊/噪点人脸,不换脸',
        prompt:
          '修复这张照片里的人脸:补清模糊的五官、去掉噪点与压缩伪影,让脸部细节锐利自然。保持人物的真实长相与五官特征完全一致 —— 不要换脸、不要变成另一个人、不要过度美颜;身体、背景、构图、颜色保持原样。',
        ratio: 'source',
      },
      {
        id: 'illustration',
        name: '转插画风格',
        desc: '水彩/插画化,构图不变',
        prompt:
          '把画面转成干净的水彩插画风格:笔触柔和、色块通透、边缘自然,保留原有的构图、主体特征与关键细节。不要改变画面内容与比例。',
      },
      {
        id: 'restyle',
        name: '转风格',
        desc: '按指定风格重绘,构图不变',
        prompt:
          '把这张图整体转成我下面指定的风格(如水彩、油画、国画、3D、像素风),保留原有的构图、主体特征与关键细节,只改变画面风格与质感。转换后的画面干净、完成度高,不要改变画面内容、比例与人物长相。',
        ratio: 'source',
      },
      {
        id: 'line-color',
        name: '线稿上色',
        desc: '线稿/草图渲染成成品',
        prompt:
          '把这张线稿或草图渲染成一张完整的成品图:给人物或物体上色,并补全光影与质感,保留原线稿的构图、姿态与结构。上色风格看我下面写的那句话,默认干净、自然、不改变原结构。',
        ratio: 'source',
      },
      {
        id: 'no-text-space',
        name: '留白配图(本地加字)',
        desc: '不生成任何文字,留出干净区域,字用本机字体本地加',
        prompt:
          '处理/生成这张图,但画面里**绝对不要出现任何文字、字母、数字、水印或 logo**(这些由我后期用本地字体加)。在画面上部或下部留出一块相对干净、颜色均匀、细节较少的区域,方便后期加标题;主体与光线、氛围保持协调,留白自然,不要空洞。',
      },
      {
        id: 'expand',
        name: '扩图补全',
        desc: '向四周扩展,补全被裁掉的场景',
        prompt:
          '把画面向四周自然扩展,补全被裁掉的场景:透视、光线方向、色温、材质与原有风格都要衔接一致,接缝看不出来。原画面里的内容保持不变,不要移动、不要重绘。',
      },
      {
        id: 'recompose',
        name: '重构构图',
        desc: '主体放大/居中/留白重排',
        prompt:
          '调整这张图的构图:把主体按我下面说的方式重新安排(放大、居中、偏移、留白),画面内容与主体本身保持不变,重新填充被移动后空出的区域,透视与光线衔接自然。',
        ratio: 'source',
      },
    ];

    /**
     * 「交给 Agent」入口 —— **不是**图像模板,别和上面那批 `BUILTIN_SKILLS` 混。
     *
     * 上面那批的执行者是 GrsAI 的图像模型(选中后模板文字排在提示词前面一起发出去);
     * 这一条的执行者是 DSH 里的 agent:点击后画布把选中的图落盘到工作区,
     * 再往当前对话发一句话,agent 加载 `image-layering` 技能跑本地脚本,
     * 产出**真正可编辑的 PSD 图层**(每个元素一个独立透明层)。
     *
     * 默认只要 PSD 分支:只调 APIMart 拆图,不碰 Recraft,不产生矢量费用。
     */
    const AGENT_LAYERING = {
      id: 'agent-image-layering',
      name: '图片分层(交给 Agent)',
      desc: '把选中的图交给 DSH agent,用 image-layering 技能拆成可编辑图层,先出 PSD',
      skill: 'image-layering',
      size: '2K',
      timeout: 900,
    };

    /**
     * 内置模板的分组:面板上按类目展示,而不是 30 个平铺一堆。
     * 顺序就是面板上的显示顺序;改模板 / 加模板时记得把 id 归到某一组,
     * 漏掉的会自动落进「其他」组(不会从面板上消失)。
     */
    const SKILL_GROUPS = [
      { label: '人像', ids: ['id-photo-white', 'id-photo-blue', 'id-photo-red', 'outfit', 'face-restore', 'portrait-natural', 'photo-restore'] },
      { label: '商品', ids: ['cutout', 'ecommerce', 'product-scene', 'product-recolor', 'product-retouch', 'food-retouch'] },
      { label: '修复', ids: ['remove-watermark', 'local-repair', 'local-redraw', 'enhance', 'descreen', 'natural-white-balance', 'expand'] },
      { label: '风格', ids: ['illustration', 'restyle', 'line-color', 'photo-lineart', 'recompose'] },
      { label: '背景/配图', ids: ['replace-bg', 'replace-sky', 'no-text-space', 'social-cover', 'presentation-background'] },
    ];

    // ── 零件 06-utils.js ─────────────────────────────────────────────────────────────
    const TOOL_ICONS = {
      select: 'M4 2.5l13.5 7.6-5.8 1.4-1.4 5.8z',
      brush: 'M3.5 17.5c3 0 4.4-2.1 4.4-4.4l7.6-7.6 3 3-7.6 7.6c0 2.3-2.1 3.5-4.4 3.5-1.5 0-2.5-.6-3-2.1z',
      mask: 'M11 4.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM11 4.5v14',
      arrow: 'M4 18L17.5 4.5M17.5 4.5h-6.2M17.5 4.5v6.2',
      rect: 'M4 5.5h14v12H4z',
      ellipse: 'M11 5.5c4 0 7 2.4 7 5.5s-3 5.5-7 5.5-7-2.4-7-5.5 3-5.5 7-5.5z',
      shape: 'M4 6h14v11H4zM4 10h14M4 14h14',
      eraser: 'M7.5 17.5l-3.4-3.4 8-8 4.3 4.3-5.4 5.4zM10.5 19.5h8',
    };

    /**
     * useState 的声明顺序。测试用的假 hooks 按这个顺序喂值,改动组件时同步这里
     * (bundle 会把这份清单导出成 `__stateOrder`,测试会核对数量)。
     */
    const STATE_ORDER = [
      'tool', 'selectedId', 'selectedIds', 'docVersion', 'loaded',
      'apikey', 'keyDraft', 'apiBase', 'baseDraft', 'prompt', 'model', 'ratio', 'quality', 'background', 'imageSize',
      'cropToMark', 'batchSizes', 'appendHint', 'color', 'markWidth',
      'busy', 'phase', 'progress', 'error', 'notice', 'saved',
      'showSettings', 'dockOpen', 'wsFiles', 'wsBusy', 'results',
      'records', 'historyQuery', 'historyFavOnly', 'historyOpenId', 'historyLimit', 'historyCorrupted',
      'compareA', 'compareB', 'compareMode', 'compareSwap', 'compareSlider', 'compareZoom', 'comparePan', 'compareTick',
      'layerRenameId', 'layerRenameText',
      'savePath', 'layerSize', 'showGen', 'showModels', 'showSizes', 'customSize', 'sizeDraft', 'dpiDraft',
      'selectedTextId', 'showText', 'submitTexts', 'fontList',
      'size', 'spaceDown', 'zoomLabel', 'hostStale', 'lastUpstream',
      'skills', 'activeSkillId', 'skillDraft', 'agentBusy', 'layerCfg', 'showLayerKey', 'hostFeatures',
      'showUpscale', 'upscaleTier', 'upscaleScale', 'upscaleBusy', 'upscaleTiers', 'upscaleNote',
      'updateUrl', 'updateDraft', 'updateAuto', 'updateInfo', 'updateStatus', 'updateBusy', 'updateNote',
      'draftSync', 'frameSizeDraft', 'frameDraft', 'selectedFrameId', 'menuAt', 'textEditId', 'expandFrameId',
      'modelsBusy', 'modelsNote',
    ];

    // ── 通用小工具 ──────────────────────────────────────────────────────

    let seq = 0;
    function uid(prefix) {
      seq += 1;
      return `${prefix || 'x'}${Date.now().toString(36)}${seq.toString(36)}`;
    }
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }
    function tokenValue() {
      try {
        return new URLSearchParams(location.search).get('token') || '';
      } catch {
        return '';
      }
    }
    function routeUrl(path, sessionId) {
      const params = [];
      const token = tokenValue();
      if (token) params.push(`token=${encodeURIComponent(token)}`);
      if (sessionId) params.push(`session=${encodeURIComponent(sessionId)}`);
      if (!params.length) return ROUTE + path;
      return `${ROUTE}${path}${path.includes('?') ? '&' : '?'}${params.join('&')}`;
    }
    async function api(path, init, sessionId) {
      // 没有传 signal 就补一个超时:半开的连接会让 /result 轮询永远卡在 await 上,
      // MAX_CONCURRENT_JOBS 被占满后整条队列再也不动,画布上的「打断」也按不动。
      // 45 秒够慢网络传完最大的存档,又能在真的挂死时收口。
      const options = Object.assign({ credentials: 'same-origin' }, init);
      if (!options.signal && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        options.signal = AbortSignal.timeout(45000);
      }
      let response;
      try {
        response = await fetch(routeUrl(path, sessionId), options);
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new Error(`请求超时(45 秒):${path}`);
        }
        throw e;
      }
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!response.ok) throw new Error((data && (data.error || data.msg)) || `HTTP ${response.status}`);
      return data;
    }
    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(blob);
      });
    }
    async function fetchAsDataUrl(url) {
      const init = { credentials: 'same-origin' };
      // 取图也设个上限:图片站挂住不响应时,不封顶就一直占着一个 pending 任务
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(60000);
      let response;
      try {
        response = await fetch(url, init);
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error('取图超时(60 秒):图片地址没有响应');
        throw e;
      }
      if (!response.ok) throw new Error(`取图失败:HTTP ${response.status}`);
      return blobToDataUrl(await response.blob());
    }
    function proxyImageDataUrl(remoteUrl, sessionId) {
      return fetchAsDataUrl(routeUrl(`/image?url=${encodeURIComponent(remoteUrl)}`, sessionId));
    }
    /** 解码一张图,拿它的自然尺寸。 */
    function decodeImage(dataUrl) {
      return new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('图片解码失败'));
        el.src = dataUrl;
      });
    }
    /**
     * dataURL → Blob(复制到剪贴板用)。
     * 先让浏览器自己解:fetch 对 `data:` 是原生解码,几十 MB 的 PNG 也不会把主线程卡住;
     * 万一这个环境不认 data: URL 的 fetch,再退回手写 base64 解码。
     * @param {string} dataUrl - dataURL。
     * @returns {Promise<Blob>} 带正确 MIME 的 Blob。
     */
    async function dataUrlToBlob(dataUrl) {
      const text = String(dataUrl || '');
      if (!/^data:/i.test(text)) throw new Error('不是 dataURL,没法当图片复制');
      if (typeof fetch === 'function') {
        try {
          const res = await fetch(text);
          if (res && res.ok) {
            const blob = await res.blob();
            if (blob && blob.size) return blob;
          }
        } catch {
          /* 走下面的手写解码 */
        }
      }
      const comma = text.indexOf(',');
      if (comma < 0) throw new Error('dataURL 坏了');
      const head = text.slice(0, comma);
      const body = text.slice(comma + 1);
      const binary = /;base64/i.test(head) ? atob(body) : decodeURIComponent(body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
      const mime = (/^data:([^;,]+)/i.exec(head) || [])[1] || 'application/octet-stream';
      return new Blob([bytes], { type: mime });
    }
    /**
     * 把一张图做成「能写进系统剪贴板」的 PNG Blob。
     *
     * 剪贴板里的图只有 PNG 这一种通行写法,而且浏览器会拿声明的类型和 Blob 实际类型对一对 ——
     * 对不上就直接拒收。原图可能是 jpg/webp(甚至就是画布上那张没转过的结果图),
     * 所以不是 PNG 的先按**原始像素**重画成 PNG 再交出去。
     * @param {string} dataUrl - 图片的 dataURL。
     * @returns {Promise<Blob>} image/png 的 Blob。
     */
    async function clipboardPngBlob(dataUrl) {
      const text = String(dataUrl || '');
      if (/^data:image\/png[;,]/.test(text)) {
        const blob = await dataUrlToBlob(text);
        if (blob && blob.type === 'image/png') return blob;
      }
      const el = await decodeImage(text);
      const off = document.createElement('canvas');
      off.width = el.naturalWidth || el.width || 1;
      off.height = el.naturalHeight || el.height || 1;
      off.getContext('2d').drawImage(el, 0, 0);
      return dataUrlToBlob(off.toDataURL('image/png'));
    }
    /**
     * 从 dataURL 的 MIME 推图片后缀。
     *
     * 上游结果图不一定是 PNG(jpeg / webp 都见过),而 `/ws-save` 会校验「文件头与后缀一致」,
     * 所以文件名必须跟着真实格式走 —— 一律写 `.png` 会被宿主当成"内容和后缀对不上"拒掉。
     * @param {string} dataUrl - 图片 dataURL(空/异常时按 png 处理,和上游最常见的情况一致)。
     * @returns {string} `.png` / `.jpg` / `.webp` / `.gif` / `.bmp` / `.avif`。
     */
    function imageExtOf(dataUrl) {
      const m = /^data:([^;,]+)/i.exec(String(dataUrl || ''));
      const mime = m ? m[1].toLowerCase() : '';
      if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
      if (mime === 'image/webp') return '.webp';
      if (mime === 'image/gif') return '.gif';
      if (mime === 'image/bmp') return '.bmp';
      if (mime === 'image/avif') return '.avif';
      return '.png';
    }
    /**
     * 让文件名后缀与 dataURL 的真实格式一致:填 `.png` 却拿到 jpeg,会自动改成 `.jpg`。
     * @param {string} rel - 工作区相对路径(可带后缀,也可不带)。
     * @param {string} dataUrl - 要写进去的图片 dataURL。
     * @returns {string} 修正过后缀的路径。
     */
    function withImageExt(rel, dataUrl) {
      const want = imageExtOf(dataUrl);
      const file = String(rel == null ? '' : rel).trim() || `画布输出/${stamp()}${want}`;
      const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
      const dot = file.lastIndexOf('.');
      const stem = dot > slash + 1 ? file.slice(0, dot) : file;
      return `${stem}${want}`;
    }
    function stamp() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }
    /** 毫秒 → `01:23`(画布上的占位框显示"已经等了多久")。 */
    function durationText(ms) {
      const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }
    /** 比较 `a.b.c` 形式的版本号:a<b 返回 -1,相等 0,更大 1。 */
    function compareVersion(a, b) {
      const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d < 0 ? -1 : 1;
      }
      return 0;
    }
    /** 宿主不支持存档接口时的提示文案。 */
    const STALE_HOST_HINT = '宿主半边还是旧版(没有画布存档接口),画布自动保存/恢复暂时不可用 —— 重启一次 DSH 就会一致。';
    function humanSize(bytes) {
      if (!bytes && bytes !== 0) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    function readPrefs() {
      try {
        return JSON.parse(localStorage.getItem(LS_PREFS) || '{}') || {};
      } catch {
        return {};
      }
    }
    function writePrefs(patch) {
      try {
        localStorage.setItem(LS_PREFS, JSON.stringify(Object.assign(readPrefs(), patch)));
      } catch {
        /* 隐私模式忽略 */
      }
    }
    /**
     * 把用户填的「同时生成数」夹进 1–MAX_CONCURRENT_JOBS_MAX。
     * 空值/写坏了就回默认值 —— 宁可慢一点,也不要因为一个手滑变成一次开一大堆任务(每个都扣费)。
     * @param {string|number} value - 输入框里的原话。
     * @returns {number} 1–4 之间的整数。
     */
    function clampConcurrency(value) {
      if (value == null || value === '') return MAX_CONCURRENT_JOBS;
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return MAX_CONCURRENT_JOBS;
      return Math.max(1, Math.min(MAX_CONCURRENT_JOBS_MAX, n));
    }
    /** 当前生效的「同时生成数」:设置面板写进本机 prefs,没设过就是默认值。 */
    function concurrencyLimit() {
      const prefs = readPrefs();
      return clampConcurrency(prefs ? prefs.maxJobs : undefined);
    }
    /**
     * 参考图编号:**必须与提交顺序一致**(41-generate 里 `payloadImages = [主图, ...参考图]`)。
     * 主选图在提交里是第 1 张(主图),不占参考号;其余 `isRef` 且未隐藏的图按图层顺序从 1 编号。
     * 画布角标、生成卡上的「参考图 N」、以及提交时补的编号说明,三处都用这一个规则。
     * @param {Array<object>} images - 画布图片列表(顺序 = 图层顺序 = 提交顺序)。
     * @param {string|null} selectedId - 当前主选图 id(它的 isRef 不算参考)。
     * @returns {Map<string, number>} 图 id → 参考号(1 起)。
     */
    function refNumbers(images, selectedId) {
      const map = new Map();
      let no = 0;
      for (const image of Array.isArray(images) ? images : []) {
        if (!image || !image.isRef || image.hidden) continue;
        if (selectedId && image.id === selectedId) continue;
        no += 1;
        map.set(image.id, no);
      }
      return map;
    }
    /**
     * 在画布上画参考图角标:贴在图的内侧左上角,越过视口时收进来(图被裁掉一半也看得见)。
     * 主图用深灰、参考图用蓝,跟生成卡上的编号配同一套颜色语言。
     * @param {CanvasRenderingContext2D} c - 画布上下文。
     * @param {number} sx - 图左上角的屏幕 x。
     * @param {number} sy - 图左上角的屏幕 y。
     * @param {number} W - 画布宽(CSS 像素)。
     * @param {number} H - 画布高(CSS 像素)。
     * @param {string} label - 「主图」或「参考 N」。
     * @param {boolean} isMain - 主图 true(深灰),参考图 false(蓝)。
     */
    function drawRefBadge(c, sx, sy, W, H, label, isMain) {
      c.save();
      c.font = '600 11px system-ui, sans-serif';
      const tw = c.measureText(label).width;
      const bw = tw + 10;
      const bh = 17;
      const bx = Math.max(2, Math.min(sx + 5, W - bw - 2));
      const by = Math.max(2, Math.min(sy + 5, H - bh - 2));
      c.fillStyle = isMain ? 'rgba(15,23,42,0.72)' : 'rgba(59,130,246,0.92)';
      c.fillRect(bx, by, bw, bh);
      c.fillStyle = '#fff';
      c.fillText(label, bx + 5, by + 12);
      c.restore();
    }
    function normalizeRect(rect) {
      return {
        x0: Math.min(rect.x0, rect.x1),
        y0: Math.min(rect.y0, rect.y1),
        x1: Math.max(rect.x0, rect.x1),
        y1: Math.max(rect.y0, rect.y1),
      };
    }

    // ── 零件 07-textlayer.js ─────────────────────────────────────────────────────────
    // ── 文字图层(本机字体,本地绘制)────────────────────────────────────
    //
    // 为什么要有它:图像模型"画字"是画像素 —— 出图分辨率就那么大,字必然是糊的,
    // 还经常把笔画写错。所以正确做法是让模型只出**干净底图**(Skills 里有「留白配图」模板),
    // 文字用**本机已安装的字体**在本地矢量绘制,导出时按原图分辨率烧进去 —— 边缘是清晰的。

    /** 新加一条文字时的默认样式(字号是"占图高的比例",所以缩放/导出都等比)。 */
    const TEXT_DEFAULTS = {
      font: '微软雅黑',
      size: 0.08,
      color: '#ffffff',
      weight: 700,
      align: 'center',
      shadow: true,
      lineHeight: 1.25,
    };

    /** 常见中文字体候选(能不能用现场检测;也可以用「导入字体文件」加载任意字体)。 */
    const FONT_CANDIDATES = [
      '微软雅黑',
      'Microsoft YaHei',
      '思源黑体',
      'Noto Sans SC',
      '黑体',
      'SimHei',
      '宋体',
      'SimSun',
      '楷体',
      'KaiTi',
      '仿宋',
      'FangSong',
      '等线',
      'DengXian',
      '苹方',
      'PingFang SC',
      'HarmonyOS Sans SC',
      '阿里巴巴普惠体',
      'Alibaba PuHuiTi',
      '站酷高端黑',
      '霞鹜文楷',
      'LXGW WenKai',
      '思源宋体',
      'Noto Serif SC',
      'JetBrains Mono',
      'Consolas',
      'Arial',
    ];

    /** 一段文字按换行拆行。 */
    function textLines(value) {
      return String(value == null ? '' : value).split('\n');
    }

    /**
     * 估一行字有多宽(不依赖 measureText,便于离线测试与命中判断)。
     * 中日韩字符按 1 个字宽算,其余(字母/数字/空格)按 0.55 字宽算。
     */
    function estimateTextWidth(line, sizePx) {
      let units = 0;
      for (const ch of String(line || '')) units += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.55;
      return units * sizePx;
    }

    /**
     * 某个字体在这台机器上能不能用。
     * 办法:同一段字用"基准字体"和"基准字体 + 候选"各量一次宽度,不一样就说明候选真的生效了。
     * @param {string} name - 字体名。
     * @returns {boolean} 可用给 true。
     */
    function isFontAvailable(name) {
      const key = String(name || '').trim();
      if (!key) return false;
      try {
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx || typeof ctx.measureText !== 'function') return false;
        const probe = '汉字WMwmwiii888';
        return ['monospace', 'serif', 'sans-serif'].some((fallback) => {
          ctx.font = `72px ${fallback}`;
          const base = ctx.measureText(probe).width;
          ctx.font = `72px "${key}", ${fallback}`;
          const test = ctx.measureText(probe).width;
          return Number.isFinite(base) && Number.isFinite(test) && Math.abs(base - test) > 0.5;
        });
      } catch (e) {
        return false;
      }
    }

    /** 列出这台机器上真的有的候选字体(检测失败的返回空数组,由界面兜底成手填)。 */
    function availableFonts() {
      return FONT_CANDIDATES.filter((font) => isFontAvailable(font));
    }

    /**
     * 把一组文字图层画到 2D 上下文上 —— **按目标分辨率**算字号与坐标。
     *
     * 屏幕预览、原图导出的都走这一个函数:导出时传原图自然尺寸,字就是按原分辨率矢量绘制的,
     * 不管图片多大都是清晰的。调用方负责把上下文原点挪到图片左上角(见绘制循环里的 translate)。
     *
     * @param {CanvasRenderingContext2D} c - 上下文(原点 = 图片左上角)。
     * @param {Array<object>} texts - 文字图层数组。
     * @param {number} w - 图片显示宽(像素)。
     * @param {number} h - 图片显示高(像素)。
     */
    function drawImageTexts(c, texts, w, h) {
      const list = Array.isArray(texts) ? texts : [];
      for (const item of list) {
        const value = String(item.value == null ? '' : item.value);
        if (!value.trim()) continue;
        const sizePx = Math.max(6, h * (Number(item.size) || TEXT_DEFAULTS.size));
        const lineHeight = sizePx * (Number(item.lineHeight) || TEXT_DEFAULTS.lineHeight);
        const lines = textLines(value);
        const cx = (Number(item.nx) || 0) * w;
        const cy = (Number(item.ny) || 0) * h;
        const totalH = lineHeight * lines.length;
        c.save();
        c.font = `${item.weight || 700} ${sizePx}px "${item.font || TEXT_DEFAULTS.font}", "Microsoft YaHei", "PingFang SC", sans-serif`;
        c.textAlign = item.align === 'left' ? 'left' : item.align === 'right' ? 'right' : 'center';
        c.textBaseline = 'middle';
        c.lineJoin = 'round';
        // 深色描边:保证在任何底图上都看得清(比纯阴影更稳)
        if (item.shadow !== false) {
          c.strokeStyle = 'rgba(0,0,0,0.72)';
          c.lineWidth = Math.max(2, sizePx * 0.14);
        }
        lines.forEach((line, index) => {
          const y = cy - totalH / 2 + lineHeight * (index + 0.5);
          if (item.shadow !== false) c.strokeText(line, cx, y);
          c.fillStyle = item.color || TEXT_DEFAULTS.color;
          c.fillText(line, cx, y);
        });
        c.restore();
      }
    }

    /**
     * 文字图层在图内坐标系里的包围盒(拖动命中、选中框用)。
     * 宽高按估算算,不做 measureText —— 离线也能跑,而且误差对"点没点到"够用。
     */
    function textLayerBounds(item, w, h) {
      const sizePx = Math.max(6, h * (Number(item.size) || TEXT_DEFAULTS.size));
      const lineHeight = sizePx * (Number(item.lineHeight) || TEXT_DEFAULTS.lineHeight);
      const lines = textLines(item.value);
      const width = Math.max(sizePx, ...lines.map((line) => estimateTextWidth(line, sizePx)));
      const cx = (Number(item.nx) || 0) * w;
      const cy = (Number(item.ny) || 0) * h;
      const left = item.align === 'left' ? cx : item.align === 'right' ? cx - width : cx - width / 2;
      const height = lineHeight * lines.length;
      return { x: left, y: cy - height / 2, w: width, h: height };
    }

    /**
     * 在 [0,1] 归一化坐标里找点到了哪条文字(从上往下找,后加的在上)。
     * @param {Array<object>} texts - 文字图层。
     * @param {number} nx - 归一化 x。
     * @param {number} ny - 归一化 y。
     * @param {number} scale - 图片显示尺寸/自然尺寸(w/h 同步缩放,这里传宽的比例即可)。
     */
    function hitTextLayer(texts, nx, ny, w, h) {
      const list = Array.isArray(texts) ? texts : [];
      // w/h 是**图片的显示宽高**(像素)。之前调用点传的是"显示尺寸/自然尺寸"这个比例,
      // 于是包围盒被 textLayerBounds 里 `Math.max(6, …)` 的下限顶成比整张图还大,
      // 「选择」工具下点这张图任何位置都会命中文字 → 图片再也拖不动。
      const W = Number(w) || 1;
      const H = Number(h == null ? w : h) || 1;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const box = textLayerBounds(list[i], W, H);
        const px = nx * W;
        const py = ny * H;
        const pad = 4;
        if (px >= box.x - pad && px <= box.x + box.w + pad && py >= box.y - pad && py <= box.y + box.h + pad) return list[i];
      }
      return null;
    }

    // ── 分层导出:成品图 / 无文字底图 / 文字参数 ────────────────────────
    //
    // 为什么要分层:**底图是位图(放大就糊),文字是矢量的(多清晰都行)**。
    // 烧在一起的成品图只能重来;分开存,以后换尺寸重出、改字、把同一套文字套到别的底图上,都还有得救。

    /**
     * 把「保存路径」派生成分层导出的三个文件名。
     *
     * `画布输出/图-123.png` →
     *   - `full` 成品(底图 + 文字)
     *   - `base` 底图(不含任何文字)
     *   - `meta` 文字参数 JSON
     *
     * 没有扩展名就按 `.png` 补;点号落在目录名里(`a.b/图`)不算扩展名。
     * @param {string} rel - 相对工作区的保存路径。
     * @returns {{ full: string, base: string, meta: string }} 三个落盘路径。
     */
    function layerPaths(rel) {
      const file = String(rel == null ? '' : rel).trim();
      const dot = file.lastIndexOf('.');
      const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
      const hasExt = dot > slash + 1 && dot < file.length - 1;
      const stem = hasExt ? file.slice(0, dot) : file;
      const ext = hasExt ? file.slice(dot) : '.png';
      return {
        full: file,
        base: `${stem}-底图${ext}`,
        meta: `${stem}.texts.json`,
      };
    }

    /**
     * 「导出尺寸」框 → 目标像素。
     *
     * 复用「尺寸」框那一整套人类写法,但**只认能定出具体像素的**:
     * `1080x1440` / `小红书` / `A4` / `210x297mm` 都行;
     * `3:4`、`竖版` 定不出像素(底图是位图,凭空指定一个分辨率没有意义),一律当"留空"。
     * @param {string} text - 输入框里的原话。
     * @param {number} dpi - 实物尺寸(mm/cm/英寸)的换算基准。
     * @returns {{ w: number, h: number, shrunk?: boolean }|null} 目标像素;null = 按原图分辨率。
     */
    function parseExportSize(text, dpi) {
      const parsed = parseHumanSize(text, dpi);
      if (parsed.mode !== 'pixel' || !parsed.pixels) return null;
      const w = Math.round(Number(parsed.pixels[0]) || 0);
      const h = Math.round(Number(parsed.pixels[1]) || 0);
      if (!(w > 0) || !(h > 0)) return null;
      // 和成品尺寸走同一套保险:超过浏览器画布上限就等比缩下来
      const scale = fitScale(w, h);
      if (scale < 1) return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), shrunk: true };
      return { w, h };
    }

    /**
     * 生成分层导出里的文字参数清单(JSON)。
     *
     * 关键:文字在这里是**参数**不是像素 —— 坐标是 0~1 的归一化值,字号是"占图高的比例",
     * 所以这份 JSON 配上任意尺寸的底图,都能重画出一模一样的排版,而且永远清晰。
     * @param {object} image - 画布上的图片对象。
     * @param {{ w: number, h: number }|null} size - 成品实际导出的尺寸。
     * @param {Record<string, boolean>} [fonts] - 字体名 → 本机是否可用(缺省不写这一节)。
     * @returns {object} 可直接 JSON.stringify 的清单。
     */
    function textLayerManifest(image, size, fonts) {
      const src = image && Array.isArray(image.texts) ? image.texts : [];
      const texts = src.map((tx) => ({
        id: String(tx.id || ''),
        value: String(tx.value == null ? '' : tx.value),
        nx: Number(tx.nx) || 0,
        ny: Number(tx.ny) || 0,
        size: Number(tx.size) || TEXT_DEFAULTS.size,
        font: String(tx.font || TEXT_DEFAULTS.font),
        weight: Number(tx.weight) || TEXT_DEFAULTS.weight,
        align: tx.align === 'left' || tx.align === 'right' ? tx.align : 'center',
        color: String(tx.color || TEXT_DEFAULTS.color),
        shadow: tx.shadow !== false,
        lineHeight: Number(tx.lineHeight) || TEXT_DEFAULTS.lineHeight,
      }));
      const out = {
        version: 1,
        plugin: 'dsh-grsai-canvas',
        exportedAt: new Date().toISOString(),
        note: '文字是矢量参数:nx/ny 是 0~1 的归一化坐标,size 是占图高的比例 —— 换 exportW/exportH 就能在任意分辨率上重画,边缘永远清晰。',
        image: {
          name: String((image && image.name) || ''),
          naturalW: Number((image && image.naturalW) || (image && image.w) || 0),
          naturalH: Number((image && image.naturalH) || (image && image.h) || 0),
          exportW: Number(size && size.w) || 0,
          exportH: Number(size && size.h) || 0,
        },
        texts,
      };
      if (fonts && typeof fonts === 'object') out.fonts = fonts;
      return out;
    }

    function cloneDoc(doc) {
      return {
        // texts 要深拷一层:浅拷会让两份文档共用同一个文字数组,撤销就失灵了
        images: doc.images.map((im) => Object.assign({}, im, { texts: (im.texts || []).map((tx) => Object.assign({}, tx)) })),
        marks: doc.marks.map((mk) => Object.assign({}, mk)),
        frames: (doc.frames || []).map((f) => Object.assign({}, f)),
      };
    }

    // ── 零件 08-geometry.js ──────────────────────────────────────────────────────────
    // ── 相机与世界坐标 ──────────────────────────────────────────────────
    // 世界单位 = 图片在 100% 缩放下的像素。screen = (world - cam.xy) * cam.zoom

    function worldToScreen(cam, wx, wy) {
      return [(wx - cam.x) * cam.zoom, (wy - cam.y) * cam.zoom];
    }
    function screenToWorld(cam, sx, sy) {
      return [sx / cam.zoom + cam.x, sy / cam.zoom + cam.y];
    }
    function imageBounds(images) {
      if (!images.length) return null;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const im of images) {
        x0 = Math.min(x0, im.x);
        y0 = Math.min(y0, im.y);
        x1 = Math.max(x1, im.x + im.w);
        y1 = Math.max(y1, im.y + im.h);
      }
      return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
    }
    /** 让所有图片落在视口里。 */
    function fitCamera(images, size) {
      const box = imageBounds(images);
      if (!box || box.w <= 0 || box.h <= 0) return { x: 0, y: 0, zoom: 1 };
      const zoom = clamp(Math.min((size.w * 0.92) / box.w, (size.h * 0.92) / box.h), MIN_ZOOM, MAX_ZOOM);
      const cx = (box.x0 + box.x1) / 2;
      const cy = (box.y0 + box.y1) / 2;
      return { x: cx - size.w / (2 * zoom), y: cy - size.h / (2 * zoom), zoom };
    }
    /** 某个世界矩形是否完整落在视口里。 */
    function rectVisible(cam, size, x, y, w, hh) {
      const a = worldToScreen(cam, x, y);
      const b = worldToScreen(cam, x + w, y + hh);
      return a[0] >= 0 && a[1] >= 0 && b[0] <= size.w && b[1] <= size.h;
    }
    /**
     * 从 (x, y) 起往下找一个**不与这些矩形重叠**的位置,返回校正后的 y。
     *
     * 用途:并发生成时几张图几乎同时落图,若都按"原图右边、同一行"摆就会叠在一起 ——
     * 落图前用它把后面的那张顺到下面去。传入的矩形可以是图片,也可以是**生成中的占位框**
     * (所以排队时就先把位置错开,出图后才不会跳)。
     * @param {Array<{x: number, y: number, w: number, h: number, hidden?: boolean}>} rects - 已有的矩形。
     * @param {number} x - 候选位置左上角 x。
     * @param {number} y - 候选位置左上角 y。
     * @param {number} w - 宽。
     * @param {number} hh - 高。
     * @returns {number} 不重叠的 y(实在找不到就返回下移 200 次后的值)。
     */
    function freeSpotY(rects, x, y, w, hh) {
      const list = (rects || []).filter((im) => im && !im.hidden && im.w > 0 && im.h > 0);
      let top = Number(y) || 0;
      for (let guard = 0; guard < 200; guard += 1) {
        let hit = null;
        for (const im of list) {
          const overlap = x < im.x + im.w && x + w > im.x && top < im.y + im.h && top + hh > im.y;
          if (!overlap) continue;
          if (!hit || im.y + im.h > hit.y + hit.h) hit = im;
        }
        if (!hit) break;
        top = hit.y + hit.h + GAP;
      }
      return top;
    }

    // ── 零件 09-marks.js ─────────────────────────────────────────────────────────────
    // ── 标注渲染 ────────────────────────────────────────────────────────
    /**
     * 把一组标注画到 2D 上下文里。
     * @param c - 目标上下文。
     * @param marks - 标注数组。
     * @param map - `{ toPx(nx, ny), wpx(f), hpx(f) }`:归一化坐标 → 目标像素,
     *   以及宽度(相对图片宽)与字号(相对图片高)的换算。
     */
    function renderMarks(c, marks, map) {
      // 提交用的图先描一层深色底,保证标注在任何底色(白墙/深色照片)上都醒目
      if (map && map.halo) renderMarksPass(c, marks, map, true);
      renderMarksPass(c, marks, map, false);
    }

    /**
     * 画一遍标注。
     * @param c - 2D 上下文。
     * @param marks - 标注数组。
     * @param map - 坐标/尺寸换算(见 {@link screenMarkMap} 与 {@link naturalMarkMap})。
     * @param halo - true 时只画"深色加粗底衬",用于提交给模型的图。
     */
    function renderMarksPass(c, marks, map, halo) {
      for (const mark of marks) {
        c.save();
        c.lineCap = 'round';
        c.lineJoin = 'round';
        const stroke = halo ? 'rgba(0,0,0,0.55)' : mark.color;
        const widthScale = halo ? 2.4 : 1;
        if (mark.kind === 'brush') {
          c.strokeStyle = stroke;
          c.lineWidth = Math.max(1, map.wpx(mark.width) * widthScale);
          c.globalAlpha = halo ? 1 : map.halo ? 0.95 : 0.9;
          c.beginPath();
          for (let i = 0; i < mark.points.length; i += 1) {
            const q = map.toPx(mark.points[i][0], mark.points[i][1]);
            if (i === 0) c.moveTo(q[0], q[1]);
            else c.lineTo(q[0], q[1]);
          }
          if (mark.points.length === 1) {
            const q = map.toPx(mark.points[0][0], mark.points[0][1]);
            c.lineTo(q[0] + 0.01, q[1]);
          }
          c.stroke();
        } else if (mark.kind === 'mask') {
          // 蒙版:屏幕上只给一层"涂到哪"的半透明蓝示意。
          // 提交图里**不画**这一笔 —— 那时它才变成本体:未涂区域压暗、涂过的地方抠回原亮度
          // (做法见 41-generate.js 的 buildSubmission,那里用 destination-out 抠)。
          if (!map.halo) {
            c.strokeStyle = 'rgba(10,132,255,0.30)';
            c.lineWidth = Math.max(1, map.wpx(mark.width));
            c.globalAlpha = 1;
            c.beginPath();
            for (let i = 0; i < mark.points.length; i += 1) {
              const q = map.toPx(mark.points[i][0], mark.points[i][1]);
              if (i === 0) c.moveTo(q[0], q[1]);
              else c.lineTo(q[0], q[1]);
            }
            if (mark.points.length === 1) {
              const q = map.toPx(mark.points[0][0], mark.points[0][1]);
              c.lineTo(q[0] + 0.01, q[1]);
            }
            c.stroke();
          }
        } else if (mark.kind === 'pen') { // legacy:钢笔工具早已从 TOOLS 移除,此分支仅兼容旧存档
          // 钢笔:把点连成平滑曲线(二次贝塞尔走中点),比画笔更顺
          c.strokeStyle = stroke;
          c.lineWidth = Math.max(1, map.wpx(mark.width) * widthScale);
          c.globalAlpha = halo ? 1 : 0.9;
          const pts = mark.points.map((p) => map.toPx(p[0], p[1]));
          c.beginPath();
          if (pts.length === 1) {
            c.moveTo(pts[0][0], pts[0][1]);
            c.lineTo(pts[0][0] + 0.01, pts[0][1]);
          } else if (pts.length === 2) {
            c.moveTo(pts[0][0], pts[0][1]);
            c.lineTo(pts[1][0], pts[1][1]);
          } else {
            c.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length - 1; i += 1) {
              const mx = (pts[i][0] + pts[i + 1][0]) / 2;
              const my = (pts[i][1] + pts[i + 1][1]) / 2;
              c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
            }
            c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
          }
          c.stroke();
        } else if (mark.kind === 'rect' || mark.kind === 'ellipse') {
          const box = normalizeRect(mark.rect);
          const a = map.toPx(box.x0, box.y0);
          const b = map.toPx(box.x1, box.y1);
          const x = Math.min(a[0], b[0]);
          const y = Math.min(a[1], b[1]);
          const w = Math.abs(b[0] - a[0]);
          const hh = Math.abs(b[1] - a[1]);
          const path = () => {
            c.beginPath();
            if (mark.kind === 'rect') c.rect(x, y, w, hh);
            else c.ellipse(x + w / 2, y + hh / 2, Math.max(0.5, w / 2), Math.max(0.5, hh / 2), 0, 0, Math.PI * 2);
          };
          c.strokeStyle = stroke;
          c.fillStyle = stroke;
          c.lineWidth = Math.max(1, map.wpx(mark.width) * widthScale);
          if (!halo) {
            c.globalAlpha = 0.3;
            path();
            c.fill();
            c.globalAlpha = 1;
          }
          path();
          c.stroke();
        } else if (mark.kind === 'arrow') {
          const a = map.toPx(mark.from[0], mark.from[1]);
          const b = map.toPx(mark.to[0], mark.to[1]);
          c.strokeStyle = stroke;
          c.fillStyle = stroke;
          c.lineWidth = Math.max(1, map.wpx(mark.width) * widthScale);
          c.beginPath();
          c.moveTo(a[0], a[1]);
          c.lineTo(b[0], b[1]);
          c.stroke();
          const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
          const head = Math.max(7, map.wpx(mark.width) * (halo ? 3.9 : 3.4));
          c.beginPath();
          c.moveTo(b[0], b[1]);
          c.lineTo(b[0] - head * Math.cos(angle - 0.42), b[1] - head * Math.sin(angle - 0.42));
          c.lineTo(b[0] - head * Math.cos(angle + 0.42), b[1] - head * Math.sin(angle + 0.42));
          c.closePath();
          c.fill();
        } else if (mark.kind === 'text') { // legacy:旧式文字标注,已被文字图层(text layer)取代,仅兼容旧存档
          const size = Math.max(5, map.hpx(mark.size));
          c.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
          c.textBaseline = 'top';
          const at = map.toPx(mark.at[0], mark.at[1]);
          const lines = String(mark.text).split('\n');
          c.lineJoin = 'round';
          for (let i = 0; i < lines.length; i += 1) {
            const ty = at[1] + i * size * 1.3;
            c.lineWidth = Math.max(2, size * (halo ? 0.3 : 0.16));
            c.strokeStyle = halo ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.6)';
            c.strokeText(lines[i], at[0], ty);
            if (!halo) {
              c.fillStyle = mark.color;
              c.fillText(lines[i], at[0], ty);
            }
          }
        }
        c.restore();
      }
    }

    /** 屏幕坐标下的标注映射(给画布用)。 */
    function screenMarkMap(cam, image) {
      return {
        toPx: (nx, ny) => worldToScreen(cam, image.x + nx * image.w, image.y + ny * image.h),
        wpx: (f) => f * image.w * cam.zoom,
        hpx: (f) => f * image.h * cam.zoom,
      };
    }
    /** 图片自然像素下的标注映射(给提交合成用)。带 `halo`,提交的图上线要更醒目。 */
    function naturalMarkMap(width, height) {
      return {
        toPx: (nx, ny) => [nx * width, ny * height],
        wpx: (f) => f * width,
        hpx: (f) => f * height,
        halo: true,
      };
    }
    /**
     * 把画在图上的一堆标注翻译成"给模型看的文字说明"。
     *
     * 这一步是这个插件能不能"被听懂"的关键:图像模型不是读图 agent,只给它一根红箭头,
     * 它多半不知道你想把箭头指的地方改成什么。所以把「箭头从哪指到哪、框住哪块、
     * 上面写了什么字」都写成句子,并把文字标注原样抬进提示词当指令用。
     *
     * @param marks - 同一张图上的标注。
     * @returns {string} 多行说明;没有标注时返回空串。
     */
    function describeMarks(marks) {
      if (!marks || !marks.length) return '';
      const pct = (v) => `${Math.round(clamp(v, 0, 1) * 100)}%`;
      const where = (nx, ny) => {
        const h = nx < 0.34 ? '左' : nx > 0.66 ? '右' : '中';
        const v = ny < 0.34 ? '上' : ny > 0.66 ? '下' : '中';
        if (h === '中' && v === '中') return '画面中央';
        if (h === '中') return `${v}方`;
        if (v === '中') return `${h}方`;
        return `${h}${v}方`;
      };
      const lines = [];
      const labels = [];
      for (const mark of marks) {
        if (mark.kind === 'arrow') {
          lines.push(
            `- 红色箭头:从 (${pct(mark.from[0])}, ${pct(mark.from[1])}) 指向 (${pct(mark.to[0])}, ${pct(mark.to[1])}) 的${where(mark.to[0], mark.to[1])} —— 箭头所指的位置就是这次要改的目标,箭头起点是参照物。`,
          );
        } else if (mark.kind === 'rect') {
          const b = normalizeRect(mark.rect);
          lines.push(`- 红色矩形框:框住 (${pct(b.x0)}, ${pct(b.y0)}) 到 (${pct(b.x1)}, ${pct(b.y1)}) 的${where((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)},框内是要改的地方。`);
        } else if (mark.kind === 'ellipse') {
          const b = normalizeRect(mark.rect);
          lines.push(`- 红色椭圆圈:圈住 (${pct(b.x0)}, ${pct(b.y0)}) 到 (${pct(b.x1)}, ${pct(b.y1)}) 的${where((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)},圈内是要改的地方。`);
        } else if (mark.kind === 'brush') {
          const b = marksBounds([mark]);
          if (b) lines.push(`- 红色涂抹:盖住 (${pct(b.x0)}, ${pct(b.y0)}) 到 (${pct(b.x1)}, ${pct(b.y1)}) 的${where((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)}一片,这一片是要改的地方。`);
        } else if (mark.kind === 'mask') {
          const b = marksBounds([mark]);
          if (b) lines.push(`- 蓝色蒙版:整张图只有 (${pct(b.x0)}, ${pct(b.y0)}) 到 (${pct(b.x1)}, ${pct(b.y1)}) 的${where((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)}这一片标了蒙版,它就是这次**唯一**要改的地方,其余部分我已经压暗,请原样保留、不要改动。`);
        } else if (mark.kind === 'pen') {
          const b = marksBounds([mark]);
          if (b) lines.push(`- 红色钢笔曲线:从 (${pct(b.x0)}, ${pct(b.y0)}) 到 (${pct(b.x1)}, ${pct(b.y1)}) 划了一条平滑曲线,曲线经过的地方是要改/勾勒的地方。`);
        } else if (mark.kind === 'text') {
          const text = String(mark.text || '').trim();
          if (!text) continue;
          labels.push(text);
          lines.push(`- 画面里的手写标注文字「${text}」写在 (${pct(mark.at[0])}, ${pct(mark.at[1])}) 的${where(mark.at[0], mark.at[1])},它写的就是修改要求本身。`);
        }
      }
      if (!lines.length) return '';
      const head = labels.length
        ? `图上有我画的标注。它们的文字内容就是修改要求,请照做:${labels.map((t) => `「${t}」`).join('')}。标注位置如下:`
        : '图上有我画的标注,请按它们的指示修改:';
      return `${head}\n${lines.map((line, i) => line.replace(/^- /, `${i + 1}. `)).join('\n')}`;
    }
    /** 一组标注的包围盒(归一化)。 */
    function marksBounds(marks) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      const add = (nx, ny) => {
        x0 = Math.min(x0, nx);
        y0 = Math.min(y0, ny);
        x1 = Math.max(x1, nx);
        y1 = Math.max(y1, ny);
      };
      for (const mark of marks) {
        if (mark.kind === 'brush' || mark.kind === 'pen' || mark.kind === 'mask') for (const p of mark.points) add(p[0], p[1]);
        else if (mark.kind === 'rect' || mark.kind === 'ellipse') {
          const box = normalizeRect(mark.rect);
          add(box.x0, box.y0);
          add(box.x1, box.y1);
        } else if (mark.kind === 'arrow') {
          add(mark.from[0], mark.from[1]);
          add(mark.to[0], mark.to[1]);
        } else if (mark.kind === 'text') add(mark.at[0], mark.at[1]);
      }
      if (!Number.isFinite(x0)) return null;
      return { x0, y0, x1, y1 };
    }
    function markDistanceToPoint(mark, image, wx, wy) {
      const toWorld = (nx, ny) => [image.x + nx * image.w, image.y + ny * image.h];
      const points = [];
      if (mark.kind === 'brush' || mark.kind === 'pen' || mark.kind === 'mask') for (const p of mark.points) points.push(toWorld(p[0], p[1]));
      else if (mark.kind === 'rect' || mark.kind === 'ellipse') {
        const b = normalizeRect(mark.rect);
        points.push(toWorld(b.x0, b.y0), toWorld(b.x1, b.y1));
      } else if (mark.kind === 'arrow') {
        points.push(toWorld(mark.from[0], mark.from[1]), toWorld(mark.to[0], mark.to[1]));
      } else if (mark.kind === 'text') points.push(toWorld(mark.at[0], mark.at[1]));
      let best = Infinity;
      for (const p of points) best = Math.min(best, Math.hypot(p[0] - wx, p[1] - wy));
      return best;
    }
    /** 随提交附带的要求说明。 */
    function markHint(submission) {
      if (submission.cropped) {
        return '这张图是从原图里裁下来的待修改区域,请只重绘这张图本身,保持它原有的风格与比例。';
      }
      return (
        '修改要求:\n' +
        '1. 只按上面的标注位置和内容修改;画面其余部分(主体、构图、风格、比例、光线)保持原样,不要重绘整张图。\n' +
        '2. 输出必须是清理干净的成品图:不要保留任何标注痕迹(红色箭头、线框、涂抹、手写标注文字),也不要有任何多余的标记。'
      );
    }
    /**
     * 提交用的合成尺寸:长边不超过 SUBMIT_MAX_SIDE,其余等比;本来就够小就原样。
     * @param naturalW - 原图宽。
     * @param naturalH - 原图高。
     * @returns {{ width: number, height: number, scale: number }} 目标尺寸与缩放比。
     */
    function submissionSize(naturalW, naturalH) {
      const scale = Math.min(1, SUBMIT_MAX_SIDE / Math.max(naturalW || 1, naturalH || 1));
      return {
        width: Math.max(1, Math.round((naturalW || 1) * scale)),
        height: Math.max(1, Math.round((naturalH || 1) * scale)),
        scale,
      };
    }

    /** 提交图与 UI 预览共用的裁剪范围,蒙版始终提交整图。 */
    function submissionRegion(naturalW, naturalH, marks, cropToMark) {
      const full = submissionSize(naturalW, naturalH);
      const list = marks || [];
      let sx = 0;
      let sy = 0;
      let width = full.width;
      let height = full.height;
      let cropped = false;
      if (cropToMark && list.length && !list.some((mark) => mark.kind === 'mask')) {
        const bounds = marksBounds(list);
        if (bounds) {
          const x0 = clamp(bounds.x0 - 0.02, 0, 1);
          const y0 = clamp(bounds.y0 - 0.02, 0, 1);
          const x1 = clamp(bounds.x1 + 0.02, 0, 1);
          const y1 = clamp(bounds.y1 + 0.02, 0, 1);
          sx = Math.min(full.width - 1, Math.round(x0 * full.width));
          sy = Math.min(full.height - 1, Math.round(y0 * full.height));
          width = Math.min(full.width - sx, Math.max(16, Math.round((x1 - x0) * full.width)));
          height = Math.min(full.height - sy, Math.max(16, Math.round((y1 - y0) * full.height)));
          cropped = true;
        }
      }
      return { width, height, sx, sy, fullWidth: full.width, fullHeight: full.height, scale: full.scale, cropped };
    }

    // ── 零件 10-tasks.js ─────────────────────────────────────────────────────────────
    /** 未取回的任务存在这个 localStorage 键里(参考站也是这么做的:重开页面还能接着查)。 */
    const LS_TASKS = 'dsh.grsai-canvas.tasks';

    /**
     * 读未取回的任务。
     * @returns {Array<object>} 任务记录数组。
     */
    function readPendingTasks() {
      try {
        const raw = localStorage.getItem(LS_TASKS);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((item) => item && item.id) : [];
      } catch {
        return [];
      }
    }

    /**
     * 写未取回的任务(最多留 100 条)。
     *
     * 上限别定太小:超了就是「静默丢掉最老的那条未取回任务」—— 那张图已经花过钱,
     * 丢了再也取不回来。一条记录只有几百字节,100 条也不到 100KB。
     * @param {Array<object>} list - 任务记录。
     * @returns {void}
     */
    function writePendingTasks(list) {
      try {
        localStorage.setItem(LS_TASKS, JSON.stringify(list.slice(0, 100)));
      } catch {
        /* 隐私模式忽略 */
      }
    }

    /**
     * 上游状态归类:宽松一点 —— 多一个没见过的状态词,不该直接判成"未知状态"。
     * @param {unknown} raw - 上游返回的 status。
     * @returns {'done'|'running'|'failed'|'unknown'} 归类。
     */
    function classifyStatus(raw) {
      const value = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!value) return 'unknown';
      if (['succeeded', 'success', 'done', 'completed', 'complete', 'finished', 'ok'].includes(value)) return 'done';
      if (['running', 'pending', 'queued', 'processing', 'in_queue', 'in-progress', 'in_progress', 'created', 'starting', 'waiting'].includes(value)) {
        return 'running';
      }
      if (['failed', 'failure', 'error', 'violation', 'canceled', 'cancelled', 'rejected'].includes(value)) return 'failed';
      return 'unknown';
    }

    /**
     * 从上游返回里找出图片地址:先按官方 `results[0].url` 取,取不到再兜底深扫。
     * 上游字段偶尔会变,这里多认几种,免得"任务成功了却拿不到图"。
     * @param {any} data - `/result` 的 JSON。
     * @returns {string} 图片 URL;找不到返回空串。
     */
    function pickImageUrl(data) {
      if (!data || typeof data !== 'object') return '';
      const isUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());
      for (const key of ['url', 'imageUrl', 'image_url', 'output', 'src', 'href']) {
        if (isUrl(data[key])) return data[key].trim();
      }
      for (const key of ['results', 'data', 'images', 'outputs', 'result', 'items']) {
        const list = data[key];
        if (!list) continue;
        for (const item of Array.isArray(list) ? list : [list]) {
          if (isUrl(item)) return item.trim();
          if (item && typeof item === 'object') {
            for (const inner of ['url', 'imageUrl', 'image_url', 'src', 'href', 'path']) {
              if (isUrl(item[inner])) return item[inner].trim();
            }
          }
        }
      }
      // 最后的兜底:整个返回里第一个像图片链接的字符串
      let flat = '';
      try {
        flat = JSON.stringify(data);
      } catch {
        return '';
      }
      const image = flat.match(/https?:\/\/[^"'\s\\]+\.(?:png|jpe?g|webp|gif|bmp|avif)(?:\?[^"'\s\\]*)?/i);
      if (image) return image[0];
      const any = flat.match(/https?:\/\/[^"'\s\\]+/i);
      return any ? any[0] : '';
    }

    // ── 零件 11-style.js ─────────────────────────────────────────────────────────────
    // ── 样式 ────────────────────────────────────────────────────────────

    const label = 'var(--dsw-alias-label-primary, currentColor)';
    const label2 = 'var(--dsw-alias-label-secondary, currentColor)';
    const line = 'var(--dsw-alias-border-l3, rgba(127,127,127,0.35))';
    const hoverBg = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))';
    const fillBtn = 'var(--dsw-alias-button-elevated-fill, rgba(127,127,127,0.10))';
    const panelBg = 'var(--dsw-alias-bg-elevated, var(--dsw-specific-sidebar-fill, rgba(127,127,127,0.08)))';

    const S = {
      // 主题令牌(局部 const 的公开面):零件里直接用 S.token.* 引用主题变量,
      // 不要再复制十六进制/变量串 —— 换主题只改这里。
      token: { label, label2, line, hoverBg, fillBtn, panelBg },
      root: { position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', color: label },
      canvas: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', touchAction: 'none' },
      float: { position: 'absolute', display: 'flex', gap: 4, zIndex: 5 },
      col: { flexDirection: 'column' },
      card: {
        background: panelBg,
        border: `1px solid ${line}`,
        borderRadius: 10,
        boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
        backdropFilter: 'blur(6px)',
        padding: 8,
        display: 'flex',
        gap: 6,
      },
      btn: {
        opacity: 1,
        appearance: 'none',
        border: '1px solid transparent',
        background: 'transparent',
        color: label,
        borderRadius: 8,
        width: 32,
        height: 32,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        padding: 0,
        flex: 'none',
      },
      /**
       * 选中态(工具栏按钮用)。
       *
       * ⚠ 这里必须给**完整的 `border`**,不能只给 `borderColor`:本插件的 `h` 是自定义
       * 虚拟 DOM,它的样式 diff **只设置"这次有的 key",不会清除"这次没有的 key"** ——
       * 只给颜色的话,取消选中后那圈颜色会留在元素上,而背景已经回到透明,
       * 看上去就是一个空心的黑框(工具栏"上一个工具的框没消掉"就是这么来的)。
       *
       * 规矩:**任何"有时出现"的样式 key,都要在两个状态下都给全**。
       */
      btnOn: { background: 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.22))', border: `1px solid ${line}` },
      wideBtn: {
        appearance: 'none',
        border: `1px solid ${line}`,
        background: fillBtn,
        color: 'inherit',
        borderRadius: 8,
        padding: '5px 10px',
        fontSize: 13,
        lineHeight: '20px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      tiny: {
        opacity: 1,
        appearance: 'none',
        border: '1px solid transparent',
        background: 'transparent',
        color: label2,
        borderRadius: 6,
        padding: '2px 7px',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      // 输入框右边的「▾」:原来的 S.tiny 只有 16×22 左右,鼠标/触控都难点中。
      // 这个给足命中区(30×28)和一点边框,一眼能看出是个按钮。
      caret: {
        opacity: 1,
        appearance: 'none',
        border: `1px solid ${line}`,
        background: fillBtn,
        color: label2,
        borderRadius: 6,
        padding: '0 6px',
        minWidth: 30,
        minHeight: 28,
        fontSize: 14,
        lineHeight: '26px',
        textAlign: 'center',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      status: {
        position: 'absolute',
        left: 8,
        bottom: 8,
        zIndex: 4,
        maxWidth: '58%',
        fontSize: 12,
        lineHeight: '17px',
        color: label2,
        background: panelBg,
        border: `1px solid ${line}`,
        borderRadius: 8,
        padding: '3px 8px',
        pointerEvents: 'none',
        whiteSpace: 'pre-wrap',
      },
      // 右下纵向容器:属性区(props)在上、生成卡(gen)在下,一起贴右下角
      stack: {
        position: 'absolute',
        right: 6,
        bottom: 40,
        zIndex: 5,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
        maxWidth: 'calc(100% - 66px)',
        maxHeight: 'calc(100% - 52px)',
      },
      gen: {
        position: 'relative',
        width: 348,
        maxWidth: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        minHeight: 0,
        flex: '0 1 auto',
      },
      props: {
        position: 'relative',
        width: 348,
        maxWidth: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        minHeight: 0,
        flex: '0 1 auto',
        overflowY: 'auto',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        border: `1px solid ${line}`,
        borderRadius: 8,
        background: 'transparent',
        color: 'inherit',
        padding: '6px 8px',
        fontSize: 13,
        fontFamily: 'inherit',
        resize: 'vertical',
        minHeight: 64,
        maxHeight: 280,
        height: 64,
      },
      input: {
        boxSizing: 'border-box',
        border: `1px solid ${line}`,
        borderRadius: 6,
        background: 'transparent',
        color: 'inherit',
        padding: '4px 8px',
        fontSize: 13,
        fontFamily: 'inherit',
        minWidth: 0,
      },
      row: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 0 },
      hint: { fontSize: 12, lineHeight: '17px', color: label2, overflowWrap: 'anywhere' },
      primary: {
        appearance: 'none',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-label-primary, #3b82f6)',
        color: 'var(--dsw-alias-label-primary-inverted, #fff)',
        borderRadius: 8,
        padding: '7px 12px',
        fontSize: 14,
        fontWeight: 500,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      bar: { height: 3, borderRadius: 2, background: 'rgba(127,127,127,0.25)', overflow: 'hidden' },
      barInner: { height: '100%', background: 'var(--dsw-alias-label-primary, #3b82f6)', transition: 'width .3s' },
      err: { color: 'var(--dsw-alias-state-error-primary, #e5484d)', fontSize: 12, lineHeight: '17px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
      warn: { color: 'var(--dsw-alias-state-warn-primary, #d97706)', fontSize: 12, lineHeight: '17px', whiteSpace: 'pre-wrap' },
      ok: { color: label2, fontSize: 12, lineHeight: '17px', whiteSpace: 'pre-wrap' },
      list: { maxHeight: 190, overflowY: 'auto', border: `1px solid ${line}`, borderRadius: 8, background: panelBg },
      listRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 7px',
        cursor: 'pointer',
        borderBottom: '1px solid rgba(127,127,127,0.14)',
        fontSize: 11,
      },
      thumb: { width: 48, height: 48, objectFit: 'cover', borderRadius: 6, border: `1px solid ${line}`, flex: 'none' },
      badge: { fontSize: 12, lineHeight: '17px', padding: '0 6px', borderRadius: 5, border: `1px solid ${line}`, color: label2, flex: '0 1 auto', minWidth: 0, overflowWrap: 'anywhere' },
      // 点一张图 → 图上方浮出的快捷工具条。固定白底(不是主题变量):它飘在画布内容上,
      // 深色图/浅色图上都要一眼看清。位置由渲染期按 camRef 现算,这里只管长相。
      quickBar: {
        position: 'absolute',
        transform: 'translateX(-50%)',
        zIndex: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: 4,
        background: '#ffffff',
        border: '1px solid rgba(0,0,0,0.10)',
        borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.12)',
      },
      quickBtn: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '5px 9px',
        fontSize: 12,
        lineHeight: '16px',
        fontFamily: 'inherit',
        color: '#1f2937',
        background: '#ffffff',
        border: '1px solid rgba(0,0,0,0.08)',
        borderRadius: 8,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
    };

    // ── 零件 12-canvas-tab.js ────────────────────────────────────────────────────────
/**
 * 生成占位框的底纹小块:14×14 里放一个圆点,createPattern 平铺 —— 比逐点 arc 快一个数量级。
 * 惰性建一次就缓存住,画布上同时开着好几个占位框也只付一次代价。
 */
let placeholderDotTile = null;
const placeholderDotPattern = (c) => {
  if (!placeholderDotTile) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 14;
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(15, 23, 42, 0.13)';
    g.beginPath();
    g.arc(7, 7, 0.9, 0, Math.PI * 2);
    g.fill();
    placeholderDotTile = cv;
  }
  return c.createPattern(placeholderDotTile, 'repeat');
};

    // ── 面板主体 ────────────────────────────────────────────────────────

    /**
     * 画布标签页。
     * @param props - 座位注入的 props(用到 `sessionId` 与 `useTabInfo`)。
     * @returns React 元素。
     */
    function CanvasTab(props) {
      const prefs = readPrefs;
      const [tool, setTool] = useState('select');
      const [selectedId, setSelectedId] = useState(null);
      /** 框选/多选的图片 id 集合;selectedId 始终是其中第一张(主选中),用于存/下载等单选操作。 */
      const [selectedIds, setSelectedIds] = useState([]);
      const [docVersion, setDocVersion] = useState(0);
      const [loaded, setLoaded] = useState(false);
      const [apikey, setApikey] = useState(() => {
        try {
          return localStorage.getItem(LS_KEY) || '';
        } catch {
          return '';
        }
      });
      const [keyDraft, setKeyDraft] = useState(apikey);
      const [apiBase, setApiBase] = useState(() => prefs().apiBase || DEFAULT_API_BASE);
      const [baseDraft, setBaseDraft] = useState(() => prefs().apiBase || DEFAULT_API_BASE);
      const [prompt, setPrompt] = useState('');
      const [model, setModel] = useState(() => prefs().model || 'gpt-image-2');
      /** 尺寸:默认「原图比例」—— 上传什么比例的图,就按什么比例出图(见 SOURCE_SIZE)。 */
      const [ratio, setRatio] = useState(() => prefs().ratio || SOURCE_SIZE);
      const [quality, setQuality] = useState(() => prefs().quality || 'auto');
      const [background, setBackground] = useState(() => prefs().background || 'auto');
      const [imageSize, setImageSize] = useState(() => prefs().imageSize || 'auto');
      const [cropToMark, setCropToMark] = useState(false);
      /** 「跨平台」勾选的成品尺寸(可多个):勾了就把同一个提示词按每个尺寸各出一张;空数组=按当前那一个尺寸出。 */
      const [batchSizes, setBatchSizes] = useState([]);
      const [appendHint, setAppendHint] = useState(true);
      const [color, setColor] = useState(() => prefs().color || '#ff3b30');
      const [markWidth, setMarkWidth] = useState(() => Number(prefs().markWidth) || 10);
      const [busy, setBusy] = useState(false);
      const [phase, setPhase] = useState('');
      const [progress, setProgress] = useState(0);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [saved, setSaved] = useState('');
      const [showSettings, setShowSettings] = useState(false);
      /** 受控停靠区开合:'' | 'history' | 'layers' | 'workspace' | 'skills'(同一时间只开一个标签)。 */
      const [dockOpen, setDockOpen] = useState('');
      const [wsFiles, setWsFiles] = useState(null);
      const [wsBusy, setWsBusy] = useState(false);
      const [results, setResults] = useState([]);
      // ── 生成记录(第一期 A):权威数据在 recordsRef,这里是渲染镜像;面板的查询状态 ──
      const [records, setRecords] = useState([]);
      const [historyQuery, setHistoryQuery] = useState('');
      const [historyFavOnly, setHistoryFavOnly] = useState(false);
      const [historyOpenId, setHistoryOpenId] = useState('');
      const [historyLimit, setHistoryLimit] = useState(20);
      const [historyCorrupted, setHistoryCorrupted] = useState(false);
      // ── 对比视图(第一期 B):A/B 存 {name,dataUrl,naturalW,naturalH} 快照,
      // 打开的是覆盖层,关闭不碰画布;zoom 是「图像像素→CSS 像素」倍率(100% = 1/dpr)。
      const [compareA, setCompareA] = useState(null);
      const [compareB, setCompareB] = useState(null);
      const [compareMode, setCompareMode] = useState('side');
      const [compareSwap, setCompareSwap] = useState(false);
      const [compareSlider, setCompareSlider] = useState(0.5);
      const [compareZoom, setCompareZoom] = useState(1);
      const [comparePan, setComparePan] = useState({ x: 0, y: 0 });
      const [compareTick, setCompareTick] = useState(0); // 图解码完成/变化时 +1 触发重绘
      /** 图层面板行内重命名:正在改名的图片 id(空 = 没在改)+ 输入框当前值。 */
      const [layerRenameId, setLayerRenameId] = useState('');
      const [layerRenameText, setLayerRenameText] = useState('');
      const [savePath, setSavePath] = useState('');
      /**
       * 分层导出(成品图 / 无文字底图 / 文字参数 JSON)的目标尺寸。
       * 留空 = 按原图分辨率;要写成**能定出具体像素**的写法(`1080x1440` / `小红书` / `A4` / `210x297mm`)。
       */
      const [layerSize, setLayerSize] = useState('');
      const [showGen, setShowGen] = useState(true);
      /** 模型选择菜单(点「▾」弹出;原生 datalist 会被输入框里的字过滤成一个,不好挑)。 */
      const [showModels, setShowModels] = useState(false);
      /** 尺寸选择菜单(同一个道理:框里写着「原图比例」时,原生下拉就只剩它一条,别的档位根本选不到)。 */
      const [showSizes, setShowSizes] = useState(false);
      /**
       * 成品尺寸(可选):填 `1080x1440` 这种,就按它出图。
       * 上游只认自己的尺寸表,所以提交时挑最接近的档位渲染,**回来以后本地精确缩放到这个尺寸**。
       */
      const [customSize, setCustomSize] = useState(() => prefs().customSize || '');
      /**
       * 「尺寸」输入框里**正在写的原话**(可以随便写:1080x1440 / 3:4 / 竖版 / 小红书…),
       * 失焦时由 `parseHumanSize()` 换算成上游认识的值。存的是"意图",不是最终字段。
       */
      const [sizeDraft, setSizeDraft] = useState(() => prefs().customSize || (prefs().ratio === SOURCE_SIZE ? SOURCE_TEXT : prefs().ratio) || SOURCE_TEXT);
      /**
       * 实物尺寸(mm/cm/英寸)换算成像素的基准,在「设置」里改,默认 300 DPI。
       * 存的是输入框里的**原话**,真正生效的值由 `normalizeDpi()` 兜底 —— 所以只占一个 state。
       */
      const [dpiDraft, setDpiDraft] = useState(() => String(Number(prefs().dpi) || DEFAULT_DPI));
      /** 当前生效的 DPI(空串 / 越界都退回 300)。 */
      const dpi = normalizeDpi(dpiDraft);
      /** 文字图层:选中的那一条、面板开关、本机检测到的字体。 */
      const [selectedTextId, setSelectedTextId] = useState('');
      const [showText, setShowText] = useState(false);
      /** 提交给模型时要不要把文字一起烧进去(默认不带:让模型别去重画你的字,反而会糊)。 */
      const [submitTexts, setSubmitTexts] = useState(false);
      const [fontList, setFontList] = useState(null);
      const [size, setSize] = useState({ w: 640, h: 480 });
      const [spaceDown, setSpaceDown] = useState(false);
      const [zoomLabel, setZoomLabel] = useState(1);
      const [hostStale, setHostStale] = useState(false);
      /** 上游最近一次返回的概要(排错用:卡住时能直接看到上游说了什么)。 */
      const [lastUpstream, setLastUpstream] = useState('');
      /** Skills 模板(在停靠区 Skills 标签里)。 */
      const [skills, setSkills] = useState([]);
      const [activeSkillId, setActiveSkillId] = useState('');
      const [skillDraft, setSkillDraft] = useState({ name: '', prompt: '' });
      /** 「图片分层(交给 Agent)」是否正在跑(落盘 + 发消息)。 */
      const [agentBusy, setAgentBusy] = useState(false);
      /**
       * 「图片分层(Agent)」的接口配置:地址 + 密钥草稿 + 回显掩码。
       * 密钥**只往宿主写、从不回读** —— 读接口只回 `sk-1****ab12` 这样的掩码。
       */
      const [layerCfg, setLayerCfg] = useState({
        base: '',
        /**
         * 端点路径(收在「高级」里,展开才出现):留空 = 用默认。
         *
         * 为什么要有这两格:图层分解各家路径不一样 —— 别人给的地址可能已经带 `/v1`,
         * 也可能整个路径形状都不同。能改路径 + 宿主拼 URL 时吃掉重复的 `/v1`
         * (见 `lib/index.js` 的 `joinApiUrl`),换平台才不至于"地址没错却怎么都连不上"。
         */
        submitEndpoint: '',
        statusEndpoint: '',
        /** 宿主给的默认端点(配置里空着时用它;由宿主下发,客户端不写死路径)。 */
        defaultSubmitEndpoint: '',
        defaultStatusEndpoint: '',
        /** 宿主按当前地址 + 端点算出的最终 URL:面板直接显示,免得猜"到底打到哪"。 */
        createUrl: '',
        statusUrl: '',
        modelsUrl: '',
        key: '',
        /** 技能配置里**已经存下来**的模型名(config/apimart_config.json 的 model)。 */
        model: '',
        /**
         * 输入框里正在写的模型名(草稿)。
         *
         * 为什么不直接绑 `model`:模型 ID 各家叫法都不一样,上游 `/v1/models` 也未必列全,
         * 所以这一格必须能手写;草稿与"已保存"分开,写一半切面板/重读配置都不会被冲掉。
         */
        modelDraft: '',
        /** 宿主给的兜底模型名(配置里空着时才会用到;由宿主下发,客户端不写死)。 */
        defaultModel: '',
        models: [],
        modelsAll: false,
        /** 「高级:端点路径」是否展开(纯界面状态,不落盘)。 */
        advanced: false,
        hasKey: false,
        masked: '',
        dir: '',
        note: '',
        busy: '',
      });
      /** 右上角「🔑 分层」浮层(独立的接口/密钥面板,从设置里拎出来的)。 */
      const [showLayerKey, setShowLayerKey] = useState(false);
      /** 宿主声明的能力清单(null = 还没探测到;老宿主没这个字段就当空数组)。 */
      const [hostFeatures, setHostFeatures] = useState(null);
      /**
       * 「AI 高清放大」:面板开关 / 档位 / 倍率 / 忙碌状态 / 宿主报的档位情况 / 提示语。
       *
       * 引擎不随插件打包(会从 386 KB 涨到几十 MB),所以第一次用时才下载;
       * `upscaleTiers` 就是宿主那份「哪个档位已经装好」的清单。
       */
      const [showUpscale, setShowUpscale] = useState(false);
      const [upscaleTier, setUpscaleTier] = useState('fast');
      const [upscaleScale, setUpscaleScale] = useState(4);
      const [upscaleBusy, setUpscaleBusy] = useState('');
      const [upscaleTiers, setUpscaleTiers] = useState([]);
      const [upscaleNote, setUpscaleNote] = useState('');
      /** 插件自我更新:更新地址(留空则用 DEFAULT_UPDATE_URL)、自动检查开关、检查结果与状态。 */
      const [updateUrl, setUpdateUrl] = useState(() => prefs().updateUrl || '');
      const [updateDraft, setUpdateDraft] = useState(() => prefs().updateUrl || '');
      const [updateAuto, setUpdateAuto] = useState(() => prefs().updateAuto !== false);
      const [updateInfo, setUpdateInfo] = useState(null);
      const [updateStatus, setUpdateStatus] = useState(null);
      const [updateBusy, setUpdateBusy] = useState('');
      const [updateNote, setUpdateNote] = useState('');
      /**
       * 把「正在编辑的提示词 + 文字图层」同步一份到工作区的 `画布/draft.json`。
       * 开着这个,对话里的 AI 才能读到你在写什么、帮你检查提示词漏了什么(默认开)。
       */
      const [draftSync, setDraftSync] = useState(() => prefs().draftSync !== false);
      /** 场景框(生成框)的尺寸/比例输入草稿。 */
      const [frameSizeDraft, setFrameSizeDraft] = useState('');
      /** 场景框点击放置时的弹窗草稿:{x,y}=世界坐标,{sx,sy}=屏幕坐标,value=输入的尺寸/比例。 */
      const [frameDraft, setFrameDraft] = useState(null);
      /** 选中的场景框 id(选择工具点中框后,可拖动/删除/改尺寸)。 */
      const [selectedFrameId, setSelectedFrameId] = useState(null);
      /** 画布右键菜单:`{ x, y, imageId }`(相对画布区左上角的屏幕坐标;空 id = 点在空白处)。 */
      const [menuAt, setMenuAt] = useState(null);
      /** 正在"就地编辑"的那条文字 id(双击文字进入,编辑框直接盖在画布上;空 = 没在编辑)。 */
      const [textEditId, setTextEditId] = useState('');
      /**
       * 「扩图」正在拉的那个框的 id(空 = 没在扩图)。
       *
       * 点工具条的「扩图」→ 图外围生成一个比它大的框并选中,四边四角出现可拖手柄;
       * 拉多大,扩出来就多大(框的宽高比与最终像素尺寸都照着它走)。
       */
      const [expandFrameId, setExpandFrameId] = useState(null);
      /** 「⟳ 获取新模型」的进行态(交给 Agent 那段时间里置灰,免得连点)。 */
      const [modelsBusy, setModelsBusy] = useState(false);
      /** 模型清单那一行提示语(载入了几个 / 正在让 Agent 去查)。 */
      const [modelsNote, setModelsNote] = useState('');

      const wrapRef = useRef(null);
      const canvasRef = useRef(null);
      const fileRef = useRef(null);
      /** 提示词输入框:画完箭头自动聚焦过去,顺势让人写"改成什么"。 */
      const promptRef = useRef(null);
      const camRef = useRef({ x: 0, y: 0, zoom: 1 });
      const docRef = useRef({ images: [], marks: [], frames: [] });
      const imgCacheRef = useRef(new Map());
      const sizeRef = useRef(size);
      const dragRef = useRef(null);
      /** 给 window 兜底用的"结束当前拖拽"入口(每次渲染更新,见下面的 useEffect)。 */
      const onPointerUpRef = useRef(() => {});
      const historyRef = useRef({ stack: [], index: -1 });
      const rafRef = useRef(0);
      const sessionRef = useRef('');
      const aliveRef = useRef(true);
      /** 「打断本次生成」的信号:轮询循环里查它,置位后最多半秒内停掉。 */
      const cancelRef = useRef(false);
      const saveTimerRef = useRef(0);
      const liveRef = useRef({});
      const drawRef = useRef(() => {});
      /**
       * 画笔类工具的「圆形笔尖」位置(屏幕坐标 `[x, y]`);鼠标离开画布时置 null。
       * 只是绘制层的一份临时数据:进 ref 不进 state —— 鼠标每动一下不该让 React 重渲染,
       * 但要让 draw() 知道圆点画在哪(直径 = 当前粗细 `markWidth`,与落笔后的线一样粗)。
       */
      const pointerRef = useRef(null);
      /** 刚结束的那次平移(右键是不是"按住拖了"用来判定:拖了就不弹右键菜单)。 */
      const panTailRef = useRef(null);
      /** 选中文字时画出来的那些屏幕坐标(包围盒 + 右下角"拉字号"手柄),供命中测试用。 */
      const textHandleRef = useRef(null);
      /**
       * 扩图框(正在拉的那个框)的 8 个手柄屏幕坐标 `{ id, handles: { nw, n, ne, w, e, sw, s, se } }`。
       * 和文字手柄一个套路:绘制时记下来,onPointerDown 拿它命中 —— "看到的方块"就是"能拖的方块"。
       */
      const frameHandleRef = useRef(null);
      /**
       * 「▶ 生成扩图」提交时钉住的那个框 id。
       *
       * 为什么不只靠 `selectedFrameId`:`run()` 要等下一次渲染才执行,这中间用户点一下
       * 画布空白就会把 `selectedFrameId` 清空 —— 生成于是掉进"落图到主图右侧"的默认
       * 分支(表现就是"另起一行、没盖住原图")。ref 不受渲染和选中状态影响,一路钉住。
       */
      const expandFrameRef = useRef(null);
      /**
       * 生成中的占位框:画布上那块「图将出现在这里」的框(里面是进度条与已耗时)。
       *
       * 刻意**不进 `docRef.current.images`** —— 不进存档(48MB 那条线)、不进撤销栈、
       * 不出现在图层面板/导出/命中测试里;它只是绘制层的一份临时数据,
       * 出图或失败就摘掉,所以画布上绝不会留下"取不回来的假图"。
       * 元素:`{ id, x, y, w, h, startedAt, label, pct, state, jobId, cancel }`。
       */
      const pendingRef = useRef([]);
      /**
       * 快捷工具条(点一张图,图上方浮出的那排按钮)刚点的模板 id。
       * `setActiveSkillId` 要等下一次渲染才生效,而「生成」得用生效后的那个闭包 ——
       * 所以按钮只把 id 记在这,等 activeSkillId 追上来了再自动提交一次(见下面的 effect)。
       */
      const autoRunSkillRef = useRef('');
      /**
       * 生成任务表(**并发/排队**都靠它)。同样用 ref 不进 state:连点几次「生成」时,
       * 每次 run() 拿到的都是同一次渲染里的旧闭包,写 state 会互相顶掉;写 ref 则叠加。
       * `busy` 仍是"还有任务在跑"的汇总,给界面看。
       * 元素:`{ id, state, label, queueLabel, phase, pct, startedAt, plan, rect, cancelFlag, ph }`。
       */
      const jobsRef = useRef([]);
      /**
       * 落图串行锁:两张同时出图时,位置要在**前一张写回 doc 之后**才算,否则算出同一个点。
       * 传进 generate 零件的是这个 ref,不是 Promise 本身。
       */
      const placeLockRef = useRef(Promise.resolve());
      /**
       * 顶部导航「鼠标停上去就开」的记账本:`name` 记下当前**因为悬停**开着的那一块
       * (手点开的不记),`timer` 是鼠标移开后的收起倒计时 —— 期间划到别的入口、
       * 或者落进面板里,都会被下一次 enter 清掉,所以穿过画布那一下不会误收。
       */
      const hoverPanelRef = useRef({ name: '', timer: null });
      /**
       * 悬停开出来的那块面板贴哪儿(`{ left, top, maxRight }`,相对画布区左上角)。
       * 用 ref 不用 state:它总是和「开面板」那一次 setState 一起变,渲染时读到的一定是新的,
       * 而且能绕开 `06-utils.js` 里 STATE_ORDER 的同步约束。
       */
      const panelAnchorRef = useRef(null);
      /**
       * 当前被点中的生成占位框 id。用 ref 不用 state:选中只是画布上的一圈描边,
       * 重绘一下就够,不参与 React 渲染,也不用去动 06-utils.js 里 STATE_ORDER 的同步约束。
       */
      const selectedPlaceholderRef = useRef('');
      const actionsRef = useRef({});
      /**
       * 宿主半边是否缺少画布存档接口(客户端被 HMR 换成新版、宿主还没重启时会这样)。
       * 用 ref 是为了让防抖里的自动保存能立刻看到。
       */
      const hostStaleRef = useRef(false);
      /** 鼠标是否在画布上:快捷键只在鼠标悬停画布时生效,免得抢走 Delete/Ctrl+Z。 */
      const hoverRef = useRef(false);
      /** 当前 KEY:续查等待存档和凭据就绪,异步查询从 ref 读最新值。 */
      const apikeyRef = useRef('');
      /** 自定义 Skills 模板是否已经从宿主读过一次。 */
      const skillsLoadedRef = useRef(false);
      /** 「交给 Agent」的并发闸:state 在异步回调里可能是旧值,用它挡住连点。 */
      const agentBusyRef = useRef(false);
      /** 「⟳ 获取新模型」防连点(交给 Agent 那一段是异步的)。 */
      const modelsBusyRef = useRef(false);
      /** 工作区模型清单只在打开画布时自动载入一次,之后靠用户点按钮。 */
      const modelsLoadedRef = useRef(false);
      /** 等 Agent 写清单时的轮询定时器。 */
      const modelsWatchRef = useRef(null);
      /** 宿主能力清单,给 effect / 回调读最新值(它们只跑一次或不在渲染期)。 */
      const featuresRef = useRef([]);
      // ── 生成记录(第一期 A) ──────────────────────────────────────────
      /** 记录的权威数据:入库/收藏/删除都先改这里,再同步到渲染 state。 */
      const recordsRef = useRef([]);
      /** 清单文件是否损坏(GET /history 回 corrupted:true)——覆盖前必须确认。 */
      const corruptedRef = useRef(false);
      /** 用户已确认覆盖损坏清单。 */
      const corruptedOkRef = useRef(false);
      /** 串行化持久化队列(makePersister 实例;每渲染重建会让排队失效,所以放 ref)。 */
      const persisterRef = useRef(null);
      // 对比视图的引用:覆盖层 canvas、两个解码 Image、拖拽手势中间态
      // (放在核心 refs 之后,保持 docRef 及之前 ref 的声明顺序不变)
      const compareCanvasRef = useRef(null);
      const compareImgARef = useRef(null);
      const compareImgBRef = useRef(null);
      const compareDragRef = useRef(null);

      const sessionId = (props && props.sessionId) || '';
      sessionRef.current = sessionId;
      apikeyRef.current = apikey;
      featuresRef.current = Array.isArray(hostFeatures) ? hostFeatures : [];
      /** 宿主半边是否带「图片分层」配置接口(缺了就是旧版,得重启一次 DSH)。 */
      const layerHostReady = featuresRef.current.includes('layering-config');
      /** 宿主是否支持「取可用模型」(0.19.6 才加的接口;缺了就是旧版,点了只会得到"未知路由")。 */
      const layerModelsReady = featuresRef.current.includes('layering-models');
      /** 宿主是否提供「AI 高清放大」接口(缺了就是旧版,得重启一次 DSH)。 */
      const upscaleHostReady = featuresRef.current.includes('upscale');
      sizeRef.current = size;
      liveRef.current = { tool, selectedId, selectedIds, selectedFrameId, expandFrameId, selectedTextId, color, markWidth, spaceDown };

      const images = docRef.current.images;
      const marks = docRef.current.marks;
      const selected = images.find((im) => im.id === selectedId) || null;
      // 参考计数与 41-generate 的收集规则保持一致:排除主选、排除隐藏(隐藏的 isRef 原样保留)
      const refCount = images.filter((im) => im.isRef && !im.hidden && im.id !== selectedId).length;
      const selectedMarks = selected ? marks.filter((mk) => mk.targetId === selected.id) : [];
      /** 选中图实际会按什么尺寸提交(大图会被缩),给按钮边上显示,免得事后惊讶。 */
      const frames = docRef.current.frames || [];
      const selectedFrame = frames.find((frame) => frame.id === selectedFrameId) || frames[frames.length - 1] || null;
      const submitPreview = selected
        ? submissionRegion(selected.naturalW || selected.w, selected.naturalH || selected.h, selectedMarks, cropToMark)
        : null;
      /**
       * 「原图比例」当前会换算成什么 —— 给界面提示用,免得人以为尺寸被"定死"了。
       * 跟着被改的那张图;没有主图就跟第一张参考图;都没有就是空的(提交时会按 auto)。
       */
      const sourceImage = selected || images.find((im) => im.isRef) || null;
      const sourceAspect = selectedFrame
        ? selectedFrame.w / selectedFrame.h
        : submitPreview
          ? submitPreview.width / submitPreview.height
        : sourceImage && sourceImage.naturalW && sourceImage.naturalH
          ? sourceImage.naturalW / sourceImage.naturalH
          : 0;
      const sourceResolved = ratio === SOURCE_SIZE || selectedFrame ? (sourceAspect > 0 ? nearestSize(model, sourceAspect) : defaultSizeFor(model)) : '';
      /** 自动检查发现的新版本(有的话设置按钮会变成「设置 ⬆x.y.z」)。 */
      const updateAvailable = Boolean(updateInfo && updateInfo.newer);
      /** 内置 + 自定义的 Skills 模板;选中的那个(没选就是 null)。 */
      const allSkills = BUILTIN_SKILLS.concat(skills);
      const activeSkill = allSkills.find((item) => item.id === activeSkillId) || null;
      // docVersion 让上面这些派生值跟着文档变化刷新
      void docVersion;

      const bumpDoc = useCallback(() => setDocVersion((v) => v + 1), []);

      const ensureImage = useCallback((id, dataUrl) => {
        const cache = imgCacheRef.current;
        const hit = cache.get(id);
        if (hit && hit.dataset.src === dataUrl) return hit;
        const el = new Image();
        el.dataset.src = dataUrl;
        el.onload = () => actionsRef.current.scheduleDraw && actionsRef.current.scheduleDraw();
        el.src = dataUrl;
        cache.set(id, el);
        return el;
      }, []);

      const scheduleDraw = useCallback(() => {
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          drawRef.current();
        });
      }, []);

      /**
       * 占位框里那个「⏹ 打断」按钮的屏幕矩形。
       * **绘制与命中共用这一个算法** —— 不然按钮画在一处、手点在另一处,迟早错位。
       * 框在屏幕上太小时返回 null(不画、也不可点:那种尺寸点了只会误触旁边的图)。
       * @returns {{x:number,y:number,w:number,h:number}|null}
       */
      function placeholderCancelRect(cam, ph) {
        const a = worldToScreen(cam, ph.x, ph.y);
        const w = ph.w * cam.zoom;
        const hh = ph.h * cam.zoom;
        if (w < 40 || hh < 24) return null;
        const wide = w >= 84 && hh >= 52;
        const bw = wide ? 64 : 24;
        const pad = wide ? 8 : 4;
        return { x: a[0] + w - bw - pad, y: a[1] + pad, w: bw, h: 20 };
      }

      /**
       * 屏幕坐标落在哪个生成占位框里 —— 从后往前找(后画的在上层,和图片一个规矩)。
       * 点选和拖动都用它,所以走的是绘制时那套 worldToScreen/zoom,不会"看到一处、点到另一处"。
       * 返回的就是 pendingRef 里那一条,改它的 x/y 即生效(出图就落在那个位置)。
       * @returns {object|null}
       */
      function hitPlaceholder(sx, sy) {
        const cam = camRef.current;
        const list = pendingRef.current;
        for (let i = list.length - 1; i >= 0; i--) {
          const ph = list[i];
          const a = worldToScreen(cam, ph.x, ph.y);
          const w = ph.w * cam.zoom;
          const hh = ph.h * cam.zoom;
          if (sx >= a[0] && sx <= a[0] + w && sy >= a[1] && sy <= a[1] + hh) return ph;
        }
        return null;
      }

      // ── 绘制 ────────────────────────────────────────────────────────
      drawRef.current = function draw() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const W = sizeRef.current.w;
        const H = sizeRef.current.h;
        if (W <= 0 || H <= 0) return;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        const c = canvas.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, W, H);

        const cam = camRef.current;
        const doc = docRef.current;
        const ui = liveRef.current;

        // 点阵底纹:让平移/缩放有参照
        const steps = [10, 20, 50, 100, 200, 500, 1000, 2000];
        let step = steps[steps.length - 1];
        for (const candidate of steps) {
          if (candidate * cam.zoom >= 22) {
            step = candidate;
            break;
          }
        }
        const startWx = cam.x - cam.x % step;
        const startWy = cam.y - cam.y % step;
        c.fillStyle = 'rgba(127,127,127,0.30)';
        for (let wx = startWx; ; wx += step) {
          const sx = (wx - cam.x) * cam.zoom;
          if (sx > W) break;
          if (sx < -1) continue;
          for (let wy = startWy; ; wy += step) {
            const sy = (wy - cam.y) * cam.zoom;
            if (sy > H) break;
            if (sy < -1) continue;
            c.fillRect(sx, sy, 1, 1);
          }
        }

        // 图片(隐藏的图:不绘制 —— 显隐开关在图层面板)
        for (const image of doc.images) {
          if (image.hidden) continue;
          const a = worldToScreen(cam, image.x, image.y);
          const w = image.w * cam.zoom;
          const hh = image.h * cam.zoom;
          c.save();
          c.fillStyle = 'rgba(127,127,127,0.10)';
          c.fillRect(a[0], a[1], w, hh);
          const el = imgCacheRef.current.get(image.id);
          if (el && el.complete && el.naturalWidth > 0) {
            c.imageSmoothingQuality = 'high';
            c.drawImage(el, a[0], a[1], w, hh);
          } else {
            c.strokeStyle = 'rgba(127,127,127,0.5)';
            c.setLineDash([6, 4]);
            c.strokeRect(a[0] + 0.5, a[1] + 0.5, w - 1, hh - 1);
            c.setLineDash([]);
            c.fillStyle = 'rgba(127,127,127,0.8)';
            c.font = '12px system-ui, sans-serif';
            c.fillText('载入中…', a[0] + 8, a[1] + 18);
          }
          // 文字图层:和导出用的是同一个绘制函数,所以屏幕上看到的就是最后烧进去的样子
          if (Array.isArray(image.texts) && image.texts.length) {
            c.save();
            c.translate(a[0], a[1]);
            drawImageTexts(c, image.texts, w, hh);
            c.restore();
          }
          c.restore();
        }

        // 选中的文字图层:虚线包围盒 + 右下角方块手柄(拖它 = 拉大/缩小字号)。
        // 手柄位置写进 textHandleRef,onPointerDown 拿它做命中 —— "看到的方块"就是"能拖的方块"。
        textHandleRef.current = null;
        if (tool === 'select' && selectedId && selectedTextId) {
          const host = docRef.current.images.find((im) => im.id === selectedId);
          const item = host && !host.hidden && Array.isArray(host.texts) ? host.texts.find((tx) => tx.id === selectedTextId) : null;
          if (host && item) {
            const a = worldToScreen(cam, host.x, host.y);
            const w = host.w * cam.zoom;
            const hh = host.h * cam.zoom;
            const box = textLayerBounds(item, w, hh);
            const bx = a[0] + box.x;
            const by = a[1] + box.y;
            const hx = bx + box.w + 2;
            const hy = by + box.h + 2;
            c.save();
            c.strokeStyle = '#3b82f6';
            c.lineWidth = 1;
            c.setLineDash([5, 4]);
            c.strokeRect(bx - 2, by - 2, box.w + 4, box.h + 4);
            c.setLineDash([]);
            c.fillStyle = '#ffffff';
            c.fillRect(hx - 6, hy - 6, 12, 12);
            c.strokeStyle = '#3b82f6';
            c.lineWidth = 2;
            c.strokeRect(hx - 6, hy - 6, 12, 12);
            c.restore();
            textHandleRef.current = {
              id: item.id,
              targetId: host.id,
              hx,
              hy,
              size: Number(item.size) || TEXT_DEFAULTS.size,
              wx: host.x + (box.x + box.w / 2) / cam.zoom,
              wy: host.y + (box.y + box.h / 2) / cam.zoom,
            };
          }
        }

        // 生成中的占位框:和即将出现的那张图同尺寸,框里是进度条 + 已耗时 + 「⏹ 打断」。
        // 只读 pendingRef(绘制专用) —— 不参与图层与导出,出图/失败/打断即消失。
        // 进度读的是**每个框自己的** `ph.pct`:同一条上游上可能同时跑着好几张。
        const placeholders = pendingRef.current;
        if (placeholders.length) {
          const now = Date.now();
          for (const ph of placeholders) {
            const a = worldToScreen(cam, ph.x, ph.y);
            const w = ph.w * cam.zoom;
            const hh = ph.h * cam.zoom;
            const pct = clamp(Math.round(ph.pct) || 0, 0, 100);
            const queued = ph.state === 'queued';
            const stopping = ph.state === 'cancelling';
            const elapsed = Math.max(0, now - (ph.startedAt || now));
            c.save();
            // 状态色:排队=石板灰 / 打断=橙 / 生成中=蓝
            const tone = stopping ? [249, 115, 22] : queued ? [100, 116, 139] : [59, 130, 246];
            const tint = (alpha) => `rgba(${tone[0]}, ${tone[1]}, ${tone[2]}, ${alpha})`;
            const R = Math.max(2, Math.min(16, w / 8, hh / 8));
            // 圆角路径:c.roundRect 优先(Chromium 99+ / Safari 16+),老引擎退化成直角
            const shape = (x, y, pw, phh, r) => {
              c.beginPath();
              if (c.roundRect) c.roundRect(x, y, pw, phh, r);
              else c.rect(x, y, pw, phh);
            };
            // 底:白卡 + 点阵底纹(极简风)。点阵走缓存小块平铺,裁在圆角里
            shape(a[0], a[1], w, hh, R);
            c.fillStyle = 'rgba(255, 255, 255, 0.96)';
            c.fill();
            c.save();
            shape(a[0], a[1], w, hh, R);
            c.clip();
            c.fillStyle = placeholderDotPattern(c);
            c.fillRect(a[0], a[1], w, hh);
            c.restore();
            // 边:一根细墨线 + 很含蓄的呼吸 —— 安静地"活着",不跳(排队时不呼吸,免得像在催)
            // 被点中的那个换成状态色加粗,像图片选中那样给一句"它在你手上"的反馈
            const selected = ph.id === selectedPlaceholderRef.current;
            const pulse = queued ? 0.13 : 0.1 + 0.06 * (0.5 + 0.5 * Math.sin(now / 620));
            shape(a[0] + 0.75, a[1] + 0.75, w - 1.5, hh - 1.5, Math.max(1, R - 0.75));
            c.strokeStyle = selected ? tint(0.9) : `rgba(15, 23, 42, ${pulse})`;
            c.lineWidth = selected ? 2 : 1.5;
            c.stroke();
            if (selected) {
              // 再套一圈淡的:单根细线落在浅色画布上容易看不见
              shape(a[0], a[1], w, hh, R);
              c.strokeStyle = tint(0.32);
              c.lineWidth = 4;
              c.stroke();
            }
            // 框在屏幕上太小就只留边框:字和进度条塞进去只会糊成一团
            if (w >= 84 && hh >= 52) {
              // 顶部:一行状态色小字(尺寸 + 备注),不再是贴边的一块方角
              const caption =
                `${queued ? '排队中' : stopping ? '正在打断' : '生成中'} ${Math.round(ph.w)}×${Math.round(ph.h)}` +
                (ph.label ? ` · ${ph.label}` : '');
              c.font = '600 11px system-ui, sans-serif';
              c.fillStyle = tint(0.95);
              c.fillText(caption, a[0] + 16, a[1] + 22);
              // 中央:大号墨色百分比(字号随框宽缩,小框不糊) + 已耗时
              const midY = a[1] + hh / 2;
              const pctPx = Math.max(16, Math.min(40, Math.round(w * 0.1)));
              c.textAlign = 'center';
              if (pct > 0) {
                c.font = `700 ${pctPx}px system-ui, sans-serif`;
                c.fillStyle = 'rgba(15, 23, 42, 0.94)';
                c.fillText(`${pct}%`, a[0] + w / 2, midY - 2);
                c.font = '11px system-ui, sans-serif';
                c.fillStyle = 'rgba(100, 116, 139, 0.95)';
                c.fillText(stopping ? '正在打断…' : `已等 ${durationText(elapsed)}`, a[0] + w / 2, midY + 24);
              } else {
                c.font = '600 12px system-ui, sans-serif';
                c.fillStyle = 'rgba(100, 116, 139, 0.95)';
                c.fillText(queued ? '排队中…' : stopping ? '正在打断…' : '等待上游…', a[0] + w / 2, midY + 6);
              }
              c.textAlign = 'start';
              // 底部:细圆角进度条。没进度时跑一条柔光(两头淡出的渐变拖尾),不是硬方块来回撞
              const barW = Math.max(28, Math.min(w - 24, 420));
              const barH = 5;
              const barX = a[0] + (w - barW) / 2;
              const barY = a[1] + hh - 15;
              shape(barX, barY, barW, barH, barH / 2);
              c.fillStyle = 'rgba(15, 23, 42, 0.09)';
              c.fill();
              if (pct > 0) {
                shape(barX, barY, Math.max(barH, (barW * pct) / 100), barH, barH / 2);
                c.fillStyle = tint(0.95);
                c.fill();
              } else {
                // 上游还没报进度(或者一直给 0):一条柔光慢慢扫过,让人知道没卡死
                const span = barW * 0.34;
                const cx = barX - span + (barW + span) * (((now / 1000) % 2.2) / 2.2);
                const left = Math.max(barX, cx);
                const right = Math.min(barX + barW, cx + span);
                if (right > left + 1) {
                  const flow = c.createLinearGradient(left, 0, right, 0);
                  flow.addColorStop(0, tint(0));
                  flow.addColorStop(0.5, tint(queued ? 0.5 : 0.85));
                  flow.addColorStop(1, tint(0));
                  c.fillStyle = flow;
                  shape(left, barY, right - left, barH, barH / 2);
                  c.fill();
                }
              }
            }
            // 「⏹ 打断」按钮:画在框的右上角。矩形来自 placeholderCancelRect —— 命中测试用的是同一个
            const btn = placeholderCancelRect(cam, ph);
            if (btn) {
              const wide = w >= 84 && hh >= 52;
              // 白底红字 + 细红边:危险,但不抢戏
              shape(btn.x, btn.y, btn.w, btn.h, Math.min(9, btn.h / 2));
              c.fillStyle = 'rgba(255, 255, 255, 0.94)';
              c.fill();
              shape(btn.x + 0.5, btn.y + 0.5, btn.w - 1, btn.h - 1, Math.min(9, btn.h / 2));
              c.strokeStyle = 'rgba(220, 38, 38, 0.38)';
              c.lineWidth = 1;
              c.stroke();
              c.fillStyle = 'rgba(220, 38, 38, 1)';
              c.font = '600 11px system-ui, sans-serif';
              c.textAlign = 'center';
              c.textBaseline = 'middle';
              c.fillText(wide ? '⏹ 打断' : '⏹', btn.x + btn.w / 2, btn.y + btn.h / 2 + 1);
              c.textAlign = 'start';
              c.textBaseline = 'alphabetic';
            }
            c.restore();
          }
        }

        // 标注(画在图片之上;隐藏图的标注跟着图一起不画)
        for (const image of doc.images) {
          if (image.hidden) continue;
          const list = doc.marks.filter((mk) => mk.targetId === image.id);
          if (list.length) renderMarks(c, list, screenMarkMap(cam, image));
        }

        // 参考图常驻编号:不选中任何图的时候,画布上也要看得见"哪几张会被当参考发出去、排第几"。
        // 编号规则跟提交顺序严格对齐(refNumbers,见 06-utils):提交体里第 1 张是主图,
        // 参考图从第 2 张起 —— 所以主选图打「主图」、不占参考号。
        {
          const refs = doc.images.filter((im) => im.isRef && !im.hidden);
          if (refs.length) {
            const numbers = refNumbers(doc.images, ui.selectedId);
            for (const image of refs) {
              const no = numbers.get(image.id);
              const isMain = !no;
              const label = isMain ? '主图' : `参考 ${no}`;
              const a = worldToScreen(cam, image.x, image.y);
              drawRefBadge(c, a[0], a[1], W, H, label, isMain);
            }
          }
        }

        // 选中框 + 缩放手柄(仅选择工具,避免画标注时挡视线);多选时只给主选中画手柄
        if (ui.tool === 'select') {
          const selIds = ui.selectedIds && ui.selectedIds.length ? ui.selectedIds : ui.selectedId ? [ui.selectedId] : [];
          for (const id of selIds) {
            const image = doc.images.find((im) => im.id === id);
            // 隐藏图不画选中框(画布上看不见它);它仍可在图层面板里选中
            if (!image || image.hidden) continue;
            const a = worldToScreen(cam, image.x, image.y);
            const w = image.w * cam.zoom;
            const hh = image.h * cam.zoom;
            const isPrimary = id === ui.selectedId;
            c.save();
            c.strokeStyle = isPrimary ? '#3b82f6' : 'rgba(59,130,246,0.55)';
            c.lineWidth = 1.5;
            c.strokeRect(a[0] - 1, a[1] - 1, w + 2, hh + 2);
            if (image.locked) {
              // 锁定图:画个灰标签提醒,不画缩放手柄(所有改它的入口都挡在 hitHandle/pointer 层)
              // (参考图编号已经常驻画在图内了,这里只管锁定,不再叠一个「参考图」标签)
              c.fillStyle = 'rgba(127,127,127,0.85)';
              c.fillRect(a[0] - 1, a[1] - 20, 46, 18);
              c.fillStyle = '#fff';
              c.font = '600 11px system-ui, sans-serif';
              c.fillText('已锁定', a[0] + 4, a[1] - 7);
            }
            if (isPrimary && !image.locked) {
              const corners = [
                [a[0], a[1]],
                [a[0] + w, a[1]],
                [a[0], a[1] + hh],
                [a[0] + w, a[1] + hh],
              ];
              c.fillStyle = '#fff';
              for (const p of corners) {
                c.beginPath();
                c.rect(p[0] - 4, p[1] - 4, 8, 8);
                c.fill();
                c.stroke();
              }
            }
            c.restore();
          }
        }

        // 场景框(生成框):绿色虚线框 + 尺寸标签;选中的框高亮
        // 「扩图」拉出来的那个框(ui.expandFrameId)另画 8 个拖拽手柄:框拉多大,扩出来就多大。
        frameHandleRef.current = null;
        for (const frame of doc.frames || []) {
          const selectedFrame = ui.selectedFrameId === frame.id;
          const expanding = Boolean(ui.expandFrameId) && ui.expandFrameId === frame.id;
          const a = worldToScreen(cam, frame.x, frame.y);
          const w = frame.w * cam.zoom;
          const h = frame.h * cam.zoom;
          c.save();
          c.fillStyle = expanding ? 'rgba(59,130,246,0.10)' : selectedFrame ? 'rgba(229,72,77,0.16)' : 'rgba(11,110,79,0.10)';
          c.fillRect(a[0], a[1], w, h);
          c.strokeStyle = expanding ? '#3b82f6' : selectedFrame ? '#e5484d' : '#0b6e4f';
          c.lineWidth = selectedFrame || expanding ? 2.5 : 2;
          c.setLineDash(expanding ? [] : [6, 4]);
          c.strokeRect(a[0], a[1], w, h);
          c.setLineDash([]);
          const frameTag = expanding
            ? `扩图 ${Math.round(frame.w)}×${Math.round(frame.h)}`
            : `${selectedFrame ? '生成框(选中)' : '生成框'} ${Math.round(frame.w)}×${Math.round(frame.h)}`;
          c.fillStyle = expanding ? '#3b82f6' : selectedFrame ? '#fff' : '#d3f2e0';
          c.fillRect(a[0], a[1], expanding ? 180 : selectedFrame ? 172 : 152, 18);
          c.fillStyle = expanding || selectedFrame ? '#fff' : '#111';
          c.font = '600 11px system-ui, sans-serif';
          c.fillText(frameTag, a[0] + 4, a[1] + 3);
          if (expanding) {
            const hs = {
              nw: [a[0], a[1]],
              n: [a[0] + w / 2, a[1]],
              ne: [a[0] + w, a[1]],
              w: [a[0], a[1] + h / 2],
              e: [a[0] + w, a[1] + h / 2],
              sw: [a[0], a[1] + h],
              s: [a[0] + w / 2, a[1] + h],
              se: [a[0] + w, a[1] + h],
            };
            c.fillStyle = '#ffffff';
            c.strokeStyle = '#3b82f6';
            c.lineWidth = 2;
            for (const key of Object.keys(hs)) {
              c.fillRect(hs[key][0] - 6, hs[key][1] - 6, 12, 12);
              c.strokeRect(hs[key][0] - 6, hs[key][1] - 6, 12, 12);
            }
            frameHandleRef.current = { id: frame.id, handles: hs };
          }
          c.restore();
        }

        // 橡皮的指示圈
        const drag = dragRef.current;
        if (drag && drag.kind === 'box') {
          // 框选橡皮筋
          const bx0 = Math.min(drag.sx, drag.ex);
          const by0 = Math.min(drag.sy, drag.ey);
          const bw = Math.abs(drag.ex - drag.sx);
          const bh = Math.abs(drag.ey - drag.sy);
          c.save();
          c.fillStyle = 'rgba(59,130,246,0.12)';
          c.fillRect(bx0, by0, bw, bh);
          c.strokeStyle = '#3b82f6';
          c.lineWidth = 1;
          c.setLineDash([4, 3]);
          c.strokeRect(bx0 + 0.5, by0 + 0.5, bw, bh);
          c.setLineDash([]);
          c.restore();
        }
        if (drag && drag.kind === 'erase' && drag.cursor) {
          c.save();
          c.strokeStyle = '#e5484d';
          c.lineWidth = 1.5;
          c.beginPath();
          c.arc(drag.cursor[0], drag.cursor[1], 12, 0, Math.PI * 2);
          c.stroke();
          c.restore();
        }

        // 画笔类工具的圆形笔尖:直径就是当前粗细的**屏幕**像素(和画上去的线一样粗),
        // 所以拖动滑杆能直接看出这一笔多粗。黑白双圈 + 淡填充:深底、浅底、花底上都看得见。
        const pen = pointerRef.current;
        if (pen && !ui.spaceDown && RING_TOOLS.indexOf(ui.tool) >= 0) {
          const radius = Math.max(2.5, (Number(ui.markWidth) || 10) / 2);
          c.save();
          c.beginPath();
          c.arc(pen[0], pen[1], radius, 0, Math.PI * 2);
          c.fillStyle = 'rgba(255,255,255,0.16)';
          c.fill();
          c.lineWidth = 3;
          c.strokeStyle = 'rgba(0,0,0,0.5)';
          c.stroke();
          c.lineWidth = 1.5;
          c.strokeStyle = 'rgba(255,255,255,0.95)';
          c.stroke();
          c.restore();
        }
      };

      // ── 文档变更与历史 ──────────────────────────────────────────────
      // 语义:`stack[index]` 就是"当前状态"那一份快照。改动提交时把新状态压栈,
      // 撤销/重做只挪 index 并整份还原 —— 这样一次改动正好一步。
      const resetHistory = useCallback(() => {
        historyRef.current = { stack: [cloneDoc(docRef.current)], index: 0 };
      }, []);

      const beginChange = useCallback(() => {
        if (dragRef.current) dragRef.current.changed = false;
      }, []);

      const scheduleSave = useCallback(() => {
        if (hostStaleRef.current) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = 0;
          actionsRef.current.saveNow && actionsRef.current.saveNow(true);
        }, 1200);
      }, []);

      const finishChange = useCallback(
        (changed) => {
          if (changed !== false) {
            const history = historyRef.current;
            if (history.stack.length === 0) {
              history.stack = [cloneDoc(docRef.current)];
              history.index = 0;
            } else {
              history.stack = history.stack.slice(0, history.index + 1);
              history.stack.push(cloneDoc(docRef.current));
              if (history.stack.length > 60) history.stack.shift();
              history.index = history.stack.length - 1;
            }
            scheduleSave();
          }
          bumpDoc();
          scheduleDraw();
        },
        [bumpDoc, scheduleDraw, scheduleSave],
      );

      const saveNow = useCallback(
        async (silent) => {
          if (hostStaleRef.current) {
            setSaved('宿主旧版:没存');
            return;
          }
          const doc = docRef.current;
          const payload = {
            version: DOC_VERSION,
            savedAt: Date.now(),
            cam: camRef.current,
            images: doc.images,
            marks: doc.marks,
            frames: doc.frames || [],
            prefs: { model, ratio, quality, background, imageSize, color, markWidth },
          };
          try {
            await api('/state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }, sessionRef.current);
            const now = new Date();
            const p = (n) => String(n).padStart(2, '0');
            setSaved(`已保存 ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`);
            if (!silent) setNotice('画布已保存');
          } catch (e) {
            const message = String((e && e.message) || e);
            // 宿主没有 /state:说人话,不要甩一句「未知路由」
            if (/未知路由|HTTP 404/.test(message)) {
              hostStaleRef.current = true;
              setHostStale(true);
              setSaved('宿主旧版:没存');
              return;
            }
            setSaved('保存失败');
            setError(`画布保存失败:${message}`);
          }
        },
        [model, ratio, quality, background, imageSize, color, markWidth],
      );

      /**
       * 撤销/重做之后按新文档校正选择:别让 selectedId / 框 / 正在改的文字指向已经不存在的对象。
       * 不校正的话,属性卡会读到 undefined 白屏,「删除」也可能删错东西。
       */
      const pruneSelectionAfterHistory = useCallback(() => {
        const live = liveRef.current;
        const doc = docRef.current;
        const imageIds = new Set(doc.images.map((im) => im.id));
        if (live.selectedId && !imageIds.has(live.selectedId)) setSelectedId(null);
        setSelectedIds((prev) => {
          const next = prev.filter((id) => imageIds.has(id));
          return next.length === prev.length ? prev : next;
        });
        const frameIds = new Set((doc.frames || []).map((frame) => frame.id));
        if (live.selectedFrameId && !frameIds.has(live.selectedFrameId)) setSelectedFrameId(null);
        if (expandFrameRef.current && !frameIds.has(expandFrameRef.current)) {
          expandFrameRef.current = null;
          setExpandFrameId(null);
        }
        const textIds = new Set();
        for (const im of doc.images) for (const tx of im.texts || []) if (tx && tx.id) textIds.add(tx.id);
        if (live.selectedTextId && !textIds.has(live.selectedTextId)) {
          setSelectedTextId(null);
          setTextEditId('');
        }
      }, []);

      const undo = useCallback(() => {
        const history = historyRef.current;
        if (history.index <= 0 || history.stack.length === 0) return;
        history.index -= 1;
        docRef.current = cloneDoc(history.stack[history.index]);
        for (const image of docRef.current.images) ensureImage(image.id, image.dataUrl);
        pruneSelectionAfterHistory();
        setNotice('已撤销');
        bumpDoc();
        scheduleSave();
        scheduleDraw();
      }, [bumpDoc, ensureImage, pruneSelectionAfterHistory, scheduleDraw, scheduleSave]);

      const redo = useCallback(() => {
        const history = historyRef.current;
        if (history.index < 0 || history.index >= history.stack.length - 1) return;
        history.index += 1;
        docRef.current = cloneDoc(history.stack[history.index]);
        for (const image of docRef.current.images) ensureImage(image.id, image.dataUrl);
        pruneSelectionAfterHistory();
        setNotice('已重做');
        bumpDoc();
        scheduleSave();
        scheduleDraw();
      }, [bumpDoc, ensureImage, pruneSelectionAfterHistory, scheduleDraw, scheduleSave]);

      // ── 生成记录(第一期 A:持久化 + 参数复用) ─────────────────────
      const historyStore = rt['history-store'].createHistoryStore({ sessionRef });
      if (!persisterRef.current) {
        persisterRef.current = historyStore.makePersister({
          sessionRef,
          getRecords: () => recordsRef.current,
          onError: setError,
          shouldOverride: () => {
            if (!corruptedRef.current || corruptedOkRef.current) return true;
            // 清单坏过:第一次覆盖前必须用户点头,不能悄悄把旧数据抹成空
            const ok = window.confirm('生成记录清单文件损坏(载入时按空处理)。保存会用当前记录覆盖它,旧内容无法找回。继续吗?');
            corruptedOkRef.current = ok;
            return ok;
          },
        });
      }
      /** 宿主是否提供「生成记录」清单接口(缺了就是旧版:记录仅本页有效,重启一次 DSH 恢复持久化)。 */
      const historyHostReady = featuresRef.current.includes('history');

      /**
       * 把一次成功生成写进记录 —— 正常生成与续查都汇到这里。
       * 先落资源、再写清单;任何一步失败都只提示,**绝不重跑生成**(那要再花一次钱)。
       * @param {object} snap - 生成侧快照(白名单字段,见 41-generate 的 onRecord 调用)。
       * @returns {Promise<void>} 异步完成。
       */
      async function onRecord(snap) {
        const session = sessionRef.current;
        const record = historyStore.buildRecord(snap);
        // 去重:同一上游任务只入一条(正常与续查两条路都走这里)
        if (record.taskId && recordsRef.current.some((item) => item.taskId === record.taskId)) return;
        if (recordsRef.current.some((item) => item.id === record.id)) return;
        const trimmed = historyStore.trimRecords([record, ...recordsRef.current]);
        recordsRef.current = trimmed.records;
        setRecords(trimmed.records);
        if (trimmed.trimmed) {
          setNotice(`生成记录已达 ${historyStore.MAX_RECORDS} 条上限:丢掉了最旧的 ${trimmed.trimmed} 条${trimmed.touchedFav ? `(含收藏 ${trimmed.touchedFav} 条)` : ''} —— 收藏优先保留`);
        }
        if (!historyHostReady) return; // 旧宿主:仅本页有效
        try {
          record.file = await historyStore.saveResource(record, snap.dataUrl, session);
        } catch (e) {
          if (sessionRef.current !== session) return;
          setError(`结果图没能存进工作区(${(e && e.message) || e}):这条记录只留了来源链接,重启画布后可能无法恢复图片`);
        }
        if (sessionRef.current !== session) return; // 切了工作区:清单留给新会话自己读
        persisterRef.current.push('入库');
      }

      /** 收藏 / 取消收藏一条记录(持久化)。 */
      function toggleRecordFav(id) {
        const record = recordsRef.current.find((item) => item.id === id);
        if (!record) return;
        record.fav = !record.fav;
        setRecords(recordsRef.current.slice());
        if (historyHostReady) persisterRef.current.push(record.fav ? '收藏' : '取消收藏');
      }

      /**
       * 删除一条记录:只从清单移除。不碰画布上的图(独立对象),也不删工作区里的
       * 结果文件 —— 那是你的文件,面板里删记录 ≠ 清磁盘。
       */
      function removeRecord(id) {
        recordsRef.current = recordsRef.current.filter((item) => item.id !== id);
        setRecords(recordsRef.current.slice());
        setHistoryOpenId((cur) => (cur === id ? '' : cur));
        if (historyHostReady) persisterRef.current.push('删除记录');
      }

      /** 清空全部记录:确认后清(收藏数量明示);画布与工作区文件都不动。 */
      function clearRecords() {
        const total = recordsRef.current.length;
        if (!total) return;
        const favCount = recordsRef.current.filter((item) => item.fav).length;
        const ok = window.confirm(
          `清空全部生成记录?共 ${total} 条${favCount ? `(含收藏 ${favCount} 条)` : ''}。\n画布上的图片不受影响;已存进工作区的结果文件也不会被删除。`,
        );
        if (!ok) return;
        recordsRef.current = [];
        setRecords([]);
        setHistoryOpenId('');
        setHistoryLimit(20);
        if (historyHostReady) persisterRef.current.push('清空记录');
      }

      /**
       * 恢复参数:只回填输入区,**不自动生成**。
       * 默认回填「用户原始输入」并按记录里的 skillId 重新挂模板 —— 用户输入与最终提交
       * 提示词分开存就是为了这里不重复叠加模板/标注说明;`finalOnly` 是独立的
       * 「仅用最终提示词」模式:不挂模板,把当时的最终提交文本原样放回输入框。
       * @param {object} record - 记录。
       * @param {boolean} [finalOnly] - 用最终提示词模式。
       */
      function restoreRecordParams(record, finalOnly) {
        if (!record) return;
        if (finalOnly) {
          setActiveSkillId('');
          setPrompt(record.promptFinal || record.promptUser || '');
          setNotice('已回填最终提示词(模板已取消挂载)—— 提交前检查一遍');
          return;
        }
        const hints = [];
        if (record.model) setModel(record.model);
        if (record.ratio) setRatio(record.ratio);
        if (record.quality) setQuality(record.quality);
        if (record.background) setBackground(record.background);
        if (record.imageSize) setImageSize(record.imageSize);
        if (record.exactSize && parsePixelSize(record.exactSize)) setCustomSize(record.exactSize);
        if (record.skillId) {
          if (allSkills.some((item) => item.id === record.skillId)) setActiveSkillId(record.skillId);
          else hints.push(`当时的模板「${record.skillId}」已不在模板列表里,没有挂载`);
        }
        if (record.promptUser) setPrompt(record.promptUser);
        else if (record.promptFinal) { setPrompt(record.promptFinal); hints.push('这条记录只存了最终提示词,已原样回填'); }
        setNotice(`参数已回填(不会自动生成)${hints.length ? ` —— ${hints.join(';')}` : ''}`);
      }

      /** 从记录把结果放回画布:优先本地文件,缺资源再试来源链接。 */
      async function placeRecordImage(record) {
        if (!record) return;
        setError('');
        try {
          if (record.file) {
            const dataUrl = await fetchAsDataUrl(routeUrl(`/ws-file?path=${encodeURIComponent(record.file)}`, sessionRef.current));
            await addImageFromDataUrl(dataUrl, `记录-${stamp()}.png`, false);
            setNotice('已放入画布(本地文件)');
            return;
          }
          if (record.sourceUrl) {
            const dataUrl = await proxyImageDataUrl(record.sourceUrl, sessionRef.current);
            await addImageFromDataUrl(dataUrl, `记录-${stamp()}.png`, false);
            setNotice('已放入画布(本地文件缺失,经来源链接取回)');
            return;
          }
          setError('这条记录没有本地文件,也没有来源链接 —— 图片无法恢复');
        } catch (e) {
          setError(String((e && e.message) || e));
        }
      }

      /** 从记录下载结果图(同上,优先本地文件)。 */
      async function downloadRecordImage(record) {
        if (!record) return;
        setError('');
        try {
          let href = '';
          if (record.file) href = await fetchAsDataUrl(routeUrl(`/ws-file?path=${encodeURIComponent(record.file)}`, sessionRef.current));
          else if (record.sourceUrl) href = await proxyImageDataUrl(record.sourceUrl, sessionRef.current);
          else { setError('这条记录没有本地文件,也没有来源链接 —— 图片无法恢复'); return; }
          const a = document.createElement('a');
          a.href = href;
          a.download = `记录-${record.model || '结果'}-${stamp()}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } catch (e) {
          setError(String((e && e.message) || e));
        }
      }

      // ── 对比视图(第一期 B)────────────────────────────────────────
      // 纯查看覆盖层:不改画布、不写撤销、不提交生成;关闭即还原。
      const compareOpen = Boolean(compareA && compareB);

      /** 把两张画布图(multi==2,按图层顺序)开进对比视图。 */
      function compareSelectedTwo() {
        const pair = selectedIds.map((id) => images.find((im) => im.id === id)).filter(Boolean);
        if (pair.length !== 2) {
          setError('对比需要正好选中两张图');
          return;
        }
        setCompareA({ name: pair[0].name, dataUrl: pair[0].dataUrl, naturalW: pair[0].naturalW || pair[0].w, naturalH: pair[0].naturalH || pair[0].h });
        setCompareB({ name: pair[1].name, dataUrl: pair[1].dataUrl, naturalW: pair[1].naturalW || pair[1].w, naturalH: pair[1].naturalH || pair[1].h });
        setCompareMode('side');
        setCompareSwap(false);
        setCompareSlider(0.5);
        setComparePan({ x: 0, y: 0 });
      }

      /**
       * 从生成记录开对比:B = 记录的结果图(本地文件优先),A = 画布上它的来源图
       * (sourceId 匹配)。来源图不在画布上时明确报错并指路,不硬开半成品视图。
       */
      async function compareRecord(record) {
        if (!record) return;
        const source = record.sourceId ? images.find((im) => im.id === record.sourceId) : null;
        if (!source) {
          setError(
            `画布上没有这张记录的来源图${record.sourceName ? `(${record.sourceName})` : ''} —— 先把来源图放回画布(记录里点「放入画布」),或在画布上选中两张图用属性区的「对比这两张」`,
          );
          return;
        }
        try {
          let bUrl = '';
          if (record.file) bUrl = await fetchAsDataUrl(routeUrl(`/ws-file?path=${encodeURIComponent(record.file)}`, sessionRef.current));
          else if (record.sourceUrl) bUrl = await proxyImageDataUrl(record.sourceUrl, sessionRef.current);
          else {
            setError('这条记录没有本地文件,也没有来源链接 —— 结果图取不回来,没法对比');
            return;
          }
          setCompareA({ name: source.name, dataUrl: source.dataUrl, naturalW: source.naturalW || source.w, naturalH: source.naturalH || source.h });
          setCompareB({ name: record.model ? `结果(${record.model})` : '记录结果', dataUrl: bUrl, naturalW: Number(record.w) || 0, naturalH: Number(record.h) || 0 });
          setCompareMode('side');
          setCompareSwap(false);
          setCompareSlider(0.5);
          setComparePan({ x: 0, y: 0 });
        } catch (e) {
          setError(`取回记录结果图失败:${String((e && e.message) || e)}`);
        }
      }

      /** 关闭对比并释放解码缓存;监听器的清理在本文件对比视图的 effect 里。 */
      function closeCompare() {
        setCompareA(null);
        setCompareB(null);
        compareImgARef.current = null;
        compareImgBRef.current = null;
        compareDragRef.current = null;
      }

      /** 适应视口:并排半区里两图都完整可见(同一倍率,同步缩放)。 */
      function fitCompare() {
        const cv = compareCanvasRef.current;
        const a = compareImgARef.current;
        const b = compareImgBRef.current;
        if (!cv || !a || !b || !cv.clientWidth) return;
        const half = cv.clientWidth / 2;
        const fitA = Math.min(half / a.naturalWidth, cv.clientHeight / a.naturalHeight);
        const fitB = Math.min(half / b.naturalWidth, cv.clientHeight / b.naturalHeight);
        setCompareZoom(Math.max(0.005, Math.min(fitA, fitB)));
        setComparePan({ x: 0, y: 0 });
      }

      /** 滚轮缩放(以当前视图为中心的简单倍率缩放,clamp 到 100%/16 ~ 64 倍)。 */
      function compareWheel(e) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0012);
        const min = 1 / ((window.devicePixelRatio || 1) * 16);
        setCompareZoom((z) => Math.max(min, Math.min(64, z * factor)));
      }

      /** 拖拽平移:pointer capture 跟踪手势,松手即停。 */
      function comparePointerDown(e) {
        compareDragRef.current = { x: e.clientX, y: e.clientY, panX: comparePan.x, panY: comparePan.y };
        if (e.currentTarget.setPointerCapture) {
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 手势竞争时静默 */ }
        }
      }
      function comparePointerMove(e) {
        const d = compareDragRef.current;
        if (!d) return;
        setComparePan({ x: d.panX + (e.clientX - d.x), y: d.panY + (e.clientY - d.y) });
      }
      function comparePointerUp(e) {
        compareDragRef.current = null;
        if (e && e.currentTarget && e.currentTarget.releasePointerCapture) {
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
        }
      }

      /** 100%:1 图像像素 = 1 物理像素 —— 倍率按 DPR 折算,Retina 屏不虚标。 */
      function zoom100Compare() {
        setCompareZoom(1 / (window.devicePixelRatio || 1));
        setComparePan({ x: 0, y: 0 });
      }

      /** 导出当前的结果图(B 角色)原图 —— 对比不改图,导出就是结果本身。 */
      function exportCompareResult() {
        if (!compareB || !compareB.dataUrl) return;
        const a = document.createElement('a');
        a.href = compareB.dataUrl;
        a.download = `对比-结果-${compareB.name || stamp()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }

      // 对比视图:加载两张快照 → 重绘;Esc 优先关顶层(capture 阶段截获,不落到画布快捷键)。
      useEffect(() => {
        if (!compareA || !compareB) {
          compareImgARef.current = null;
          compareImgBRef.current = null;
          return undefined;
        }
        let alive = true;
        const load = (snap) => new Promise((resolve) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => resolve(null);
          im.src = snap.dataUrl;
        });
        Promise.all([load(compareA), load(compareB)]).then(([a, b]) => {
          if (!alive) return;
          compareImgARef.current = a;
          compareImgBRef.current = b;
          setCompareTick((t) => t + 1);
          if (a && b) fitCompare(); // 打开即适应视口
        });
        return () => { alive = false; };
      }, [compareA, compareB]);

      useEffect(() => {
        if (!compareOpen) return undefined;
        const cv = compareCanvasRef.current;
        if (!cv) return undefined;
        rt['compare-view'].drawCompareCanvas(cv, {
          imgA: compareImgARef.current,
          imgB: compareImgBRef.current,
          mode: compareMode,
          swap: compareSwap,
          slider: compareSlider,
          zoom: compareZoom,
          panX: comparePan.x,
          panY: comparePan.y,
          dpr: window.devicePixelRatio || 1,
        });
        return undefined;
      }, [compareOpen, compareTick, compareMode, compareSwap, compareSlider, compareZoom, comparePan]);

      useEffect(() => {
        if (!compareOpen) return undefined;
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.stopImmediatePropagation();
            e.preventDefault();
            closeCompare();
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [compareOpen]);

      // ── 提交与生成 ──────────────────────────────────────────────────
      const { buildSubmission, referenceDataUrl, pollTask, placeResultImage, withPlaceLock, addPendingTask, removePendingTask, previewPlaceholderRect, run, cancelGenerate } = rt['generate'].createGenerate(
        deps('generate', {
          activeSkill,
          aliveRef,
          apikey,
          apiBase,
          appendHint,
          background,
          batchSizes,
          busy,
          camRef,
          cancelRef,
          cropToMark,
          customSize,
          docRef,
          expandFrameRef,
          finishChange,
          imageSize,
          imgCacheRef,
          jobsRef,
          model,
          onRecord,
          pendingRef,
          placeLockRef,
          prompt,
          quality,
          ratio,
          selected,
          selectedFrameId,
          scheduleDraw,
          sessionRef,
          setBusy,
          setError,
          setLastUpstream,
          setNotice,
          setPhase,
          setProgress,
          setRatio,
          setResults,
          setSelectedId,
          setSelectedIds,
          setShowSettings,
          sizeRef,
          submitTexts,
        }),
      );

      // ── 相机操作 ────────────────────────────────────────────────────
      const zoomAtPoint = useCallback(
        (sx, sy, factor) => {
          const cam = camRef.current;
          const zoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
          if (zoom === cam.zoom) return;
          const [wx, wy] = screenToWorld(cam, sx, sy);
          camRef.current = { x: wx - sx / zoom, y: wy - sy / zoom, zoom };
          setZoomLabel(zoom);
          scheduleSave();
          scheduleDraw();
        },
        [scheduleDraw, scheduleSave],
      );

      const fitAll = useCallback(() => {
        // 适应视口只算可见的图:全隐藏时 fitCamera 拿到空列表,安全回退到原点 100%
        camRef.current = fitCamera(docRef.current.images.filter((im) => !im.hidden), sizeRef.current);
        setZoomLabel(camRef.current.zoom);
        scheduleSave();
        scheduleDraw();
      }, [scheduleDraw, scheduleSave]);

      /** 图层面板点行:与画布点选同一套选择逻辑(Ctrl/Shift = 加选/减选),不产生撤销步骤。 */
      const selectImageFromPanel = useCallback(
        (id, event) => {
          const multi = Boolean(event && (event.ctrlKey || event.metaKey || event.shiftKey));
          if (multi) {
            const next = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
            setSelectedIds(next);
            setSelectedId(next.length ? next[0] : null);
          } else {
            setSelectedIds([id]);
            setSelectedId(id);
          }
          setSelectedTextId('');
          setSelectedFrameId(null);
          scheduleDraw();
        },
        [selectedIds, setSelectedFrameId, setSelectedId, setSelectedIds, setSelectedTextId, scheduleDraw],
      );

      const zoomTo = useCallback(
        (zoom) => {          const cam = camRef.current;
          const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
          const cx = sizeRef.current.w / 2;
          const cy = sizeRef.current.h / 2;
          const [wx, wy] = screenToWorld(cam, cx, cy);
          camRef.current = { x: wx - cx / next, y: wy - cy / next, zoom: next };
          setZoomLabel(next);
          scheduleSave();
          scheduleDraw();
        },
        [scheduleDraw, scheduleSave],
      );

      // ── 命中测试 ────────────────────────────────────────────────────
      function hitImage(wx, wy) {
        const list = docRef.current.images;
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const im = list[i];
          if (im.hidden) continue; // 隐藏图:不参与命中(点不到)
          if (wx >= im.x && wx <= im.x + im.w && wy >= im.y && wy <= im.y + im.h) return im;
        }
        return null;
      }
      function hitFrame(wx, wy) {
        const list = docRef.current.frames || [];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const f = list[i];
          if (wx >= f.x && wx <= f.x + f.w && wy >= f.y && wy <= f.y + f.h) return f;
        }
        return null;
      }
      function hitHandle(wx, wy) {
        const cam = camRef.current;
        const image = docRef.current.images.find((im) => im.id === liveRef.current.selectedId);
        if (!image) return null;
        // 隐藏图不显示手柄;锁定图防误改,缩放柄整个不响应(解锁用图层面板)
        if (image.hidden || image.locked) return null;
        const r = 7 / cam.zoom;
        const points = [
          ['nw', image.x, image.y],
          ['ne', image.x + image.w, image.y],
          ['sw', image.x, image.y + image.h],
          ['se', image.x + image.w, image.y + image.h],
        ];
        for (const [name, px, py] of points) {
          if (Math.abs(wx - px) <= r && Math.abs(wy - py) <= r) return name;
        }
        return null;
      }
      function normalized(image, wx, wy) {
        return [(wx - image.x) / image.w, (wy - image.y) / image.h];
      }

      // ── 加图 ────────────────────────────────────────────────────────
      const addImageFromDataUrl = useCallback(
        async (dataUrl, name, asRef, at) => {
          let el;
          try {
            el = await decodeImage(dataUrl);
          } catch (e) {
            setError(`图片打不开:${(e && e.message) || e}`);
            return null;
          }
          const naturalW = el.naturalWidth || 512;
          const naturalH = el.naturalHeight || 512;
          const scale = Math.min(1, MAX_PLACE_SIZE / Math.max(naturalW, naturalH));
          const w = Math.max(24, Math.round(naturalW * scale));
          const hh = Math.max(24, Math.round(naturalH * scale));
          const doc = docRef.current;
          const box = imageBounds(doc.images);
          const cam = camRef.current;
          const view = sizeRef.current;
          let x;
          let y;
          if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
            // 指哪放哪(拖进来的网图以落点为中心)
            x = at.x - w / 2;
            y = at.y - hh / 2;
          } else if (!box) {
            const [cx, cy] = screenToWorld(cam, view.w / 2, view.h / 2);
            x = cx - w / 2;
            y = cy - hh / 2;
          } else {
            x = box.x1 + GAP;
            y = box.y0;
          }
          const image = {
            id: uid('img'),
            name: name || `图片-${stamp()}.png`,
            dataUrl,
            x,
            y,
            w,
            h: hh,
            naturalW,
            naturalH,
            isRef: Boolean(asRef),
            hidden: false,
            locked: false,
          };
          docRef.current = { images: [...doc.images, image], marks: doc.marks, frames: doc.frames || [] };
          ensureImage(image.id, dataUrl);
          imgCacheRef.current.set(image.id, el);
          setSelectedId(image.id);
          setSelectedIds([image.id]);
          if (!rectVisible(cam, view, image.x, image.y, image.w, image.h)) {
            camRef.current = fitCamera(docRef.current.images, view);
          }
          setNotice(`已加入:${image.name}`);
          finishChange(true);
          return image;
        },
        [ensureImage, finishChange],
      );

      /** 从网址里挑一个像文件名的部分当图名。 */
      function urlFileName(url) {
        try {
          const base = decodeURIComponent((new URL(url)).pathname.split('/').filter(Boolean).pop() || '');
          return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(base) ? base : `网图-${stamp()}.png`;
        } catch {
          return `网图-${stamp()}.png`;
        }
      }

      /** 认不认这段文本是网址:只收 http/https 的裸链接,带别的字或超长的一律当普通文本。 */
      function asImageUrl(text) {
        const s = String(text || '').trim();
        return /^https?:\/\/\S+$/i.test(s) && s.length <= 2048 ? s : '';
      }

      /**
       * 把网图拉进画布:走宿主代理(浏览器直连会被 CORS 挡),再按普通加图落位。
       * @param {string} url - 图片直链(http/https)。
       * @param {{x: number, y: number}} [at] - 落点(世界坐标);给了就以它为中心放。
       * @returns {Promise<object|null>} 落好的图片对象;失败返回 null。
       */
      const addImageFromUrl = useCallback(
        async (url, at) => {
          const clean = String(url || '').trim();
          if (!/^https?:\/\/\S+$/i.test(clean) || clean.length > 2048) {
            setError('只认 http/https 开头的图片直链');
            return null;
          }
          setError('');
          setNotice('正在取这张网图…');
          try {
            const dataUrl = await proxyImageDataUrl(clean, sessionRef.current);
            const made = await addImageFromDataUrl(dataUrl, urlFileName(clean), false, at);
            if (!made) setError('这个网址给回来的好像不是图片(可能是网页或要登录),换图片直链再试');
            return made;
          } catch (e) {
            setError(`取网图失败:${String((e && e.message) || e)}`);
            return null;
          }
        },
        [addImageFromDataUrl],
      );

      const addFiles = useCallback(
        async (fileList, asRef) => {
          const files = Array.from(fileList || []);
          let added = 0;
          for (const file of files) {
            const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name || '');
            if (!isImage) continue;
            try {
              const dataUrl = await blobToDataUrl(file);
              const made = await addImageFromDataUrl(dataUrl, file.name, asRef);
              if (made) added += 1;
            } catch {
              /* 单张失败跳过 */
            }
          }
          if (!added) setError('没有读到可用的图片文件');
          return added;
        },
        [addImageFromDataUrl],
      );

      const addFilesRef = useRef(addFiles);
      addFilesRef.current = addFiles;
      const addImageFromUrlRef = useRef(addImageFromUrl);
      addImageFromUrlRef.current = addImageFromUrl;
      const addImageFromDataUrlRef = useRef(addImageFromDataUrl);
      addImageFromDataUrlRef.current = addImageFromDataUrl;

      // 粘贴加图
      useEffect(() => {
        const onPaste = (event) => {
          // 只有"人正在画布上操作"时才接管粘贴。挂在 document 上且无条件 preventDefault
          // 会把 DSH 对话输入框的图片粘贴一起抢走 —— 用户往对话框粘截图,图却跑到画布上。
          const host = wrapRef.current;
          const inside = (node) => Boolean(node && node !== document.body && host && host.contains(node));
          // 焦点在输入框 / 文本域 / 可编辑区里:**一律不抢**,交给浏览器正常粘贴。
          // 否则往提示词框(或就地改字框)里粘一条图片直链,会被当成"拉网图"并 preventDefault,
          // 文字根本粘不进去 —— 用户要的是把链接写进提示词,不是把图拽上画布。
          const node = event.target && event.target.nodeType === 1 ? event.target : document.activeElement;
          const tag = node && node.tagName ? String(node.tagName).toUpperCase() : '';
          if (node && (node.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return;
          if (!hoverRef.current && !inside(event.target) && !inside(document.activeElement)) return;
          const items = event.clipboardData && event.clipboardData.items;
          if (!items) return;
          const files = [];
          for (const item of items) {
            if (item.kind === 'file' && /^image\//.test(item.type)) {
              const file = item.getAsFile();
              if (file) files.push(file);
            }
          }
          if (files.length) {
            event.preventDefault();
            addFilesRef.current(files, false);
            return;
          }
          // 剪贴板里是图片网址(浏览器里「复制图片地址」)也认,顺手把这张网图拉进画布
          const cb = event.clipboardData;
          const text = cb && typeof cb.getData === 'function' ? cb.getData('text/plain') : '';
          const url = asImageUrl(text);
          if (url) {
            event.preventDefault();
            addImageFromUrlRef.current(url);
          }
        };
        document.addEventListener('paste', onPaste);
        return () => document.removeEventListener('paste', onPaste);
      }, []);

      /**
       * 右键菜单里的「粘贴」。paste 事件必须由用户按 Ctrl+V 才会来,菜单点击拿不到
       * `event.clipboardData`,所以这里走异步剪贴板 API 自己读。浏览器不给权限时明说,
       * 让用户按 Ctrl+V —— 不静默失败(不然用户会以为图丢了)。
       */
      const pasteFromClipboard = useCallback(async () => {
        const clip = typeof navigator === 'undefined' ? null : navigator.clipboard;
        if (!clip || typeof clip.read !== 'function') {
          setError('这个浏览器读不了剪贴板,按 Ctrl+V 粘贴吧');
          return;
        }
        try {
          const items = await clip.read();
          for (const item of items || []) {
            const type = (item.types || []).find((t) => /^image\//.test(t));
            if (!type) continue;
            const blob = await item.getType(type);
            const dataUrl = await blobToDataUrl(blob);
            await addImageFromDataUrlRef.current(dataUrl, `剪贴板-${stamp()}.png`, false);
            setNotice('已从剪贴板粘进画布');
            return;
          }
          const text = typeof clip.readText === 'function' ? await clip.readText() : '';
          const url = asImageUrl(text);
          if (url) {
            addImageFromUrlRef.current(url);
            setNotice('已从剪贴板粘进图片网址');
            return;
          }
          setNotice('剪贴板里没有图片');
        } catch {
          setError('读不到剪贴板(浏览器可能没给权限),按 Ctrl+V 试试');
        }
      }, [setError, setNotice]);

      // 右键菜单:Esc 关掉(点画布别处也会关,见 onPointerDown)
      useEffect(() => {
        if (!menuAt) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setMenuAt(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [menuAt]);

      // 第一次用(还没填 KEY)就把设置面板打开,免得找不到填 key 的地方
      useEffect(() => {
        if (!apikey) setShowSettings(true);
      }, []);

      /**
       * 换模型时把尺寸掰成新模型认识的值。
       * 例:证件照模板给的是 3:4,换成 gpt-image-2-vip 时自动变 864x1152 —— 
       * 否则上游会回 "does not support 3:4 parameter"。
       */
      useEffect(() => {
        setRatio((cur) => {
          const fixed = normalizeSize(model, cur);
          return fixed === cur ? cur : fixed;
        });
      }, [model]);

      // 容器尺寸
      useEffect(() => {
        const node = wrapRef.current;
        if (!node) return undefined;
        const measure = () => {
          const r = node.getBoundingClientRect();
          const next = { w: Math.max(80, Math.round(r.width)), h: Math.max(80, Math.round(r.height)) };
          setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
      }, []);

      useEffect(() => {
        scheduleDraw();
      }, [size, docVersion, tool, selectedId, selectedTextId, spaceDown, progress, markWidth, scheduleDraw]);

      // 生成期间占位框要「活着」:每秒重绘一次,让已耗时和没进度时的流动色块动起来。
      // 平时画布依旧按需重绘 —— 只有 busy(生成/续查)时才多这一个 1Hz 的 timer。
      useEffect(() => {
        if (!busy) return undefined;
        const timer = setInterval(() => scheduleDraw(), 1000);
        return () => {
          clearInterval(timer);
          scheduleDraw();
        };
      }, [busy, scheduleDraw]);

      // 进入"就地改字"后把光标送进编辑框。用 id 找元素最省事(自定义 h 的 ref 只认对象 ref,
      // 属性卡里的输入框也是这么拿的),顺便全选,双击后直接打字就能覆盖旧文字。
      useEffect(() => {
        if (!textEditId) return;
        const el = document.getElementById('grsai-text-edit');
        if (el && typeof el.focus === 'function') {
          el.focus();
          if (typeof el.select === 'function') el.select();
        }
      }, [textEditId]);

      // 滚轮缩放(需要 preventDefault,只能挂原生监听)
      useEffect(() => {
        const el = canvasRef.current;
        if (!el) return undefined;
        const onWheel = (event) => {
          event.preventDefault();
          const box = el.getBoundingClientRect();
          actionsRef.current.zoomAtPoint &&
            actionsRef.current.zoomAtPoint(event.clientX - box.left, event.clientY - box.top, event.deltaY < 0 ? 1.12 : 1 / 1.12);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
      }, []);

      // 加载存档(先探宿主版本:客户端被 HMR 更新、宿主没重启时没有 /state)
      useEffect(() => {
        let alive = true;
        (async () => {
          let stale = false;
          let features = [];
          try {
            const ping = await api('/ping', undefined, sessionRef.current);
            const version = ping && ping.version;
            stale = !version || compareVersion(version, MIN_HOST_VERSION) < 0;
            if (Array.isArray(ping && ping.features)) features = ping.features;
          } catch {
            /* 探测失败就当宿主是好的,后面读存档失败也会被吞掉 */
          }
          if (!alive) return;
          setHostFeatures(features);
          if (stale) {
            hostStaleRef.current = true;
            setHostStale(true);
            setSaved('宿主旧版:没存');
            setLoaded(true);
            resetHistory();
            bumpDoc();
            scheduleDraw();
            return;
          }
          try {
            const data = await api('/state', undefined, sessionRef.current);
            const st = data && data.state;
            if (!alive) return;
            if (st && Array.isArray(st.images) && st.images.length) {
              docRef.current = {
                // hidden/locked 是可选字段:旧存档没有就按 false 归一化,新字段不丢。
                // name 与尺寸也要兜底:外部写入/旧版本的存档可能缺 name 或 w/h 是 null,
                // 生成卡直接取 `.length`、worldToScreen 直接算 NaN,一处抛错就是整块白屏。
                images: st.images
                  .filter((im) => im && typeof im === 'object' && im.dataUrl)
                  .map((im) => {
                    const w = Number(im.w) > 0 ? Number(im.w) : 512;
                    const h = Number(im.h) > 0 ? Number(im.h) : 512;
                    const naturalW = Number(im.naturalW) > 0 ? Number(im.naturalW) : w;
                    const naturalH = Number(im.naturalH) > 0 ? Number(im.naturalH) : h;
                    const x = Number.isFinite(Number(im.x)) ? Number(im.x) : 0;
                    const y = Number.isFinite(Number(im.y)) ? Number(im.y) : 0;
                    return Object.assign(
                      { name: '', naturalW, naturalH, isRef: false, hidden: false, locked: false },
                      im,
                      { name: String(im.name || '图片'), x, y, w, h, naturalW, naturalH },
                    );
                  }),
                marks: Array.isArray(st.marks) ? st.marks : [],
                frames: Array.isArray(st.frames) ? st.frames : [],
              };
              for (const image of docRef.current.images) ensureImage(image.id, image.dataUrl);
              camRef.current = st.cam && st.cam.zoom ? st.cam : fitCamera(docRef.current.images.filter((im) => !im.hidden), sizeRef.current);
              setSelectedId(docRef.current.images[docRef.current.images.length - 1].id);
              setSelectedIds([docRef.current.images[docRef.current.images.length - 1].id]);
              setNotice(`已恢复上次的画布(${docRef.current.images.length} 张图)`);
            }
          } catch {
            /* 第一次用没有存档,正常 */
          } finally {
            if (alive) {
              setLoaded(true);
              // 以"刚载入/刚恢复"的状态作为撤销历史的起点
              resetHistory();
              bumpDoc();
              scheduleDraw();
            }
          }
        })();
        return () => {
          alive = false;
        };
      }, [bumpDoc, ensureImage, resetHistory, scheduleDraw]);

      useEffect(
        () => () => {
          aliveRef.current = false;
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        },
        [],
      );

      // 偏好落盘
      useEffect(() => {
        writePrefs({ model, ratio, quality, background, imageSize, color, markWidth, apiBase, updateUrl, customSize, dpi });
      }, [model, ratio, quality, background, imageSize, color, markWidth, apiBase, updateUrl, customSize, dpi]);

      // 「图片分层(Agent)」的接口配置:宿主支持就读一次(密钥只以掩码形式回来)
      useEffect(() => {
        if (!Array.isArray(hostFeatures) || !hostFeatures.includes('layering-config')) return undefined;
        let alive = true;
        (async () => {
          try {
            const data = await api('/layering-config', undefined, sessionRef.current);
            if (!alive) return;
            setLayerCfg((prev) =>
              Object.assign({}, prev, {
                base: String(data.base_url || LAYER_DEFAULT_BASE),
                // 端点:配置里存着的真实值(宿主兜底后回传),「高级」两格据此预填
                submitEndpoint: String(data.submit_endpoint || ''),
                statusEndpoint: String(data.task_status_endpoint || ''),
                defaultSubmitEndpoint: String(data.default_submit_endpoint || prev.defaultSubmitEndpoint || ''),
                defaultStatusEndpoint: String(data.default_task_status_endpoint || prev.defaultStatusEndpoint || ''),
                modelsUrl: String(data.models_url || ''),
                createUrl: String(data.create_url || ''),
                statusUrl: String(data.status_url || ''),
                model: String(data.model || ''),
                // 手上没草稿时才回填:正在手写的时候重读配置不该把输入框冲掉
                modelDraft: String(prev.modelDraft || data.model || ''),
                defaultModel: String(data.default_model || prev.defaultModel || ''),
                hasKey: Boolean(data.configured),
                masked: String(data.keyMasked || ''),
                dir: String(data.dir || ''),
              }),
            );
          } catch {
            /* 读不到就先留空;真要用时保存/运行会给明确错误 */
          }
        })();
        return () => {
          alive = false;
        };
      }, [hostFeatures]);

      // 第一次打开停靠区的 Skills 标签时,把自定义模板从工作区读进来
      useEffect(() => {
        if (dockOpen !== 'skills' || skillsLoadedRef.current) return undefined;
        // 宿主没这个能力(客户端被 HMR 更新、宿主还没重启)就别去撞墙,面板里会说明原因
        if (!featuresRef.current.includes('skills')) return undefined;
        skillsLoadedRef.current = true;
        let alive = true;
        (async () => {
          try {
            const data = await api('/skills', undefined, sessionRef.current);
            if (alive) setSkills(Array.isArray(data && data.presets) ? data.presets : []);
          } catch (e) {
            const message = String((e && e.message) || e);
            if (!alive) return;
            if (/未知路由/.test(message)) {
              skillsLoadedRef.current = false;
              setNotice('宿主是旧版:自定义 Skills 模板要重启一次 DSH 才能用(内置模板现在就能用)');
              return;
            }
            setError(`读取 Skills 模板失败:${message}`);
          }
        })();
        return () => {
          alive = false;
        };
      }, [dockOpen]);

      /** 打开「AI 高清放大」面板时问一次宿主:哪个档位已经装好了。 */
      useEffect(() => {
        if (!showUpscale) return undefined;
        let alive = true;
        (async () => {
          try {
            const data = await api('/upscale-status', undefined, sessionRef.current);
            if (!alive) return;
            setUpscaleTiers(Array.isArray(data.tiers) ? data.tiers : []);
            setUpscaleNote('');
          } catch (e) {
            if (!alive) return;
            const message = String((e && e.message) || e);
            setUpscaleNote(/未知路由/.test(message) ? '宿主是旧版:重启一次 DSH 后这颗按钮才可用' : `读取放大引擎状态失败:${message}`);
          }
        })();
        return () => {
          alive = false;
        };
      }, [showUpscale]);

      /**
       * 打开某一块(**不做**「已开就收起」的切换):鼠标悬停联动用。
       * 工作区走 openWorkspace —— 它顺带把目录列出来(已经列过就直接开,不会重复读盘)。
       * @param name - 与 togglePanel 同一套名字。
       * @returns {void}
       */
      function openPanel(name) {
        if (name === 'workspace') {
          setShowSettings(false);
          setShowLayerKey(false);
          setShowUpscale(false);
          openWorkspace();
          return;
        }
        const dockTabs = ['history', 'layers', 'workspace', 'skills'];
        if (dockTabs.includes(name)) {
          setShowSettings(false);
          setShowLayerKey(false);
          setShowUpscale(false);
          setDockOpen(name);
          return;
        }
        if (name === 'settings' || name === 'layerkey' || name === 'upscale') {
          setDockOpen('');
          setShowSettings(name === 'settings');
          setShowLayerKey(name === 'layerkey');
          setShowUpscale(name === 'upscale');
        }
      }

      /**
       * 收起指定的那一块(鼠标移开时用,不误伤别的)。
       * @param name - 与 togglePanel 同一套名字。
       * @returns {void}
       */
      function closePanel(name) {
        const dockTabs = ['history', 'layers', 'workspace', 'skills'];
        if (dockTabs.includes(name)) {
          setDockOpen((prev) => (prev === name ? '' : prev));
          return;
        }
        if (name === 'settings') setShowSettings(false);
        if (name === 'layerkey') setShowLayerKey(false);
        if (name === 'upscale') setShowUpscale(false);
      }

      /**
       * 鼠标落到某个入口按钮上:把它对应的面板开起来(不用点)。
       * 已经在同一块上就只清倒计时 —— 鼠标在面板里移来移去不该反复 setState。
       * @param name - 入口名(按钮上的 data-nav-panel)。
       * @returns {void}
       */
      function hoverPanelEnter(name) {
        const box = hoverPanelRef.current;
        if (!name) return;
        if (box.timer) {
          clearTimeout(box.timer);
          box.timer = null;
        }
        if (box.name === name) return;
        box.name = name;
        openPanel(name);
      }

      /**
       * 鼠标落进「悬停开出来的那块面板」里:只清收起倒计时,不动记账 ——
       * 否则会把「点一下钉住」的状态又抹回可收起。
       * @returns {void}
       */
      function hoverPanelKeep() {
        const box = hoverPanelRef.current;
        if (box.timer) {
          clearTimeout(box.timer);
          box.timer = null;
        }
      }

      /**
       * 鼠标从入口/面板上移开:160ms 后收起「悬停开的这一块」。
       * 这 160ms 是留给「按钮 → 面板」中间那段画布的过路时间。
       * @returns {void}
       */
      function hoverPanelLeave() {
        const box = hoverPanelRef.current;
        if (!box.name || box.timer) return;
        box.timer = setTimeout(() => {
          box.timer = null;
          // 焦点还留在面板里(正在输入 key / 提示词 / 改名)就先别收,免得打字打到一半被抽走
          const active = document.activeElement;
          if (active && active.closest && active.closest('[data-nav-keep]')) return;
          const name = box.name;
          box.name = '';
          if (name) closePanel(name);
        }, 160);
      }

      useEffect(
        () => () => {
          const box = hoverPanelRef.current;
          if (box.timer) clearTimeout(box.timer);
        },
        [],
      );

      /**
       * 量一下按钮在画布区里的位置,给面板当锚点(贴在按钮正下方弹)。
       * 只给左边缘 + 上边缘 + 右边界,真正的宽度 clamp 交给每块面板按自己的宽度做。
       * @param btn - 触发开面板的那个导航按钮。
       * @returns {{left: number, top: number, maxRight: number}|null} 读不到布局时给 null(退回靠右的默认位置)。
       */
      function measureAnchor(btn) {
        const root = wrapRef.current;
        if (!btn || !root || !btn.getBoundingClientRect) return null;
        const box = btn.getBoundingClientRect();
        const frame = root.getBoundingClientRect();
        if (!box.width || !frame.width) return null;
        return {
          left: Math.round(box.left - frame.left),
          top: Math.round(box.bottom - frame.top + 6),
          maxRight: Math.round(frame.width - 6),
        };
      }

      /**
       * 鼠标在画布区里滑过时调一次(冒泡上来的 pointerover):落在导航按钮上就开那块,
       * 落在那块面板上就续命,其余位置(画布、工具条、别的浮层)都算「移开」。
       * @param event - React 的 pointerover 事件。
       * @returns {void}
       */
      function onNavPointerOver(event) {
        const target = event && event.target;
        const closest = (attr) => (target && target.closest ? target.closest(`[${attr}]`) : null);
        const btn = closest('data-nav-panel');
        if (btn) {
          const name = btn.getAttribute('data-nav-panel');
          // 换到另一个入口才重新量 —— 同一块按钮里鼠标乱动不用重算
          if (hoverPanelRef.current.name !== name) panelAnchorRef.current = measureAnchor(btn);
          hoverPanelEnter(name);
          return;
        }
        if (closest('data-nav-keep')) {
          hoverPanelKeep();
          return;
        }
        hoverPanelLeave();
      }

      /**
       * 面板开合(按簇分发):
       * - 停靠区标签(history/layers/workspace/skills)互斥,再点同一个标签收起;
       * - 设置簇弹层(settings/layerkey/upscale)互斥,打开时顺带收起停靠区,免得叠住;
       * - models/sizes 是生成卡里的弹出菜单,只和彼此互斥。
       */
      function togglePanel(name) {
        const hovered = hoverPanelRef.current;
        // 悬停已经把这块开着了:这一下点就是「钉住」—— 不关,鼠标移开也不再收
        if (hovered.name === name) {
          hovered.name = '';
          return;
        }
        const dockTabs = ['history', 'layers', 'workspace', 'skills'];
        if (dockTabs.includes(name)) {
          setShowSettings(false);
          setShowLayerKey(false);
          setShowUpscale(false);
          setDockOpen(dockOpen === name ? '' : name);
          return;
        }
        if (name === 'settings' || name === 'layerkey' || name === 'upscale') {
          setDockOpen('');
          setShowSettings(name === 'settings' ? !showSettings : false);
          setShowLayerKey(name === 'layerkey' ? !showLayerKey : false);
          setShowUpscale(name === 'upscale' ? !showUpscale : false);
          return;
        }
        setShowModels(name === 'models' ? !showModels : false);
        setShowSizes(name === 'sizes' ? !showSizes : false);
      }

      /**
       * 套用一个 Skills 模板(再点一次取消)。模板文字会在提交时排在你写的要求前面。
       * @param id - 模板 id。
       * @param forceOn - true 时只套用不切换:模板已激活也重新置值,不做「取消模板」(自检建议用)。
       * @returns {void}
       */
      function applySkill(id, forceOn) {
        const next = forceOn ? id : id === activeSkillId ? '' : id;
        setActiveSkillId(next);
        const preset = allSkills.find((item) => item.id === next);
        if (!preset) return;
        // 模板自带的参数一并套上;没写的保持你当前的选择
        const nextModel = preset.model || model;
        if (preset.model) setModel(preset.model);
        // 模板写的是比例(如证件照 3:4);遇到只认像素的模型就地换算成 864x1152 之类
        if (preset.ratio) setRatio(nearestSize(nextModel, preset.ratio));
        if (preset.quality) setQuality(preset.quality);
        if (preset.background) setBackground(preset.background);
        if (preset.imageSize) setImageSize(preset.imageSize);
        // 把模板改了什么参数说清楚,别让用户以为「取消模板」就等于恢复原样
        const changed = [];
        if (preset.model) changed.push(`模型 ${preset.model}`);
        if (preset.ratio) changed.push(`比例 ${preset.ratio}${sizeFormatOf(nextModel) === 'pixel' ? ` → ${nearestSize(nextModel, preset.ratio)}` : ''}`);
        if (preset.quality) changed.push(`质量 ${preset.quality}`);
        if (preset.background) changed.push(`背景 ${preset.background}`);
        if (preset.imageSize) changed.push(`分辨率 ${preset.imageSize}`);
        setNotice(
          changed.length
            ? `已套用模板「${preset.name}」:${changed.join('、')} —— 下面还能再补一句具体要求`
            : `已套用模板「${preset.name}」—— 下面还能再补一句具体要求`,
        );
      }

      /**
       * 快捷工具条的「点一下就执行」:按钮先把模板套上(改的是 state,下一次渲染才生效),
       * 这个 effect 等到 activeSkillId 真追上那个模板后,自动替你按一次「生成」。
       * 刻意不写依赖数组 —— `run` 每次渲染都是新闭包,只有最新那次才带着新模板。
       */
      useEffect(() => {
        const want = autoRunSkillRef.current;
        if (!want) return;
        if (activeSkillId !== want) {
          // 还没落地:再套一次(setState 同值不触发渲染,所以下一轮必然走下面的分支)
          applySkill(want, true);
          return;
        }
        const skillName = (allSkills.find((item) => item.id === want) || {}).name || '';
        autoRunSkillRef.current = '';
        run();
        // 模板是"点一次用一次"的:请求上面已经带着模板发出去了,这里立刻把模板摘掉 ——
        // 否则下一次随手点「生成」还默认带着上一次的 skill(主人报过这个问题)。
        applySkill('', false);
        if (skillName) setNotice(`已按「${skillName}」提交 —— 模板用完自动取消,想再来一次就再点那个按钮`);
      });

      /**
       * 保存自定义模板(整份写回工作区)。
       * @param next - 新的自定义模板数组。
       * @returns {Promise<boolean|undefined>} 写盘成功才返回 true。
       */
      async function saveSkills(next) {
        if (!featuresRef.current.includes('skills')) {
          setNotice('宿主是旧版:自定义模板要重启一次 DSH 才能保存(内置模板现在就能用)');
          return false;
        }
        try {
          const data = await api(
            '/skills',
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ presets: next }) },
            sessionRef.current,
          );
          // 磁盘确认成功后才更新列表,失败时保留原列表与用户输入。
          setSkills(next);
          setError('');
          setNotice(`模板已保存:${data.count} 个自定义模板 → ${data.path}`);
          return true;
        } catch (e) {
          const message = String((e && e.message) || e);
          if (/未知路由/.test(message)) {
            setNotice('宿主是旧版:自定义模板要重启一次 DSH 才能保存(内置模板现在就能用)');
            return;
          }
          setError(`模板保存失败:${message}`);
        }
        return false;
      }

      /**
       * 读工作区里的模型清单并合并进面板(打开画布时自动走一次,「⟳ 获取新模型」也走它)。
       *
       * 上游没有任何模型列表接口(9 条候选路径实测全 404),所以"模型清单"是
       * **内置表 + 工作区 `画布/models.json`** 叠出来的:这里只负责读,合并规则在
       * `02-model-sizes.js` 的 `mergeModelCatalog` 里(同名覆盖、新的追加、内置永不丢)。
       *
       * @param {object} [options] - `{ quiet: true }` 时读不到也不刷提示语(自动载入用)。
       * @returns {Promise<object|null>} 宿主返回的清单数据(宿主没这能力就是 null)。
       */
      async function loadModelCatalog(options) {
        const quiet = Boolean(options && options.quiet);
        if (!featuresRef.current.includes('models')) {
          if (!quiet) setModelsNote('宿主是旧版:「获取新模型」要重启一次 DSH 才能用');
          return null;
        }
        const data = await api('/models', undefined, sessionRef.current);
        const stats = mergeModelCatalog(data);
        if (data && data.exists) {
          setModelsNote(
            `已载入模型清单:${stats.total} 条${data.updated ? `(更新于 ${data.updated})` : ''} —— 新增 ${stats.added}、覆盖 ${stats.updated}`,
          );
        } else if (!quiet) {
          setModelsNote('工作区还没有模型清单 —— 点「⟳ 获取新模型」让 Agent 去查一份');
        }
        return data;
      }

      /**
       * 交给 Agent 去查/更新模型清单时说的话 —— 它是唯一知道"写哪个文件、写成什么样"的地方。
       * @param {string} absolute - 清单文件的绝对路径(宿主给的)。
       * @returns {string} 发进对话的那段文本。
       */
      function modelCatalogBrief(absolute) {
        const known = MODEL_CHOICES_BUILTIN.map((item) => item.id).join(', ');
        return [
          '帮我更新画布插件的「生成模型清单」(GrsAI 的可用模型)。',
          '',
          `把这个文件整份覆盖写出来(UTF-8):${absolute}`,
          '',
          'JSON 结构:',
          '{',
          '  "version": 1,',
          '  "updated": "YYYY-MM-DD",',
          '  "models": [',
          '    { "id": "模型ID", "label": "面板上显示的名字",',
          '      "format": "pixel | ratio | enum",',
          '      "sizes": ["auto", "1024x1024", "3:4"],',
          '      "labels": { "1024x1024": "1024x1024 (1:1)" } }',
          '  ],',
          '  "aliases": { "别名": "主模型ID" }',
          '}',
          '',
          '要求:',
          '- format 指这个模型的 aspectRatio 字段吃什么:pixel=像素值(如 1024x1024)、ratio=比例(如 3:4)、enum=方向词(如 portrait)',
          '- sizes 里把 "auto" 放第一个;labels 只在像素值模型上给(把 16:9、4:3 这类标出来)',
          '- 只列图像生成模型(minimax-h3 那种视频模型也留着,format 用 enum)',
          `- 插件当前内置了这些,别漏掉它们,只补/改有变化的:${known}`,
          '- 查不到依据的新模型别硬编;写完把新增和改动了哪些模型报我',
        ].join('\n');
      }

      /** 等 Agent 把清单写出来:每 4 秒看一眼,内容变了就载入并收工(最多 2 分钟)。 */
      function startModelsWatch(before) {
        if (modelsWatchRef.current) clearInterval(modelsWatchRef.current);
        const seen = `${(before && before.updated) || ''}|${Array.isArray(before && before.models) ? before.models.length : 0}`;
        let rounds = 0;
        modelsWatchRef.current = setInterval(async () => {
          rounds += 1;
          if (rounds > 30) {
            clearInterval(modelsWatchRef.current);
            modelsWatchRef.current = null;
            setModelsNote('等 Agent 写清单超时了 —— 去对话里看看它跑到哪了;写好后点一下「⟳ 获取新模型」就能载入');
            return;
          }
          try {
            const data = await api('/models', undefined, sessionRef.current);
            const now = `${(data && data.updated) || ''}|${Array.isArray(data && data.models) ? data.models.length : 0}`;
            if (!data || !data.exists || now === seen) return;
            clearInterval(modelsWatchRef.current);
            modelsWatchRef.current = null;
            const stats = mergeModelCatalog(data);
            setModelsNote(
              `模型清单已更新:${stats.total} 条(新增 ${stats.added}、覆盖 ${stats.updated})${data.updated ? ` · ${data.updated}` : ''}`,
            );
          } catch {
            /* 轮询期间的网络抖动忽略;超时那条兜底 */
          }
        }, 4000);
      }

      /**
       * 模型面板上那颗「⟳ 获取新模型」。
       *
       * 三步:① 先读工作区已有的清单(有就当场生效,不用干等)② 交给 DSH 里的 Agent 去查最新
       * ——上游没有模型列表接口,只能让它查资料 + 写文件 ③ 边等边轮询那份文件,写好了自动载入。
       * @returns {Promise<void>} 无返回值;结果落在 modelsNote / error 上。
       */
      async function fetchModels() {
        if (modelsBusyRef.current) return;
        setError('');
        modelsBusyRef.current = true;
        setModelsBusy(true);
        let data = null;
        try {
          data = await loadModelCatalog();
        } catch (e) {
          modelsBusyRef.current = false;
          setModelsBusy(false);
          setError(`读取模型清单失败:${String((e && e.message) || e)}`);
          return;
        }
        const bridge = (props && props.agentBridge) || null;
        if (!bridge || typeof bridge.send !== 'function') {
          modelsBusyRef.current = false;
          setModelsBusy(false);
          setModelsNote('当前 DSH 版本不支持从画布发起对话:请直接在对话里说「更新画布模型清单」');
          return;
        }
        try {
          const absolute = String((data && data.absolute) || '');
          if (!absolute) throw new Error('宿主没给出清单路径(宿主可能是旧版,重启一次 DSH 再来)');
          const result = await bridge.send(modelCatalogBrief(absolute), sessionRef.current);
          if (!result || !result.ok) throw new Error((result && result.error) || '未知原因');
          setModelsNote('已交给 Agent 去查 GrsAI 最新模型 —— 它写完清单会自动载入(最多等 2 分钟)');
          startModelsWatch(data);
        } catch (e) {
          setError(`交给 Agent 失败:${String((e && e.message) || e)}`);
        } finally {
          modelsBusyRef.current = false;
          setModelsBusy(false);
        }
      }

      /**
       * 把画布上选中的图交给 DSH 里的 agent,用 image-layering 技能做图片分层(只出 PSD)。
       *
       * 三步:① 选图(选中的 → 最后导入/生成的)② 落盘到工作区(脚本要一个真实文件路径)
       * ③ 往当前会话发一条带输入图与输出目录的指令 —— 等于替你在输入框按了回车。
       *
       * 和上面那批 `BUILTIN_SKILLS` 模板的区别:模板改的是"发给图像模型的那句话",
       * 这条是把活交给 agent,**产出可编辑的 PSD 图层**。
       * @returns {Promise<void>} 无返回值;结果落在 notice / error 上。
       */
      async function runAgentLayering() {
        if (agentBusyRef.current) return;
        // 与 saveSkills 一致:落盘要走 /ws-save,旧宿主没有这个能力就明确说出来
        if (!featuresRef.current.includes('ws-save')) {
          setError('宿主是旧版:重启一次 DSH 后才能把图落盘做分层(缺 ws-save 能力)');
          return;
        }
        setError('');
        setNotice('');
        const bridge = (props && props.agentBridge) || null;
        if (!bridge || typeof bridge.send !== 'function') {
          setError('当前 DSH 版本不支持从画布发起对话:请在对话里直接说「图片分层」');
          return;
        }
        const target = selected || images.filter((im) => !im.isRef).slice(-1)[0] || images[images.length - 1] || null;
        if (!target) {
          setError('画布上还没有图片:先拖入或生成一张,再做分层');
          return;
        }
        agentBusyRef.current = true;
        setAgentBusy(true);
        try {
          // 带文字图层的图按原图分辨率烧成成品图 —— 要分的是眼睛看到的这张
          const dataUrl = await renderExportDataUrl(target);
          const base = String(target.name || 'grsai').replace(/\.[a-z0-9]+$/i, '') || 'grsai';
          const rel = `画布输出/${base}-分层输入-${stamp()}.png`;
          const saved = await api(
            '/ws-save',
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: rel, dataUrl }) },
            sessionRef.current,
          );
          const absolute = String((saved && saved.absolute) || '');
          const folder = absolute.replace(/[\\/][^\\/]+$/, '');
          const outDir = `${folder}\\分层-${base}-${stamp()}`;
          const text = [
            '用 image-layering 技能把这张图做图片分层,只要 PSD 分支(不要跑矢量):',
            '',
            `输入图:${absolute || rel}`,
            `输出目录:${outDir}`,
            '',
            '要求:',
            '- 只出 PSD + 透明 PNG 图层(--no-svg --no-ai),不要调用 Recraft',
            `- 档位 ${AGENT_LAYERING.size},--timeout ${AGENT_LAYERING.timeout}`,
            '- --output-dir 用上面那个专用空目录(脚本会清理同名图层文件,别指到别处)',
            '- 跑完把 PSD 的绝对路径报给我',
          ].join('\n');
          const result = await bridge.send(text, sessionRef.current);
          if (result && result.ok) {
            setNotice(`已把这张图交给 Agent:${rel} —— 去对话里看进度(image-layering,只出 PSD)`);
          } else {
            setError(`交给 Agent 失败:${(result && result.error) || '未知原因'}`);
          }
        } catch (e) {
          setError(`交给 Agent 失败:${String((e && e.message) || e)}`);
        } finally {
          agentBusyRef.current = false;
          setAgentBusy(false);
        }
      }

      /**
       * 「帮我写提示词」:把选中的图 + 你写的草稿一起交给对话里的 agent,
       * 让它回一条能直接用的提示词。
       *
       * 和「按标注改图」的区别:这条**不发给图像模型、不花钱** —— 只是让 agent 帮你把话说清楚。
       * 图会作为对话附件一起发过去,agent 看得到画面才写得准。
       * @returns {Promise<void>} 结果落在 notice / error 上。
       */
      async function askAgentPrompt() {
        if (agentBusyRef.current) return;
        setError('');
        setNotice('');
        const bridge = (props && props.agentBridge) || null;
        if (!bridge || typeof bridge.sendWithImage !== 'function') {
          setError('当前 DSH 版本不支持从画布发起对话:请在对话里直接说「帮我写提示词」');
          return;
        }
        const target = selected || images.filter((im) => !im.isRef).slice(-1)[0] || images[images.length - 1] || null;
        if (!target) {
          setError('画布上还没有图片:先拖入或生成一张,再让 agent 帮你写提示词');
          return;
        }
        agentBusyRef.current = true;
        setAgentBusy(true);
        try {
          const dataUrl = await renderExportDataUrl(target);
          const base = String(target.name || 'grsai').replace(/\.[a-z0-9]+$/i, '') || 'grsai';
          const text = [
            '帮我写一条改图提示词。',
            '',
            `我现在的草稿:${prompt.trim() || '(还没想好)'}`,
            '',
            '要求:',
            '- 按上面这张图的实际内容写,该保留的保留,别把画面描述成另一个场景',
            '- 一条中文提示词,120 字以内,只给提示词本身:不要解释、不要分点、不要客套',
            '- 我草稿里写明的意思以我为准,你只负责说清楚、补到位',
          ].join('\n');
          const result = await bridge.sendWithImage(text, sessionRef.current, {
            dataUrl,
            name: `写提示词-${base}-${stamp()}.png`,
          });
          if (result && result.ok) {
            setNotice(
              result.withImage
                ? '已交给 agent(带着图):提示词它会直接写在对话里'
                : '已交给 agent(只发了文字):提示词它会直接写在对话里',
            );
          } else {
            setError(`交给 agent 失败:${(result && result.error) || '未知原因'}`);
          }
        } catch (e) {
          setError(`交给 agent 失败:${String((e && e.message) || e)}`);
        } finally {
          agentBusyRef.current = false;
          setAgentBusy(false);
        }
      }

      /**
       * 「AI 高清放大」:把引擎下下来(缺什么补什么,已装好的会跳过)。
       * @param {string} tier - 档位 id(fast / quality)。
       * @returns {Promise<void>} 结果落在 upscaleNote 上。
       */
      async function ensureUpscale(tier) {
        if (upscaleBusy) return;
        setUpscaleBusy('download');
        setUpscaleNote(`正在下载「${tier === 'quality' ? '高清放大' : '快速放大'}」引擎…(下完就永久离线可用)`);
        try {
          const data = await api(
            '/upscale-ensure',
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier }) },
            sessionRef.current,
          );
          setUpscaleNote(data.downloaded ? `引擎已就绪(本次下载 ${data.downloaded} 个文件)` : '引擎本来就已经装好了');
          const status = await api('/upscale-status', undefined, sessionRef.current);
          setUpscaleTiers(Array.isArray(status.tiers) ? status.tiers : []);
        } catch (e) {
          const message = String((e && e.message) || e);
          setUpscaleNote(/未知路由/.test(message) ? '宿主是旧版:重启一次 DSH 后这颗按钮才可用' : `下载失败:${message}`);
        } finally {
          setUpscaleBusy('');
        }
      }

      /**
       * 「AI 高清放大」:把画布上选中的图丢给本机显卡放大,结果放回画布。
       *
       * 走的不是云端模型(那条路是「高清修复」模板):这里由宿主进程调用本机的
       * realesrgan 引擎在**你自己的显卡**上跑,图片不出本机、不花 API 额度。
       *
       * 选图规则和「图片分层」一致:选中的 → 最后导入/生成的;带文字图层的按原图分辨率烧好再放大。
       * @returns {Promise<void>} 结果落在 notice / error / upscaleNote 上。
       */
      async function runUpscale() {
        if (upscaleBusy) return;
        setError('');
        const target = selected || images.filter((im) => !im.isRef).slice(-1)[0] || images[images.length - 1] || null;
        if (!target) {
          setError('画布上还没有图片:先拖入或生成一张,再放大');
          return;
        }
        setUpscaleBusy('run');
        setUpscaleNote(`${upscaleScale}x 放大中…(首次会先把引擎下下来,之后完全离线)`);
        try {
          const dataUrl = await renderExportDataUrl(target);
          const base = String(target.name || 'grsai').replace(/\.[a-z0-9]+$/i, '') || 'grsai';
          const rel = `画布输出/${base}-放大${upscaleScale}x-${stamp()}.png`;
          const data = await api(
            '/upscale-run',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tier: upscaleTier, scale: upscaleScale, dataUrl, outputRel: rel }),
            },
            sessionRef.current,
          );
          // 宿主已经写回工作区了,直接按那条路径读回来摆上画布
          await pickWorkspace(data.output);
          setUpscaleNote(`已放大 ${data.scale}x → ${data.output}(用时 ${data.seconds} 秒)`);
          setNotice(`AI 高清放大完成:${data.output}(${data.seconds} 秒)`);
          const status = await api('/upscale-status', undefined, sessionRef.current);
          setUpscaleTiers(Array.isArray(status.tiers) ? status.tiers : []);
        } catch (e) {
          const message = String((e && e.message) || e);
          setUpscaleNote(/未知路由/.test(message) ? '宿主是旧版:重启一次 DSH 后这颗按钮才可用' : `放大失败:${message}`);
          setError(`AI 高清放大失败:${message}`);
        } finally {
          setUpscaleBusy('');
        }
      }

      /**
       * 保存「图片分层(Agent)」的接口地址与密钥。
       *
       * 密钥由**宿主半边**直接写进 image-layering 技能的 `config/apimart_config.json`,
       * 不经过聊天窗口、也不回显(读接口只回掩码);留空 = 保持已保存的那把钥匙不变。
       * @returns {Promise<void>} 结果落在 layerCfg.note 与顶部提示上。
       */
      async function saveLayerCfg() {
        if (layerCfg.busy) return;
        setError('');
        setNotice('');
        setLayerCfg((prev) => Object.assign({}, prev, { busy: 'save', note: '' }));
        try {
          const data = await api(
            '/layering-config',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                base_url: String(layerCfg.base || '').trim() || LAYER_DEFAULT_BASE,
                api_key: String(layerCfg.key || ''),
                // 手写框里写了新模型就一起存下去(「保存」等于把地址 + key + 模型一次写全)
                model: String(layerCfg.modelDraft || layerCfg.model || ''),
                // 高级端点:空 = 不动配置里那一格(要改回默认,把默认值原样填进去再保存)
                submit_endpoint: String(layerCfg.submitEndpoint || '').trim(),
                task_status_endpoint: String(layerCfg.statusEndpoint || '').trim(),
              }),
            },
            sessionRef.current,
          );
          setLayerCfg((prev) =>
            Object.assign({}, prev, {
              busy: '',
              key: '',
              base: String(data.base_url || prev.base),
              submitEndpoint: String(data.submit_endpoint || prev.submitEndpoint || ''),
              statusEndpoint: String(data.task_status_endpoint || prev.statusEndpoint || ''),
              createUrl: String(data.create_url || prev.createUrl || ''),
              statusUrl: String(data.status_url || prev.statusUrl || ''),
              model: String(data.model || prev.model || ''),
              modelDraft: String(data.model || prev.modelDraft || ''),
              hasKey: Boolean(data.configured),
              masked: String(data.keyMasked || ''),
              dir: String(data.dir || prev.dir),
              note: `已保存 → ${data.path}`,
            }),
          );
          setNotice('分层配置已保存:现在可以点「▶ 图片分层(交给 Agent)」了');
        } catch (e) {
          const message = String((e && e.message) || e);
          setLayerCfg((prev) => Object.assign({}, prev, { busy: '', note: `保存失败:${message}` }));
        }
      }

      /** 清掉本机保存的分层密钥(地址留着)。 */
      async function clearLayerKey() {
        if (layerCfg.busy) return;
        setError('');
        setNotice('');
        setLayerCfg((prev) => Object.assign({}, prev, { busy: 'clear', note: '' }));
        try {
          const data = await api(
            '/layering-config',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ base_url: String(layerCfg.base || '').trim() || LAYER_DEFAULT_BASE, clear_key: true }),
            },
            sessionRef.current,
          );
          setLayerCfg((prev) =>
            Object.assign({}, prev, {
              busy: '',
              key: '',
              hasKey: Boolean(data.configured),
              masked: '',
              note: '已清除本机保存的分层密钥',
            }),
          );
        } catch (e) {
          setLayerCfg((prev) => Object.assign({}, prev, { busy: '', note: `清除失败:${String((e && e.message) || e)}` }));
        }
      }

      /** 连接自检:宿主只 GET 一次 `/v1/models`,不产生生成费用。 */
      async function testLayerCfg() {
        if (layerCfg.busy) return;
        setError('');
        setLayerCfg((prev) => Object.assign({}, prev, { busy: 'test', note: '' }));
        try {
          const data = await api('/layering-test', undefined, sessionRef.current);
          setLayerCfg((prev) =>
            Object.assign({}, prev, {
              busy: '',
              note: `HTTP ${(data && data.status) || '?'} —— ${String((data && data.hint) || '')}`,
            }),
          );
        } catch (e) {
          setLayerCfg((prev) => Object.assign({}, prev, { busy: '', note: `测试失败:${String((e && e.message) || e)}` }));
        }
      }

      /**
       * 拉一次上游的模型清单,挑出像"图层分解"的那些。
       *
       * 为什么要有这个:图层分解各家叫法不一样 —— APIMart 叫 `seedream-5-0-pro`,
       * EvoLink 叫 `doubao-seedream-5.0-pro-layerize`,kie 叫 `seedream/5-pro-layer-decomposition`。
       * 以前换服务商得去技能目录手改 json 里的 model,现在点一下就能选。
       * @param {boolean} [all] - 连"不太像"的一起列出来(上游模型动辄几百个,默认只看像的)。
       * @returns {Promise<void>} 结果落在 layerCfg.models / note 上。
       */
      async function fetchLayerModels(all) {
        if (layerCfg.busy) return;
        setError('');
        setLayerCfg((prev) => Object.assign({}, prev, { busy: 'models', note: '' }));
        try {
          const data = await api('/layering-models', undefined, sessionRef.current);
          const models = Array.isArray(data.models) ? data.models : [];
          setLayerCfg((prev) =>
            Object.assign({}, prev, {
              busy: '',
              models,
              modelsAll: Boolean(all),
              model: String(prev.model || data.current || ''),
              note: data.matched
                ? `上游 ${data.total} 个模型,其中 ${data.matched} 个像图层分解(已排在最前面)—— 点一个就存下来`
                : `上游 ${data.total} 个模型里没找到明显像"图层分解"的 —— 点「显示全部」自己认一个`,
            }),
          );
        } catch (e) {
          const message = String((e && e.message) || e);
          setLayerCfg((prev) =>
            Object.assign({}, prev, {
              busy: '',
              models: [],
              note: /未知路由/.test(message)
                ? '宿主半边是旧版(还没有这条接口)—— 重启一次 DSH 后可用'
                : `取模型失败:${message}`,
            }),
          );
        }
      }

      /**
       * 存一个模型名进技能配置(点清单里的一个,或在手写框里自己写一个,走的是同一条)。
       *
       * 模型 ID **不写死**:清单是上游给的(见 `fetchLayerModels`),清单里没有的也能手写 ——
       * 图层分解各家叫法不一样(APIMart `seedream-5-0-pro` / EvoLink
       * `doubao-seedream-5.0-pro-layerize` / kie `seedream/5-pro-layer-decomposition`),
       * 上游 `/v1/models` 未必列全,所以手写这条路必须留着。
       * @param {string} id - 模型名。
       * @returns {Promise<void>} 结果落在 layerCfg.model / modelDraft / note 上。
       */
      async function saveLayerModel(id) {
        if (layerCfg.busy) return;
        const model = String(id || '').trim();
        if (!model) return;
        setError('');
        setLayerCfg((prev) => Object.assign({}, prev, { busy: 'model', note: '' }));
        try {
          const data = await api(
            '/layering-config',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ base_url: String(layerCfg.base || '').trim() || LAYER_DEFAULT_BASE, model }),
            },
            sessionRef.current,
          );
          const saved = String(data.model || model);
          setLayerCfg((prev) =>
            Object.assign({}, prev, { busy: '', model: saved, modelDraft: saved, note: `已选用「${saved}」并存进技能配置` }),
          );
          setNotice(`分层模型已保存:${saved}`);
        } catch (e) {
          setLayerCfg((prev) => Object.assign({}, prev, { busy: '', note: `保存模型失败:${String((e && e.message) || e)}` }));
        }
      }

      // ── 文字图层 ──────────────────────────────────────────────────
      /** 选中的那一条文字(没选就是 null)。 */
      const selectedText = selected && selectedTextId ? (selected.texts || []).find((tx) => tx.id === selectedTextId) || null : null;

      /** 改一条文字(直接改图片对象上的数组,再提交一次历史)。 */
      function updateText(id, patch, commit) {
        const image = selected;
        if (!image) return;
        const list = (image.texts || []).map((tx) => (tx.id === id ? Object.assign({}, tx, patch) : tx));
        image.texts = list;
        if (commit !== false) finishChange(true);
        else scheduleDraw();
      }

      /** 给选中的图加一条文字(默认放在画面中间偏下,常见标题位)。 */
      function addTextLayer() {
        const image = selected;
        if (!image) {
          setError('先选中一张图,再点「＋文字」');
          return;
        }
        const item = Object.assign({}, TEXT_DEFAULTS, { id: uid('tx'), value: '双击这里改文字', nx: 0.5, ny: 0.78 });
        image.texts = [...(image.texts || []), item];
        setSelectedTextId(item.id);
        setShowText(true);
        finishChange(true);
        setNotice('文字是本机字体本地画的:拖动摆位置,「存 / 下载」时按原图分辨率烧进去');
      }

      function removeTextLayer(id) {
        const image = selected;
        if (!image) return;
        image.texts = (image.texts || []).filter((tx) => tx.id !== id);
        if (selectedTextId === id) setSelectedTextId('');
        finishChange(true);
      }

      /** 量一下这台机器上装了哪些候选字体(第一次打开文字面板时跑一次)。 */
      useEffect(() => {
        if (!showText || fontList !== null) return undefined;
        const timer = setTimeout(() => {
          try {
            setFontList(availableFonts());
          } catch {
            setFontList([]);
          }
        }, 0);
        return () => clearTimeout(timer);
      }, [showText, fontList]);

      /** 载入一个本地字体文件(.ttf/.otf/.woff2)—— 系统里没装、又想要某个字体时用。 */
      async function importFontFile(file) {
        if (!file) return;
        try {
          if (typeof FontFace !== 'function' || !document.fonts) throw new Error('这个浏览器不支持载入字体文件');
          const buffer = await file.arrayBuffer();
          const family = file.name.replace(/\.[a-z0-9]+$/i, '') || '导入字体';
          const face = new FontFace(family, buffer);
          await face.load();
          document.fonts.add(face);
          setFontList((cur) => Array.from(new Set([...(cur || []), family])));
          if (selectedText) updateText(selectedText.id, { font: family });
          setNotice(`字体已载入:${family}(本次会话有效,可直接用在文字上)`);
        } catch (e) {
          setError(`字体载入失败:${String((e && e.message) || e)}`);
        }
      }

      /**
       * 把「尺寸」框里写的原话换算给上游并生效。
       *
       * 规则(界面上的提示会照这个说):
       *   · 写的是**像素**(`1080x1440`、`小红书`、`A4`…)→ 交给「成品尺寸」:上游按最近档位渲染,
       *     导出时本地精确缩放到你写的尺寸;
       *   · 写的是**比例/方向词**(`3:4`、`竖版`…)→ 只设尺寸(不缩放);
       *   · 认不出来的原话留着不动,由黄字提示兜底。
       * @returns {boolean} 换算成功了给 true。
       */
      function applySizeDraft() {
        const value = String(sizeDraft).trim();
        if (value === SOURCE_TEXT || value === SOURCE_SIZE || value === 'auto') {
          setRatio(value === 'auto' ? normalizeSize(model, value) : SOURCE_SIZE);
          setCustomSize('');
          setSizeDraft(value === 'auto' ? normalizeSize(model, value) : SOURCE_TEXT);
          return true;
        }
        const converted = convertSizeForModel(model, sizeDraft, dpi);
        if (!converted) return false;
        if (converted.mode === 'pixel') {
          setCustomSize(converted.exact);
          setNotice(`尺寸「${String(sizeDraft).trim()}」:上游按 ${converted.send} 渲染,导出 ${converted.exact}`);
        } else {
          setCustomSize('');
          setRatio(converted.send);
          setNotice(`尺寸「${String(sizeDraft).trim()}」换算为上游的「${converted.send}」`);
        }
        return true;
      }

      /** 场景框(生成框):把「尺寸/比例」草稿应用到最后一个框。 */
      function applyFrameSize() {
        const frames = docRef.current.frames || [];
        if (!frames.length) return;
        const frame = frames.find((f) => f.id === selectedFrameId) || frames[frames.length - 1];
        const text = String(frameSizeDraft).trim();
        if (!text) {
          setNotice(`场景框 ${Math.round(frame.w)}×${Math.round(frame.h)}(${(frame.w / frame.h).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')})`);
          return;
        }
        const parsed = parseHumanSize(text, dpi);
        if (parsed.mode === 'pixel' && parsed.pixels) {
          frame.w = parsed.pixels[0];
          frame.h = parsed.pixels[1];
        } else if (parsed.aspect) {
          frame.h = frame.w / parsed.aspect;
        } else {
          setNotice('认不出这个尺寸/比例:写 800x600、210x297mm 或 3:4 之类');
          return;
        }
        docRef.current = { images: docRef.current.images, marks: docRef.current.marks, frames };
        finishChange(true);
        setNotice(`场景框已设为 ${Math.round(frame.w)}×${Math.round(frame.h)}`);
      }

      /** 删掉一个场景框。 */
      function removeFrame(id) {
        const frames = (docRef.current.frames || []).filter((f) => f.id !== id);
        docRef.current = { images: docRef.current.images, marks: docRef.current.marks, frames };
        finishChange(true);
        setNotice('已删除场景框');
      }

      /**
       * 「扩图」第一步:在选中的图外围生成一个比它大的框并选中它。
       *
       * 之后画布上出现 8 个可拖手柄 —— 拉多大就扩多大:框的宽高比会原样发给上游
       * (`sourceAspect` 取的就是框的比例),落图时也按框的像素尺寸精确缩放,所以不会变形。
       * 拉好去工具条上点「▶ 生成扩图」。
       */
      function startExpand() {
        const image = docRef.current.images.find((im) => im.id === selectedId) || null;
        if (!image) {
          setNotice('先点选一张图,再点「扩图」');
          return;
        }
        if (image.hidden) {
          setNotice('这张图已隐藏 —— 先在图层面板里点「显」,再扩图');
          return;
        }
        const grow = 0.25; // 四周各留 25% 的空白,拖起来有地方下笔
        const fw = Math.max(64, Math.round(image.w * (1 + grow * 2)));
        const fh = Math.max(64, Math.round(image.h * (1 + grow * 2)));
        const frame = {
          id: uid('fr'),
          x: Math.round(image.x - (fw - image.w) / 2),
          y: Math.round(image.y - (fh - image.h) / 2),
          w: fw,
          h: fh,
          expand: true,
          sourceId: image.id, // 提交时把这张图选回来当主图(run() 认"选中的图")
        };
        docRef.current = {
          images: docRef.current.images,
          marks: docRef.current.marks,
          // 扩图期间画布上只留这一个框:旧框(普通场景框、上一次还没用上的扩图框)全摘掉。
          // 一是会叠框、旧的没手柄却挡点击;二是 run() 的 frames[last] 兜底会误选;
          // 三是用户点完「生成扩图」后最常抱怨的就是"原先那个框还戳在原地"。
          frames: [frame],
        };
        setSelectedFrameId(frame.id);
        setExpandFrameId(frame.id);
        expandFrameRef.current = frame.id;
        setTool('select');
        finishChange(true);
        setNotice('画布上原有的框已收起;拉四边/四角决定往外扩多少,拉好点工具条上的「▶ 生成扩图」');
        scheduleDraw();
      }

      /** 退出扩图:摘掉还没用上的那个扩图框(生成成功后框会被结果图顶掉,不用管)。 */
      function cancelExpand() {
        if (!expandFrameId) return;
        const all = docRef.current.frames || [];
        const frames = all.filter((f) => f.id !== expandFrameId);
        if (frames.length !== all.length) {
          docRef.current = { images: docRef.current.images, marks: docRef.current.marks, frames };
          finishChange(true);
        }
        setExpandFrameId(null);
        setSelectedFrameId(null);
        expandFrameRef.current = null;
        scheduleDraw();
      }

      /** 场景框弹窗确认:解析输入的尺寸/比例,在点击处生成框。 */
      function confirmFrame() {
        const draft = frameDraft;
        if (!draft) return;
        const text = String(draft.value || '').trim();
        if (!text) {
          setNotice('输入尺寸或比例:800x600 / 210x297mm / 3:4');
          return;
        }
        const parsed = parseHumanSize(text, dpi);
        let w;
        let h;
        if (parsed.mode === 'pixel' && parsed.pixels) {
          w = parsed.pixels[0];
          h = parsed.pixels[1];
        } else if (parsed.aspect) {
          w = 800;
          h = Math.round(800 / parsed.aspect);
        } else {
          setNotice('认不出这个尺寸/比例:写 800x600、210x297mm 或 3:4');
          return;
        }
        const frames = docRef.current.frames || [];
        docRef.current = {
          images: docRef.current.images,
          marks: docRef.current.marks,
          frames: [...frames, { id: uid('fr'), x: draft.x, y: draft.y, w, h }],
        };
        finishChange(true);
        setNotice(`场景框已放在 (${Math.round(draft.x)}, ${Math.round(draft.y)}):${Math.round(w)}×${Math.round(h)}`);
        setFrameDraft(null);
      }

      /** 把「新建模板」表单里的内容存下来并直接选中。 */
      async function addSkill() {
        const name = skillDraft.name.trim();
        const promptText = skillDraft.prompt.trim();
        if (!name || !promptText) {
          setError('新建模板要填名称和具体要做什么');
          return;
        }
        const preset = { id: `custom-${Date.now().toString(36)}`, name: name.slice(0, 60), prompt: promptText.slice(0, 4000) };
        setError('');
        if (await saveSkills([...skills, preset])) {
          setSkillDraft({ name: '', prompt: '' });
          setActiveSkillId(preset.id);
        }
      }

      // ── 插件自我更新(「更新」按钮)────────────────────────────────
      // 下载/校验/解压/替换全部由宿主半边做(浏览器跨域拿不到别人的站点、也写不了安装目录)。
      // 客户端只负责:让你填「更新地址」、点按钮、把结果说清楚。

      const { canUpdate, effectiveUpdateUrl, loadUpdateStatus, checkUpdate, applyUpdateNow, rollbackUpdateNow } = rt['update-center'].createUpdateCenter(
        deps('update-center', {
          featuresRef,
          sessionRef,
          setNotice,
          setUpdateBusy,
          setUpdateInfo,
          setUpdateNote,
          setUpdateStatus,
          updateDraft,
          updateUrl,
        }),
      );

      /**
       * 把当前草稿同步到工作区(交给宿主写文件)。
       *
       * 内容只有**文字**:提示词、套用的模板、文字图层、标注类型 —— **不含图片数据**。
       * 目的是让对话里的 AI 能读到"你正在写什么",从而帮你检查漏了哪些要求。
       * @returns {Promise<void>} 写完(失败静默 —— 这只是辅助信息,不该打扰生成流程)。
       */
      const saveDraft = useCallback(async () => {
        if (!draftSync) return;
        // 与 saveSkills 一致:宿主缺能力时静默跳过(这只是辅助信息,不该打扰生成流程)
        if (!featuresRef.current.includes('ws-save')) return;
        const doc = docRef.current;
        const payload = {
          updatedAt: Date.now(),
          prompt,
          skill: activeSkill ? { id: activeSkill.id, name: activeSkill.name, prompt: activeSkill.prompt } : null,
          form: { model, ratio, customSize, dpi, cropToMark, submitTexts },
          images: doc.images.map((im) => ({
            name: im.name,
            size: `${im.naturalW || im.w}x${im.naturalH || im.h}`,
            isRef: Boolean(im.isRef),
            texts: (im.texts || []).map((t) => ({ value: t.value, font: t.font, size: t.size, nx: t.nx, ny: t.ny })),
          })),
          marks: doc.marks.map((m) => ({
            kind: m.kind,
            text: m.text || undefined,
            at: m.at || undefined,
            from: m.from || undefined,
            to: m.to || undefined,
            rect: m.rect || undefined,
          })),
        };
        try {
          const json = JSON.stringify(payload, null, 2);
          await api(
            '/ws-save',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // 复用 /ws-save(它本来就是把一段数据写进工作区);非 base64 的 dataURL 会被原样解码成文本
              body: JSON.stringify({ path: DRAFT_REL, dataUrl: `data:application/json,${encodeURIComponent(json)}` }),
            },
            sessionRef.current,
          );
        } catch {
          /* 同步失败不打扰用户 */
        }
      }, [draftSync, prompt, model, ratio, customSize, dpi, cropToMark, submitTexts, activeSkill]);

      // 提示词 / 画布内容一变就防抖同步一次(1.5 秒),让工作区里那份 draft.json 跟上
      useEffect(() => {
        if (!draftSync) return undefined;
        const timer = setTimeout(() => {
          saveDraft();
        }, 1500);
        return () => clearTimeout(timer);
      }, [draftSync, saveDraft, docVersion]);

      // 启动时(**用默认地址也算**)悄悄查一次:有新版只在设置按钮上冒 ⬆ + 状态栏留一句,不弹东西。
      // 勾掉「启动时自动检查」就完全不联网(手动点「检查更新」仍然可用)。
      useEffect(() => {
        if (!updateAuto) return undefined;
        const timer = setTimeout(() => {
          checkUpdate(true);
        }, 2500);
        return () => clearTimeout(timer);
      }, [updateAuto, updateUrl, hostFeatures]);

      // 打开「设置」面板就问一次宿主现状(版本 / 可回滚的备份)。不做这件事的话,
      // 关掉「启动时自动检查」的人永远看不到版本信息,面板还会误报"宿主半边是旧版"。
      useEffect(() => {
        if (showSettings) loadUpdateStatus();
      }, [showSettings]);

      /**
       * 续查:上次没取回的任务(轮询期间关页面/切标签/收起侧栏都会导致标签页被卸载)。
       * 参考站也是把未完成任务存起来、重开继续查 —— 否则那一次生成就白费了。
       */
      useEffect(() => {
        if (!loaded) return undefined;
        const cutoff = Date.now() - 6 * 3600 * 1000;
        const pending = readPendingTasks().filter((task) => task && task.id && (task.at || 0) > cutoff);
        writePendingTasks(pending);
        if (!pending.length) return undefined;
        let alive = true;
        // 续查也把占位框画出来(和正常生成同一套:知道会落在哪就别让人干等)
        const startBox = (task) => {
          const rect = previewPlaceholderRect({
            frame: task.frame,
            exactSize: task.exactSize === undefined ? '' : task.exactSize,
            aspectRatio: task.aspect,
            targetId: task.targetId,
            placement: task.placement,
            offsetY: task.offsetY,
          });
          if (!rect) return null;
          const entry = {
            id: uid('ph'),
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            startedAt: Date.now(),
            label: '续查',
            pct: 0,
            state: 'running',
            // 续查这条路是单线的(cancelRef 管着),所以框里的「⏹ 打断」直接置它
            cancel: () => {
              cancelRef.current = true;
            },
          };
          pendingRef.current = [...pendingRef.current, entry];
          scheduleDraw();
          return entry;
        };
        const stopBox = (entry) => {
          if (!entry) return;
          const list = pendingRef.current;
          const next = list.filter((item) => item.id !== entry.id);
          if (next.length === list.length) return;
          pendingRef.current = next;
          scheduleDraw();
        };
        (async () => {
          if (!apikeyRef.current) {
            setNotice(`有 ${pending.length} 个上次没取回的任务,填入 APIKEY 后会继续查`);
            return;
          }
          cancelRef.current = false;
          setBusy(true);
          setNotice(`正在继续查询上次的 ${pending.length} 个任务…`);
          for (const task of pending) {
            if (!alive || !aliveRef.current) return;
            const box = startBox(task);
            try {
              setPhase(`继续查询 ${String(task.id).slice(0, 8)}…`);
              const url = await pollTask(task.id, apikeyRef.current, { isActive: () => alive });
              if (!alive) return;
              const dataUrl = await proxyImageDataUrl(url, sessionRef.current);
              if (!alive) return;
              let made;
              try {
                // 和正常生成走同一把落图锁:同时收尾的两张才不会算出同一个落点叠在一起
                made = await withPlaceLock(() => placeResultImage(dataUrl, task.targetId, task.frame, {
                  exactSize: task.exactSize === undefined ? '' : task.exactSize,
                  placement: task.placement, offsetY: task.offsetY,
                }));
              } catch (e) {
                // 图已经下载到手、只是放不进画布:标终局,别让下次开画布重复下载再失败一遍
                if (e) e.placeFailed = true;
                throw e;
              }
              setResults((prev) => [{ id: task.id, url, at: Date.now(), model: task.model || '', prompt: task.prompt || '' }, ...prev].slice(0, 30));
              // 续查的结果同样入库(第一期 A):与正常生成同一路径、同一去重(按 taskId)。
              // 续查任务只存过 model/prompt/exactSize/frame —— 其余字段缺就缺,不编造。
              await onRecord({
                taskId: task.id,
                url,
                dataUrl,
                w: Number(made && (made.naturalW || made.w)) || 0,
                h: Number(made && (made.naturalH || made.h)) || 0,
                model: task.model || '',
                promptFinal: task.prompt || '',
                exactSize: task.exactSize === undefined ? '' : String(task.exactSize),
                frame: Boolean(task.frame),
              }).catch(() => {});
              removePendingTask(task.id);
              setNotice('上次没取回的结果已经补上 🎉');
            } catch (e) {
              if (e && e.cancelled) {
                removePendingTask(task.id);
                if (alive) setNotice('已打断本次续查,其余任务保留等待下次恢复');
                break;
              }
              if (e && (e.definitive || e.placeFailed)) removePendingTask(task.id);
              else if (alive) setError(`继续查询 ${String(task.id).slice(0, 8)} 失败:${(e && e.message) || e}`);
            } finally {
              // 取回/失败/打断都在这儿摘掉占位框
              stopBox(box);
            }
          }
          if (alive) {
            setBusy(false);
            setPhase('');
          }
        })();
        // 只摘这次续查自己加的框,别一把清空 pendingRef ——
        // 那里同时挂着正在生成的占位框,清空会让用户以为任务丢了(还顺手把 busy 关掉)。
        const added = [];
        return () => {
          alive = false;
          for (const entry of pendingRef.current) {
            if (entry && entry.label === '续查') added.push(entry);
          }
          for (const entry of added) stopBox(entry);
          // 还有生成任务在跑就别抢它的 busy
          const running = Array.isArray(jobsRef.current) ? jobsRef.current.length : 0;
          if (!running) setBusy(false);
        };
      }, [loaded, Boolean(apikey)]);

      // 生成记录:打开画布(宿主有 /history 能力)时读一次清单。
      // 会话守卫在 persister.load 里:回来时工作区已切走就整体丢弃,不污染新工作区。
      useEffect(() => {
        if (!loaded || !featuresRef.current.includes('history')) return undefined;
        const session = sessionRef.current;
        let alive = true;
        (async () => {
          try {
            const res = await persisterRef.current.load(session);
            if (!alive || res.stale || sessionRef.current !== session) return;
            recordsRef.current = res.records;
            setRecords(res.records);
            if (res.corrupted) {
              corruptedRef.current = true;
              corruptedOkRef.current = false;
              setHistoryCorrupted(true);
              setNotice('生成记录清单文件损坏,已按空载入;保存前会再次向你确认');
            }
          } catch (e) {
            if (alive && sessionRef.current === session) {
              setError(`读取生成记录失败:${(e && e.message) || e}(本次会话的新记录不会持久化)`);
            }
          }
        })();
        return () => { alive = false; };
      }, [loaded]);

      // 打开画布时先悄悄载入一次工作区模型清单(有就当场生效;没有也不打扰,面板上有按钮可以手动来)
      useEffect(() => {
        if (!loaded || modelsLoadedRef.current) return undefined;
        if (!featuresRef.current.includes('models')) return undefined;
        modelsLoadedRef.current = true;
        (async () => {
          try {
            await loadModelCatalog({ quiet: true });
          } catch {
            /* 读不到就继续用内置表;面板上点「⟳ 获取新模型」可以再来 */
          }
        })();
        return undefined;
      }, [loaded]);

      // 画布关掉时别把"等 Agent 写清单"的定时器留着
      useEffect(() => () => {
        if (modelsWatchRef.current) clearInterval(modelsWatchRef.current);
      }, []);

      // ── 指针交互 ────────────────────────────────────────────────────
      function localPoint(event) {
        const el = canvasRef.current;
        const box = el.getBoundingClientRect();
        return [event.clientX - box.left, event.clientY - box.top];
      }

      /**
       * 双击画布上的文字 → 就地改字。
       *
       * 只在选择工具下响应:别的工具双击是"画两笔",抢过来会让人画不出东西。
       * 编辑框由渲染段按文字的屏幕位置盖上去(见 textEditor),这里只负责进入编辑态。
       */
      function onCanvasDoubleClick(event) {
        if (tool !== 'select') return;
        const [sx, sy] = localPoint(event);
        const [wx, wy] = screenToWorld(camRef.current, sx, sy);
        const image = hitImage(wx, wy);
        if (!image || image.locked || !Array.isArray(image.texts) || !image.texts.length) return;
        const [tnx, tny] = normalized(image, wx, wy);
        const hit = hitTextLayer(image.texts, tnx, tny, image.w, image.h);
        if (!hit) return;
        setSelectedId(image.id);
        setSelectedIds([image.id]);
        setSelectedTextId(hit.id);
        setShowText(true);
        setTextEditId(hit.id);
      }

      /**
       * 就地编辑收尾:把这次改字提交进历史并触发存盘。
       *
       * 编辑器是直接写 docRef 的(见 textEditor 的 onChange),内容已经生效;
       * 但如果只 `setTextEditId('')` 把 textarea 卸掉,blur 不会派发,
       * 于是这次改动既不进撤销栈也不存盘 —— 平移/缩放画布时就会踩到,刷新后改字全丢。
       */
      function commitTextEdit() {
        if (!textEditId) return;
        setTextEditId('');
        finishChange(true);
      }

      function onPointerDown(event) {
        const el = canvasRef.current;
        if (!el) return;
        // 手势开始先把上一轮平移留下的尾巴清掉:否则一次右键拖动会让右键菜单永久失效
        panTailRef.current = null;
        // 右键菜单开着的时候,点画布/画布上的图先只把菜单收掉(和系统菜单一样:
        // 第一下点击不当成操作,免得连菜单带图一起误拖)。
        if (menuAt) {
          setMenuAt(null);
          return;
        }
        const [sx, sy] = localPoint(event);
        const cam = camRef.current;
        const [wx, wy] = screenToWorld(cam, sx, sy);
        try {
          el.setPointerCapture(event.pointerId);
        } catch {
          /* 个别环境不支持捕获 */
        }
        setError('');
        const pan = event.button === 1 || event.button === 2 || event.altKey || spaceDown;
        if (pan) {
          // 平移/缩放时把就地编辑收掉:编辑框是按当时的相机位置摆的,画布一动就对不上了
          // (走 commitTextEdit 而不是 setTextEditId(''),否则这次改字不进历史也不存盘)
          commitTextEdit();
          dragRef.current = { kind: 'pan', sx, sy, camX: cam.x, camY: cam.y, changed: false, button: event.button };
          return;
        }
        // 占位框里的「⏹ 打断」:先判它 —— 按钮只有一小块,而且只在生成中出现。
        // 矩形用的是绘制时那个 placeholderCancelRect,保证"看到的按钮"就是"能点的按钮"。
        for (const ph of pendingRef.current) {
          const btn = placeholderCancelRect(cam, ph);
          if (btn && sx >= btn.x && sx <= btn.x + btn.w && sy >= btn.y && sy <= btn.y + btn.h) {
            if (typeof ph.cancel === 'function') ph.cancel();
            setNotice(ph.state === 'queued' ? '已把这张从队列里撤掉' : '已打断这一张,结果不会取回');
            return;
          }
        }
        if (tool === 'select') {
          // 生成占位框:能点选、能拖(出图就落在拖过去的位置)。放在最前面判 ——
          // 它是刚冒出来的那一块,底下往往还压着别的图,不先判就永远轮不到它。
          const phHit = hitPlaceholder(sx, sy);
          if (phHit) {
            selectedPlaceholderRef.current = phHit.id;
            setSelectedId(null);
            setSelectedIds([]);
            setSelectedTextId('');
            setSelectedFrameId(null);
            dragRef.current = {
              kind: 'phMove',
              id: phHit.id,
              world: [wx, wy],
              start: { x: phHit.x, y: phHit.y },
              changed: false,
            };
            scheduleDraw();
            return;
          }
          // 文字的「拉字号」手柄先判:它挂在文字包围盒右下角,可能落在图片外面(图片的
          // hitHandle 判断的是图片自己的四角,两者位置不同,但先判文字更符合"看到什么点什么")
          const textHandle = textHandleRef.current;
          if (textHandle && Math.abs(sx - textHandle.hx) <= 9 && Math.abs(sy - textHandle.hy) <= 9) {
            beginChange();
            dragRef.current = {
              kind: 'textSize',
              id: textHandle.id,
              targetId: textHandle.targetId,
              startSize: textHandle.size,
              center: [textHandle.wx, textHandle.wy],
              startDist: Math.max(1, Math.hypot(wx - textHandle.wx, wy - textHandle.wy)),
              changed: false,
            };
            return;
          }
          // 扩图框的手柄(优先于图片自己的四角):框比图大,先判框更贴"看到什么点什么"
          const frameHandle = frameHandleRef.current;
          if (frameHandle) {
            for (const key of Object.keys(frameHandle.handles)) {
              const pt = frameHandle.handles[key];
              if (Math.abs(sx - pt[0]) <= 9 && Math.abs(sy - pt[1]) <= 9) {
                const target = (docRef.current.frames || []).find((f) => f.id === frameHandle.id);
                if (target) {
                  beginChange();
                  dragRef.current = {
                    kind: 'frameResize',
                    id: target.id,
                    corner: key,
                    start: { x: target.x, y: target.y, w: target.w, h: target.h },
                    world: [wx, wy],
                    changed: false,
                  };
                  return;
                }
              }
            }
          }
          const handle = hitHandle(wx, wy);
          if (handle) {
            const image = docRef.current.images.find((im) => im.id === selectedId);
            beginChange();
            dragRef.current = {
              kind: 'resize',
              id: image.id,
              corner: handle,
              start: { x: image.x, y: image.y, w: image.w, h: image.h },
              world: [wx, wy],
              changed: false,
            };
            return;
          }
          const image = hitImage(wx, wy);
          if (image) {
            selectedPlaceholderRef.current = '';
            // 点选:按住 Shift 增选/减选,否则只选这一张(框选结果会被点一下替换掉)
            if (event.shiftKey) {
              const next = selectedIds.includes(image.id)
                ? selectedIds.filter((id) => id !== image.id)
                : [...selectedIds, image.id];
              setSelectedIds(next);
              setSelectedId(next.length ? next[0] : null);
            } else if (!selectedIds.includes(image.id)) {
              // 点的是多选之外的新图 → 单选它;点的是多选里的图 → 保持整组,准备一起拖
              setSelectedIds([image.id]);
              setSelectedId(image.id);
            }
            if (image.locked) {
              // 锁定图:可选中查看,但不能拖动/缩放/编辑(解锁在图层面板)
              setSelectedTextId('');
              scheduleDraw();
              return;
            }
            // 先看点到的是不是这张图上的文字图层:是的话拖文字(而不是拖图)
            if (Array.isArray(image.texts) && image.texts.length) {
              const [tnx, tny] = normalized(image, wx, wy);
              const hit = hitTextLayer(image.texts, tnx, tny, image.w, image.h);
              if (hit) {
                setSelectedTextId(hit.id);
                beginChange();
                dragRef.current = {
                  kind: 'text',
                  id: hit.id,
                  targetId: image.id,
                  offset: [tnx - (Number(hit.nx) || 0), tny - (Number(hit.ny) || 0)],
                  changed: false,
                };
                return;
              }
            }
            setSelectedTextId('');
            beginChange();
            // 多选(≥2 且含这张图)时整组一起动,否则只动这张
            const group = selectedIds.length > 1 && selectedIds.includes(image.id)
              ? selectedIds
                  .map((id) => {
                    const im = docRef.current.images.find((m) => m.id === id);
                    return im ? { id, x: im.x, y: im.y } : null;
                  })
                  .filter(Boolean)
              : null;
            dragRef.current = { kind: 'move', id: image.id, world: [wx, wy], start: { x: image.x, y: image.y }, group, changed: false };
          } else {
            const frame = hitFrame(wx, wy);
            if (frame) {
              // 点中场景框:选中它,准备拖动
              setSelectedFrameId(frame.id);
              setSelectedId(null);
              setSelectedIds([]);
              setSelectedTextId('');
              beginChange();
              dragRef.current = { kind: 'frameMove', id: frame.id, world: [wx, wy], start: { x: frame.x, y: frame.y }, changed: false };
              return;
            }
            // 空白处按下:开始框选(左键不再平移;平移用空格/中键/右键)
            selectedPlaceholderRef.current = '';
            setSelectedId(null);
            setSelectedIds([]);
            setSelectedTextId('');
            setSelectedFrameId(null);
            dragRef.current = { kind: 'box', sx, sy, ex: sx, ey: sy, changed: false };
          }
          return;
        }
        if (tool === 'shape') {
          // 场景框(生成框):点击画布 → 弹窗输入尺寸/比例 → 在点击处生成,不拖拽
          setFrameDraft({ x: wx, y: wy, sx, sy, value: '' });
          return;
        }
        // 绘制类工具:找目标图(隐藏图点不到;主选中的隐藏/锁定图也不能当画布)
        const target = hitImage(wx, wy) || docRef.current.images.find((im) => im.id === selectedId) || null;
        if (target && target.hidden) {
          setNotice('这张图已隐藏 —— 先在图层面板里点「显」,再画标注');
          return;
        }
        if (target && target.locked) {
          setNotice('这张图已锁定 —— 先在图层面板里解锁,再画标注');
          return;
        }
        if (!target) {
          setNotice('先把标注画在图片上:用「＋图片」加一张,或点在图片上');
          return;
        }
        if (target.id !== selectedId) {
          setSelectedId(target.id);
          setSelectedIds([target.id]);
        }
        const [nx, ny] = normalized(target, wx, wy);

        if (tool === 'eraser') {
          beginChange();
          dragRef.current = { kind: 'erase', id: target.id, cursor: [sx, sy], changed: false };
          eraseAt(target, wx, wy);
          return;
        }
        const widthNorm = (markWidth / cam.zoom) / target.w;
        beginChange();
        const mark =
          tool === 'brush'
            ? { id: uid('mk'), targetId: target.id, kind: 'brush', color, width: widthNorm, points: [[nx, ny]] }
            : tool === 'mask'
              ? { id: uid('mk'), targetId: target.id, kind: 'mask', color, width: widthNorm * 2.2, points: [[nx, ny]] }
              : tool === 'arrow'
              ? { id: uid('mk'), targetId: target.id, kind: 'arrow', color, width: widthNorm, from: [nx, ny], to: [nx, ny] }
              : { id: uid('mk'), targetId: target.id, kind: tool, color, width: widthNorm, rect: { x0: nx, y0: ny, x1: nx, y1: ny } };
        docRef.current = { images: docRef.current.images, marks: [...docRef.current.marks, mark], frames: docRef.current.frames };
        // `id` 必须带上:onPointerMove 靠它找回目标图,少了它拖动会被当成"找不到图"直接返回
        dragRef.current = { kind: 'draw', id: target.id, mark, changed: false };
        scheduleDraw();
      }

      function eraseAt(image, wx, wy) {
        const radius = 14 / camRef.current.zoom;
        const marks = docRef.current.marks;
        const kept = marks.filter((mk) => {
          if (mk.targetId !== image.id) return true;
          return markDistanceToPoint(mk, image, wx, wy) > radius;
        });
        if (kept.length !== marks.length) {
          docRef.current = { images: docRef.current.images, marks: kept, frames: docRef.current.frames };
          if (dragRef.current) dragRef.current.changed = true;
          scheduleDraw();
        }
      }

      /** 鼠标离开画布:把笔尖圆点收掉(不收会停在最后那个位置上)。 */
      function onPointerLeave() {
        if (!pointerRef.current) return;
        pointerRef.current = null;
        scheduleDraw();
      }

      function onPointerMove(event) {
        const [sx, sy] = localPoint(event);
        const drag = dragRef.current;
        // 画笔类工具:先记下笔尖位置并重绘,让小圆点跟手。
        // 只有这些工具、且不在空格平移时才多这一次重绘;其余工具连坐标都不算。
        const ui = liveRef.current;
        if (RING_TOOLS.indexOf(ui.tool) >= 0 && !ui.spaceDown) {
          const at = pointerRef.current;
          pointerRef.current = [sx, sy];
          if (!at || at[0] !== sx || at[1] !== sy) scheduleDraw();
        }
        if (!drag) return;
        const cam = camRef.current;
        const [wx, wy] = screenToWorld(cam, sx, sy);
        if (drag.kind === 'pan') {
          const next = { x: drag.camX - (sx - drag.sx) / cam.zoom, y: drag.camY - (sy - drag.sy) / cam.zoom, zoom: cam.zoom };
          camRef.current = next;
          drag.changed = true;
          scheduleDraw();
          return;
        }
        if (drag.kind === 'text') {
          // 拖文字:改的是归一化坐标,所以图缩放/导出时位置都跟着走
          const host = docRef.current.images.find((im) => im.id === drag.targetId);
          const item = host && Array.isArray(host.texts) ? host.texts.find((tx) => tx.id === drag.id) : null;
          if (!host || !item) return;
          const [nx, ny] = normalized(host, wx, wy);
          item.nx = clamp(nx - drag.offset[0], -0.2, 1.2);
          item.ny = clamp(ny - drag.offset[1], -0.2, 1.2);
          drag.changed = true;
          scheduleDraw();
          return;
        }
        if (drag.kind === 'textSize') {
          // 拉字号:按"鼠标离文字中心多远"等比缩放 —— 往外拖变大,往里收变小。
          // 存的是**占图高的比例**,所以换尺寸/导出时字跟着图走,不会跑位。
          const host = docRef.current.images.find((im) => im.id === drag.targetId);
          const item = host && Array.isArray(host.texts) ? host.texts.find((tx) => tx.id === drag.id) : null;
          if (!host || !item) return;
          const dist = Math.hypot(wx - drag.center[0], wy - drag.center[1]);
          const next = clamp((Number(drag.startSize) || TEXT_DEFAULTS.size) * (dist / drag.startDist), 0.01, 1.2);
          item.size = Math.round(next * 10000) / 10000;
          drag.changed = true;
          scheduleDraw();
          return;
        }
        if (drag.kind === 'box') {
          drag.ex = sx;
          drag.ey = sy;
          drag.changed = true;
          scheduleDraw();
          return;
        }
        if (drag.kind === 'phMove') {
          // 拖生成占位框:直接改 pendingRef 里那一条 —— 出图按它的 x/y 落位,所以拖完就是图的位置
          const ph = pendingRef.current.find((item) => item.id === drag.id);
          if (!ph) return;
          ph.x = drag.start.x + (wx - drag.world[0]);
          ph.y = drag.start.y + (wy - drag.world[1]);
          ph.moved = true; // 落图时看到这个标记就尊重用户拖的位置,不再自动避让重排
          drag.changed = true;
          scheduleDraw();
          return;
        }
        if (drag.kind === 'frameMove') {
          const frame = (docRef.current.frames || []).find((f) => f.id === drag.id);
          if (!frame) return;
          frame.x = drag.start.x + (wx - drag.world[0]);
          frame.y = drag.start.y + (wy - drag.world[1]);
          drag.changed = true;
          scheduleDraw();
          return;
        }
        if (drag.kind === 'frameResize') {
          // 拉扩图框:被拖的那条边/角跟着鼠标走,对边原地不动;小到 48 就顶住,也不许翻面。
          const frame = (docRef.current.frames || []).find((f) => f.id === drag.id);
          if (!frame) return;
          const s = drag.start;
          const dx = wx - drag.world[0];
          const dy = wy - drag.world[1];
          const corner = String(drag.corner || 'se');
          let x = s.x;
          let y = s.y;
          let w = s.w;
          let hh = s.h;
          if (corner.indexOf('w') >= 0) {
            x = s.x + dx;
            w = s.w - dx;
          } else if (corner.indexOf('e') >= 0) {
            w = s.w + dx;
          }
          if (corner.indexOf('n') >= 0) {
            y = s.y + dy;
            hh = s.h - dy;
          } else if (corner.indexOf('s') >= 0) {
            hh = s.h + dy;
          }
          if (w < 48) {
            if (corner.indexOf('w') >= 0) x = s.x + s.w - 48;
            w = 48;
          }
          if (hh < 48) {
            if (corner.indexOf('n') >= 0) y = s.y + s.h - 48;
            hh = 48;
          }
          frame.x = Math.round(x);
          frame.y = Math.round(y);
          frame.w = Math.round(w);
          frame.h = Math.round(hh);
          drag.changed = true;
          scheduleDraw();
          return;
        }
        const image = docRef.current.images.find((im) => im.id === drag.id);
        if (!image) return;
        if (drag.kind === 'move') {
          const dx = wx - drag.world[0];
          const dy = wy - drag.world[1];
          if (drag.group) {
            // 多选整组一起动
            for (const item of drag.group) {
              const im = docRef.current.images.find((m) => m.id === item.id);
              if (im) {
                im.x = item.x + dx;
                im.y = item.y + dy;
              }
            }
          } else {
            image.x = drag.start.x + dx;
            image.y = drag.start.y + dy;
          }
          drag.changed = true;
          scheduleDraw();
          return;
        }
        if (drag.kind === 'resize') {
          const start = drag.start;
          const right = drag.corner === 'ne' || drag.corner === 'se';
          const bottom = drag.corner === 'sw' || drag.corner === 'se';
          const aspect = start.w / start.h;
          let w = Math.max(24, right ? wx - start.x : start.x + start.w - wx);
          let hh = Math.max(24, bottom ? wy - start.y : start.y + start.h - wy);
          if (!event.shiftKey) {
            if (w / hh > aspect) w = hh * aspect;
            else hh = w / aspect;
          }
          image.w = Math.round(w);
          image.h = Math.round(hh);
          image.x = right ? start.x : start.x + start.w - image.w;
          image.y = bottom ? start.y : start.y + start.h - image.h;
          drag.changed = true;
          scheduleDraw();
          return;
        }
        if (drag.kind === 'erase') {
          drag.cursor = [sx, sy];
          eraseAt(image, wx, wy);
          return;
        }
        if (drag.kind === 'draw') {
          const [nx, ny] = normalized(image, wx, wy);
          const mark = drag.mark;
          if (mark.kind === 'brush' || mark.kind === 'mask') mark.points.push([nx, ny]);
          else if (mark.kind === 'arrow') mark.to = [nx, ny];
          else mark.rect = { x0: mark.rect.x0, y0: mark.rect.y0, x1: nx, y1: ny };
          drag.changed = true;
          scheduleDraw();
        }
      }

      function onPointerUp() {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag) return;
        if (drag.kind === 'textSize') {
          // 拉完字号提交一次:不然这次改动既进不了撤销栈,也不会存盘
          finishChange(drag.changed !== false);
          return;
        }
        if (drag.kind === 'pan') {
          // 记下这次平移是哪个键、有没有真的拖动过:紧接着的 contextmenu 要靠它判断
          // "用户是右键点一下(要菜单)还是右键拖着平移(不要菜单)"。
          panTailRef.current = { button: drag.button, changed: drag.changed };
          if (drag.changed) scheduleSave();
          return;
        }
        if (drag.kind === 'box') {
          // 松手:统计选框(屏幕坐标)扫过的图片,组成多选
          const cam = camRef.current;
          const x0 = Math.min(drag.sx, drag.ex);
          const y0 = Math.min(drag.sy, drag.ey);
          const x1 = Math.max(drag.sx, drag.ex);
          const y1 = Math.max(drag.sy, drag.ey);
          const hits = [];
          for (const image of docRef.current.images) {
            if (image.hidden) continue; // 隐藏图不参与框选(看不见的图不该被框进去)
            const a = worldToScreen(cam, image.x, image.y);
            const w = image.w * cam.zoom;
            const h = image.h * cam.zoom;
            if (a[0] < x1 && a[0] + w > x0 && a[1] < y1 && a[1] + h > y0) hits.push(image.id);
          }
          setSelectedIds(hits);
          setSelectedId(hits.length ? hits[0] : null);
          scheduleDraw();
          return;
        }
        if (drag.kind === 'draw') {
          const mark = drag.mark;
          let keep = true;
          if (mark.kind === 'brush' && mark.points.length < 2) keep = drag.changed;
          if (mark.kind === 'rect' || mark.kind === 'ellipse') {
            const b = normalizeRect(mark.rect);
            // 用**屏幕像素**判"是不是误触"。原来只看归一化面积 > 1e-5,而小图上鼠标
            // 抖动 1~2 像素就超过这个阈值了 —— 想"点一下"却在画布上留下一个
            // 几乎看不见的小框。要求两条边都至少 4 个屏幕像素。
            const box = docRef.current.images.find((im) => im.id === mark.targetId);
            const zoom = camRef.current.zoom;
            const wpx = box ? Math.abs(b.x1 - b.x0) * box.w * zoom : 0;
            const hpx = box ? Math.abs(b.y1 - b.y0) * box.h * zoom : 0;
            keep = wpx >= 4 && hpx >= 4;
          }
          if (mark.kind === 'arrow') {
            const d = Math.hypot(mark.to[0] - mark.from[0], mark.to[1] - mark.from[1]);
            keep = d > 0.004;
          }
          if (!keep) {
            docRef.current = { images: docRef.current.images, marks: docRef.current.marks.filter((mk) => mk.id !== mark.id), frames: docRef.current.frames };
            finishChange(false);
            return;
          }
          // 箭头画完、提示词还空着:直接把光标送进提示词框 —— 光有箭头模型猜不出你要改成什么
          if (mark.kind === 'arrow' && !prompt.trim() && promptRef.current && typeof promptRef.current.focus === 'function') {
            try {
              promptRef.current.focus();
            } catch {
              /* 聚焦失败不影响别的 */
            }
          }
        }
        finishChange(drag.changed !== false);
      }

      /**
       * 丢掉"正在画、还没放手"的那一笔。
       *
       * 为什么要它:切工具(或按 Esc)时若还拖着一个半成品,它会留在画布上;而且
       * `dragRef` 不清理的话,之后鼠标一动就会接着往那个框上加 —— 表现出来就是
       * 「点了方块工具,再选别的工具,画布上莫名多出一个框」。
       * @returns {void}
       */
      function cancelPendingDrag() {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        if (drag.kind === 'draw' && drag.mark && drag.mark.id) {
          docRef.current = {
            images: docRef.current.images,
            marks: docRef.current.marks.filter((mk) => mk.id !== drag.mark.id),
            frames: docRef.current.frames,
          };
          bumpDoc();
        }
        scheduleDraw();
      }

      /** 切工具:先把没画完的那一笔丢掉,再换工具。 */
      function chooseTool(next) {
        cancelPendingDrag();
        setTool(next);
      }

      // 兜底：万一指针捕获失败(setPointerCapture 在个别环境会抛)，或用户把鼠标移到
      // 画布外才松手，canvas 就收不到 pointerup —— 那一笔会永远卡在半成品状态：
      // 画布上留一个框，鼠标一动还接着画。挂到 window 上补住这个缺口。
      // 正常路径下 canvas 的 onPointerUp 先跑并把 dragRef 清成 null，所以不会重复触发。
      onPointerUpRef.current = onPointerUp;
      useEffect(() => {
        const finish = () => {
          if (dragRef.current) onPointerUpRef.current();
        };
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
        return () => {
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
        };
      }, []);

      // 键盘
      useEffect(() => {
        const onKeyDown = (event) => {
          const tag = (event.target && event.target.tagName) || '';
          if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
          // 只在鼠标位于画布上时接管按键:否则会抢走对话输入框的 Delete / 空格 / 字母键
          if (!hoverRef.current) return;
          if (event.code === 'Space') {
            setSpaceDown(true);
            event.preventDefault();
            return;
          }
          const actions = actionsRef.current;
          // 用 liveRef 而不是闭包里的 state:这段键盘逻辑挂一次就长期有效,
          // 读闭包容易看到"上一次渲染"的选中状态。
          const live = liveRef.current || {};
          const key = String(event.key || '').toLowerCase();
          if ((event.ctrlKey || event.metaKey) && key === 'c') {
            // 画布上的 Ctrl+C = 把选中的图写进系统剪贴板。
            // 拦下来是必要的:不拦的话浏览器只会去复制"没选中的网页文字",什么也拿不到。
            event.preventDefault();
            actions.copySelected && actions.copySelected();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && key === 'z') {
            event.preventDefault();
            if (event.shiftKey) actions.redo && actions.redo();
            else actions.undo && actions.undo();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && key === 'y') {
            event.preventDefault();
            actions.redo && actions.redo();
            return;
          }
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (key === 'escape') {
            // 正在拉扩图框:Esc 先退出扩图(把还没用上的框摘掉);再按一次才是"取消选择"
            if (live.expandFrameId && actions.cancelExpand) actions.cancelExpand();
            else actions.escape && actions.escape();
            return;
          }
          if (key === 'delete' || key === 'backspace') {
            event.preventDefault();
            // 选中的是文字图层:只删这条字。以前这里直接走 deleteSelected,
            // 而它只管 images/marks —— 于是点中一行字再按 Delete,整张图连标注一起没了。
            if (live.selectedTextId && actions.removeTextLayer) {
              actions.removeTextLayer(live.selectedTextId);
              return;
            }
            // 选中「生成框」时删框:`deleteSelected` 只管图片,以前框选中时按 Delete 毫无反应
            if (!live.selectedId && live.selectedFrameId && actions.removeFrame) actions.removeFrame(live.selectedFrameId);
            else actions.deleteSelected && actions.deleteSelected();
            return;
          }
          const hit = TOOLS.find((t) => t.key.toLowerCase() === key);
          if (hit) {
            event.preventDefault();
            actions.setTool && actions.setTool(hit.id);
            return;
          }
          if (key === '0') {
            actions.fitAll && actions.fitAll();
            return;
          }
          if (key === '1') {
            actions.zoomTo && actions.zoomTo(1);
          }
        };
        const onKeyUp = (event) => {
          if (event.code === 'Space') setSpaceDown(false);
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        return () => {
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('keyup', onKeyUp);
        };
      }, []);

      // ── 图片操作 ────────────────────────────────────────────────────
      const { toggleRef, deleteSelected, reorderSelected, setImageFlag, setGeometry, renameImage, moveImageTo, alignSelected, clearMarks, clearCanvas, renderExportDataUrl, saveImageToWorkspace, saveSelectedToWorkspace, saveImageLayered, downloadImage, downloadSelected, copyImageToClipboard, importResult, openWorkspace, refreshWorkspace, pickWorkspace } = rt['images'].createImages(
        deps('images', {
          addImageFromDataUrl,
          camRef,
          docRef,
          dpi,
          finishChange,
          imgCacheRef,
          layerSize,
          savePath,
          selected,
          selectedIds,
          sessionRef,
          setError,
          setNotice,
          setSelectedId,
          setSelectedIds,
          setDockOpen,
          setWsBusy,
          setWsFiles,
          wsFiles,
        }),
      );

      // 把动作挂到 ref 上,给键盘/滚轮/定时器用
      actionsRef.current = {
        undo,
        redo,
        fitAll,
        zoomTo,
        zoomAtPoint,
        scheduleDraw,
        scheduleSave,
        saveNow,
        setTool: chooseTool,
        popOut: (props && props.popOut) || null,
        escape: () => {
          cancelPendingDrag();
          setSelectedId(null);
          setSelectedIds([]);
          setTool('select');
        },
        deleteSelected,
        // 场景框:Delete 删框、Esc 退出扩图(都挂在键盘上,见上面的 onKeyDown)
        removeFrame,
        cancelExpand,
        // Ctrl+C:没选中就给句提示,别让按键看起来"没反应"
        copySelected: () => {
          if (!selected) {
            setNotice('先点选一张图,再按 Ctrl+C 复制');
            return;
          }
          copyImageToClipboard(selected, selectedIds.length > 1 ? '(多选里只复制了主选中这张)' : '');
        },
      };

      /**
       * 提交前自检(每次渲染按当前表单算一遍)。
       * 只提醒"几乎每次都要写、却最容易忘"的那几句,不做教条式检查。
       */
      const preflight = preflightChecks({
        prompt,
        skillPrompt: activeSkill ? activeSkill.prompt : '',
        skillId: activeSkill ? activeSkill.id : '',
        marks: selectedMarks,
        textCount: selected ? (selected.texts || []).length : 0,
        refCount,
        cropToMark,
        submitTexts,
        hasTarget: Boolean(selected),
      });
      /** 能直接补进提示词的那几条。 */
      const preflightFixes = preflight.issues.filter((item) => item.fix);
      /** 需要"套用某个模板"才能解决的那条。 */
      const preflightSkill = preflight.issues.find((item) => item.action && item.action.indexOf('skill:') === 0);

      /** 一键把缺的要求追加到提示词末尾。 */
      function applyPreflightFixes() {
        const fixes = preflightFixes.map((item) => item.fix);
        if (!fixes.length) return;
        const text = fixes.join('\n');
        setPrompt((cur) => (cur.trim() ? `${cur.trim()}\n${text}` : text));
        setNotice(`已补上 ${fixes.length} 条常用要求`);
      }

      // ── 渲染 ────────────────────────────────────────────────────────
      // 画笔类工具用 'none':画布上那个跟着鼠标的小圆点才是指针(系统光标会跟它打架)。
      const cursor = spaceDown ? 'grab' : tool === 'select' ? 'default' : RING_TOOLS.indexOf(tool) >= 0 ? 'none' : 'crosshair';

      const toolbar = rt.toolbar.renderToolbar(
        deps('toolbar', {
          tool,
          chooseTool,
          undo,
          redo,
          clearMarks,
          color,
          setColor,
          markWidth,
          setMarkWidth,
          selected,
          reorderSelected,
        }),
      );

      const topRight = rt.topright.renderTopRight(
        deps('topright', {
          fileRef,
          addFiles,
          openWorkspace,
          activeSkill,
          togglePanel,
          dockOpen,
          actionsRef,
          apikey,
          layerCfg,
          layerHostReady,
          updateAvailable,
          updateInfo,
          upscaleHostReady,
          upscaleTiers,
          upscaleBusy,
        }),
      );

      // 顶部第二行正中的视图条(缩小 / 比例 / 放大 / 适应);读数按百分比显示。
      const viewBar = rt.viewbar.renderViewbar(deps('viewbar', { fitAll, zoomTo, zoomAtPoint, zoomLabel, size }));

      const statusBar = rt.statusbar.renderStatusBar(deps('statusbar', { zoomLabel, images, refCount, saved, notice }));

      const modelPanel = rt['model-panel'].renderModelPanel(deps('model-panel', { showModels, setShowModels, model, setModel, modelsBusy, modelsNote, fetchModels }));
      const sizePanel = rt['size-panel'].renderSizePanel(
        deps('size-panel', {
          showSizes,
          setShowSizes,
          model,
          ratio,
          setRatio,
          setSizeDraft,
          setCustomSize,
          setNotice,
          dpi,
        }),
      );
      const genCard = rt['gen-card'].renderGenCard(
        deps('gen-card', {
          activeSkill,
          apikey,
          appendHint,
          applyFrameSize,
          applyPreflightFixes,
          applySizeDraft,
          applySkill,
          batchSizes,
          busy,
          cancelGenerate,
          cropToMark,
          customSize,
          docRef,
          dpi,
          error,
          finishChange,
          frameSizeDraft,
          hostStale,
          imageSize,
          images,
          jobsRef,
          lastUpstream,
          model,
          modelPanel,
          phase,
          preflight,
          preflightFixes,
          preflightSkill,
          progress,
          prompt,
          promptRef,
          ratio,
          refCount,
          removeFrame,
          run,
          selected,
          selectedFrameId,
          selectedMarks,
          setAppendHint,
          setBatchSizes,
          setCropToMark,
          setFrameSizeDraft,
          setImageSize,
          setModel,
          setPrompt,
          setRatio,
          setShowGen,
          setShowSettings,
          setSizeDraft,
          showGen,
          showModels,
          showSizes,
          sizeDraft,
          sizePanel,
          sourceAspect,
          sourceImage,
          selectedFrame,
          sourceResolved,
          submitPreview,
          togglePanel,
        }),
      );

      // 选中对象属性区:图片操作/对齐分布/文字图层(生成卡迁出,仅选中时出现)
      const propsCard = rt['props-card'].renderPropsCard(
        deps('props-card', {
          addTextLayer,
          alignSelected,
          compareSelectedTwo,
          copyImageToClipboard,
          deleteSelected,
          downloadSelected,
          fontList,
          importFontFile,
          layerSize,
          removeTextLayer,
          saveImageLayered,
          saveSelectedToWorkspace,
          selected,
          selectedIds,
          selectedMarks,
          selectedText,
          selectedTextId,
          setGeometry,
          setLayerSize,
          setSelectedTextId,
          setShowText,
          setSubmitTexts,
          showText,
          submitTexts,
          toggleRef,
          updateText,
        }),
      );
      // 属性区在上、生成卡在下,同一列贴右下角(modelPanel/sizePanel 仍锚定生成卡)
      // 停靠区打开时,属性卡+生成卡整列让到停靠区左侧(避免同位重叠);窄屏停靠区全宽,栈保持原位(自然被盖)
      const dockNarrow = size.w < 640;
      /**
       * 悬停开的那块面板贴哪儿:渲染时现读 ref —— 它总跟「开面板」的 setState 同一次变化,
       * 所以这里拿到的一定是新的。传给四块面板各自的零件,由它们按自己的宽度落位。
       */
      const panelAnchor = panelAnchorRef.current;
      // 面板贴着按钮在左边弹时并不占右侧,生成卡就别白让那 302px(不然两块会叠上)
      const dockOnRight = dockOpen && !dockNarrow && (!panelAnchor || panelAnchor.left + 302 > size.w - 8);
      const rightStack = h('div', { style: Object.assign({}, S.stack, dockOnRight ? { right: 314 } : null) }, propsCard, genCard);

      const skillsPanel = rt['skills-panel'].renderSkillsPanel(
        deps('skills-panel', {
          activeSkill,
          activeSkillId,
          addSkill,
          agentBusy,
          applySkill,
          askAgentPrompt,
          featuresRef,
          hostFeatures,
          runAgentLayering,
          saveSkills,
          setActiveSkillId,
          setSkillDraft,
          skillDraft,
          skills,
        }),
      );

      const settingsPanel = rt['settings-panel'].renderSettingsPanel(
        deps('settings-panel', {
          panelAnchor,
          apiBase,
          apikey,
          applyUpdateNow,
          background,
          baseDraft,
          canUpdate,
          checkUpdate,
          dpi,
          dpiDraft,
          draftSync,
          clearCanvas,
          hostFeatures,
          hostStale,
          keyDraft,
          quality,
          rollbackUpdateNow,
          saveNow,
          setApiBase,
          setApikey,
          setBackground,
          setBaseDraft,
          setDpiDraft,
          setDraftSync,
          setError,
          setKeyDraft,
          setNotice,
          setQuality,
          setUpdateAuto,
          setUpdateDraft,
          setUpdateNote,
          setUpdateUrl,
          showSettings,
          updateAuto,
          updateBusy,
          updateDraft,
          updateInfo,
          updateNote,
          updateStatus,
          updateUrl,
        }),
      );

      const layerKeyPanel = rt['layer-key-panel'].renderLayerKeyPanel(
        deps('layer-key-panel', {
          panelAnchor,
          clearLayerKey,
          fetchLayerModels,
          layerCfg,
          layerHostReady,
          layerModelsReady,
          saveLayerCfg,
          saveLayerModel,
          setLayerCfg,
          setShowLayerKey,
          showLayerKey,
          testLayerCfg,
        }),
      );

      const upscalePanel = rt['upscale-panel'].renderUpscalePanel(
        deps('upscale-panel', {
          panelAnchor,
          ensureUpscale,
          hostFeatures,
          runUpscale,
          setShowUpscale,
          setUpscaleScale,
          setUpscaleTier,
          showUpscale,
          upscaleBusy,
          upscaleNote,
          upscaleScale,
          upscaleTier,
          upscaleTiers,
        }),
      );

      const historyPanel = rt['history-panel'].renderHistoryPanel(
        deps('history-panel', {
          S,
          downloadRecordImage,
          historyCorrupted,
          historyFavOnly,
          historyHostReady,
          historyLimit,
          historyOpenId,
          historyQuery,
          clearRecords,
          compareRecord,
          placeRecordImage,
          removeRecord,
          restoreRecordParams,
          records,
          sessionId,
          setHistoryFavOnly,
          setHistoryLimit,
          setHistoryOpenId,
          setHistoryQuery,
          toggleRecordFav,
        }),
      );

      const wsPanel = rt['workspace-panel'].renderWorkspacePanel(
        deps('workspace-panel', {
          pickWorkspace,
          refreshWorkspace,
          savePath,
          setSavePath,
          wsBusy,
          wsFiles,
        }),
      );

      // 图层面板(C 期):紧凑列表,顺序 = doc.images 数组顺序(首行最底层)
      const layersPanel = rt['layers-panel'].renderLayersPanel(
        deps('layers-panel', {
          deleteSelected,
          images,
          layerRenameId,
          layerRenameText,
          moveImageTo,
          renameImage,
          selectImageFromPanel,
          setImageFlag,
          setLayerRenameId,
          setLayerRenameText,
          selectedId,
          selectedIds,
        }),
      );

      // 右侧停靠区:四个内容块装进同一块面板,四标签互斥。
      const dockPanel = rt.dock.renderDock(
        deps('dock', {
          panelAnchor,
          dockOpen,
          historyPanel,
          images,
          layersPanel,
          results,
          setDockOpen,
          size,
          skills,
          skillsPanel,
          wsFiles,
          wsPanel,
        }),
      );

      const frameInput = rt['frame-input'].renderFrameInput(deps('frame-input', { confirmFrame, frameDraft, setFrameDraft, size }));

      // 对比视图覆盖层(A/B 都有才渲染;z9,关闭后画布无任何改动)
      /**
       * 选中一张图 → 图的正上方浮出一条快捷工具条:点哪个就用哪个 Skills 模板**直接出图**,
       * 不用再去右下角写提示词、点生成。
       * 只在纯选择工具、单张选中、没在改文字时出现(画标注时它让开)。
       * 位置在这里按 camRef 现算 —— 和文字编辑框一个套路,不额外占 state。
       */
      const quickBar = (() => {
        if (textEditId) return null;
        // 扩图时框比图大,锚点换成框 —— 而且点框那一下会把图片取消选中,
        // 工具条不能跟着消失(不然"拉完了没法提交");扩图进行中也别因为切了工具就消失。
        const expandFrame = expandFrameId
          ? (docRef.current.frames || []).find((f) => f.id === expandFrameId) || null
          : null;
        if (tool !== 'select' && !expandFrame) return null;
        const barAnchor = expandFrame || (selected && !selected.hidden ? selected : null);
        if (!barAnchor) return null;
        const barCam = camRef.current;
        const barAt = worldToScreen(barCam, barAnchor.x, barAnchor.y);
        const barW = Math.max(24, barAnchor.w * barCam.zoom);
        const barH = Math.max(24, barAnchor.h * barCam.zoom);
        // 实测 8 颗按钮横排约 552px;比这更窄的容器(侧栏 390 / 手机 360)再按锚点居中就一定会
        // 被画布 overflow:hidden 裁掉两头按钮。窄的时候改成「左右贴边 + 换行居中」的整条,
        // 宽的时候照旧跟着图走 —— 收边按工具条真实半宽算,而不是拿图片宽度估。
        const QUICKBAR_WIDTH = 560;
        const barNarrow = !size || !size.w || size.w < QUICKBAR_WIDTH + 24;
        let barX = barAt[0] + barW / 2;
        if (!barNarrow && size && size.w) {
          const half = QUICKBAR_WIDTH / 2 + 6;
          barX = Math.min(Math.max(barX, half), size.w - half);
        }
        // 默认浮在图上沿外侧;图贴着画布顶就翻到下方,免得被裁掉
        const aboveY = barAt[1] - 46;
        const barY = aboveY > 6 ? aboveY : barAt[1] + barH + 10;
        /** 工具条落点:窄容器贴边换行(压在顶导航下面),宽容器跟着图片锚点走。 */
        // top 在窄视口要给顶导航让够位置:390/360 宽时那排「＋图片/工作区/Skills/记录/分层/放大/设置」
        // 会折成三行(约 128px),给 54/96 都会被导航条压住,所以留到 140。
        const narrowTop = size && size.w && size.w >= 480 ? 54 : 140;
        const barPlace = barNarrow
          ? { left: 6, right: 6, top: narrowTop, transform: 'none', justifyContent: 'center', flexWrap: 'wrap' }
          : { left: Math.round(barX), top: Math.round(barY) };
        /** 套上模板并**直接提交**(state 落地由上面的 effect 接力)。 */
        const quickSkill = (skillId) => {
          applySkill(skillId, true);
          autoRunSkillRef.current = skillId;
        };
        const quickBtn = (label, title, onClick, disabled) =>
          h(
            'button',
            {
              key: label,
              type: 'button',
              title,
              disabled: Boolean(disabled),
              style: Object.assign({}, S.quickBtn, disabled ? { opacity: 0.45, cursor: 'default' } : null),
              // 白底工具条上的悬停高亮(自定义 h 没有 CSS 伪类,改自己的背景即可,重渲染会重写回来)
              onPointerEnter: (event) => {
                if (!disabled && event.currentTarget) event.currentTarget.style.background = 'rgba(59,130,246,0.12)';
              },
              onPointerLeave: (event) => {
                if (event.currentTarget) event.currentTarget.style.background = '#ffffff';
              },
              onClick: () => {
                if (!disabled) onClick();
              },
            },
            label,
          );
        if (expandFrame) {
          // 扩图模式:只留"提交/取消"两颗 —— 正拉着框的时候别点错别的
          return h(
            'div',
            {
              key: 'quickbar',
              style: Object.assign({}, S.quickBar, barPlace),
              onPointerDown: (event) => event.stopPropagation(),
            },
            quickBtn('▶ 生成扩图', '按这个框的大小和比例扩图(生成后框自动消失)', () => {
              // 点框那一下图片被取消选中了,这里先把它选回来 —— run() 要靠"选中的图"当主图,
              // 少了它发出去的是一句光秃秃的提示词,那就成了凭空生成而不是扩图。
              const src = expandFrame.sourceId;
              if (src && docRef.current.images.some((im) => im.id === src)) {
                setSelectedId(src);
                setSelectedIds([src]);
              }
              setExpandFrameId(null);
              quickSkill('expand');
            }),
            quickBtn('✕ 取消', '不扩了,把框去掉', () => cancelExpand()),
          );
        }
        return h(
          'div',
          {
            key: 'quickbar',
            style: Object.assign({}, S.quickBar, barPlace),
            // 工具条压在画布上:别让它的按下被画布当成"拖图/取消选中"
            onPointerDown: (event) => event.stopPropagation(),
          },
          quickBtn('✎ 编辑', '在这张图上画标注(画笔);标完点右下角「按标注改图」', () => chooseTool('brush')),
          quickBtn('✦ 引用生成', '把这张图设为参考图,再写一句要求点生成', () => {
            setImageFlag(selected.id, 'isRef', true);
            const box = document.getElementById('grsai-prompt');
            if (box && box.focus) box.focus();
          }),
          quickBtn('≡ 分图层', '交给 Agent(image-layering 技能)拆成可编辑 PSD 图层', () => runAgentLayering(), agentBusy),
          quickBtn('⛶ 去背景', '用「抠图去背景」模板直接出图', () => quickSkill('cutout')),
          quickBtn('⊗ 去水印', '用「去水印」模板清掉水印/logo/日期戳,直接出图', () => quickSkill('remove-watermark')),
          quickBtn('⛶ 扩图', '拉一个比图大的框,框拉多大就扩多大', () => startExpand()),
          quickBtn('◐ 变清晰', '用「高清修复」模板直接出图', () => quickSkill('enhance')),
          quickBtn('↓ 下载', '下载这张图', () => downloadImage(selected)),
        );
      })();
      /**
       * 画布右键菜单:复制 / 下载 / 粘贴 + 图层顺序四项(和左侧工具栏「图层」那组调同一个
       * reorderSelected)。位置贴鼠标,但会被画布边界收回来,免得菜单跑出可视区点不到。
       */
      const menuImage = menuAt && menuAt.imageId ? images.find((im) => im.id === menuAt.imageId) || null : null;
      const menuItem = (label, onClick, disabled) =>
        h(
          'button',
          {
            key: label,
            type: 'button',
            style: Object.assign({}, S.wideBtn, {
              width: '100%',
              textAlign: 'left',
              background: 'transparent',
              color: '#1f2937',
              border: '1px solid transparent',
              opacity: disabled ? 0.4 : 1,
              cursor: disabled ? 'default' : 'pointer',
            }),
            // 白底菜单上的悬停高亮:自定义 h 没有 CSS 伪类,就改这一个元素自己的背景色
            // (下次重渲染会把 style 整体重写回来,不会留下脏状态)
            onPointerEnter: (event) => {
              if (!disabled && event.currentTarget) event.currentTarget.style.background = 'rgba(0,0,0,0.06)';
            },
            onPointerLeave: (event) => {
              if (event.currentTarget) event.currentTarget.style.background = 'transparent';
            },
            onClick: () => {
              if (disabled) return;
              setMenuAt(null);
              onClick();
            },
          },
          label,
        );
      const menuLayerItems = [
        ['置顶(画在最上面)', 'top'],
        ['上移一层', 'up'],
        ['下移一层', 'down'],
        ['置底(画在最下面)', 'bottom'],
      ].map(([label, dir]) => menuItem(label, () => reorderSelected(dir)));
      /**
       * 就地改字:编辑框直接盖在画布上那条文字的位置,字号/字体/对齐都按"画出来的样子"给,
       * 边打字边看效果。用**非受控**(defaultValue 只在挂载时取一次):文字数据存在 docRef 里,
       * 受控的话"数据变了但不会重渲染",反而看不到自己打的字。
       */
      const editHost = textEditId
        ? docRef.current.images.find((im) => (im.texts || []).some((tx) => tx.id === textEditId)) || null
        : null;
      const editItem = editHost ? (editHost.texts || []).find((tx) => tx.id === textEditId) || null : null;
      let textEditor = null;
      if (editHost && editItem) {
        const editCam = camRef.current;
        const ea = worldToScreen(editCam, editHost.x, editHost.y);
        const ew = editHost.w * editCam.zoom;
        const eh = editHost.h * editCam.zoom;
        const ebox = textLayerBounds(editItem, ew, eh);
        const sizePx = Math.max(8, eh * (Number(editItem.size) || TEXT_DEFAULTS.size));
        const bw = Math.max(90, ebox.w + 16);
        const bh = Math.max(26, ebox.h + 8);
        textEditor = h('textarea', {
          key: `textedit-${textEditId}`,
          id: 'grsai-text-edit',
          defaultValue: editItem.value,
          placeholder: '写要出现在图上的文字(支持换行;Esc 或点别处结束)',
          style: {
            position: 'absolute',
            left: Math.round(ea[0] + ebox.x + ebox.w / 2 - bw / 2),
            top: Math.round(ea[1] + ebox.y + ebox.h / 2 - bh / 2),
            width: Math.round(bw),
            height: Math.round(bh),
            zIndex: 8,
            margin: 0,
            padding: 2,
            border: '2px solid #3b82f6',
            borderRadius: 6,
            outline: 'none',
            resize: 'none',
            overflow: 'hidden',
            background: 'rgba(15,23,42,0.86)',
            color: editItem.color || TEXT_DEFAULTS.color,
            font: `${editItem.weight || 700} ${Math.round(sizePx)}px "${editItem.font || TEXT_DEFAULTS.font}", "Microsoft YaHei", "PingFang SC", sans-serif`,
            lineHeight: String(Number(editItem.lineHeight) || TEXT_DEFAULTS.lineHeight),
            textAlign: editItem.align === 'left' ? 'left' : editItem.align === 'right' ? 'right' : 'center',
          },
          onChange: (event) => {
            // 直接改数据 + 重绘画布(编辑框自己由浏览器负责显示);不压历史,结束时统一提交一次
            editItem.value = event.target.value;
            scheduleDraw();
          },
          onBlur: () => {
            commitTextEdit();
          },
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              if (event.currentTarget && typeof event.currentTarget.blur === 'function') event.currentTarget.blur();
            }
          },
        });
      }
      const contextMenu = menuAt
        ? h(
            'div',
            {
              key: 'ctxmenu',
              style: Object.assign({}, S.float, {
                left: Math.min(Math.max(4, menuAt.x), Math.max(4, size.w - 176)),
                top: Math.min(Math.max(4, menuAt.y), Math.max(4, size.h - (menuImage ? 232 : 48))),
                zIndex: 9,
                minWidth: 168,
                padding: 4,
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 2,
                // 白底 + 半透明投影:菜单是压在画布/照片上的,要一眼看清边界
                background: '#ffffff',
                color: '#1f2937',
                border: '1px solid rgba(0,0,0,0.10)',
                borderRadius: 10,
                boxShadow: '0 12px 32px rgba(0,0,0,0.22), 0 2px 6px rgba(0,0,0,0.12)',
              }),
            },
            menuImage ? menuItem('复制(到剪贴板)', () => copyImageToClipboard(menuImage)) : null,
            menuImage ? menuItem('下载这张图', () => downloadImage(menuImage)) : null,
            menuItem('粘贴(从剪贴板)', () => pasteFromClipboard()),
            menuImage ? h('div', { key: 'sep', style: { height: 1, background: 'rgba(0,0,0,0.10)', margin: '3px 4px' } }) : null,
            ...(menuImage ? menuLayerItems : []),
          )
        : null;
      const compareOverlay = rt['compare-view'].renderCompareView(
        deps('compare-view', {
          S,
          compareA,
          compareB,
          compareCanvasRef,
          compareMode,
          comparePointerDown,
          comparePointerMove,
          comparePointerUp,
          compareSlider,
          compareSwap,
          compareWheel,
          compareZoom,
          closeCompare,
          exportCompareResult,
          fitCompare,
          setCompareMode,
          setCompareSlider,
          setCompareSwap,
          zoom100Compare,
        }),
      );

      return h(
        'div',
        {
          ref: wrapRef,
          style: S.root,
          onPointerEnter: () => {
            hoverRef.current = true;
          },
          // 悬停联动:滑到哪个导航入口上就把哪块面板开出来(冒泡到这儿统一判定)
          onPointerOver: onNavPointerOver,
          onPointerLeave: () => {
            hoverRef.current = false;
            setSpaceDown(false);
            hoverPanelLeave();
          },
          onDragOver: (e) => e.preventDefault(),
          onDrop: (e) => {
            e.preventDefault();
            const dt = e.dataTransfer;
            if (!dt) return;
            if (dt.files && dt.files.length) {
              addFiles(dt.files, false);
              return;
            }
            // 从浏览器里拖网图(或拖一条链接)过来时 files 是空的,得去这几个地方把网址挖出来
            let url = '';
            const uriList = dt.getData ? dt.getData('text/uri-list') : '';
            for (const line of String(uriList || '').split(/\r?\n/)) {
              const hit = asImageUrl(line);
              if (hit) {
                url = hit;
                break;
              }
            }
            if (!url) url = asImageUrl(dt.getData ? dt.getData('text/plain') : '');
            if (!url) {
              const found = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(String((dt.getData ? dt.getData('text/html') : '') || ''));
              if (found) url = asImageUrl(found[1]);
            }
            if (!url) return;
            // 拖到哪就放哪(以落点为中心)
            const [sx, sy] = localPoint(e);
            const [wx, wy] = screenToWorld(camRef.current, sx, sy);
            addImageFromUrl(url, { x: wx, y: wy });
          },
        },
        h('canvas', {
          ref: canvasRef,
          style: Object.assign({}, S.canvas, { cursor }),
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onPointerLeave,
          onDoubleClick: onCanvasDoubleClick,
          onContextMenu: (e) => {
            e.preventDefault();
            // 右键"按住拖过"的这次不弹菜单(那是平移手势,见 onPointerUp 里的 panTailRef)。
            // 读一次就消费掉:否则 tail 会一直留着 {button:2,changed:true},右键菜单从此再也出不来。
            const tail = panTailRef.current;
            panTailRef.current = null;
            const [cx, cy] = localPoint(e);
            if (tail && tail.button === 2 && tail.changed) return;
            const [wx, wy] = screenToWorld(camRef.current, cx, cy);
            const hit = hitImage(wx, wy);
            // 右键点某张图 = 顺手选中它:「图层顺序」那几项作用的是当前选中,不选中就会出现
            // "点 A 却把上一张 B 移走了"。已经在多选里的一张则不打断多选(那时整块挪)。
            if (hit && !(selectedIds.length > 1 && selectedIds.indexOf(hit.id) >= 0)) {
              setSelectedId(hit.id);
              setSelectedIds([hit.id]);
            }
            setMenuAt({ x: cx, y: cy, imageId: hit ? hit.id : '' });
          },
        }),
        !loaded ? h('div', { style: Object.assign({}, S.float, { left: 0, top: '46%', width: '100%', justifyContent: 'center' }) }, h('span', { style: S.hint }, '读取画布…')) : null,
        loaded && images.length === 0
          ? h(
              'div',
              { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, pointerEvents: 'none', color: label2, textAlign: 'center', padding: 20 } },
              h('div', { style: { fontSize: 22 } }, '🖼'),
              h('div', { style: S.hint }, '「＋图片」选文件、拖进来、Ctrl+V 粘贴图片或图片网址,或「工作区」从当前目录挑'),
              h('div', { style: S.hint }, '加好图后用画笔/箭头/文字在图上标注,再点「按标注改图」'),
            )
          : null,
        toolbar,
        topRight,
        viewBar,
        statusBar,
        rightStack,
        settingsPanel,
        layerKeyPanel,
        upscalePanel,
        dockPanel,
        frameInput,
        compareOverlay,
        quickBar,
        contextMenu,
        textEditor,
      );
    }

    // ── 零件 20-toolbar.js ───────────────────────────────────────────────────────────
/* 左侧工具栏:工具按钮 + 撤销/重做/清空标注 + 颜色 + 粗细滑杆。
 *
 * 全局零件作用域里的 `h`/`S`/`TOOLS`/`TOOL_ICONS`/`COLORS`/`line` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('toolbar', () => {
      /** 图层顺序四个按钮(从上到下):图标 + 提示。排在后面的画在上面,所以「上移」= 在数组里往后挪一格。 */
      const LAYER_MOVES = [
        { dir: 'top', label: '置顶(画在最上面)', d: 'M11 17V8M6 13l5-5 5 5M5 4h12' },
        { dir: 'up', label: '上移一层', d: 'M11 18V7M6 12l5-5 5 5' },
        { dir: 'down', label: '下移一层', d: 'M11 4v11M6 10l5 5 5-5' },
        { dir: 'bottom', label: '置底(画在最下面)', d: 'M11 5v9M6 9l5 5 5-5M5 18h12' },
      ];
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderToolbar(p) {
        const {
          tool,
          chooseTool,
          undo,
          redo,
          clearMarks,
          color,
          setColor,
          markWidth,
          setMarkWidth,
          selected,
          reorderSelected,
        } = p;

        return h(
          'div',
          {
            style: Object.assign({}, S.float, S.col, {
              left: 6,
              top: 42,
              maxHeight: 'calc(100% - 100px)',
              overflowY: 'auto',
              overflowX: 'hidden',
              paddingRight: 1,
            }),
          },
          h(
            'div',
            { style: Object.assign({}, S.card, S.col, { padding: 4, gap: 2 }) },
            TOOLS.map((t) =>
              h(
                'button',
                {
                  key: t.id,
                  style: Object.assign({}, S.btn, tool === t.id ? S.btnOn : null),
                  title: `${t.label}(${t.key})`,
                  // 顺手 blur:点过的按钮若留着焦点,DSH 给按钮的全局样式会在它上面
                  // 再叠一层背景,看起来就像"上一个工具的选中框没消掉"。
                  onClick: (event) => {
                    chooseTool(t.id);
                    if (event && event.currentTarget && typeof event.currentTarget.blur === 'function') {
                      event.currentTarget.blur();
                    }
                  },
                },
                h(
                  'svg',
                  { width: 18, height: 18, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
                  h('path', { d: TOOL_ICONS[t.id] }),
                ),
              ),
            ),
            h('div', { style: { height: 1, background: line, margin: '3px 2px' } }),
            h(
              'button',
              { style: S.btn, title: '撤销(Ctrl+Z)', onClick: undo },
              h('svg', { width: 18, height: 18, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }, h('path', { d: 'M7 8H14a4.5 4.5 0 010 9H9M7 8l3-3M7 8l3 3' })),
            ),
            h(
              'button',
              { style: S.btn, title: '重做(Ctrl+Shift+Z)', onClick: redo },
              h('svg', { width: 18, height: 18, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }, h('path', { d: 'M15 8H8a4.5 4.5 0 000 9h5M15 8l-3-3M15 8l-3 3' })),
            ),
            h(
              'button',
              { style: S.btn, title: '清空这张图的标注', onClick: clearMarks },
              h('svg', { width: 18, height: 18, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }, h('path', { d: 'M4 6h14M8 6V4h6v2M6 6l1 12h8l1-12' })),
            ),
            h('div', { style: { height: 1, background: line, margin: '3px 2px' } }),
            // 图层顺序:排在后面的画在上面。没选中图片时先灰掉,免得点了没反应
            LAYER_MOVES.map((mv) =>
              h(
                'button',
                {
                  key: mv.dir,
                  style: Object.assign({}, S.btn, selected ? null : { opacity: 0.35, cursor: 'default' }),
                  title: mv.label,
                  onClick: () => {
                    if (selected) reorderSelected(mv.dir);
                  },
                },
                h(
                  'svg',
                  { width: 18, height: 18, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
                  h('path', { d: mv.d }),
                ),
              ),
            ),
            h('div', { style: { height: 1, background: line, margin: '3px 2px' } }),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center', padding: '2px 0' } },
              COLORS.map((c) =>
                h('button', {
                  key: c,
                  title: c,
                  style: Object.assign({}, S.btn, {
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    background: c,
                    border: color === c ? '2px solid var(--dsw-alias-label-primary, #3b82f6)' : '1px solid rgba(127,127,127,0.6)',
                  }),
                  onClick: () => setColor(c),
                }),
              ),
              h('input', {
                id: 'grsai-tool-markwidth',
                type: 'range',
                min: 2,
                max: 40,
                value: markWidth,
                title: `粗细 ${markWidth}px`,
                style: { width: 26, height: 60, writingMode: 'vertical-lr', direction: 'rtl' },
                onChange: (e) => setMarkWidth(Number(e.target.value)),
              }),
            ),
          ),
        );
      }

      return { renderToolbar };
    });

    // ── 零件 21-topright.js ──────────────────────────────────────────────────────────
/* 顶部导航(一行):加图 / 工作区 / Skills / 记录 / 分层接口 / 放大 / 设置(带更新角标)+ 隐藏的文件选择框 + 弹成浮窗。
 *
 * 视图控制(适应/100%/±)已挪到左下 34-viewbar;记录/工作区/Skills 三个入口开的是右侧停靠区(36-dock)的标签。
 *
 * 全局零件作用域里的 `h`/`S`/`line` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('topright', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderTopRight(p) {
        const {
          fileRef,
          addFiles,
          openWorkspace,
          togglePanel,
          dockOpen,
          activeSkill,
          actionsRef,
          apikey,
          layerCfg,
          layerHostReady,
          updateAvailable,
          updateInfo,
          upscaleHostReady,
          upscaleTiers,
          upscaleBusy,
        } = p;

        /** 顶导航按钮:当前停靠区标签或弹层开着时描蓝边,让「现在开的是哪块」一眼可见。 */
        const navBtn = (extra, on) => Object.assign({}, S.wideBtn, on ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null, extra || null);

        return h(
          'div',
          {
            style: Object.assign({}, S.float, S.row, {
              left: 6,
              right: 6,
              top: 6,
              // 整条导航按钮居中排(原来的 flex-start 全挤在左边,右边空一大片)
              justifyContent: 'center',
              flexWrap: 'wrap',
            }),
          },
          h(
            'div',
            {
              style: Object.assign({}, S.card, S.row, {
                padding: 4,
                maxWidth: '100%',
                flexWrap: 'wrap',
              }),
            },
            h('button', { style: S.wideBtn, title: '加入图片文件', onClick: () => fileRef.current && fileRef.current.click() }, '＋图片'),
            h('button', { style: navBtn(null, dockOpen === 'workspace'), 'data-nav-panel': 'workspace', title: '从工作区挑一张', onClick: () => { openWorkspace(); } }, '工作区'),
            h(
              'button',
              {
                style: navBtn(null, dockOpen === 'skills' || Boolean(activeSkill)),
                'data-nav-panel': 'skills',
                title: activeSkill ? `Skills 模板:已选「${activeSkill.name}」` : 'Skills 模板:证件照、抠图、换背景…(可自建)',
                onClick: () => togglePanel('skills'),
              },
              activeSkill ? `Skills·${activeSkill.name.length > 6 ? `${activeSkill.name.slice(0, 6)}…` : activeSkill.name}` : 'Skills',
            ),
            h('button', { style: navBtn(null, dockOpen === 'history'), 'data-nav-panel': 'history', title: '生成记录', onClick: () => togglePanel('history') }, '记录'),
            h('div', { style: { width: 1, alignSelf: 'stretch', background: line, margin: '4px 3px' } }),
            h(
              'button',
              {
                'data-nav-panel': 'layerkey',
                style: Object.assign(
                  {},
                  S.wideBtn,
                  layerHostReady && layerCfg.hasKey
                    ? null
                    : { border: '1px solid var(--dsw-alias-state-warn-label, #b7791f)', color: 'var(--dsw-alias-state-warn-label, #b7791f)' },
                ),
                title: !layerHostReady
                  ? '图片分层(Agent)接口:宿主半边是旧版,重启一次 DSH 后可用'
                  : layerCfg.hasKey
                    ? `图片分层(Agent)接口:已配置 ${layerCfg.masked} —— 点这里改地址 / 换 key`
                    : '图片分层(Agent)还没配接口和 key —— 点这里填(和 GrsAI 那把不是同一个)',
                onClick: () => togglePanel('layerkey'),
              },
              layerCfg.hasKey ? '🔑 分层' : '🔑 分层·未配',
            ),
            h(
              'button',
              {
                'data-nav-panel': 'upscale',
                style: Object.assign(
                  {},
                  S.wideBtn,
                  upscaleHostReady
                    ? null
                    : { border: '1px solid var(--dsw-alias-state-warn-label, #b7791f)', color: 'var(--dsw-alias-state-warn-label, #b7791f)' },
                ),
                title: !upscaleHostReady
                  ? 'AI 高清放大:宿主半边是旧版,重启一次 DSH 后可用'
                  : (upscaleTiers || []).some((t) => t.ready)
                    ? 'AI 高清放大 —— 用本机显卡,不联网、不花 API 额度'
                    : 'AI 高清放大 —— 还没下引擎(第一次约 7 MB,之后离线可用)',
                onClick: () => togglePanel('upscale'),
              },
              upscaleBusy ? '⬆ 放大中…' : '⬆ 放大',
            ),
            h('div', { style: { width: 1, alignSelf: 'stretch', background: line, margin: '4px 3px' } }),
            h('button', { style: S.btn, title: '弹成浮动面板(可拉大)', onClick: () => actionsRef.current.popOut && actionsRef.current.popOut() }, h('svg', { width: 17, height: 17, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }, h('path', { d: 'M13 4h5v5M18 4l-6 6M9 18H4v-5M4 18l6-6' }))),
            h(
              'button',
              {
                'data-nav-panel': 'settings',
                style: Object.assign(
                  {},
                  S.wideBtn,
                  apikey ? null : { border: '1px solid var(--dsw-alias-state-warn-label, #b7791f)', color: 'var(--dsw-alias-state-warn-label, #b7791f)' },
                  updateAvailable ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null,
                ),
                title: updateAvailable
                  ? `插件有新版本 ${updateInfo.version}(当前 ${updateInfo.current})——点这里去更新`
                  : apikey
                    ? '设置:APIKEY / 接口地址 / 参数 / 插件更新'
                    : '还没填 APIKEY —— 点这里填',
                onClick: () => togglePanel('settings'),
              },
              updateAvailable ? `设置 ⬆${updateInfo.version}` : apikey ? '设置' : '填 APIKEY',
            ),
            h('input', {
              id: 'grsai-file-import',
              ref: fileRef,
              type: 'file',
              accept: 'image/*',
              multiple: true,
              style: { display: 'none' },
              onChange: (event) => {
                addFiles(event.target.files, false);
                event.target.value = '';
              },
            }),
          ),
        );
      }

      return { renderTopRight };
    });

    // ── 零件 22-statusbar.js ─────────────────────────────────────────────────────────
/* 左下角状态栏:缩放比例 / 图片数 / 参考图数 / 保存时间 / 一句提示。
 *
 * 全局零件作用域里的 `h`/`S` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('statusbar', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderStatusBar(p) {
        const { zoomLabel, images, refCount, saved, notice } = p;

        return h(
          'div',
          { style: S.status },
          `${Math.round(zoomLabel * 100)}% · ${images.length} 图${refCount ? ` / ${refCount} 参考` : ''}${saved ? ` · ${saved}` : ''}`,
          notice ? `\n${notice}` : '',
        );
      }

      return { renderStatusBar };
    });

    // ── 零件 23-model-panel.js ───────────────────────────────────────────────────────
/* 模型菜单:点模型右边的 `▾` 弹出,一次列全型号(自绘 —— 原生 `<datalist>` 会被框里已有的字过滤成一个)。
 *
 * 全局零件作用域里的 `h`/`S`/`MODEL_CHOICES` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('model-panel', () => {
      /**
       * 模型菜单(点模型右边的 ▾ 弹出,再点一次收起)。
       *
       * 为什么不用 `<datalist>`:浏览器会拿输入框里已有的文字去**过滤**候选,框里写着
       * `gpt-image-2-vip` 时下拉就只剩这一条 —— 看着像"模型表只剩一个了",想换别的
       * 得先把框里的字删掉。自绘菜单永远列全,而且标出每个模型认哪种尺寸格式。
       */
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderModelPanel(p) {
        const { showModels, setShowModels, model, setModel, modelsBusy, modelsNote, fetchModels } = p;
        return showModels
          ? h(
              'div',
              {
                style: Object.assign({}, S.card, S.col, {
                  position: 'absolute',
                  // 叠在生成卡片里、紧贴「生成」那排按钮上方:卡片本身一定在可视区内,
                  // 这样菜单不会被 root 的 overflow:hidden 裁掉(窗口矮的时候也不会)
                  right: 0,
                  bottom: 36,
                  width: 322,
                  maxWidth: '100%',
                  maxHeight: 'calc(100% - 44px)',
                  gap: 4,
                  zIndex: 7,
                }),
              },
              h(
                'div',
                { style: S.row },
                h('strong', { style: { fontSize: 12 } }, `模型(${MODEL_CHOICES.length})`),
                h('span', { style: S.grow }),
                h(
                  'button',
                  {
                    style: Object.assign({}, S.tiny, modelsBusy ? { opacity: 0.5 } : null),
                    disabled: Boolean(modelsBusy),
                    title: '读工作区的 画布/models.json;没有就让 DSH 里的 Agent 去查一份最新的',
                    onClick: () => { fetchModels(); },
                  },
                  modelsBusy ? '⟳ 查询中…' : '⟳ 获取新模型',
                ),
                h('button', { style: S.tiny, onClick: () => setShowModels(false) }, '✕'),
              ),
              modelsNote ? h('div', { style: S.hint }, modelsNote) : null,
              h(
                'div',
                { style: S.list },
                MODEL_CHOICES.map((item) =>
                  h(
                    'div',
                    {
                      key: item.id,
                      style: Object.assign({}, S.listRow, item.id === model ? { background: 'rgba(59,130,246,0.14)' } : null),
                      title: `用 ${item.id}(这个模型的尺寸要填${item.note})`,
                      onClick: () => {
                        setModel(item.id);
                        setShowModels(false);
                      },
                    },
                    h('span', { style: Object.assign({}, S.grow, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, item.label),
                    h('span', { style: S.hint }, item.id === model ? '✓ 当前' : item.note),
                  ),
                ),
              ),
              MODEL_CHOICES.some((item) => item.id === model)
                ? null
                : h('div', { style: S.hint }, `当前是手填的「${model}」,不在清单里 —— 照样能用,插件会原样发给上游`),
            )
          : null;

      }

      return { renderModelPanel };
    });

    // ── 零件 24-size-panel.js ────────────────────────────────────────────────────────
/* 尺寸菜单:点「尺寸」右边的 `▾` 弹出,按比例分组列全档位 + 常用成品尺寸快捷值。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`SOURCE_SIZE`/`SOURCE_TEXT`/`sizeMenuGroups`/`COMMON_OUTPUT_SIZES`/`convertSizeForModel` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('size-panel', () => {
      /**
       * 尺寸菜单(点「尺寸」右边的 ▾ 弹出)。
       *
       * 为什么也要自绘:原生 `<datalist>` 会拿输入框里已有的字过滤候选 —— 框里写着
       * 「原图比例」时下拉就只剩这一条,别的档位根本看不到(用户反馈"尺寸被固定了、
       * 没法指定")。这里按比例分组列全,并在顶部给「原图比例」「auto」和成品尺寸输入。
       */
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderSizePanel(p) {
        const {
          showSizes,
          setShowSizes,
          model,
          ratio,
          setRatio,
          setSizeDraft,
          setCustomSize,
          setNotice,
          dpi,
        } = p;
        return showSizes
          ? h(
              'div',
              {
                style: Object.assign({}, S.card, S.col, {
                  position: 'absolute',
                  right: 0,
                  bottom: 36,
                  width: 322,
                  maxWidth: '100%',
                  maxHeight: 'calc(100% - 44px)',
                  gap: 4,
                  zIndex: 8,
                }),
              },
              h(
                'div',
                { style: S.row },
                h('strong', { style: { fontSize: 12 } }, `尺寸(${model})`),
                h('span', { style: S.grow }),
                h('button', { style: S.tiny, onClick: () => setShowSizes(false) }, '✕'),
              ),
              h(
                'div',
                { style: S.list },
                h(
                  'div',
                  { style: S.listRow, onClick: () => { setRatio(SOURCE_SIZE); setSizeDraft(SOURCE_TEXT); setCustomSize(''); setShowSizes(false); } },
                  h('span', { style: S.grow }, '原图比例(跟随提交的那张图)'),
                  h('span', { style: S.hint }, ratio === SOURCE_SIZE ? '✓ 当前' : '默认'),
                ),
                h(
                  'div',
                  { style: S.listRow, onClick: () => { setRatio('auto'); setSizeDraft('auto'); setCustomSize(''); setShowSizes(false); } },
                  h('span', { style: S.grow }, 'auto(让上游自己定)'),
                  h('span', { style: S.hint }, ratio === 'auto' ? '✓ 当前' : ''),
                ),
                sizeMenuGroups(model).map((group) =>
                  h(
                    'div',
                    { key: `g-${group.title}` },
                    h('div', { style: Object.assign({}, S.hint, { padding: '4px 8px 0' }) }, group.title),
                    group.items.map((item) =>
                      h(
                        'div',
                        {
                          key: item.value,
                          style: Object.assign({}, S.listRow, item.value === ratio ? { background: 'rgba(59,130,246,0.14)' } : null),
                          onClick: () => {
                            setRatio(item.value);
                            setSizeDraft(item.value);
                            setCustomSize('');
                            setShowSizes(false);
                          },
                        },
                        h('span', { style: S.grow }, item.label),
                        h('span', { style: S.hint }, item.value === ratio ? '✓ 当前' : ''),
                      ),
                    ),
                  ),
                ),
              ),
              h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
              h('div', { style: S.hint }, '常用成品尺寸(点一下就填进「尺寸」框;上游按最近档位渲染,导出按这个尺寸本地缩放)'),
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                COMMON_OUTPUT_SIZES.map((preset) =>
                  h(
                    'button',
                    {
                      key: preset.value,
                      style: S.tiny,
                      title: `${preset.label} —— ${preset.note}`,
                      onClick: () => {
                        // 值可能是像素(1080x1440),也可能是实物尺寸(210x297mm)。
                        // 统一换算一次:存进 customSize 的一定是**像素** —— 下游(挑上游档位、本地精确缩放)不用改。
                        const conv = convertSizeForModel(model, preset.value, dpi);
                        if (conv && conv.mode === 'pixel') {
                          setCustomSize(conv.exact);
                          setNotice(conv.hint);
                        } else {
                          setCustomSize('');
                        }
                        setSizeDraft(preset.value);
                        setShowSizes(false);
                      },
                    },
                    preset.label,
                  ),
                ),
              ),
              h('div', { style: S.hint }, '也可以直接关掉菜单,在「尺寸」框里手写:1080x1440 / 3:4 / 竖版 / 小红书 / A4 — 插件会换算成上游认识的值'),
            )
          : null;

      }

      return { renderSizePanel };
    });

    // ── 零件 25-gen-card.js ──────────────────────────────────────────────────────────
/* 右下角「生成/发送」区块(画布的主操作区):错误/进度、主图与参考图摘要、场景框、提示词输入框、模型与尺寸、提交前自检、提交按钮、模型/尺寸菜单。选中图片的信息与操作、对齐分布、文字图层在属性区(35-props-card);保存/清空画布在设置面板(27)。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`IMAGE_SIZES`/`SOURCE_SIZE`/`SOURCE_TEXT`/`SIZE_TIPS`/`STALE_HOST_HINT` 与尺寸纯函数(`convertSizeForModel`/`sizeWarning`/`parsePixelSize`/`nearestSize`/`sizeFormatOf`/`sizeAspect`/`isValidSize`/`normalizeSize`)直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('gen-card', () => {
      /**
       * 「跨平台」能勾的常用平台尺寸:取 `COMMON_OUTPUT_SIZES` 里标了 `batch` 的那几项
       * (标记在 03 的尺寸表上,这里不再重抄一遍像素值)。
       */
      const BATCH_CHOICES = COMMON_OUTPUT_SIZES.filter((item) => item.batch);
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderGenCard(p) {
        const {
          activeSkill,
          apikey,
          appendHint,
          applyFrameSize,
          applyPreflightFixes,
          applySizeDraft,
          applySkill,
          batchSizes,
          busy,
          cancelGenerate,
          cropToMark,
          customSize,
          docRef,
          dpi,
          error,
          finishChange,
          frameSizeDraft,
          hostStale,
          imageSize,
          images,
          jobsRef,
          lastUpstream,
          model,
          modelPanel,
          phase,
          preflight,
          preflightFixes,
          preflightSkill,
          progress,
          prompt,
          promptRef,
          ratio,
          refCount,
          removeFrame,
          run,
          selected,
          selectedFrameId,
          selectedFrame,
          selectedMarks,
          setAppendHint,
          setBatchSizes,
          setCropToMark,
          setFrameSizeDraft,
          setImageSize,
          setModel,
          setPrompt,
          setRatio,
          setShowGen,
          setShowSettings,
          setSizeDraft,
          showGen,
          showModels,
          showSizes,
          sizeDraft,
          sizePanel,
          sourceAspect,
          sourceImage,
          sourceResolved,
          submitPreview,
          togglePanel,
        } = p;
        return h(
          'div',
          { style: S.gen },
          error ? h('div', { style: Object.assign({}, S.card, { padding: '4px 7px', flexShrink: 0, maxHeight: 80, overflowY: 'auto' }) }, h('div', { style: S.err }, error)) : null,
          busy
            ? (() => {
                // 任务本体在 jobsRef 里(不占 state):这里只把它读出来显示。
                // 每张的进度、状态都在它自己的行上,所以在排队/同时在跑几张一眼能看清。
                const jobs = jobsRef && Array.isArray(jobsRef.current) ? jobsRef.current : [];
                const running = jobs.filter((job) => job.state !== 'queued').length;
                return h(
                  'div',
                  { style: Object.assign({}, S.card, S.col, { padding: '5px 7px', gap: 4, flexShrink: 0, maxHeight: 120, overflowY: 'auto' }) },
                  h(
                    'div',
                    { style: S.hint },
                    jobs.length
                      ? `正在生成 ${running}/${jobs.length} 张 —— 想停哪张,就点画布上那个框里的「⏹ 打断」`
                      : phase || '处理中…',
                  ),
                  jobs.slice(0, 4).map((job) =>
                    h(
                      'div',
                      { key: job.id, style: S.row },
                      h('span', { style: S.hint }, `${job.queueLabel ? `${job.queueLabel} · ` : ''}${job.label || ''}`),
                      h('span', { style: S.grow }),
                      h(
                        'span',
                        { style: S.hint },
                        job.state === 'queued' ? '排队中' : job.pct > 0 ? `${job.pct}%` : job.phase || '生成中…',
                      ),
                    ),
                  ),
                  jobs.length > 4 ? h('div', { style: S.hint }, `…还有 ${jobs.length - 4} 张在等`) : null,
                  // 续查时没有 jobsRef 条目(老任务走的是另一条路径),那就还显示总进度条
                  !jobs.length
                    ? h('div', { style: S.bar }, h('div', { style: Object.assign({}, S.barInner, { width: `${progress || 8}%` }) }))
                    : null,
                  lastUpstream
                    ? h(
                        'details',
                        { style: Object.assign({}, S.hint, { opacity: 0.72, minWidth: 0 }) },
                        h('summary', { style: { cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '上游最近返回(点开看原文)'),
                        h('div', { style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' } }, lastUpstream),
                      )
                    : null,
                );
              })()
            : null,
          showGen
            ? h(
            'div',
            { style: Object.assign({}, S.card, S.col, { minHeight: 0, overflowY: 'auto', flex: '0 1 auto' }) },
            hostStale
              ? h(
                  'div',
                  { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                  `⚠ ${STALE_HOST_HINT}`,
                )
              : null,
            !apikey
              ? h(
                  'div',
                  { style: Object.assign({}, S.row, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                  h('span', { style: S.hint }, '⚠ 还没填 APIKEY'),
                  h('button', { style: S.tiny, onClick: () => setShowSettings(true) }, '点这里填 →'),
                )
              : null,
            // 选中图片的信息与操作(参考/复制/存/下载/分层/删除)已迁到属性区(35-props-card)
            (() => {
              const frames = docRef.current.frames || [];
              if (!frames.length) return null;
              // 明确删「显示中的这个框」:优先选中框;没选中时显示最后一框并写明,免得多框时删错
              const shownFrame = frames.find((f) => f.id === selectedFrameId) || frames[frames.length - 1];
              const shownIsPicked = Boolean(selectedFrameId) && shownFrame.id === selectedFrameId;
              return h(
                'div',
                { style: S.row },
                h(
                  'span',
                  { style: S.badge, title: '场景框(生成框):模型会在框内生成新图,框的比例就是生成图片的比例' },
                  `场景框 ${Math.round(shownFrame.w)}×${Math.round(shownFrame.h)} (${(shownFrame.w / shownFrame.h).toFixed(2)})${shownIsPicked ? '' : '(最后一个)'}`,
                ),
                h('input', {
                  id: 'grsai-gen-frame-size',
                  style: Object.assign({}, S.input, S.grow),
                  placeholder: '改尺寸/比例:800x600 / 210x297mm / 3:4',
                  value: frameSizeDraft,
                  title: '输入像素 800x600、实物 210x297mm 或比例 3:4,失焦生效',
                  onChange: (e) => setFrameSizeDraft(e.target.value),
                  onBlur: applyFrameSize,
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.target.blur();
                    }
                  },
                }),
                h('button', {
                  style: S.tiny,
                  title: shownIsPicked ? '删除选中的这个场景框' : '当前没选中框:将删除显示中的(最后一个)场景框',
                  onClick: () => removeFrame(shownFrame.id),
                }, '删框'),
              );
            })(),
            // 本次输入:主图 + 参考图(一起发给模型);隐藏的参考图不参与提交,下面会提示有几张被排除
            (() => {
              const refs = images.filter((im) => im.isRef && !im.hidden && im.id !== (selected && selected.id));
              const hiddenRefs = images.filter((im) => im.isRef && im.hidden && im.id !== (selected && selected.id)).length;
              if (!selected && !refs.length) return null;
              // 名字统一兜底:存档被外部改过/旧版本缺 name 时,直接取 .length 会让整块生成卡抛错白屏
              const mainName = selected ? String(selected.name || '图片') : '';
              return h(
                'div',
                { style: S.col },
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, '主图'),
                  selected
                    ? h('span', { style: S.badge, title: `主图(被改的图):${mainName}` }, `${mainName.length > 12 ? `${mainName.slice(0, 10)}…` : mainName} ${selected.naturalW || selected.w}×${selected.naturalH || selected.h}`)
                    : h('span', { style: S.hint }, '未选(文生图)'),
                  h('span', { style: S.grow }),
                  refs.length ? h('span', { style: S.hint }, `参考 ${refs.length} 张`) : h('span', { style: S.hint }, '无参考图'),
                  hiddenRefs
                    ? h('span', { style: S.hint, title: '隐藏的图不参与生成;在图层面板点「显」可以恢复' }, `另有 ${hiddenRefs} 张隐藏参考图不参与`)
                    : null,
                  h('button', { style: S.tiny, title: '收起面板(把画布让出来)', onClick: () => setShowGen(false) }, '▾'),
                ),
                refs.length
                  ? h(
                      'div',
                      { style: S.row },
                      refs.map((im, idx) => {
                        const refName = String(im.name || '图片');
                        // 编号跟画布角标、提交顺序三处一致(主图不占参考编号,参考从 1 起):
                        // 用户在提示词里写「参考图2」,指的就是这一颗。
                        return h(
                          'button',
                          {
                            key: im.id,
                            style: S.tiny,
                            title: `参考图${idx + 1}「${refName}」:提示词里写「参考图${idx + 1}」就能指到它,提交时会自动补上编号说明(第 1 张是主图,后面依次是参考图);点一下取消参考`,
                            onClick: () => {
                              im.isRef = false;
                              finishChange(true);
                            },
                          },
                          `参考图${idx + 1}:${refName.length > 8 ? `${refName.slice(0, 6)}…` : refName} ✕`,
                        );
                      }),
                    )
                  : null,
              );
            })(),
            h('textarea', {
              id: 'grsai-prompt',
              ref: promptRef,
              style: S.textarea,
              placeholder: selected
                ? selectedMarks.length
                  ? '写一句「要改成什么」(强烈建议):例如「箭头指着的招牌改成深夜食堂」。只画箭头,模型容易猜错。'
                  : '想怎么改这张图?例如:把招牌换成「深夜食堂」'
                : '选中一张图来改;也可以只写提示词直接生成新图',
              value: prompt,
              onChange: (event) => setPrompt(event.target.value),
            }),
            h(
              'div',
              { style: S.row },
              h('span', { style: S.hint }, '模型'),
              h('input', {
                id: 'grsai-model-input',
                style: Object.assign({}, S.input, { maxWidth: 150 }),
                value: model,
                title: '可以直接输入任意模型名;点右边 ▾ 从菜单里挑',
                onChange: (e) => setModel(e.target.value),
              }),
              h(
                'button',
                {
                  style: Object.assign({}, S.caret, showModels ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null),
                  title: '列出全部模型(含上游尺寸表里的型号)',
                  'aria-label': '打开模型列表',
                  onClick: () => togglePanel('models'),
                },
                '▾',
              ),
              h('span', { style: S.hint }, '尺寸'),
              h('input', {
                id: 'grsai-size-draft',
                style: Object.assign({}, S.input, { maxWidth: 132 }),
                // 框里显示你写的原话(1080x1440 / 3:4 / 竖版 / 小红书…),失焦时换算给上游
                value: sizeDraft,
                placeholder: `${SOURCE_TEXT} / 210x297mm / 1080x1440 / 3:4 / 竖版 / 小红书`,
                title: `${SIZE_TIPS[sizeFormatOf(model)]}\n可以直接写:\n· 实物尺寸(带单位)210x297mm / 21x29.7cm / 8.5x11in —— 按 ${dpi} DPI 换算成像素\n· 像素 1080x1440(不写单位就是像素)\n· 比例 3:4、方向 竖版/横屏/方图、常用名 小红书/A4/头像…\n失焦(或按回车)时插件会换算成上游认识的值;点右边 ▾ 也能挑`,
                onChange: (e) => setSizeDraft(e.target.value),
                onBlur: () => {
                  if (!applySizeDraft()) {
                    // 认不出来的写法:沿用老规矩,能当尺寸用就地规范化,否则留着让黄字提示
                    const cur = String(sizeDraft).trim();
                    if (cur === SOURCE_TEXT) setRatio(SOURCE_SIZE);
                    else if (sizeAspect(cur) !== null && !isValidSize(model, cur)) setRatio(normalizeSize(model, cur));
                  }
                },
                onKeyDown: (e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.target.blur();
                  }
                },
              }),
              h(
                'button',
                {
                  style: Object.assign({}, S.caret, showSizes ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null),
                  title: '列出这个模型支持的全部尺寸 / 指定成品尺寸',
                  'aria-label': '打开尺寸列表',
                  onClick: () => togglePanel('sizes'),
                },
                '▾',
              ),
              model.indexOf('nano-banana') === 0
                ? h(
                    'select',
                    { id: 'grsai-image-size-select', style: Object.assign({}, S.input, { maxWidth: 70 }), value: imageSize, onChange: (e) => setImageSize(e.target.value) },
                    IMAGE_SIZES.map((sn) => h('option', { key: sn, value: sn }, sn)),
                  )
                : null,
            ),
            // 输入框里写的原话会被换算给上游 —— 这里把"会发什么/导出多少"当场说清楚(含 mm→像素)
            (() => {
              const conv = convertSizeForModel(model, sizeDraft, dpi);
              if (conv) return h('div', { style: S.hint }, conv.hint);
              const warn = sizeWarning(model, sizeDraft);
              return warn ? h('div', { style: S.warn }, `⚠ ${warn}`) : null;
            })(),
            // 指定了成品尺寸就把「提交按什么渲染 / 最后缩放到多少」写清楚,免得人猜
            parsePixelSize(customSize)
              ? h(
                  'div',
                  { style: S.hint },
                  `成品尺寸 ${customSize}:提交按「${nearestSize(model, parsePixelSize(customSize)[0] / parsePixelSize(customSize)[1])}」渲染` +
                    `(上游只认它那张尺寸表),回来后本地精确缩放到 ${parsePixelSize(customSize)[0]}×${parsePixelSize(customSize)[1]}`,
                )
              : null,
            ratio === SOURCE_SIZE || selectedFrame
              ? h(
                  'div',
                  { style: S.hint },
                  selectedFrame
                    ? `场景框比例:${Math.round(selectedFrame.w)}×${Math.round(selectedFrame.h)} → 这次发 ${sourceResolved}`
                    : sourceAspect > 0 && sourceImage
                    ? `原图比例:按「${sourceImage.name || '这张图'}」${sourceImage.naturalW}×${sourceImage.naturalH} → 这次发 ${sourceResolved}` +
                      `${submitPreview && submitPreview.cropped ? `(裁剪后 ${submitPreview.width}×${submitPreview.height})` : ''}`
                    : `原图比例:没有输入图片 → 这次发 ${sourceResolved}`,
                )
              : null,
            // 仅在「模板的比例真的换算到了当前尺寸上」时提示,免得存档恢复出模板时说了不实的话
            activeSkill && activeSkill.ratio && sizeFormatOf(model) === 'pixel' && ratio === nearestSize(model, activeSkill.ratio)
              ? h('div', { style: S.hint }, `模板「${activeSkill.name}」写的比例 ${activeSkill.ratio} 已按 ${model} 换算成 ${nearestSize(model, activeSkill.ratio)}(这个模型只收像素值)`)
              : null,
            selectedMarks.some((mk) => mk.kind === 'mask')
              ? h(
                  'div',
                  { style: S.hint },
                  `蓝色蒙版 ${selectedMarks.filter((mk) => mk.kind === 'mask').length} 处:只改涂到的地方,其余压暗后一起发给模型(所以这一张按整图提交,不裁剪)`,
                )
              : null,
            selectedMarks.length
              ? h(
                  'div',
                  { style: S.row },
                  h(
                    'label',
                    { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }) },
                    h('input', {
                      id: 'grsai-crop-to-mark',
                      type: 'checkbox',
                      checked: cropToMark,
                      disabled: selectedMarks.some((mk) => mk.kind === 'mask'),
                      onChange: (e) => setCropToMark(e.target.checked),
                    }),
                    selectedMarks.some((mk) => mk.kind === 'mask') ? '只提交标注范围(裁剪,有蒙版时自动跳过)' : '只提交标注范围(裁剪)',
                  ),
                  h(
                    'label',
                    { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }) },
                    h('input', { id: 'grsai-append-hint', type: 'checkbox', checked: appendHint, onChange: (e) => setAppendHint(e.target.checked) }),
                    '附加「按标注改」说明',
                  ),
                )
              : null,
            preflight.issues.length
              ? h(
                  'div',
                  { style: Object.assign({}, S.col, { display: 'flex', gap: 3, padding: '6px 0', borderTop: `1px solid ${line}` }) },
                  h(
                    'div',
                    { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                    `⚠ 提交前建议(${preflight.issues.length}) —— 点一下补上,省得又忘写`,
                  ),
                  preflight.issues.map((item) => h('div', { key: item.id, style: S.hint }, `· ${item.text}`)),
                  preflightFixes.length || preflightSkill
                    ? h(
                        'div',
                        { style: S.row },
                        preflightFixes.length
                          ? h('button', { style: S.tiny, title: '把这些要求追加到提示词末尾', onClick: applyPreflightFixes }, `补上这 ${preflightFixes.length} 条`)
                          : null,
                        preflightSkill
                          ? h(
                              'button',
                              { style: S.tiny, title: '套用「留白配图」:让模型只出干净底图,字由本机字体本地加', onClick: () => applySkill(preflightSkill.action.slice(6), true) },
                              '套用「留白配图」',
                            )
                          : null,
                        h('span', { style: S.grow }),
                      )
                    : null,
                )
              : null,
            h(
              'div',
              { style: Object.assign({}, S.col, { gap: 3 }) },
              h(
                'div',
                { style: S.row },
                h('span', { style: S.hint }, '跨平台一次出图'),
                h('span', { style: S.grow }),
                batchSizes.length
                  ? h('button', { style: S.tiny, title: '取消全部勾选,回到只出当前尺寸这一张(不会清空画布)', onClick: () => setBatchSizes([]) }, '取消勾选')
                  : null,
              ),
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                BATCH_CHOICES.map((item) =>
                  h(
                    'label',
                    {
                      key: item.value,
                      style: Object.assign({}, S.tiny, { display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer' }),
                      title: `${item.note} · 成图尺寸 ${item.value}`,
                    },
                    h('input', {
                      id: 'grsai-batch-' + item.value,
                      type: 'checkbox',
                      checked: batchSizes.includes(item.value),
                      onChange: (e) => {
                        const value = item.value;
                        setBatchSizes((cur) =>
                          e.target.checked ? [...cur.filter((v) => v !== value), value] : cur.filter((v) => v !== value),
                        );
                      },
                    }),
                    item.label,
                  ),
                ),
              ),
              h(
                'div',
                { style: S.hint },
                batchSizes.length
                  ? `会按勾的 ${batchSizes.length} 个尺寸各出一张(最多同时跑 2 张,其余的排队),结果排在原图旁边往下顺,不重叠。`
                  : '勾一个以上:同一句提示词按每个平台尺寸各出一张成图。不勾就还是只出当前这一张。',
              ),
            ),
            h(
              'div',
              { style: S.row },
              h(
                'button',
                {
                  style: S.primary,
                  title: '提交一次生成。生成中也能继续点:不会等前一张跑完;想停某一张就点画布上那个框里的「⏹ 打断」',
                  onClick: run,
                },
                batchSizes.length ? `跨平台出图(${batchSizes.length} 张)` : selected ? '按标注改图' : '生成新图',
              ),
              h(
                'span',
                { style: S.hint },
                submitPreview
                  ? `提交 ${submitPreview.width}×${submitPreview.height}${submitPreview.scale < 1 ? `(缩小)` : ''}${refCount ? ` +${refCount} 参考` : ''}`
                  : refCount
                    ? `带 ${refCount} 张参考图`
                    : '',
              ),
              activeSkill ? h('button', { style: S.tiny, title: '取消这个模板', onClick: () => applySkill(activeSkill.id) }, `模板:${activeSkill.name} ✕`) : null,
              // 保存画布/清空画布挪到了「设置」面板(低频维护,破坏性操作远离主按钮)
            ),
          )
            : h(
                'div',
                { style: Object.assign({}, S.card, S.row, { padding: 4 }) },
                h('button', { style: S.tiny, title: '展开生成面板', onClick: () => setShowGen(true) }, '▸ 生成'),
                selected ? h('span', { style: S.badge, title: selected.name }, selected.name.length > 10 ? `${selected.name.slice(0, 8)}…` : selected.name) : null,
                h('span', { style: S.grow }),
                h(
                  'button',
                  {
                    style: S.primary,
                    title: '提交一次生成。生成中也能继续点:不会等前一张跑完;想停某一张就点画布上那个框里的「⏹ 打断」',
                    onClick: run,
                  },
                  batchSizes.length ? `跨平台出图(${batchSizes.length} 张)` : selected ? '按标注改图' : '生成新图',
                ),
              ),
          modelPanel,
          sizePanel,
        );
      }

      return { renderGenCard };
    });

    // ── 零件 26-skills-panel.js ──────────────────────────────────────────────────────
/* Skills 模板内容块:内置模板按分组摆成几栏 + 自定义模板的增删。连同它用的两个局部辅助(`skillChip` 一颗模板按钮、`builtinSkillGroups` 分组)一起收进来。
 *
 * 0.21 起本零件只出内容块(不带浮层外壳),装进右侧停靠区(36-dock)的「Skills」标签;
 * 开合由 `dockOpen` 控制,这里不再判断。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`BUILTIN_SKILLS`/`SKILL_GROUPS` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('skills-panel', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderSkillsPanel(p) {
        const {
          activeSkill,
          activeSkillId,
          addSkill,
          agentBusy,
          applySkill,
          askAgentPrompt,
          featuresRef,
          hostFeatures,
          runAgentLayering,
          saveSkills,
          setActiveSkillId,
          setSkillDraft,
          skillDraft,
          skills,
        } = p;

        /** Skills 模板的一颗按钮(选中的高亮;自定义的带删除)。 */
        const skillChip = (preset, custom) =>
          h(
            'span',
            { key: preset.id, style: { display: 'inline-flex', alignItems: 'center', gap: 1 } },
            h(
              'button',
              {
                style: Object.assign(
                  {},
                  S.wideBtn,
                  { textAlign: 'left' },
                  activeSkillId === preset.id ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null,
                ),
                title: preset.desc || String(preset.prompt).slice(0, 60),
                onClick: () => applySkill(preset.id),
              },
              `${activeSkillId === preset.id ? '✓ ' : ''}${preset.name}`,
            ),
            custom
              ? h(
                  'button',
                  {
                    style: S.tiny,
                    title: '删除这个自定义模板',
                    onClick: async () => {
                      if (await saveSkills(skills.filter((item) => item.id !== preset.id))) {
                        if (activeSkillId === preset.id) setActiveSkillId('');
                      }
                    },
                  },
                  '✕',
                )
              : null,
          );

        /** 按分组把内置模板摆成几栏(漏分组的自动归到「其他」,不会掉出面板)。 */
        const builtinSkillGroups = (() => {
          const groupedIds = SKILL_GROUPS.reduce((acc, g) => acc.concat(g.ids), []);
          const ungrouped = BUILTIN_SKILLS.filter((preset) => !groupedIds.includes(preset.id));
          const groups = ungrouped.length
            ? SKILL_GROUPS.concat([{ label: '其他', ids: ungrouped.map((s) => s.id) }])
            : SKILL_GROUPS;
          return groups
            .map((group) => ({ label: group.label, items: BUILTIN_SKILLS.filter((preset) => group.ids.includes(preset.id)) }))
            .filter((group) => group.items.length);
        })();

        /** Skills 模板内容块:选一个套路,或自己加一个。 */
        return h(
              'div',
              { style: Object.assign({}, S.col, { gap: 6 }) },
              h(
                  'div',
                  { style: Object.assign({}, S.col, { gap: 4 }) },
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.wideBtn, {
                        textAlign: 'left',
                        fontWeight: 600,
                        opacity: agentBusy ? 0.6 : 1,
                        cursor: agentBusy ? 'default' : 'pointer',
                      }),
                      disabled: agentBusy === true,
                      title: AGENT_LAYERING.desc,
                      onClick: () => {
                        if (!agentBusy) runAgentLayering();
                      },
                    },
                    agentBusy ? '⏳ 正在交给 Agent…' : `▶ ${AGENT_LAYERING.name}`,
                  ),
                  h(
                    'div',
                    { style: S.hint },
                    '上面这批是图像模型模板;这条走 DSH agent:把选中的图(没选就用最后导入/生成的那张)落盘后交给对话,由 image-layering 技能拆成可编辑图层,先出 PSD,不跑矢量。',
                  ),
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.wideBtn, {
                        textAlign: 'left',
                        fontWeight: 600,
                        opacity: agentBusy ? 0.6 : 1,
                        cursor: agentBusy ? 'default' : 'pointer',
                      }),
                      disabled: agentBusy === true,
                      title: '把选中的图连同你写的草稿交给对话里的 agent,让它回一条能直接用的提示词',
                      onClick: () => {
                        if (!agentBusy) askAgentPrompt();
                      },
                    },
                    agentBusy ? '⏳ 正在交给 Agent…' : '✎ 帮我写提示词',
                  ),
                  h(
                    'div',
                    { style: S.hint },
                    '不用自己憋词:把你想到的几句草稿丢进去,agent 看着图帮你写成完整提示词 —— 只走对话,不发出图任务、不花额度。',
                  ),
                  h('div', { style: { height: 1, background: line, margin: '4px 0' } }),
                ),
                h('div', { style: S.hint }, '选一个套路就按它改,不选就是普通改图(再点一次取消)。模板文字会排在你写的要求前面一起发出去。'),
                hostFeatures !== null && !featuresRef.current.includes('skills')
                  ? h(
                      'div',
                      { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                      '⚠ 宿主半边是旧版:内置模板现在就能用,但「自定义模板」(读取/保存)要**重启一次 DSH** 才生效。',
                    )
                  : null,
                h(
                  'div',
                  { style: S.col },
                  builtinSkillGroups.map((group) =>
                    h(
                      'div',
                      { key: group.label, style: S.col },
                      h('div', { style: Object.assign({}, S.hint, { fontWeight: 600, marginTop: 2 }) }, group.label),
                      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, group.items.map((preset) => skillChip(preset, false))),
                    ),
                  ),
                ),
                h('div', { style: S.hint }, skills.length ? `自定义(${skills.length})` : '还没有自定义模板'),
                skills.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, skills.map((preset) => skillChip(preset, true))) : null,
                activeSkill
                  ? h(
                      'div',
                      { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-label-primary, #3b82f6)' }) },
                      `当前:${activeSkill.name} —— ${activeSkill.desc || String(activeSkill.prompt).slice(0, 60)}`,
                    )
                  : null,
                hostFeatures === null || featuresRef.current.includes('skills')
                  ? h(
                      'div',
                      null,
                      h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
                      h('div', { style: S.hint }, '＋ 自己加一个(存在工作区里,换台机器 / 换个人也跟着走)'),
                      h('input', {
                        id: 'grsai-skill-name',
                        style: Object.assign({}, S.input, { width: '100%' }),
                        placeholder: '名称,例如「证件照」',
                        value: skillDraft.name,
                        onChange: (e) => setSkillDraft(Object.assign({}, skillDraft, { name: e.target.value })),
                      }),
                      h('textarea', {
                        id: 'grsai-skill-prompt',
                        style: Object.assign({}, S.textarea, { height: 68 }),
                        placeholder: '这个模板要实现什么?例如:把照片做成白底证件照,正面免冠、头肩比例规范…',
                        value: skillDraft.prompt,
                        onChange: (e) => setSkillDraft(Object.assign({}, skillDraft, { prompt: e.target.value })),
                      }),
                      h(
                        'div',
                        { style: S.row },
                        h('button', { style: S.wideBtn, onClick: addSkill }, '保存为模板'),
                        h('span', { style: S.grow }),
                        h('span', { style: S.hint }, '存到 <工作区>/画布/skills.json'),
                      ),
                    )
                  : null,
            );
      }

      return { renderSkillsPanel };
    });

    // ── 零件 27-settings-panel.js ────────────────────────────────────────────────────
/* 右上角「设置」面板:① APIKEY 与接口地址 ② 质量/背景/DPI/提示词同步 ③ 插件更新(检查/更新/回滚)④ 画布维护(保存/清空,破坏性操作放这里离生成主按钮远一点)+ 快捷键提示。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`LS_KEY`/`QUALITIES`/`BACKGROUNDS`/`MM_PER_INCH`/`DRAFT_REL`/`DEFAULT_API_BASE`/`DEFAULT_UPDATE_URL`/`writePrefs` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('settings-panel', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderSettingsPanel(p) {
        const {
          panelAnchor,
          apiBase,
          apikey,
          applyUpdateNow,
          background,
          baseDraft,
          canUpdate,
          checkUpdate,
          clearCanvas,
          dpi,
          dpiDraft,
          draftSync,
          hostFeatures,
          hostStale,
          keyDraft,
          quality,
          rollbackUpdateNow,
          saveNow,
          setApiBase,
          setApikey,
          setBackground,
          setBaseDraft,
          setDpiDraft,
          setDraftSync,
          setError,
          setKeyDraft,
          setNotice,
          setQuality,
          setUpdateAuto,
          setUpdateDraft,
          setUpdateNote,
          setUpdateUrl,
          showSettings,
          updateAuto,
          updateBusy,
          updateDraft,
          updateInfo,
          updateNote,
          updateStatus,
          updateUrl,
        } = p;
        /** 悬停开的贴在按钮正下方(按自己的宽度往回收);手点开的还是老位置靠右。 */
        const place = panelAnchor
          ? { left: Math.max(6, Math.min(panelAnchor.left, panelAnchor.maxRight - 300)), right: 'auto', top: panelAnchor.top }
          : { right: 6, top: 42 };
        return showSettings
          ? h(
              'div',
              {
                // 悬停联动用:鼠标落进这块面板就算「还没走」,收起倒计时作废
                'data-nav-keep': 'settings',
                style: Object.assign({}, S.float, place, { width: 300, maxWidth: 'calc(100% - 16px)' }),
              },
              h(
                'div',
                { style: Object.assign({}, S.card, S.col, { gap: 6 }) },
                h('div', { style: S.row }, h('strong', { style: { fontSize: 12 } }, '① GrsAI APIKEY'), h('span', { style: S.grow }), h('span', { style: S.hint }, apikey ? '已填写' : '还没填')),
                h(
                  'div',
                  { style: S.row },
                  h('input', {
                    id: 'grsai-apikey',
                    style: Object.assign({}, S.input, S.grow),
                    type: 'password',
                    placeholder: '粘贴 grsai.com 的 APIKEY',
                    value: keyDraft,
                    onChange: (e) => setKeyDraft(e.target.value),
                  }),
                  apikey
                    ? h(
                        'button',
                        {
                          style: S.tiny,
                          onClick: () => {
                            try {
                              localStorage.removeItem(LS_KEY);
                            } catch {
                              /* 忽略 */
                            }
                            setApikey('');
                            setKeyDraft('');
                          },
                        },
                        '清除',
                      )
                    : null,
                ),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, '② 接口地址'),
                  h('span', { style: S.grow }),
                  apiBase !== DEFAULT_API_BASE ? h('button', { style: S.tiny, title: `恢复默认 ${DEFAULT_API_BASE}`, onClick: () => { setApiBase(DEFAULT_API_BASE); setBaseDraft(DEFAULT_API_BASE); } }, '恢复默认') : null,
                ),
                h('input', {
                  id: 'grsai-api-base',
                  style: Object.assign({}, S.input, { width: '100%' }),
                  placeholder: DEFAULT_API_BASE,
                  value: baseDraft,
                  onChange: (e) => setBaseDraft(e.target.value),
                }),
                h('div', { style: S.hint }, `只填到域名(或带路径前缀)即可,插件会自己拼 /v1/api/generate 和 /v1/api/result。当前生效:${apiBase}`),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: S.wideBtn,
                      onClick: () => {
                        const nextKey = keyDraft.trim();
                        try {
                          if (nextKey) localStorage.setItem(LS_KEY, nextKey);
                          else localStorage.removeItem(LS_KEY);
                        } catch {
                          /* 忽略 */
                        }
                        let nextBase = baseDraft.trim() || DEFAULT_API_BASE;
                        if (!/^https?:\/\//i.test(nextBase)) nextBase = `https://${nextBase}`;
                        try {
                          nextBase = new URL(nextBase).origin + new URL(nextBase).pathname.replace(/\/+$/, '');
                        } catch {
                          setError(`接口地址不是合法 URL:${baseDraft.trim()}`);
                          return;
                        }
                        setApikey(nextKey);
                        setApiBase(nextBase);
                        setBaseDraft(nextBase);
                        setError('');
                        setNotice(`已保存:KEY ${nextKey ? '已填' : '为空'},接口 ${nextBase}`);
                      },
                    },
                    '保存设置',
                  ),
                  h('span', { style: S.grow }),
                  h('span', { style: S.hint }, 'KEY 与地址都只存本机浏览器'),
                ),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, '质量'),
                  h(
                    'select',
                    { id: 'grsai-quality-select', style: Object.assign({}, S.input, { maxWidth: 90 }), value: quality, onChange: (e) => setQuality(e.target.value) },
                    QUALITIES.map((q) => h('option', { key: q.id, value: q.id }, q.label)),
                  ),
                  h('span', { style: S.hint }, '背景'),
                  h(
                    'select',
                    { id: 'grsai-background-select', style: Object.assign({}, S.input, { maxWidth: 90 }), value: background, onChange: (e) => setBackground(e.target.value) },
                    BACKGROUNDS.map((b) => h('option', { key: b.id, value: b.id }, b.label)),
                  ),
                ),
                h('div', { style: S.hint }, '质量/背景只对 gpt-image 系有意义;分辨率只对 nano-banana 系有意义。'),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, 'DPI'),
                  h('input', {
                    id: 'grsai-dpi',
                    style: Object.assign({}, S.input, { maxWidth: 72 }),
                    type: 'number',
                    min: 36,
                    max: 2400,
                    step: 1,
                    value: dpiDraft,
                    title: '毫米 / 厘米 / 英寸 尺寸换算成像素的基准(印刷常用 300)',
                    onChange: (e) => setDpiDraft(e.target.value),
                    onBlur: () => setDpiDraft(String(dpi)),
                  }),
                  h(
                    'span',
                    { style: S.hint },
                    `「尺寸」框里写 210x297mm 时按这个换算 —— 现在 210x297mm → ${Math.round((210 * dpi) / MM_PER_INCH)}×${Math.round((297 * dpi) / MM_PER_INCH)} 像素`,
                  ),
                ),
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.hint }, '同时生成'),
                  h('input', {
                    id: 'grsai-max-jobs',
                    style: Object.assign({}, S.input, { maxWidth: 56 }),
                    type: 'number',
                    min: 1,
                    max: MAX_CONCURRENT_JOBS_MAX,
                    step: 1,
                    // 非受控:它只影响队列放行速度,不值得为它多一个 state(每次改都要重渲染整块)
                    defaultValue: String(concurrencyLimit()),
                    title: `同时在跑的任务数(1–${MAX_CONCURRENT_JOBS_MAX})。调大更容易撞上游限流,而且几个任务就是几次真实扣费。`,
                    onBlur: (e) => {
                      const next = clampConcurrency(e.target.value);
                      e.target.value = String(next);
                      writePrefs({ maxJobs: next });
                      setNotice(`同时生成数已设为 ${next} 张`);
                    },
                  }),
                  h('span', { style: S.hint }, `张同时跑(1–${MAX_CONCURRENT_JOBS_MAX});多出来的排队,能单独打断`),
                ),
                h(
                  'label',
                  { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }) },
                  h('input', {
                    id: 'grsai-draft-sync',
                    type: 'checkbox',
                    checked: draftSync,
                    onChange: (e) => {
                      setDraftSync(e.target.checked);
                      writePrefs({ draftSync: e.target.checked });
                    },
                  }),
                  '把提示词同步到工作区(让对话里的 AI 能帮你检查漏写的要求)',
                ),
                h(
                  'div',
                  { style: S.hint },
                  draftSync
                    ? `已同步到 <工作区>/${DRAFT_REL} —— 只写文字(提示词、文字图层、标注类型),不含图片`
                    : '已关闭:对话里的 AI 读不到你在写的提示词',
                ),
                // ── 插件自我更新 ────────────────────────────────────────
                h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
                h(
                  'div',
                  { style: S.row },
                  h('strong', { style: { fontSize: 12 } }, '③ 插件更新'),
                  h('span', { style: S.grow }),
                  updateStatus && updateStatus.disk && updateStatus.disk !== updateStatus.loaded
                    ? h('span', { style: S.warn }, `已装 ${updateStatus.disk},等着重启`)
                    : h('span', { style: S.hint }, `当前 ${updateStatus ? updateStatus.disk || updateStatus.loaded : (hostFeatures ? '—' : '探测中')}`),
                ),
                updateStatus === null
                  ? h(
                      'div',
                      { style: S.hint },
                      hostFeatures === null
                        ? '正在问宿主版本…'
                        : canUpdate()
                          ? '点「检查更新」查看本机版本与可回滚的备份'
                          : '⚠ 宿主半边是旧版:更新按钮要重启一次 DSH 才会出现',
                    )
                  : h(
                      'div',
                      null,
                      h('input', {
                        id: 'grsai-update-url',
                        style: Object.assign({}, S.input, { width: '100%' }),
                        placeholder: `留空 = 用默认地址(${DEFAULT_UPDATE_URL})`,
                        value: updateDraft,
                        onChange: (e) => setUpdateDraft(e.target.value),
                      }),
                      h(
                        'div',
                        { style: S.hint },
                        updateUrl.trim()
                          ? `当前用你填的地址:${updateUrl.trim()}`
                          : `当前用默认地址(装好就能自动检测):${DEFAULT_UPDATE_URL}`,
                      ),
                      h(
                        'label',
                        { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }) },
                        h('input', {
                          id: 'grsai-update-auto',
                          type: 'checkbox',
                          checked: updateAuto,
                          onChange: (e) => {
                            setUpdateAuto(e.target.checked);
                            writePrefs({ updateAuto: e.target.checked });
                          },
                        }),
                        '启动时自动检查(只检查版本,绝不会自动安装;取消勾选就完全不联网)',
                      ),
                      h(
                        'div',
                        { style: S.row },
                        h(
                          'button',
                          {
                            style: S.tiny,
                            disabled: updateBusy === 'check',
                            onClick: () => {
                              const next = updateDraft.trim();
                              setUpdateUrl(next);
                              writePrefs({ updateUrl: next });
                              // 返回 promise:调用方(以及测试)能等到检查真正结束
                              return checkUpdate(false);
                            },
                          },
                          updateBusy === 'check' ? '检查中…' : '检查更新',
                        ),
                        updateInfo && updateInfo.newer
                          ? h('button', { style: S.primary, disabled: Boolean(updateBusy), onClick: applyUpdateNow }, updateBusy === 'apply' ? '更新中…' : `立即更新到 ${updateInfo.version}`)
                          : h(
                              'button',
                              {
                                style: Object.assign({}, S.tiny, updateBusy ? { opacity: 0.6 } : null),
                                disabled: Boolean(updateBusy),
                                title: '从上次更新前自动备份的那份恢复',
                                onClick: rollbackUpdateNow,
                              },
                              updateBusy === 'rollback' ? '回滚中…' : '回滚上一版',
                            ),
                        h('span', { style: S.grow }),
                        updateUrl.trim() && updateUrl.trim() !== DEFAULT_UPDATE_URL
                          ? h(
                              'button',
                              {
                                style: S.tiny,
                                title: `改回默认地址 ${DEFAULT_UPDATE_URL}`,
                                onClick: () => {
                                  setUpdateUrl('');
                                  setUpdateDraft('');
                                  writePrefs({ updateUrl: '' });
                                  setUpdateNote('已改回默认更新源');
                                },
                              },
                              '恢复默认',
                            )
                          : null,
                        updateStatus && updateStatus.dir
                          ? h('span', { style: S.hint, title: updateStatus.dir }, '装在哪:…' + String(updateStatus.dir).slice(-22))
                          : null,
                      ),
                      updateInfo && updateInfo.newer
                        ? h(
                            'div',
                            { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-label-primary, #3b82f6)' }) },
                            `有新版 ${updateInfo.version}(当前 ${updateInfo.current})${updateInfo.notes ? ` —— ${updateInfo.notes}` : ''}`,
                          )
                        : null,
                      updateNote ? h('div', { style: /失败/.test(updateNote) ? S.err : S.ok }, updateNote) : null,
                      h(
                        'div',
                        { style: S.hint },
                        '更新只从上面那个地址下载、校验 sha256、只写插件自己的目录,并先把旧文件备份成 update-backup/。',
                      ),
                      updateStatus && updateStatus.backups && updateStatus.backups.length
                        ? h('div', { style: S.hint }, `可回滚的版本:${updateStatus.backups.map((b) => b.version || b.id).join('、')}`)
                        : null,
                      h(
                        'div',
                        { style: S.hint },
                        '更新后:刷新页面即用上新客户端;**重启 DSH** 宿主才会换(双击桌面 `重启DSH.cmd`)。',
                      ),
                    ),
                h('div', { style: S.hint }, '快捷键:V/B/A/R/O/T/E 切工具,空格拖动,滚轮缩放,Ctrl+Z 撤销,Ctrl+C 复制选中图,0 适应,1 原大。'),
                // ── 画布维护(低频 + 破坏性,放最底下) ─────────────────────
                h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.tiny, hostStale ? { opacity: 0.4, cursor: 'default' } : null),
                      title: hostStale ? '宿主是旧版:没有画布存档接口(/state),重启一次 DSH 后才能保存' : '立即保存画布',
                      onClick: () => {
                        if (!hostStale) saveNow(false);
                      },
                    },
                    '保存画布',
                  ),
                  h(
                    'button',
                    {
                      style: S.tiny,
                      title: '清空整个画布(删除所有图片、标注与场景框,可用 Ctrl+Z 撤回一次)',
                      onClick: () => {
                        if (window.confirm('清空整个画布?所有图片、标注与场景框都会被删掉(撤回只剩一次机会)。')) clearCanvas();
                      },
                    },
                    '清空画布',
                  ),
                  h('span', { style: S.grow }),
                  h('span', { style: S.hint }, '低频维护'),
                ),
              ),
            )
          : null;
      }

      return { renderSettingsPanel };
    });

    // ── 零件 28-history-panel.js ─────────────────────────────────────────────────────
/* 生成记录面板(第一期 A):持久化记录的浏览/筛选/收藏/删除/清空/恢复参数/放回画布/下载。
 *
 * 改造前这里只显示本次会话的结果(刷新即失);现在列表来自持久记录(存工作区,
 * 刷新/重开都在),搜索、收藏过滤、分页、完整提示词与参数快照都在这一屏。
 *
 * 缺字段显示「—」:旧记录(或资源没存上的记录)本来就缺这些信息,不编造。
 * 面板本体是停靠区(dock)的一个标签页内容,自己不带外壳。
 */
    definePart('history-panel', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns {any} 面板内容(虚拟 DOM)。
       */
      function renderHistoryPanel(p) {
        const {
          S,
          clearRecords,
          compareRecord,
          downloadRecordImage,
          historyCorrupted,
          historyFavOnly,
          historyHostReady,
          historyLimit,
          historyOpenId,
          historyQuery,
          placeRecordImage,
          records,
          removeRecord,
          restoreRecordParams,
          sessionId,
          setHistoryFavOnly,
          setHistoryLimit,
          setHistoryOpenId,
          setHistoryQuery,
          toggleRecordFav,
        } = p;

        const query = historyQuery.trim().toLowerCase();
        const filtered = records.filter((record) => {
          if (historyFavOnly && !record.fav) return false;
          if (!query) return true;
          const hay = [record.promptUser, record.promptFinal, record.model, record.sourceName]
            .map((value) => String(value || '').toLowerCase())
            .join('\n');
          return hay.includes(query);
        });
        const shown = filtered.slice(0, historyLimit);
        const favCount = records.filter((item) => item.fav).length;

        /** 时间列:缺 at 就如实显示「—」。 */
        const fmtTime = (at) => {
          const n = Number(at);
          if (!n) return '—';
          const d = new Date(n);
          const sameDay = new Date().toDateString() === d.toDateString();
          const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
        };
        /** 尺寸列:优先实际宽高,没有再退回提交时的尺寸意图。 */
        const fmtSize = (record) => {
          if (Number(record.w) > 0 && Number(record.h) > 0) return `${record.w}×${record.h}`;
          if (record.exactSize) return String(record.exactSize);
          if (record.ratio) return String(record.ratio);
          return '—';
        };
        const fmtDim = (value) => (Number(value) > 0 ? String(Number(value)) : '—');
        /** 缩略图地址:本地文件优先;没存上的用来源链接;都没有就占位。 */
        const thumbSrc = (record) => {
          if (record.file) return routeUrl(`/ws-file?path=${encodeURIComponent(record.file)}`, p.sessionId);
          if (record.sourceUrl) return record.sourceUrl;
          return '';
        };

        const rows = shown.map((record) => {
          const open = historyOpenId === record.id;
          const src = thumbSrc(record);
          const prompt = record.promptUser || record.promptFinal || '';
          const paramRows = [
            ['模型', record.model],
            ['比例', record.ratio],
            ['质量', record.quality],
            ['背景', record.background],
            ['imageSize', record.imageSize],
            ['成品尺寸', record.exactSize],
            ['来源图', record.sourceName],
            ['参考图', Number(record.refCount) > 0 ? `${record.refCount} 张${Array.isArray(record.refNames) && record.refNames.length ? `(${record.refNames.join('、')})` : ''}` : ''],
            ['标注', fmtDim(record.marksCount)],
            ['文字层', fmtDim(record.textsCount)],
            ['裁剪提交', record.cropped ? '是' : record.cropped === false ? '否' : ''],
          ];
          return h('div', { key: record.id, style: Object.assign({}, S.listRow, { flexDirection: 'column', alignItems: 'stretch', gap: 4, cursor: 'pointer' }) },
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' }, onClick: () => setHistoryOpenId(open ? '' : record.id) },
              src
                ? h('img', { id: 'grsai-history-thumb-' + record.id, width: 46, height: 46, alt: '历史记录缩略图', src, style: { width: 46, height: 46, objectFit: 'cover', borderRadius: 4, border: '1px solid ' + S.token.line, flex: '0 0 auto', background: '#f5f5f5' } })
                : h('div', { style: { width: 46, height: 46, borderRadius: 4, border: '1px dashed ' + S.token.line, flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: S.token.label2 } }, '无图'),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: 11, color: S.token.label } },
                  `${fmtTime(record.at)} · ${record.model || '—'} · ${fmtSize(record)}`,
                  record.file ? '' : record.sourceUrl ? ' · ⚠ 未持久化' : ' · ⚠ 无图',
                ),
                h('div', { style: { fontSize: 11, color: S.token.label2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  prompt ? prompt.trim().split('\n').join(' ').slice(0, 80) : '(这条记录没存提示词)',
                ),
              ),
              h('button', {
                title: record.fav ? '取消收藏' : '收藏',
                onClick: (e) => { e.stopPropagation(); toggleRecordFav(record.id); },
                style: Object.assign({}, S.btn, { flex: '0 0 auto', color: record.fav ? '#d97706' : S.token.label2 }),
              }, record.fav ? '★' : '☆'),
            ),
            open && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5, borderTop: '1px solid ' + S.token.line, paddingTop: 5 } },
              h('div', { style: { fontSize: 11, color: S.token.label, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 140, overflowY: 'auto', background: 'rgba(127,127,127,0.08)', borderRadius: 4, padding: '5px 6px' } },
                record.promptFinal || record.promptUser || '(这条记录没存提示词)',
              ),
              h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
                h('button', {
                  title: '把最终提交的提示词(含模板与标注说明)复制到剪贴板',
                  onClick: async (e) => {
                    e.stopPropagation();
                    try {
                      await navigator.clipboard.writeText(record.promptFinal || record.promptUser || '');
                      e.target.textContent = '已复制';
                      setTimeout(() => { if (e.target) e.target.textContent = '复制提示词'; }, 1200);
                    } catch { /* 剪贴板不可用时静默:文本就在上面,可手动选 */ }
                  },
                  style: S.btn,
                }, '复制提示词'),
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px', fontSize: 11, color: S.token.label2 } },
                paramRows.map(([label, value]) => h('div', { key: label },
                  h('span', { style: { color: S.token.label } }, `${label}:`),
                  ' ',
                  value ? String(value) : '—',
                )),
              ),
              h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } },
                h('button', { title: '把当时的参数与提示词回填到生成区(只回填,不自动生成)', onClick: () => restoreRecordParams(record, false), style: S.btn }, '恢复参数'),
                h('button', { title: '独立模式:不挂模板,直接用当时提交的完整提示词', onClick: () => restoreRecordParams(record, true), style: S.btn }, '仅最终提示词'),
                h('button', { title: '与画布上的来源图对比(来源图不在画布上会提示)', onClick: () => compareRecord(record), style: S.btn }, '对比'),
                h('button', { title: '把这张结果图放回画布', onClick: () => placeRecordImage(record), style: S.btn }, '放入画布'),
                h('button', { title: '下载这张结果图', onClick: () => downloadRecordImage(record), style: S.btn }, '下载'),
                h('button', { title: '从记录里删除(不碰画布与工作区文件)', onClick: () => removeRecord(record.id), style: S.btn }, '删除'),
              ),
            ),
          );
        });

        return h('div', { style: Object.assign({}, S.col, { gap: 6 }) },
          // ── 顶栏:搜索 / 收藏过滤 / 清空 ──
          h('div', { style: { display: 'flex', gap: 5, alignItems: 'center' } },
            h('input', {
              id: 'grsai-history-search',
              value: historyQuery,
              placeholder: '搜提示词 / 模型 / 来源图',
              onChange: (e) => { setHistoryQuery(e.target.value); setHistoryLimit(20); },
              style: Object.assign({}, S.input, { flex: 1, minWidth: 0 }),
            }),
            h('label', { title: '只看收藏', style: { display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: S.token.label2, flex: '0 0 auto' } },
              h('input', { id: 'grsai-history-fav-only', type: 'checkbox', checked: historyFavOnly, onChange: (e) => setHistoryFavOnly(e.target.checked) }),
              '★',
            ),
            h('button', {
              title: `清空全部记录${favCount ? `(含收藏 ${favCount} 条)` : ''}(需确认;不碰画布与工作区文件)`,
              disabled: !records.length,
              onClick: clearRecords,
              style: Object.assign({}, S.btn, !records.length ? { opacity: 0.4 } : null),
            }, '清空'),
          ),
          // ── 状态行:持久化能力 / 损坏警示 ──
          !historyHostReady && h('div', { style: { fontSize: 11, color: '#b45309' } },
            '宿主是旧版:生成记录只在当前页面有效,重启一次 DSH 后才会自动存进工作区'),
          historyHostReady && historyCorrupted && h('div', { style: { fontSize: 11, color: '#b45309' } },
            '⚠ 清单文件损坏(按空载入)。保存新变化前会先向你确认覆盖;旧内容无法找回'),
          // ── 列表 ──
          !records.length && h('div', { style: { fontSize: 11, color: S.token.label2, padding: '6px 0' } },
            historyHostReady
              ? '还没有生成记录 —— 每次生成成功都会自动记一条(缩略图、参数、提示词),存进工作区,重开画布还在'
              : '还没有生成记录'),
          !!records.length && !filtered.length && h('div', { style: { fontSize: 11, color: S.token.label2, padding: '6px 0' } },
            '没有匹配的记录(换个关键词,或取消「只看收藏」)'),
          rows,
          // ── 分页(有界加载)──
          filtered.length > shown.length && h('button', {
            onClick: () => setHistoryLimit(historyLimit + 20),
            style: Object.assign({}, S.btn, S.wideBtn),
          }, `显示更多(已显示 ${shown.length}/${filtered.length})`),
          !!filtered.length && h('div', { style: { fontSize: 10, color: S.token.label2 } },
            `共 ${records.length} 条${favCount ? `(收藏 ${favCount})` : ''} · 上限 400 条,超出时丢最旧、收藏优先保留`),
        );
      }

      return { renderHistoryPanel };
    });

    // ── 零件 29-workspace-panel.js ───────────────────────────────────────────────────
/* 工作区内容块:列当前会话工作区里的图片(点一下放到画布)+ 保存路径输入框。
 *
 * 0.21 起本零件只出内容块(不带浮层外壳),装进右侧停靠区(36-dock)的「工作区」标签;
 * 开合由 `dockOpen` 控制,这里不再判断。
 *
 * 全局零件作用域里的 `h`/`S`/`stamp`/`humanSize` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('workspace-panel', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderWorkspacePanel(p) {
        const {
          pickWorkspace,
          refreshWorkspace,
          savePath,
          setSavePath,
          wsBusy,
          wsFiles,
        } = p;
        return h(
          'div',
          { style: Object.assign({}, S.col, { gap: 5 }) },
          h(
            'div',
            { style: S.row },
            wsBusy ? h('span', { style: S.hint }, '读取中…') : null,
            h('span', { style: S.grow }),
            h('button', { style: S.tiny, onClick: refreshWorkspace }, '刷新'),
          ),
          h(
            'div',
            { style: S.list },
            (wsFiles || []).length === 0
              ? h('div', { style: Object.assign({}, S.listRow, { cursor: 'default' }) }, wsBusy ? '读取中…' : '没找到图片文件')
              : wsFiles.map((file) =>
                  h(
                    'div',
                    { key: file.path, style: S.listRow, onClick: () => pickWorkspace(file.path), title: '点一下放到画布' },
                    h('span', { style: Object.assign({}, S.grow, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, file.path),
                    h('span', { style: S.hint }, humanSize(file.size)),
                  ),
                ),
          ),
          h('div', { style: S.row }, h('span', { style: S.hint }, '保存路径'), h('input', { id: 'grsai-save-path', style: Object.assign({}, S.input, S.grow), placeholder: `画布输出/grsai-${stamp()}.png`, value: savePath, onChange: (e) => setSavePath(e.target.value) })),
        );
      }

      return { renderWorkspacePanel };
    });

    // ── 零件 31-frame-input.js ───────────────────────────────────────────────────────
/* 场景框(生成框)放置弹窗:点画布后在点击处输入尺寸/比例(800x600 / 210x297mm / 3:4)。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`clamp` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('frame-input', () => {
      // 场景框放置弹窗:点画布后在这里输入尺寸/比例
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderFrameInput(p) {
        const { confirmFrame, frameDraft, setFrameDraft, size } = p;
        return frameDraft
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  left: clamp(frameDraft.sx, 4, Math.max(4, size.w - 320)),
                  top: clamp(frameDraft.sy - 44, 4, Math.max(4, size.h - 44)),
                  zIndex: 6,
                  display: 'flex',
                  gap: 4,
                  alignItems: 'center',
                  background: panelBg,
                  border: `1px solid ${line}`,
                  borderRadius: 8,
                  padding: 6,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
                },
              },
              h('input', {
                id: 'grsai-frame-size-input',
                autoFocus: true,
                value: frameDraft.value,
                placeholder: '800x600 / 210x297mm / 3:4',
                style: Object.assign({}, S.input, { width: 180 }),
                onChange: (e) => setFrameDraft(Object.assign({}, frameDraft, { value: e.target.value })),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmFrame();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setFrameDraft(null);
                  }
                },
              }),
              h('button', { style: S.primary, onClick: confirmFrame }, '放框'),
              h('button', { style: S.tiny, onClick: () => setFrameDraft(null) }, '取消'),
            )
          : null;
      }

      return { renderFrameInput };
    });

    // ── 零件 32-layer-key-panel.js ───────────────────────────────────────────────────
/* 「图片分层(Agent)」的接口与密钥面板:右上角工具栏那颗「🔑 分层」开出来的独立浮层。
 *
 * 从「设置」里**拎出来**的:这条链路的 key 跟 GrsAI 那把不是同一个东西(它调的是 Seedream
 * 图层分解,一次返回逐层 PNG + 每层位置),混在一个面板里迟早搞混。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`LAYER_DEFAULT_BASE` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('layer-key-panel', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderLayerKeyPanel(p) {
        const {
          panelAnchor,
          clearLayerKey,
          fetchLayerModels,
          layerCfg,
          layerHostReady,
          layerModelsReady,
          saveLayerCfg,
          saveLayerModel,
          setLayerCfg,
          setShowLayerKey,
          showLayerKey,
          testLayerCfg,
        } = p;

        const busy = Boolean(layerCfg.busy);
        /**
         * 面板上真正列出来的模型。
         *
         * 宿主一次性把上游**全部**模型拿回来了(带 rank),所以「只看像的 / 显示全部」
         * 是纯本地切换 —— 切一次不会再打一次上游(上游限流很凶,连点两下就 429)。
         */
        const visibleModels = (layerCfg.models || []).filter((m) => layerCfg.modelsAll || m.rank > 0);
        /** 手写框里的原文(不 trim,免得打字时光标乱跳)与真正拿去保存的值。 */
        const draftRaw = String(layerCfg.modelDraft || '');
        const draft = draftRaw.trim();
        /** 宿主支不支持「取模型」——旧版没这条接口,提前把按钮灰掉并说明,别等点了才报"未知路由"。 */
        const modelsReady = Boolean(layerModelsReady);
        const state = !layerHostReady
          ? { text: '宿主旧版', style: S.hint }
          : layerCfg.hasKey
            ? { text: `已配置 ${layerCfg.masked}`, style: S.ok }
            : { text: '还没填', style: S.err };

        /** 悬停开的贴在按钮正下方(按自己的宽度往回收);手点开的还是老位置靠右。 */
        const place = panelAnchor
          ? { left: Math.max(6, Math.min(panelAnchor.left, panelAnchor.maxRight - 330)), right: 'auto', top: panelAnchor.top }
          : { right: 6, top: 42 };
        return showLayerKey
          ? h(
              'div',
              {
                // 悬停联动用:鼠标落进这块面板就算「还没走」,收起倒计时作废
                'data-nav-keep': 'layerkey',
                style: Object.assign({}, S.float, place, { width: 330, maxWidth: 'calc(100% - 16px)' }),
              },
              h(
                'div',
                { style: Object.assign({}, S.card, S.col, { gap: 6 }) },
                h(
                  'div',
                  { style: S.row },
                  h('strong', { style: { fontSize: 12 } }, '🔑 图片分层(Agent)'),
                  h('span', { style: S.grow }),
                  h('span', { style: state.style }, state.text),
                  h('button', { style: S.tiny, onClick: () => setShowLayerKey(false) }, '收起'),
                ),
                h(
                  'div',
                  { style: S.hint },
                  '画布 Skills 面板那颗「▶ 图片分层(交给 Agent)」用的接口与密钥 —— 它调的是 **Seedream 图层分解**(一次返回逐层透明 PNG + 每层位置),再由本地脚本按原位组装成可编辑 PSD。',
                ),
                h(
                  'div',
                  { style: S.hint },
                  '⚠ 和「设置」里那把 GrsAI 的 APIKEY **不是一个东西、不能互用**:GrsAI 那些型号(gpt-image / nano-banana)只出整图,没有图层分解接口。',
                ),
                !layerHostReady
                  ? h(
                      'div',
                      { style: S.err },
                      '宿主半边是旧版:这一项要**重启一次 DSH** 才能保存(双击桌面 `重启DSH.cmd`);客户端半边刷新页面即生效。',
                    )
                  : null,
                h('div', { style: S.hint }, '接口地址'),
                h('input', {
                  id: 'grsai-layer-base',
                  style: S.input,
                  placeholder: LAYER_DEFAULT_BASE,
                  value: layerCfg.base,
                  onChange: (e) => setLayerCfg(Object.assign({}, layerCfg, { base: e.target.value })),
                }),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: S.tiny,
                      title:
                        '换平台用的:图层分解各家路径不一样。默认提交 /v1/images/generations、查询 /v1/tasks;地址尾部带了 /v1 也不会被拼重',
                      onClick: () => setLayerCfg(Object.assign({}, layerCfg, { advanced: !layerCfg.advanced })),
                    },
                    layerCfg.advanced ? '▾ 端点路径(高级)' : '▸ 端点路径(高级)',
                  ),
                  h('span', { style: S.grow }),
                ),
                layerCfg.advanced
                  ? h(
                      'div',
                      { style: S.col },
                      h('div', { style: S.hint }, '提交端点(留空 = 用默认)'),
                      h('input', {
                        id: 'grsai-layer-submit',
                        style: S.input,
                        spellCheck: false,
                        autoComplete: 'off',
                        placeholder: layerCfg.defaultSubmitEndpoint || '/v1/images/generations',
                        value: layerCfg.submitEndpoint,
                        onChange: (e) => setLayerCfg(Object.assign({}, layerCfg, { submitEndpoint: e.target.value })),
                      }),
                      h('div', { style: S.hint }, '查询端点(留空 = 用默认;写 {id} 就按模板替换任务号,不写则自动补 /任务号)'),
                      h('input', {
                        id: 'grsai-layer-status',
                        style: S.input,
                        spellCheck: false,
                        autoComplete: 'off',
                        placeholder: layerCfg.defaultStatusEndpoint || '/v1/tasks',
                        value: layerCfg.statusEndpoint,
                        onChange: (e) => setLayerCfg(Object.assign({}, layerCfg, { statusEndpoint: e.target.value })),
                      }),
                      h(
                        'div',
                        { style: S.row },
                        h(
                          'button',
                          {
                            style: S.tiny,
                            title: '把这两格填回默认路径;再点「保存」就会覆盖配置里存的那两项',
                            onClick: () =>
                              setLayerCfg(
                                Object.assign({}, layerCfg, {
                                  submitEndpoint: layerCfg.defaultSubmitEndpoint || '/v1/images/generations',
                                  statusEndpoint: layerCfg.defaultStatusEndpoint || '/v1/tasks',
                                }),
                              ),
                          },
                          '用默认',
                        ),
                        h('span', { style: S.grow }),
                      ),
                      layerCfg.createUrl || layerCfg.statusUrl
                        ? h(
                            'div',
                            { style: S.hint },
                            `实际会打:${layerCfg.createUrl || '?'}\n轮询:${layerCfg.statusUrl || '?'}`,
                          )
                        : null,
                      layerCfg.modelsUrl ? h('div', { style: S.hint }, `测试连接会打:${layerCfg.modelsUrl}`) : null,
                      h(
                        'div',
                        { style: S.hint },
                        '地址尾部带不带 /v1 都行(拼的时候重复的 /v1 只留一段);端点也能直接写完整 URL,跨域名中转照样用。改完点「保存」。',
                      ),
                    )
                  : null,
                h('div', { style: S.hint }, layerCfg.hasKey ? 'API Key(已保存;填新的即覆盖,留空则不改)' : 'API Key'),
                h(
                  'div',
                  { style: S.row },
                  h('input', {
                    id: 'grsai-layer-token',
                    style: Object.assign({}, S.input, S.grow),
                    type: 'password',
                    autoComplete: 'off',
                    placeholder: layerCfg.hasKey ? '留空则保持已保存的 key' : '粘贴分层服务的 API Key',
                    value: layerCfg.key,
                    onChange: (e) => setLayerCfg(Object.assign({}, layerCfg, { key: e.target.value })),
                  }),
                  layerCfg.hasKey
                    ? h('button', { style: S.tiny, title: '清掉本机保存的分层密钥(地址留着)', onClick: clearLayerKey }, '清除')
                    : null,
                ),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.wideBtn, busy ? { opacity: 0.6 } : null),
                      disabled: busy || !layerHostReady,
                      onClick: saveLayerCfg,
                    },
                    layerCfg.busy === 'save' ? '保存中…' : '保存',
                  ),
                  h('span', { style: S.grow }),
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.tiny, busy || !layerHostReady || !layerCfg.hasKey ? { opacity: 0.6 } : null),
                      disabled: busy || !layerHostReady || !layerCfg.hasKey,
                      title: !layerHostReady ? '宿主是旧版:重启一次 DSH 后才能测试(接口 /layering-test 不在旧宿主能力清单里)' : '只 GET 一次 /v1/models 探连通性,不产生生成费用',
                      onClick: testLayerCfg,
                    },
                    layerCfg.busy === 'test' ? '测试中…' : '测试连接',
                  ),
                ),
                h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
                h('div', { style: S.hint }, '模型 ID(可以点下面的清单选一个,也可以自己写 —— 两边走的是同一条保存)'),
                h(
                  'div',
                  { style: S.row },
                  h('input', {
                    id: 'grsai-layer-model',
                    style: Object.assign({}, S.input, S.grow),
                    type: 'text',
                    spellCheck: false,
                    autoComplete: 'off',
                    placeholder: `例如 ${layerCfg.defaultModel || '上游文档里写的模型名'}`,
                    value: draftRaw,
                    disabled: busy || !layerHostReady,
                    onChange: (e) => setLayerCfg(Object.assign({}, layerCfg, { modelDraft: e.target.value })),
                    onKeyDown: (e) => {
                      // 回车即存:手写模型的常见用法是"粘上 → 回车",别逼人去点按钮
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveLayerModel(draft);
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.tiny, busy || !layerHostReady || !draft ? { opacity: 0.6 } : null),
                      disabled: busy || !layerHostReady || !draft,
                      title: '把这一格里的模型名写进技能配置(apimart_config.json 的 model)',
                      onClick: () => saveLayerModel(draft),
                    },
                    layerCfg.busy === 'model' ? '保存中…' : '保存此 ID',
                  ),
                ),
                h(
                  'div',
                  { style: S.hint },
                  `技能配置里现在存的是:${layerCfg.model || `(空 —— 跑起来会兜底用 ${layerCfg.defaultModel || '宿主默认模型'})`}`,
                ),
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.tiny, busy || !layerCfg.hasKey || !modelsReady ? { opacity: 0.6 } : null),
                      disabled: busy || !layerCfg.hasKey || !modelsReady,
                      title: !modelsReady
                        ? '宿主半边是旧版(这条接口 0.19.6 才有)—— 重启一次 DSH 后可用'
                        : '拉一次上游的模型清单,挑出像「图层分解」的那些(只读,不产生费用)',
                      onClick: () => fetchLayerModels(false),
                    },
                    layerCfg.busy === 'models' ? '取模型中…' : '🔍 取可用模型',
                  ),
                  (layerCfg.models || []).length
                    ? h(
                        'button',
                        {
                          style: S.tiny,
                          disabled: busy,
                          title: '上游模型动辄几百个,默认只列像图层分解的;切换是本地过滤,不会再去问上游',
                          onClick: () => setLayerCfg(Object.assign({}, layerCfg, { modelsAll: !layerCfg.modelsAll })),
                        },
                        layerCfg.modelsAll ? '只看像的' : `显示全部(${(layerCfg.models || []).length})`,
                      )
                    : null,
                  h('span', { style: S.grow }),
                ),
                !modelsReady
                  ? h(
                      'div',
                      { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                      '⚠ 宿主半边是旧版:重启一次 DSH 之后才能「取可用模型」。',
                    )
                  : null,
                visibleModels.length
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 170, overflowY: 'auto', padding: '2px 0' } },
                      visibleModels.map((m) =>
                        h(
                          'button',
                          {
                            key: m.id,
                            style: Object.assign({}, S.tiny, {
                              textAlign: 'left',
                              wordBreak: 'break-all',
                              // ⚠ 两态都必须给**完整的 border**:本插件的样式 diff 不会清除"这次没有的 key",
                              // 只给颜色的话取消选中会留下一个空心黑框(工具栏那个老毛病)。
                              border:
                                layerCfg.model === m.id
                                  ? '1px solid var(--dsw-alias-label-primary, #3b82f6)'
                                  : '1px solid transparent',
                              background: 'transparent',
                              color: layerCfg.model === m.id ? 'var(--dsw-alias-label-primary, #3b82f6)' : label2,
                            }),
                            title: m.hint || m.id,
                            disabled: busy,
                            onClick: () => saveLayerModel(m.id),
                          },
                          `${layerCfg.model === m.id ? '● ' : '○ '}${m.id}`,
                          m.hint ? h('span', { style: { opacity: 0.6 } }, `  ·  ${m.hint}`) : null,
                        ),
                      ),
                    )
                  : null,
                layerCfg.note
                  ? h('div', { style: /失败|拒绝|连不上|没找到/.test(layerCfg.note) ? S.err : S.hint }, layerCfg.note)
                  : null,
                layerCfg.dir && layerHostReady
                  ? h('div', { style: S.hint }, `写入:${layerCfg.dir}\\config\\apimart_config.json(写在技能自己目录里,随技能走)`)
                  : null,
                h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
                h(
                  'div',
                  { style: S.hint },
                  '去哪拿:api.apimart.ai 注册后建 key。按张计费(1K 分层约 $0.0146、2K 分层约 $0.0293),1 美元起充、没有免费额度。',
                ),
                h('div', { style: S.hint }, '密钥只写不读:存好后这里只显示掩码,读接口也从不回原文。'),
              ),
            )
          : null;
      }

      return { renderLayerKeyPanel };
    });

    // ── 零件 33-upscale-panel.js ─────────────────────────────────────────────────────
/* 「AI 高清放大」面板:右上角那颗「⬆ 放大」开出来的独立浮层。
 *
 * 这条链路和云端模型无关 —— 由宿主进程调用本机的 realesrgan 引擎,在**你自己的显卡**上跑:
 * 图片不出本机、不花任何 API 额度、断网也能用。引擎不随插件打包(会从 386 KB 涨到几十 MB),
 * 第一次点「下载引擎」时才从发布点拉下来,之后离线可用。
 *
 * 样式上刻意**不用实线描边**:面板里按钮多,一排深色边框在浅色卡片上会糊成一片"黑框",
 * 所以这里一律用「透明底 → 选中/主操作用淡背景」来表达,深浅主题都不会突兀。
 *
 * 依赖由调用处经 `p` 注入(调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('upscale-panel', () => {
      /** 档位的展示文案(实际下哪些文件由宿主那边的引擎清单决定)。 */
      const TIER_TEXT = {
        fast: {
          title: '快速放大',
          size: '约 10 MB',
          speed: '一张 1200px 图约 5 秒',
          quality: '轻量模型,动漫 / 插画 / 截图效果好',
        },
        quality: {
          title: '高清放大',
          size: '再下约 32 MB',
          speed: '一张 1200px 图约 40 秒',
          quality: '高质量模型,照片细节最足',
        },
      };

      /**
       * @param {object} p - 依赖包。
       * @returns {React element|null} 面板或空。
       */
      function renderUpscalePanel(p) {
        const {
          panelAnchor,
          ensureUpscale,
          hostFeatures,
          runUpscale,
          setShowUpscale,
          setUpscaleScale,
          setUpscaleTier,
          showUpscale,
          upscaleBusy,
          upscaleNote,
          upscaleScale,
          upscaleTier,
          upscaleTiers,
        } = p;
        if (!showUpscale) return null;

        const hostReady = Array.isArray(hostFeatures) && hostFeatures.includes('upscale');
        const stateOf = (id) => (upscaleTiers || []).find((item) => item.id === id) || null;
        const current = stateOf(upscaleTier);
        const ready = Boolean(current && current.ready);
        const busy = Boolean(upscaleBusy);

        /**
         * 面板里统一的"胶囊"样式:**没有任何描边**,选中态靠淡背景 + 主色文字。
         * @param {boolean} active - 是否选中 / 主操作。
         * @param {boolean} [strong] - 主操作用(更实的底 + 加粗)。
         * @returns {object} 内联样式。
         */
        const pill = (active, strong) =>
          Object.assign({}, S.tiny, {
            appearance: 'none',
            border: 'none',
            outline: 'none',
            background: active
              ? strong
                ? 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.24))'
                : 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))'
              : 'transparent',
            color: active ? label : label2,
            borderRadius: 8,
            padding: strong ? '6px 12px' : '5px 10px',
            fontSize: strong ? 13 : 12.5,
            fontWeight: active ? 600 : 400,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
          });

        /** 档位一行(点一下切换;右边标着"已就绪 / 需要下载")。 */
        const tierRow = (id) => {
          const text = TIER_TEXT[id] || { title: id };
          const state = stateOf(id);
          const active = upscaleTier === id;
          return h(
            'button',
            {
              key: id,
              style: Object.assign(pill(active), { display: 'block', width: '100%', textAlign: 'left', marginBottom: 1 }),
              disabled: busy,
              title: `${text.quality} —— ${text.speed}`,
              onClick: () => setUpscaleTier(id),
            },
            `${active ? '● ' : '○ '}${text.title}`,
            h('span', { style: { float: 'right', opacity: 0.7, fontWeight: 400 } }, state && state.ready ? '已就绪' : `需下载 ${text.size}`),
          );
        };

        /** 悬停开的贴在按钮正下方(按自己的宽度往回收);手点开的还是老位置靠右。 */
        const place = panelAnchor
          ? { left: Math.max(6, Math.min(panelAnchor.left, panelAnchor.maxRight - 340)), right: 'auto', top: panelAnchor.top }
          : { right: 6, top: 42 };
        return h(
          'div',
          {
            // 悬停联动用:鼠标落进这块面板就算「还没走」,收起倒计时作废
            'data-nav-keep': 'upscale',
            style: Object.assign({}, S.float, place, { width: 340, maxWidth: 'calc(100% - 16px)' }),
          },
          h(
            'div',
            { style: Object.assign({}, S.card, S.col, { gap: 6 }) },
            h(
              'div',
              { style: S.row },
              h('strong', { style: { fontSize: 12 } }, '⬆ AI 高清放大'),
              h('span', { style: S.grow }),
              h('button', { style: pill(false), onClick: () => setShowUpscale(false) }, '收起'),
            ),
            h(
              'div',
              { style: S.hint },
              '用**本机显卡**放大(Real-ESRGAN):图片不出本机、不花 API 额度、断网也能用。引擎第一次用时才下载,之后一直离线可用。',
            ),
            !hostReady
              ? h(
                  'div',
                  { style: Object.assign({}, S.hint, { color: 'var(--dsw-alias-state-warn-label, #b7791f)' }) },
                  '⚠ 宿主半边是旧版(还不认识这颗按钮)—— 重启一次 DSH 后可用。',
                )
              : null,
            h('div', { style: { height: 1, background: line, opacity: 0.6, margin: '2px 0' } }),
            tierRow('fast'),
            tierRow('quality'),
            h(
              'div',
              { style: Object.assign({}, S.row, { gap: 4, alignItems: 'center' }) },
              h('span', { style: S.hint }, '倍率'),
              [2, 3, 4].map((value) =>
                h(
                  'button',
                  {
                    key: value,
                    style: pill(upscaleScale === value),
                    disabled: busy,
                    title:
                      value === 4
                        ? '4x —— 模型原生倍率,细节最足'
                        : `${value}x —— 快档是原生变体;精档由 4x 缩到 ${value} 倍(耗时同 4x)`,
                    onClick: () => setUpscaleScale(value),
                  },
                  `${value}x`,
                ),
              ),
              h('span', { style: S.hint }, '8x 要连放两次,暂不提供'),
            ),
            h('div', { style: { height: 1, background: line, opacity: 0.6, margin: '2px 0' } }),
            h(
              'div',
              { style: S.row },
              ready
                ? h(
                    'button',
                    {
                      style: Object.assign(pill(true, true), { flex: 1, textAlign: 'center' }),
                      disabled: busy,
                      title: '把选中的图(没选就用最后一张)放到本机显卡上放大',
                      onClick: () => {
                        if (!busy) runUpscale();
                      },
                    },
                    busy === 'run' ? '⏳ 放大中…(大图可能要 40 秒)' : `▶ 开始放大 ${upscaleScale}x`,
                  )
                : h(
                    'button',
                    {
                      style: Object.assign(pill(true, true), { flex: 1, textAlign: 'center' }),
                      disabled: busy,
                      title: '把放大引擎下载到本机(只下一次,之后离线可用)',
                      onClick: () => {
                        if (!busy) ensureUpscale(upscaleTier);
                      },
                    },
                    busy === 'download' ? '⏳ 下载引擎中…' : `⬇ 下载引擎(${TIER_TEXT[upscaleTier] ? TIER_TEXT[upscaleTier].size : ''})`,
                  ),
              ready
                ? h(
                    'button',
                    {
                      style: pill(false),
                      disabled: busy,
                      title: '引擎已装好;想换成另一个档位直接点上面那颗,会增量补下载',
                      onClick: () => ensureUpscale(upscaleTier),
                    },
                    '检查',
                  )
                : null,
            ),
            upscaleNote
              ? h('div', { style: /失败|错误|旧版/.test(upscaleNote) ? S.err : S.hint }, upscaleNote)
              : null,
            current && current.ready
              ? h(
                  'div',
                  { style: S.hint },
                  `引擎位置:${current.installed}/${current.total} 个文件${current.bytes ? `,${(current.bytes / 1048576).toFixed(1)} MB` : ''}`,
                )
              : null,
            h('div', { style: S.hint }, '放大结果会存到工作区「画布输出」里,并直接摆到原图旁边。'),
          ),
        );
      }

      return { renderUpscalePanel };
    });

    // ── 零件 34-viewbar.js ───────────────────────────────────────────────────────────
/* 画布视图控制(右上角):缩小 / 百分比 / 放大 | 适应。
 *
 * 位置:顶部第一行的右端 —— 导航按钮(＋图片/工作区/Skills/记录/分层/放大/设置)是左对齐排的,
 * 右边这块一直空着,放这儿不挡任何按钮(同一行居中会撞上「设置」,所以不走居中)。
 * 比例读数原来在左下那条里,而且是个**裸数字**(`zoomLabel` 是数字 1、1.5,
 * 直接当子元素渲染出来就是 "1",不是百分比);现在整条搬上来,统一按百分比显示。
 * 缩放入口一直集中在这里(原来散在右上角那排里);空格拖拽平移、滚轮缩放仍在画布上直接用。
 *
 * 全局零件作用域里的 `h`/`S`/`line` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('viewbar', () => {
      /**
       * 当前倍数的百分比文本(整数;读不到就按 100%)。
       * @param {number} zoomLabel - 画布的 zoom。
       * @returns {string} 形如 `125%`。
       */
      function zoomText(zoomLabel) {
        const n = Number(zoomLabel);
        return `${Math.round((Number.isFinite(n) && n > 0 ? n : 1) * 100)}%`;
      }

      /**
       * 右上角那条:缩小 / 当前比例(点一下回 100%) / 放大 | 适应。
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderViewbar(p) {
        const { fitAll, zoomAtPoint, zoomTo, zoomLabel, size } = p;
        return h(
          'div',
          {
            style: Object.assign({}, S.float, {
              top: 6,
              right: 6,
              // 比顶部导航那行更靠上:右上角正好是它的空白区,顺手压住不被误挡
              zIndex: 6,
            }),
          },
          h(
            'div',
            { style: Object.assign({}, S.card, S.row, { padding: 4, gap: 2, alignItems: 'center' }) },
            h('button', { style: S.btn, title: '缩小', onClick: () => zoomAtPoint(size.w / 2, size.h / 2, 1 / 1.25) }, '－'),
            h(
              'button',
              {
                style: Object.assign({}, S.wideBtn, { minWidth: 58, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }),
                title: '当前视图比例 —— 点一下回到 100%',
                onClick: () => zoomTo(1),
              },
              zoomText(zoomLabel),
            ),
            h('button', { style: S.btn, title: '放大', onClick: () => zoomAtPoint(size.w / 2, size.h / 2, 1.25) }, '＋'),
            h('div', { style: { width: 1, alignSelf: 'stretch', background: line, margin: '4px 2px' } }),
            h('button', { style: S.wideBtn, title: '把所有图缩放到可见(0)', onClick: fitAll }, '适应'),
          ),
        );
      }

      return { renderViewbar };
    });

    // ── 零件 35-props-card.js ────────────────────────────────────────────────────────
/* 选中对象属性区(右侧、生成卡上方,仅选中了图片才出现):图片信息与操作那一行
 * (参考/复制/存工作区/下载/导出底图与文字/删除)、多选时的对齐分布条、文字图层整块。
 * 从「生成卡」迁出来(任务书 §6.2:未选图不常驻图片操作,生成区只留生成相关)。
 *
 * 全局零件作用域里的 `h`/`S`/`line`/`COLORS`/`TEXT_DEFAULTS`/`FONT_CANDIDATES` 直接用;
 * CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('props-card', () => {
      /** 对齐/分布按钮(多选 ≥2 张时才出现;后两个要 ≥3 张)。 */
      const ALIGN_ACTIONS = [
        { kind: 'left', label: '左齐', tip: '左对齐:几张图的左边缘对齐' },
        { kind: 'hcenter', label: '横中', tip: '水平居中对齐' },
        { kind: 'right', label: '右齐', tip: '右对齐:几张图的右边缘对齐' },
        { kind: 'top', label: '顶齐', tip: '顶对齐:几张图的上边缘对齐' },
        { kind: 'vcenter', label: '纵中', tip: '垂直居中对齐' },
        { kind: 'bottom', label: '底齐', tip: '底对齐:几张图的下边缘对齐' },
        { kind: 'hdist', label: '横分', tip: '水平等距分布:首尾两张不动,中间的等间距铺开', need3: true },
        { kind: 'vdist', label: '纵分', tip: '垂直等距分布:首尾两张不动,中间的等间距铺开', need3: true },
      ];
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素(没选中任何图片时返回 null —— 整块不出现)。
       */
      function renderPropsCard(p) {
        const {
          addTextLayer,
          alignSelected,
          compareSelectedTwo,
          copyImageToClipboard,
          deleteSelected,
          downloadSelected,
          fontList,
          importFontFile,
          layerSize,
          removeTextLayer,
          saveImageLayered,
          saveSelectedToWorkspace,
          selected,
          selectedIds,
          selectedMarks,
          selectedText,
          selectedTextId,
          setLayerSize,
          setGeometry,
          setSelectedTextId,
          setShowText,
          setSubmitTexts,
          showText,
          submitTexts,
          toggleRef,
          updateText,
        } = p;
        // 选了 2 张以上时,「存 / 下载」按整批走(单张仍是老路:存主选中那张)
        const multi = selectedIds.length > 1 ? selectedIds.length : 0;
        if (!selected && multi < 2) return null;
        /**
         * 属性卡上的一个几何数字框(X/Y/宽/高)。
         *
         * 只在回车或失焦时提交:每敲一个字符就写一次 doc 会把撤销栈塞满。
         * `key` 绑当前值 —— 用键盘方向键挪图、或 Ctrl+Z 之后,输入框里的数字跟着变。
         * @param {'x'|'y'|'w'|'h'} key - 字段。
         * @param {string} label - 框前的小标签。
         * @returns {object} React 元素。
         */
        const geoInput = (key, label) =>
          h(
            'label',
            { key: `geo-${key}-${Math.round(Number(selected[key]) || 0)}`, style: Object.assign({}, S.hint, { display: 'inline-flex', alignItems: 'center', gap: 2 }) },
            label,
            h('input', {
              style: Object.assign({}, S.input, { width: key === 'w' || key === 'h' ? 68 : 62, padding: '1px 3px' }),
              type: 'number',
              min: key === 'w' || key === 'h' ? 8 : undefined,
              step: 1,
              defaultValue: Math.round(Number(selected[key]) || 0),
              title: `${label}:改完按回车或点别处生效(Ctrl+Z 可撤销)`,
              onBlur: (e) => setGeometry({ [key]: e.target.value }),
              onKeyDown: (e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = String(Math.round(Number(selected[key]) || 0));
                  e.currentTarget.blur();
                }
              },
            }),
          );
        return h(
          'div',
          { style: S.props },
          selected
            ? h(
                'div',
                { style: Object.assign({}, S.card, S.row, { padding: '4px 7px', flexWrap: 'wrap' }) },
                h('span', { style: S.badge, title: String(selected.name || '图片') }, `${String(selected.name || '图片').length > 14 ? `${String(selected.name || '图片').slice(0, 12)}…` : String(selected.name || '图片')} · ${selected.naturalW || selected.w}×${selected.naturalH || selected.h}`),
                selected && selectedMarks.length ? h('span', { style: S.badge }, `${selectedMarks.length} 处标注`) : null,
                h('span', { style: S.grow }),
                h('button', { style: Object.assign({}, S.tiny, selected.isRef ? { color: '#3b82f6' } : null), title: '标记为参考图:提交时会一起发给模型(画布角标会显示它的参考编号,提示词里写「参考图1」就能指到它)', onClick: toggleRef }, selected.isRef ? '参考✓' : '参考'),
                h('button', { style: S.tiny, title: '复制这张图到剪贴板(Ctrl+C):粘到聊天/PPT/PS 直接用', onClick: () => copyImageToClipboard(selected) }, '复制'),
                h('button', { style: S.tiny, title: multi ? `保存选中的 ${multi} 张图到工作区(一张失败不影响其余)` : '保存这张图到工作区', onClick: () => saveSelectedToWorkspace() }, multi ? `存工作区${multi}张` : '存工作区'),
                h('button', { style: S.tiny, title: multi ? `下载选中的 ${multi} 张图` : '下载这张图', onClick: () => downloadSelected() }, multi ? `下载${multi}张` : '下载'),
                h(
                  'button',
                  {
                    style: S.tiny,
                    title: `导出底图与文字(本地分层,非 AI 拆层)三个文件:成品图 + 无文字底图 + 文字参数(JSON)。底图能换尺寸重出,文字永远清晰${layerSize.trim() ? `(按 ${layerSize.trim()})` : '(按原图分辨率)'}`,
                    onClick: () => saveImageLayered(selected),
                  },
                  '导出底图与文字',
                ),
                h('button', { style: S.tiny, title: '从画布删除', onClick: deleteSelected }, '删除'),
              )
            : null,
          // 精确位置/尺寸:手拖对不齐的时候直接填数字(按像素排版时最省事)
          selected
            ? h(
                'div',
                { style: Object.assign({}, S.card, { padding: '4px 7px', display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }) },
                geoInput('x', 'X'),
                geoInput('y', 'Y'),
                geoInput('w', '宽'),
                geoInput('h', '高'),
                h('span', { style: S.hint, title: '画布像素。宽高只改这张图的显示尺寸(会拉伸画面),不改原图数据' }, 'px'),
              )
            : null,
          // 多选时才出现的对齐/分布条:一次把几张图排齐,省得一张张拖
          multi === 2 && h('div', { style: Object.assign({}, S.card, { padding: '4px 7px', display: 'flex', gap: 3, alignItems: 'center' }) },
            h('span', { style: S.hint }, '选了两张:'),
            h('button', { style: S.tiny, title: '并排/滑杆对比这两张图(只读视图,关掉不改画布;按图层顺序 A 在前)', onClick: compareSelectedTwo }, '对比这两张'),
          ),
          multi
            ? h(
                'div',
                { style: Object.assign({}, S.card, { padding: '4px 7px', display: 'flex', flexWrap: 'wrap', gap: 3 }) },
                h('span', { style: S.hint }, `对齐 ${multi} 张`),
                ALIGN_ACTIONS.map((a) => {
                  const blocked = Boolean(a.need3) && selectedIds.length < 3;
                  return h(
                    'button',
                    {
                      key: a.kind,
                      style: Object.assign({}, S.tiny, blocked ? { opacity: 0.4, cursor: 'default' } : null),
                      title: blocked ? `${a.tip}(还差一张:至少要选 3 张)` : a.tip,
                      onClick: () => {
                        if (!blocked) alignSelected(a.kind);
                      },
                    },
                    a.label,
                  );
                }),
              )
            : null,
          // ── 文字图层:本机字体、本地绘制,导出时按原图分辨率烧进去 ───────────
          selected
            ? h(
                'div',
                { style: Object.assign({}, S.card, S.col, { padding: '4px 7px' }) },
                h(
                  'div',
                  { style: S.row },
                  h(
                    'button',
                    {
                      style: Object.assign({}, S.tiny, showText ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null),
                      title: '文字用本机字体在本地画,导出/下载时按原图分辨率烧进去 —— 比让模型写清楚得多',
                      onClick: () => setShowText(!showText),
                    },
                    `${showText ? '▾' : '▸'} 文字${(selected.texts || []).length ? `(${(selected.texts || []).length})` : ''}`,
                  ),
                  h('button', { style: S.tiny, title: '在这张图上加一条文字', onClick: addTextLayer }, '＋文字'),
                  h('span', { style: S.grow }),
                  h(
                    'label',
                    { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }), title: '默认不带:模型看到字容易去"重画"它,反而更糊' },
                    h('input', { id: 'grsai-submit-texts', type: 'checkbox', checked: submitTexts, onChange: (e) => setSubmitTexts(e.target.checked) }),
                    '提交时带上文字',
                  ),
                ),
                showText
                  ? h(
                      'div',
                      { style: Object.assign({}, S.col, { display: 'flex', gap: 5, padding: '7px 0', borderTop: `1px solid ${line}` }) },
                      h(
                        'div',
                        { style: S.hint },
                        `本机检测到 ${fontList ? fontList.length : '…'} 个候选字体;文字是矢量绘制,导出时按原图分辨率烧入(${selected.naturalW || selected.w}×${selected.naturalH || selected.h})`,
                      ),
                      h(
                        'div',
                        { style: S.row },
                        h('span', { style: S.hint }, '导出尺寸'),
                        h('input', {
                          id: 'grsai-layer-size',
                          style: Object.assign({}, S.input, S.grow),
                          placeholder: `留空 = 原图 ${selected.naturalW || selected.w}×${selected.naturalH || selected.h}`,
                          value: layerSize,
                          title: '分层导出用,和「尺寸」框一样能写人话:1080x1440 / 小红书 / A4 / 210x297mm。比例(3:4)和方向词(竖版)定不出像素,会被当成留空',
                          onChange: (e) => setLayerSize(e.target.value),
                        }),
                        h(
                          'button',
                          {
                            style: S.tiny,
                            title: '导出底图与文字(本地分层,非 AI 拆层)三个文件:① 成品图(底图+文字) ② 无文字底图 ③ 文字参数 JSON —— 底图能换尺寸重出,文字永远清晰',
                            onClick: () => saveImageLayered(selected),
                          },
                          '导出底图与文字',
                        ),
                      ),
                      (selected.texts || []).length
                        ? h(
                            'div',
                            { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                            (selected.texts || []).map((tx) =>
                              h(
                                'button',
                                {
                                  key: tx.id,
                                  style: Object.assign({}, S.tiny, tx.id === selectedTextId ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null),
                                  title: tx.value,
                                  onClick: () => setSelectedTextId(tx.id === selectedTextId ? '' : tx.id),
                                },
                                `${tx.id === selectedTextId ? '✓ ' : ''}${String(tx.value).split('\n')[0].slice(0, 8) || '(空)'}`,
                              ),
                            ),
                          )
                        : h('div', { style: S.hint }, '还没有文字 —— 点「＋文字」加一条,然后在图上拖到想要的位置'),
                      selectedText
                        ? h(
                            'div',
                            { style: S.col },
                            h('textarea', {
                              id: 'grsai-text-value',
                              style: Object.assign({}, S.textarea, { height: 54 }),
                              placeholder: '写要出现在图上的文字(支持换行)',
                              value: selectedText.value,
                              onChange: (e) => updateText(selectedText.id, { value: e.target.value }),
                            }),
                            h(
                              'div',
                              { style: S.row },
                              h('span', { style: S.hint }, '字体'),
                              h(
                                'select',
                                {
                                  id: 'grsai-text-font',
                                  style: Object.assign({}, S.input, { maxWidth: 156 }),
                                  value: selectedText.font,
                                  title: '本机已装的字体(检测到的排前面);也可以直接改文字面板里的字体名',
                                  onChange: (e) => updateText(selectedText.id, { font: e.target.value }),
                                },
                                Array.from(new Set([...(fontList || []), ...FONT_CANDIDATES, selectedText.font].filter(Boolean))).map((font) =>
                                  h('option', { key: font, value: font }, font),
                                ),
                              ),
                              h('label', { style: Object.assign({}, S.tiny, { display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }), title: '载入一个 .ttf/.otf/.woff2 字体文件(系统里没装的也能用)' },
                                '导入字体',
                                h('input', {
                                  id: 'grsai-font-file',
                                  type: 'file',
                                  accept: '.ttf,.otf,.woff,.woff2,font/*',
                                  style: { display: 'none' },
                                  onChange: (e) => {
                                    importFontFile(e.target.files && e.target.files[0]);
                                    e.target.value = '';
                                  },
                                }),
                              ),
                            ),
                            h(
                              'div',
                              { style: S.row },
                              h('span', { style: S.hint }, '字号'),
                              h('input', {
                                id: 'grsai-text-size',
                                type: 'range',
                                min: 2,
                                max: 30,
                                step: 0.5,
                                style: { flex: 1, minWidth: 90 },
                                title: '占图片高度的百分比',
                                value: Math.round((Number(selectedText.size) || TEXT_DEFAULTS.size) * 1000) / 10,
                                onChange: (e) => updateText(selectedText.id, { size: Number(e.target.value) / 100 }),
                              }),
                              h('span', { style: S.hint }, `${Math.round((Number(selectedText.size) || TEXT_DEFAULTS.size) * 1000) / 10}%`),
                              h(
                                'select',
                                { id: 'grsai-text-weight', style: Object.assign({}, S.input, { maxWidth: 78 }), value: String(selectedText.weight || 700), onChange: (e) => updateText(selectedText.id, { weight: Number(e.target.value) }) },
                                ['400', '700', '900'].map((w) => h('option', { key: w, value: w }, w === '400' ? '常规' : w === '700' ? '粗体' : '特粗')),
                              ),
                              h(
                                'select',
                                { id: 'grsai-text-align', style: Object.assign({}, S.input, { maxWidth: 72 }), value: selectedText.align || 'center', onChange: (e) => updateText(selectedText.id, { align: e.target.value }) },
                                [['center', '居中'], ['left', '左对齐'], ['right', '右对齐']].map((pair) => h('option', { key: pair[0], value: pair[0] }, pair[1])),
                              ),
                            ),
                            h(
                              'div',
                              { style: S.row },
                              h('span', { style: S.hint }, '颜色'),
                              COLORS.map((color) =>
                                h('button', {
                                  key: color,
                                  style: { width: 20, height: 20, borderRadius: 4, background: color, border: (selectedText.color || TEXT_DEFAULTS.color) === color ? '2px solid var(--dsw-alias-label-primary, #3b82f6)' : `1px solid ${line}`, cursor: 'pointer', padding: 0 },
                                  title: color,
                                  onClick: () => updateText(selectedText.id, { color }),
                                }),
                              ),
                              h(
                                'label',
                                { style: Object.assign({}, S.hint, { display: 'flex', gap: 4, alignItems: 'center' }) },
                                h('input', { id: 'grsai-text-shadow', type: 'checkbox', checked: selectedText.shadow !== false, onChange: (e) => updateText(selectedText.id, { shadow: e.target.checked }) }),
                                '黑描边(在浅背景上也看得清)',
                              ),
                              h('span', { style: S.grow }),
                              h('button', { style: S.tiny, onClick: () => removeTextLayer(selectedText.id) }, '删掉这条'),
                            ),
                            h('div', { style: S.hint }, '位置:在选择工具下直接把文字拖到想要的地方;字号是"占图高的比例",所以换尺寸/导出都不会跑位'),
                          )
                        : null,
                    )
                  : null,
              )
            : null,
        );
      }

      return { renderPropsCard };
    });

    // ── 零件 36-dock.js ──────────────────────────────────────────────────────────────
/* 受控停靠区(右侧):生成记录 / 图层 / 工作区 / Skills 四个标签共用一块面板。
 *
 * 同一时间只开一个标签(开合状态 `dockOpen` 在 CanvasTab 里,`togglePanel` 按簇分发);
 * 打开任何设置类弹层都会先把停靠区收起来。窄屏时占满除边距外的整行宽。
 *
 * 各标签的内容由调用处渲染好(「history-panel」「workspace-panel」「skills-panel」三个零件
 * 现在只出内容块,不再自带浮层外壳),这里只负责壳:标签栏 + 滚动区。
 *
 * 全局零件作用域里的 `h`/`S`/`line` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('dock', () => {
      /** 四个标签:开合值 + 按钮文案 + 角标取值器(可空)。 */
      const TABS = [
        { id: 'history', label: '记录', badge: (p) => (p.results.length ? String(p.results.length) : '') },
        { id: 'layers', label: '图层', badge: (p) => (p.images && p.images.length ? String(p.images.length) : '') },
        { id: 'workspace', label: '工作区', badge: (p) => (p.wsFiles && p.wsFiles.length ? String(p.wsFiles.length) : '') },
        { id: 'skills', label: 'Skills', badge: (p) => (p.skills && p.skills.length ? String(p.skills.length) : '') },
      ];
      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderDock(p) {
        const {
          panelAnchor,
          dockOpen,
          historyPanel,
          images,
          layersPanel,
          results,
          setDockOpen,
          size,
          skills,
          skillsPanel,
          wsFiles,
          wsPanel,
        } = p;
        if (!dockOpen) return null;
        const narrow = size.w < 640;
        /** 悬停开的这块贴在按钮正下方(按自己的宽度往回收,别顶出右边界);窄屏整行宽,照旧靠右。 */
        const place = panelAnchor && !narrow
          ? { left: Math.max(6, Math.min(panelAnchor.left, panelAnchor.maxRight - 302)), right: 'auto', top: panelAnchor.top }
          : { right: 6, top: 42 };
        const body =
          dockOpen === 'history'
            ? historyPanel
            : dockOpen === 'layers'
              ? layersPanel
              : dockOpen === 'workspace'
                ? wsPanel
                : skillsPanel;
        return h(
          'div',
          {
            // 悬停联动用:鼠标落进这块面板就算「还没走」,收起倒计时作废
            'data-nav-keep': dockOpen,
            style: Object.assign({}, S.float, place, {
              width: narrow ? 'calc(100% - 12px)' : 302,
              maxHeight: 'calc(100% - 150px)',
            }),
          },
          h(
            'div',
            { style: Object.assign({}, S.card, S.col, { gap: 4, padding: 5, maxHeight: '100%', overflow: 'hidden' }) },
            h(
              'div',
              { style: S.row },
              TABS.map((tab) =>
                h(
                  'button',
                  {
                    key: tab.id,
                    style: Object.assign(
                      {},
                      S.wideBtn,
                      { flex: '1 1 0', padding: '5px 2px' },
                      dockOpen === tab.id
                        ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' }
                        : null,
                    ),
                    title: tab.id === 'layers' ? '图层:画布上所有图片的列表(显隐/锁定/排序/改名)' : `看${tab.label}`,
                    onClick: () => setDockOpen(dockOpen === tab.id ? '' : tab.id),
                  },
                  `${tab.label}${tab.badge({ images, results, skills, wsFiles }) ? ` ${tab.badge({ images, results, skills, wsFiles })}` : ''}`,
                ),
              ),
              h(
                'button',
                {
                  style: Object.assign({}, S.tiny, { flex: '0 0 auto', width: 24, padding: '2px 0', fontSize: 13 }),
                  title: '收起面板(鼠标移开也会自动收)',
                  onClick: () => setDockOpen(''),
                },
                '✕',
              ),
            ),
            h('div', { style: { height: 1, background: line, margin: '0 2px' } }),
            h(
              'div',
              { style: Object.assign({}, S.col, { gap: 5, overflowY: 'auto', minHeight: 60 }) },
              body,
            ),
          ),
        );
      }

      return { renderDock };
    });

    // ── 零件 37-compare-view.js ──────────────────────────────────────────────────────
/* 对比视图(第一期 B):两张图并排或滑杆叠加比较,独立覆盖层,关闭后画布分毫不改。
 *
 * 职责边界:
 * - 本零件不持有 state / ref / effect(CanvasTab 的 hook 链会被污染),渲染是纯函数,
 *   绘制是独立函数 drawCompareCanvas,由调用处的 effect 驱动;
 * - 不做拉伸对齐、不宣称配准:两图各按原始宽高比用同一倍率显示,尺寸不同时
 *   明确提示「不是像素级配准」;
 * - 100% = 1 图像像素对 1 物理像素(zoom 取 1/dpr,Retina 屏上不虚标);
 * - 滑杆是 DOM 控件,事件不会穿透到画布;关闭时监听器由调用处清理。
 */
    definePart('compare-view', () => {
      /** 棋盘格背景:透明 PNG 常用的底纹,比较时能看出图有没有透明区。 */
      function drawChecker(ctx, w, h) {
        const size = 12;
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#d4d4d4';
        for (let y = 0; y < h; y += size) {
          for (let x = ((y / size) % 2) * size; x < w; x += size * 2) {
            ctx.fillRect(x, y, size, size);
          }
        }
      }

      /** 以 (cx,cy) 为中心按 zoom 画一张图(自然尺寸 × zoom,不拉伸)。 */
      function drawCentered(ctx, img, cx, cy, zoom) {
        if (!img) return;
        const dw = img.naturalWidth * zoom;
        const dh = img.naturalHeight * zoom;
        ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
      }

      /**
       * 并排模式:左右各占一半。两图用同一 zoom(图像像素→CSS 像素倍率)与平移,
       * 即「同步缩放/平移」;「适应」倍率由调用处按两图都能完整看见来计算。
       */
      function drawSide(ctx, img, x0, halfW, h, cx, cy, zoom) {
        if (!img || !img.naturalWidth) return;
        drawCentered(ctx, img, x0 + halfW / 2 + cx, cy, zoom);
      }

      /**
       * 把两张解码图画到 canvas 上。
       * @param {HTMLCanvasElement} canvas - 画布元素(尺寸随容器)。
       * @param {object} opts - {imgA,imgB,mode:'side'|'slider',swap,slider(0..1),zoom,panX,panY,dpr}
       */
      function drawCompareCanvas(canvas, opts) {
        const { imgA, imgB, mode, swap, slider, zoom, panX, panY, dpr } = opts;
        const w = canvas.clientWidth || 0;
        const hgt = canvas.clientHeight || 0;
        if (!w || !hgt) return;
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(hgt * dpr));
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawChecker(ctx, w, hgt);
        const left = swap ? imgB : imgA;
        const right = swap ? imgA : imgB;
        const cy = hgt / 2 + panY;
        if (mode === 'side') {
          const half = w / 2;
          drawSide(ctx, left, 0, half, hgt, panX, cy, zoom);
          drawSide(ctx, right, half, half, hgt, panX, cy, zoom);
          ctx.strokeStyle = 'rgba(127,127,127,0.6)';
          ctx.beginPath();
          ctx.moveTo(half, 0);
          ctx.lineTo(half, hgt);
          ctx.stroke();
        } else {
          // 滑杆叠加:两图按同一倍率、中心对齐叠放(尺寸不同时不拉伸、不配准,UI 有提示)
          const cx = w / 2 + panX;
          drawCentered(ctx, left, cx, cy, zoom);
          const clipW = Math.max(0, Math.min(w, w * slider));
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, clipW, hgt);
          ctx.clip();
          drawCentered(ctx, right, cx, cy, zoom);
          ctx.restore();
          // 分割线 + 手柄
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(clipW, 0);
          ctx.lineTo(clipW, hgt);
          ctx.stroke();
          ctx.fillStyle = '#3b82f6';
          ctx.beginPath();
          ctx.arc(clipW, hgt / 2, 9, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('↔', clipW, hgt / 2);
          ctx.lineWidth = 1;
        }
      }

      /**
       * @param {object} p - 依赖包(state 与 handler 全部由调用处注入)。
       * @returns {any} 覆盖层(虚拟 DOM)。
       */
      function renderCompareView(p) {
        const {
          S,
          closeCompare,
          compareA,
          compareB,
          compareCanvasRef,
          compareMode,
          comparePointerDown,
          comparePointerMove,
          comparePointerUp,
          compareSlider,
          compareSwap,
          compareWheel,
          compareZoom,
          exportCompareResult,
          fitCompare,
          setCompareMode,
          setCompareSlider,
          setCompareSwap,
          zoom100Compare,
        } = p;
        if (!compareA || !compareB) return null;
        const sizeA = `${compareA.naturalW || '?'}×${compareA.naturalH || '?'}`;
        const sizeB = `${compareB.naturalW || '?'}×${compareB.naturalH || '?'}`;
        const different = sizeA !== sizeB;
        const leftName = compareSwap ? compareB.name : compareA.name;
        const rightName = compareSwap ? compareA.name : compareB.name;
        const modeBtn = (value, label) => h('button', {
          style: Object.assign({}, S.tiny, compareMode === value ? S.btnOn : null),
          onClick: () => setCompareMode(value),
        }, label);
        return h('div', {
          style: {
            position: 'absolute', inset: 0, zIndex: 9,
            background: 'rgba(15,15,18,0.72)', backdropFilter: 'blur(2px)',
            display: 'flex', flexDirection: 'column',
          },
          onWheel: compareWheel,
        },
          // ── 顶栏 ──
          h('div', { style: { display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', padding: '6px 8px' } },
            h('span', { style: { color: '#fff', fontSize: 12, fontWeight: 600 } }, '对比视图'),
            h('span', { style: { color: 'rgba(255,255,255,0.75)', fontSize: 11 } }, `${leftName} ${sizeA} ⇄ ${rightName} ${sizeB}`),
            h('span', { style: S.grow }),
            h('button', { style: S.tiny, title: '交换左右(A/B 角色对调,不改画布)', onClick: () => setCompareSwap(!compareSwap) }, '⇄ 交换'),
            modeBtn('side', '并排'),
            modeBtn('slider', '滑杆叠加'),
            h('button', { style: S.tiny, title: '两图同步缩放到都能看见', onClick: fitCompare }, '适应'),
            h('button', { style: S.tiny, title: '100% = 1 图像像素对 1 物理像素(已按屏幕 DPR 折算)', onClick: zoom100Compare }, '100%'),
            h('button', { style: S.tiny, title: '下载当前的结果图(对比不改图,导出的就是结果原图)', onClick: exportCompareResult }, '导出结果图'),
            h('button', { style: S.tiny, title: '关闭对比(Esc)。画布不会有任何改动', onClick: closeCompare }, '✕ 关闭'),
          ),
          // ── 提示条 ──
          different && h('div', { style: { padding: '0 8px 4px', color: '#fbbf24', fontSize: 11 } },
            `两图尺寸不同(${sizeA} vs ${sizeB}):按原始宽高比同倍率显示、中心/半区对齐 —— 这是像素对比,不是配准对齐`),
          // ── 画布区 ──
          h('div', { style: { flex: 1, minHeight: 0, margin: '0 8px', position: 'relative' } },
            h('canvas', {
              ref: compareCanvasRef,
              style: { position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' },
              onPointerDown: comparePointerDown,
              onPointerMove: comparePointerMove,
              onPointerUp: comparePointerUp,
              onPointerCancel: comparePointerUp,
            }),
            compareMode === 'slider' && h('div', { style: { position: 'absolute', left: 8, right: 8, bottom: 10, display: 'flex', gap: 8, alignItems: 'center', pointerEvents: 'auto' } },
              h('span', { style: { color: '#fff', fontSize: 11, flex: '0 0 auto' } }, `◂ ${leftName}`),
              h('input', {
                id: 'grsai-compare-slider',
                type: 'range', min: 0, max: 1000, value: Math.round(compareSlider * 1000),
                onChange: (e) => setCompareSlider(Number(e.target.value) / 1000),
                style: { flex: 1, accentColor: '#3b82f6' },
                title: '拖动分割线:左边显示一张、右边显示另一张(滑杆事件不会穿透到画布)',
              }),
              h('span', { style: { color: '#fff', fontSize: 11, flex: '0 0 auto' } }, `${rightName} ▸`),
            ),
          ),
          // ── 底部说明 ──
          h('div', { style: { padding: '4px 8px 6px', color: 'rgba(255,255,255,0.6)', fontSize: 11 } },
            `滚轮缩放 · 拖拽平移${compareMode === 'slider' ? ' · 滑杆比对' : ''} · Esc 关闭(画布与原图都不会被改动)${compareZoom ? ` · 当前 ${(compareZoom * 100).toFixed(0)}%` : ''}`),
        );
      }

      return { renderCompareView, drawCompareCanvas };
    });

    // ── 零件 38-layers-panel.js ──────────────────────────────────────────────────────
/* 图层面板(停靠区「图层」标签):紧凑列表 = 缩略图 / 名称 / 参考标记 / 显示 / 锁定。
 *
 * 顺序与 `doc.images` 数组一致:首行 = 最底层(画在最下面),末行 = 最顶层 ——
 * 和左侧工具栏那四个排序按钮(置顶/上移/下移/置底)共用同一套语义。
 *
 * 交互:点行 = 选中(与画布点选同步,Ctrl/Shift+点击 = 加选/减选);
 * 双击名称 = 重命名;拖动行 = 排序;行尾两个开关 = 显示 / 锁定(独立属性,旧图默认全关)。
 * 锁定的行不能拖动、改名,普通删除会跳过它 —— 「解锁」按钮就在行尾。
 *
 * 全局零件作用域里的 `h`/`S`/`line` 直接用;CanvasTab 内部的状态与动作由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js` 的渲染段;漏传会被 `deps()` 当场点出来)。
 */
    definePart('layers-panel', () => {
      /** 拖动中的行 id(dragover/drop 之间传递;零件级变量,不进 React 状态)。 */
      let dragId = null;

      /** 一行的开关按钮:文字 + 提示 + 激活高亮。 */
      function flagBtn(p) {
        // 解构出来叫 isOn / flagText(不叫 active / label / caption):主组件 12-canvas-tab.js 里有
        // `const active = document.activeElement;`、参考图角标的 `const label = …`、占位框的
        // `const caption = …`,check-deps.mjs 按名字取交集,会把这里的 props 解构误判成
        // "引用了主组件的自由变量"并要求 deps 里也传它。改个不撞车的名字就绕开了。
        const { active: isOn, label: flagText, on, title } = p;
        return h(
          'button',
          {
            style: Object.assign({}, S.tiny, {
              width: 26,
              padding: '2px 0',
              textAlign: 'center',
            }, isOn ? { border: '1px solid var(--dsw-alias-label-primary, #3b82f6)', color: 'var(--dsw-alias-label-primary, #3b82f6)' } : null),
            title,
            onClick: on,
          },
          flagText,
        );
      }

      /**
       * @param {object} p - 依赖包。
       * @returns React 元素。
       */
      function renderLayersPanel(p) {
        const {
          deleteSelected,
          images,
          layerRenameId,
          layerRenameText,
          moveImageTo,
          renameImage,
          selectImageFromPanel,
          setImageFlag,
          setLayerRenameId,
          setLayerRenameText,
          selectedId,
          selectedIds,
        } = p;

        if (!images.length) {
          return h('div', { style: Object.assign({}, S.hint, { padding: '6px 2px' }) },
            '画布上还没有图片 —— 用左上角「＋图片」加一张,加进来的图都会出现在这里。');
        }

        const picked = new Set(selectedIds.length ? selectedIds : selectedId ? [selectedId] : []);
        const rows = images.map((im, idx) => {
          const editing = layerRenameId === im.id;
          const isTop = idx === images.length - 1;
          const row = h(
            'div',
            {
              key: im.id,
              draggable: !editing && !im.locked,
              style: Object.assign({}, S.row, {
                alignItems: 'center',
                gap: 4,
                padding: '3px 4px',
                borderRadius: 4,
                cursor: 'default',
                border: picked.has(im.id) ? '1px solid var(--dsw-alias-label-primary, #3b82f6)' : '1px solid transparent',
                background: picked.has(im.id) ? 'rgba(59,130,246,0.08)' : 'transparent',
                opacity: im.hidden ? 0.55 : 1,
              }),
              title: im.locked ? '已锁定:可选中查看,不能拖动/缩放/标注/改名/删除(行尾可解锁)' : undefined,
              onDragStart: (event) => {
                dragId = im.id;
                if (event && event.dataTransfer) {
                  event.dataTransfer.effectAllowed = 'move';
                  try { event.dataTransfer.setData('text/plain', im.id); } catch { /* 老实现只读 */ }
                }
              },
              onDragOver: (event) => {
                if (!dragId || dragId === im.id) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
              },
              onDrop: (event) => {
                event.preventDefault();
                const moving = dragId;
                dragId = null;
                if (!moving || moving === im.id) return;
                // 行的上半 = 插到这张图前面;下半 = 插到下一张前面(末行下半 = 顶层)
                const half = (event && event.nativeEvent && typeof event.nativeEvent.offsetY === 'number' && event.currentTarget.getBoundingClientRect)
                  ? event.nativeEvent.offsetY - 0 < event.currentTarget.getBoundingClientRect().height / 2
                  : true;
                const beforeId = half ? im.id : (isTop ? null : images[idx + 1].id);
                moveImageTo(moving, beforeId);
              },
              onDragEnd: () => { dragId = null; },
              onClick: (event) => selectImageFromPanel(im.id, event),
            },
            // 缩略图
            h('img', {
              width: 34,
              height: 34,
              src: im.dataUrl,
              alt: im.name || '图片',
              draggable: false,
              style: { width: 34, height: 34, objectFit: 'cover', borderRadius: 3, background: 'rgba(127,127,127,0.2)', flex: '0 0 auto' },
            }),
            // 名称(双击改名)
            editing
              ? h('input', {
                id: 'grsai-layer-rename',
                  key: 'rename',
                  autoFocus: true,
                  style: Object.assign({}, S.input, { flex: '1 1 0', minWidth: 60, padding: '2px 4px' }),
                  value: layerRenameText,
                  title: '回车确认,Esc 取消',
                  onChange: (e) => setLayerRenameText(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                      renameImage(im.id, layerRenameText);
                      setLayerRenameId('');
                    } else if (e.key === 'Escape') {
                      setLayerRenameId('');
                    }
                  },
                  onBlur: () => {
                    renameImage(im.id, layerRenameText);
                    setLayerRenameId('');
                  },
                })
              : h('span', {
                  style: Object.assign({}, S.grow, {
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textDecoration: im.hidden ? 'line-through' : 'none',
                  }),
                  title: `${im.name}(${im.naturalW || im.w}×${im.naturalH || im.h})双击改名`,
                  onDoubleClick: () => { setLayerRenameId(im.id); setLayerRenameText(im.name || ''); },
                }, `${im.locked ? '🔒 ' : ''}${im.name || '(未命名)'}`),
            // 参考标记 + 开关
            im.isRef ? h('span', { style: Object.assign({}, S.badge, { flex: '0 0 auto' }), title: '参考图:提交时会一起发给模型(点「参」取消)' }, '参考') : null,
            flagBtn({
              label: '参',
              active: im.isRef,
              title: im.isRef ? '取消参考图标记(不再发给模型)' : '标记为参考图(提交时会一起发给模型)',
              on: () => setImageFlag(im.id, 'isRef', !im.isRef),
            }),
            flagBtn({
              label: im.hidden ? '显' : '隐',
              active: im.hidden,
              title: im.hidden ? '显示这张图(恢复绘制与命中)' : '隐藏这张图(不绘制、不参与命中与提交)',
              on: () => setImageFlag(im.id, 'hidden', !im.hidden),
            }),
            flagBtn({
              label: im.locked ? '已锁' : '锁',
              active: im.locked,
              title: im.locked ? '解锁(恢复拖动/缩放/标注/改名/删除)' : '锁定(防误改:不能拖动/缩放/标注/改名/删除)',
              on: () => setImageFlag(im.id, 'locked', !im.locked),
            }),
            h('button', {
              style: Object.assign({}, S.tiny, { width: 26, padding: '2px 0', textAlign: 'center', color: im.locked ? 'rgba(127,127,127,0.55)' : '#e5484d' }),
              title: im.locked ? '已锁定:删除会跳过这张图' : '删除这张图(可 Ctrl+Z 撤销)',
              onClick: () => {
                selectImageFromPanel(im.id, null);
                deleteSelected();
              },
            }, '删'),
          );
          return row;
        });

        return h(
          'div',
          { style: Object.assign({}, S.col, { gap: 2 }) },
          rows,
          h('div', { style: { height: 1, background: line, margin: '2px 0' } }),
          h('div', { style: Object.assign({}, S.hint, { fontSize: 11 }) },
            '首行在最底层,末行在最顶层;拖动行排序(锁定行不能拖)。隐藏的图不绘制、点不到、也不参与提交;锁定的图防误改,但可以选中查看、照常导出。'),
        );
      }

      return { renderLayersPanel };
    });

    // ── 零件 40-update-center.js ─────────────────────────────────────────────────────
/* 插件自我更新(「更新」按钮):问宿主现状、检查清单、下载安装、回滚上一版。
 *
 * 下载/校验/解压/替换全部由宿主半边做(浏览器跨域拿不到别人的站点、也写不了安装目录),这里只管把结果说清楚。全局零件作用域里的 `api`/`DEFAULT_UPDATE_URL`/`compareVersion` 直接用;CanvasTab 内部的状态与 ref 由调用处经 `p` 注入(调用处见 `12-canvas-tab.js`);
 * 零件里的函数闭包的是**当次渲染**的 p,所以每渲染一次就建一次(和原来一模一样)。
 */
    definePart('update-center', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns {{ canUpdate, effectiveUpdateUrl, loadUpdateStatus, checkUpdate, applyUpdateNow, rollbackUpdateNow }} 这组动作。
       */
      function createUpdateCenter(p) {
        const {
          featuresRef,
          sessionRef,
          setNotice,
          setUpdateBusy,
          setUpdateInfo,
          setUpdateNote,
          setUpdateStatus,
          updateDraft,
          updateUrl,
        } = p;

        /** 宿主支不支持更新(旧宿主没有这组路由)。 */
        function canUpdate() {
          return featuresRef.current.includes('update');
        }

        /** 这次要用哪个更新源:自己填的优先,留空就用内置默认地址(装好即自动检测)。 */
        function effectiveUpdateUrl() {
          return String(updateUrl || '').trim() || DEFAULT_UPDATE_URL;
        }

        /** 问宿主「我现在是什么版本、有没有备份」——不发网络请求,打开面板就能看到。 */
        async function loadUpdateStatus() {
          if (!canUpdate()) return null;
          try {
            const data = await api('/update/status', undefined, sessionRef.current);
            setUpdateStatus(data && data.ok ? data : null);
            return data;
          } catch {
            setUpdateStatus(null);
            return null;
          }
        }

        /**
         * 检查有没有新版本。
         * @param {boolean} silent - 静默模式(启动时自动跑):失败不打扰,只在真有新版时冒个角标。
         * @returns {Promise<void>} 检查完。
         */
        async function checkUpdate(silent) {
          const url = String(silent ? effectiveUpdateUrl() : updateDraft.trim() || effectiveUpdateUrl()).trim();
          if (!url) {
            if (!silent) setUpdateNote('先在下面填「更新地址」——就是那份清单 JSON 的完整地址');
            return;
          }
          if (!canUpdate()) {
            if (!silent) setUpdateNote('宿主半边是旧版:更新要重启一次 DSH 才能用');
            return;
          }
          setUpdateBusy('check');
          if (!silent) setUpdateNote('');
          try {
            const data = await api('/update/check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url }),
            }, sessionRef.current);
            setUpdateInfo(data);
            await loadUpdateStatus();
            if (data.newer) {
              // 自动检测到新版:状态栏留一句,设置按钮也会变成「设置 ⬆x.y.z」
              setNotice(`插件有新版本 ${data.version}(当前 ${data.current})—— 设置 → ③ 插件更新`);
            }
            if (!silent) {
              // 三种情况分开说清:站点更新、本机反而更新(站点还没发布这一版)、两边一样
              const ahead = !data.newer && compareVersion(data.current, data.version) > 0;
              setUpdateNote(
                data.newer
                  ? `发现新版本 ${data.version}(当前 ${data.current})——点「立即更新」就会下载安装`
                  : ahead
                    ? `已经是最新的:本机 ${data.current} 比站点上的 ${data.version} 还新(站点还没发布这一版)`
                    : `已经是最新的(当前 ${data.current},发布的是 ${data.version})`,
              );
            }
          } catch (e) {
            if (!silent) setUpdateNote(`检查失败:${String((e && e.message) || e)}`);
            else setUpdateInfo(null);
          } finally {
            setUpdateBusy('');
          }
        }

        /** 下载并就地安装(宿主会先备份、校验 sha256、只写插件目录)。 */
        async function applyUpdateNow() {
          const url = String(updateDraft.trim() || effectiveUpdateUrl()).trim();
          if (!url) {
            setUpdateNote('先填更新地址');
            return;
          }
          setUpdateBusy('apply');
          setUpdateNote('');
          try {
            const data = await api('/update/apply', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url }),
            }, sessionRef.current);
            setUpdateNote(`已更新:${data.from} → ${data.to}(${data.files} 个文件)。刷新页面即用上新客户端;宿主半边要重启 DSH 才生效。`);
            setNotice(`插件已更新到 ${data.to} —— 重启 DSH 后宿主也换新`);
            setUpdateInfo(null);
            await loadUpdateStatus();
          } catch (e) {
            setUpdateNote(`更新失败(什么都没改):${String((e && e.message) || e)}`);
          } finally {
            setUpdateBusy('');
          }
        }

        /** 回滚到上一个版本(上一次更新前自动备份的那份)。 */
        async function rollbackUpdateNow() {
          setUpdateBusy('rollback');
          setUpdateNote('');
          try {
            const data = await api('/update/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, sessionRef.current);
            setUpdateNote(`已回滚到 ${data.to}(${data.files} 个文件)。刷新页面生效,宿主同样要重启 DSH。`);
            setNotice(`插件已回滚到 ${data.to}`);
            await loadUpdateStatus();
          } catch (e) {
            setUpdateNote(`回滚失败:${String((e && e.message) || e)}`);
          } finally {
            setUpdateBusy('');
          }
        }

        return { canUpdate, effectiveUpdateUrl, loadUpdateStatus, checkUpdate, applyUpdateNow, rollbackUpdateNow };
      }

      return { createUpdateCenter };
    });

    // ── 零件 41-generate.js ──────────────────────────────────────────────────────────
/* 提交与生成:把「原图 + 标注」合成提交图、拼请求体、建任务、轮询取图、把结果摆回画布(原图旁边/生成框里)。
 *
 * 全局零件作用域里的 `api`/`sleep`/`uid`/`stamp`/`decodeImage`/`resizeDataUrl`/`proxyImageDataUrl`/`buildGenerateBody`/`sizeErrorFix`/`describeMarks`/`markHint`/`submissionSize`/`marksBounds`/`renderMarks`/`naturalMarkMap`/`drawImageTexts`/`classifyStatus`/`pickImageUrl`/`readPendingTasks`/`writePendingTasks`/`imageBounds`/`screenToWorld`/`fitCamera`/`rectVisible`/`parsePixelSize`/`clamp`/`MAX_PLACE_SIZE`/`GAP`/`MAX_SUBMIT_BYTES`/`SOURCE_SIZE` 直接用;CanvasTab 内部的状态与 ref 由调用处经 `p` 注入(调用处见 `12-canvas-tab.js`);
 * 零件里的函数闭包的是**当次渲染**的 p,所以每渲染一次就建一次(和原来一模一样)。
 */
    definePart('generate', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns {{ buildSubmission, referenceDataUrl, pollTask, placeResultImage, addPendingTask, removePendingTask, run }} 这组动作。
       */
      function createGenerate(p) {
        const {
          activeSkill,
          aliveRef,
          apikey,
          apiBase,
          appendHint,
          background,
          batchSizes,
          busy,
          camRef,
          cancelRef,
          cropToMark,
          customSize,
          docRef,
          expandFrameRef,
          finishChange,
          imageSize,
          imgCacheRef,
          jobsRef,
          model,
          onRecord,
          pendingRef,
          placeLockRef,
          prompt,
          quality,
          ratio,
          selected,
          selectedFrameId,
          scheduleDraw,
          sessionRef,
          setBusy,
          setError,
          setLastUpstream,
          setNotice,
          setPhase,
          setProgress,
          setRatio,
          setResults,
          setSelectedId,
          setSelectedIds,
          setShowSettings,
          sizeRef,
          submitTexts,
        } = p;

        /**
         * 合成「原图 + 标注」。先按上限等比缩小再合成 —— 大图按原始分辨率合成会爆内存/请求体。
         * @param image - 要提交的图片对象。
         * @returns {{ dataUrl, width, height, sourceWidth, sourceHeight, scaled, marks, cropped, bytes }}
         */
        function buildSubmission(image) {
          const el = imgCacheRef.current.get(image.id);
          if (!el || !el.complete || !el.naturalWidth) throw new Error('图片还在解码,稍等一下再提交');
          const naturalW = el.naturalWidth || image.naturalW || image.w;
          const naturalH = el.naturalHeight || image.naturalH || image.h;
          const list = docRef.current.marks.filter((mk) => mk.targetId === image.id);
          const region = submissionRegion(naturalW, naturalH, list, cropToMark);
          const { sx, sy, cropped } = region;
          const sw = region.width;
          const sh = region.height;
          const full = { width: region.fullWidth, height: region.fullHeight };
          const maskList = list.filter((mk) => mk.kind === 'mask');
          // 蒙版是"整图压暗 + 把涂过的地方抠亮":坐标按整张图算,一旦再裁剪就对不上了。
          // 所以有蒙版时自动按整图提交(裁剪勾了也不裁),免得压暗的罩子错位。
          const off = document.createElement('canvas');
          off.width = sw;
          off.height = sh;
          const c = off.getContext('2d');
          // 一次 drawImage 完成「缩放 + 裁剪」:整图按比例画在 (-sx,-sy) 上
          c.drawImage(el, 0, 0, naturalW, naturalH, -sx, -sy, full.width, full.height);
          // 蒙版:先把整张图压暗,再用 destination-out 把涂过的那几笔抠回原亮度。
          // 模型看到"还亮着的那片"就是这次要改的地方,比单画一块更不容易误解。
          if (maskList.length) {
            const maskMap = naturalMarkMap(full.width, full.height);
            c.save();
            c.fillStyle = 'rgba(0, 0, 0, 0.45)';
            c.fillRect(0, 0, full.width, full.height);

            // 不能直接对主画布用 destination-out:那会把蒙版区域擦成透明,
            // 上游拿到的是棋盘格而不是"恢复亮度的原图"。先做一张只含蒙版
            // alpha 的图,把原图裁进这张图后再盖回主画布。
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = full.width;
            maskCanvas.height = full.height;
            const maskCtx = maskCanvas.getContext('2d');
            maskCtx.strokeStyle = '#fff';
            maskCtx.lineCap = 'round';
            maskCtx.lineJoin = 'round';
            for (const mk of maskList) {
              maskCtx.lineWidth = Math.max(1, maskMap.wpx(mk.width));
              maskCtx.beginPath();
              for (let i = 0; i < mk.points.length; i += 1) {
                const q = maskMap.toPx(mk.points[i][0], mk.points[i][1]);
                if (i === 0) maskCtx.moveTo(q[0], q[1]);
                else maskCtx.lineTo(q[0], q[1]);
              }
              if (mk.points.length === 1) {
                const q = maskMap.toPx(mk.points[0][0], mk.points[0][1]);
                maskCtx.lineTo(q[0] + 0.01, q[1]);
              }
              maskCtx.stroke();
            }
            const restore = document.createElement('canvas');
            restore.width = full.width;
            restore.height = full.height;
            const restoreCtx = restore.getContext('2d');
            restoreCtx.drawImage(el, 0, 0, naturalW, naturalH, 0, 0, full.width, full.height);
            restoreCtx.globalCompositeOperation = 'destination-in';
            restoreCtx.drawImage(maskCanvas, 0, 0);
            c.globalCompositeOperation = 'source-over';
            c.drawImage(restore, 0, 0);
            c.restore();
          }
          if (!cropped && list.length) renderMarks(c, list, naturalMarkMap(full.width, full.height));
          // 文字图层默认**不**烧进提交图:模型看到图里有字,经常会试图"重画"它,结果更糊。
          // 想让它参与改图就在文字面板里勾「提交时带上文字」。
          if (submitTexts && Array.isArray(image.texts) && image.texts.length) {
            c.save();
            c.translate(-sx, -sy);
            drawImageTexts(c, image.texts, full.width, full.height);
            c.restore();
          }
          const dataUrl = off.toDataURL('image/png');
          if (!dataUrl || dataUrl.length < 64) throw new Error('合成失败:这张图太大,浏览器拿不出图像数据');
          return {
            dataUrl,
            width: sw,
            height: sh,
            sourceWidth: naturalW,
            sourceHeight: naturalH,
            scaled: full.width !== naturalW || full.height !== naturalH,
            marks: list.length,
            cropped,
            bytes: dataUrl.length,
          };
        }

        /**
         * 参考图也按同一上限缩一下,免得整包爆掉;本来就不大就原样返回。
         * @param image - 图片对象。
         * @returns {string} 提交用的 dataURL。
         */
        function referenceDataUrl(image) {
          const el = imgCacheRef.current.get(image.id);
          if (!el || !el.complete || !el.naturalWidth) return image.dataUrl;
          const size = submissionSize(el.naturalWidth, el.naturalHeight);
          if (size.scale >= 1) return image.dataUrl;
          const off = document.createElement('canvas');
          off.width = size.width;
          off.height = size.height;
          off.getContext('2d').drawImage(el, 0, 0, size.width, size.height);
          const dataUrl = off.toDataURL('image/png');
          return dataUrl && dataUrl.length > 64 ? dataUrl : image.dataUrl;
        }

        /**
         * 轮询任务直到出图。
         * @param id - 任务 id。
         * @param key - APIKEY。
         * @param options - `{isActive}` 续查生命周期检查、`{stop}` 打断判定、`{onProgress}` 进度回传(并发生成时用)。
         * @returns {Promise<string>} 结果图 URL。
         */
        async function pollTask(id, key, options) {
          // 「打断」怎么判定:正常生成用每个任务自己的旗子(options.stop);
          // 续查没有任务表,就还用全局的 cancelRef(点占位框上的「打断」也是置它)。
          const stopped = (options && options.stop) || (() => Boolean(cancelRef.current));
          let failures = 0;
          for (let i = 0; i < 240; i += 1) {
            // 把 3 秒拆成 6×0.5 秒:「打断」最多半秒内就能生效,而不是干等整 3 秒。
            for (let s = 0; s < 6; s += 1) {
              await sleep(500);
              if (options && options.isActive && !options.isActive()) throw new Error('续查已停止,任务保留等待下次恢复');
              if (stopped()) {
                const cancel = new Error('已打断本次生成');
                cancel.cancelled = true;
                throw cancel;
              }
              if (!aliveRef.current) throw new Error('画布标签页被关掉了(任务还在后台,重开画布会自动接着查)');
            }
            let data;
            try {
              data = await api(`/result?id=${encodeURIComponent(id)}`, { headers: { 'x-grsai-key': key, 'x-grsai-base': apiBase } }, sessionRef.current);
            } catch (e) {
              failures += 1;
              if (failures >= 5) throw e;
              continue;
            }
            failures = 0;
            if (!data) continue;
            let raw = '';
            try {
              raw = JSON.stringify(data).slice(0, 260);
            } catch {
              raw = '';
            }
            setLastUpstream(raw);
            const kind = classifyStatus(data.status);
            if (kind === 'done') {
              const url = pickImageUrl(data);
              if (!url) throw new Error(`任务成功了,但上游没给出图片地址。上游返回:${raw}`);
              return url;
            }
            if (kind === 'running') {
              if (typeof data.progress === 'number') {
                const pct = clamp(Math.round(data.progress), 0, 100);
                // 并发生成时不能往全局的 progress/phase 写(几张会互相盖):
                // 谁在跑就把进度报给谁自己的任务,汇总文案由任务表统一刷。
                if (options && options.onProgress) options.onProgress(pct);
                else {
                  setProgress(pct);
                  setPhase(`生成中… ${pct}%`);
                }
              } else if (!options || !options.onProgress) setPhase('生成中…');
              continue;
            }
            const reason =
              data.error ||
              data.msg ||
              data.failure_reason ||
              data.failureReason ||
              (kind === 'failed' ? '上游报告生成失败' : `未知任务状态:${data.status === undefined ? '(空)' : String(data.status)}`);
            const failure = new Error(String(reason));
            // 明确的失败(违规/失败)才算终局;未知状态/超时留着让续查再试
            failure.definitive = kind === 'failed';
            failure.raw = raw;
            throw failure;
          }
          throw new Error('等待超时(约 12 分钟)。任务可能还在跑 —— 重开画布会自动接着查。');
        }

        /**
         * 把一张结果图摆到画布上(原图旁边)。
         * @param dataUrl - 图片数据(dataURL)。
         * @param targetId - 原图 id;找不到就放到最右边/视口中央。
         * @returns {Promise<object|null>} 新图片对象。
         */
        async function placeResultImage(dataUrl, targetId, frame, opts) {
          const o = opts || {};
          let el = await decodeImage(dataUrl);
          // 「成品尺寸」:上游按最接近的档位渲染,这里再本地缩到你要的精确尺寸 ——
          // 画布上这张图、`存`、`下载` 用的都是缩放后的数据,所以交付尺寸就是你指定的那个。
          // 跨平台出图时每张的目标尺寸不一样,所以 `o.exactSize` 优先(不传就还是当前选的成品尺寸)。
          const exact = parsePixelSize(o.exactSize === undefined ? customSize : o.exactSize);
          if (exact && (exact[0] !== el.naturalWidth || exact[1] !== el.naturalHeight)) {
            dataUrl = resizeDataUrl(el, exact[0], exact[1]);
            el = await decodeImage(dataUrl);
          }
          const naturalW = el.naturalWidth || 512;
          const naturalH = el.naturalHeight || 512;
          const target = docRef.current.images.find((im) => im.id === targetId) || null;
          const cam = camRef.current;
          const view = sizeRef.current;
          // 新任务固定锚点并累加实际高度;slot 仅兼容旧任务记录。
          const slot = Math.max(0, Number(o.slot) || 0);
          const placement = o.placement;
          let w;
          let hh;
          let x;
          let y;
          if (frame) {
            // 结果填进生成框:位置与尺寸都按框。
            // 这是刻意的 —— 框就是用户要的成品尺寸(广告物料按框交付),宁可让它填满也不要
            // 等比内切留出白边。上游只按最接近的档位出图,比例差得多时确实会拉伸,
            // 但裁切/留白对成品更糟;要换比例就换框,或选一个能出目标比列的模型。
            w = Math.max(32, Math.round(frame.w));
            hh = Math.max(32, Math.round(frame.h));
            x = frame.x;
            y = frame.y;
          } else {
            const baseW = placement ? placement.w : target ? target.w : Math.min(MAX_PLACE_SIZE, naturalW);
            w = Math.max(32, Math.round(baseW));
            hh = Math.max(32, Math.round((naturalH / naturalW) * w));
            if (placement) {
              x = placement.x;
              y = placement.y + (Number(o.offsetY) || 0);
            } else if (target) {
              x = target.x + target.w + GAP;
              y = target.y + slot * (hh + GAP);
            } else {
              const box = imageBounds(docRef.current.images);
              if (box) {
                x = box.x1 + GAP;
                y = box.y0 + slot * (hh + GAP);
              } else {
                const [cx, cy] = screenToWorld(cam, view.w / 2, view.h / 2);
                x = cx - w / 2;
                y = cy - hh / 2 + slot * (hh + GAP);
              }
            }
          }
          const image = {
            id: uid('img'),
            // 指定了成品尺寸就把尺寸写进文件名,存到工作区后一眼能认出来
            name: `${exact ? `结果-${naturalW}x${naturalH}` : '结果'}-${stamp()}.png`,
            dataUrl,
            x,
            y,
            w,
            h: hh,
            naturalW,
            naturalH,
            isRef: false,
          };
          // 普通生成:只摘掉"这一次提交用的那个框",别的框留着(用户可能还要用)。
          // 扩图(`o.clearFrames`):整个画布的框都清掉 —— 结果图已经把这片区域占住了,
          // 留着旧框只会和结果图重叠、还挡点击。
          const nextFrames = o.clearFrames
            ? []
            : frame
              ? (docRef.current.frames || []).filter((f) => f.id !== frame.id)
              : docRef.current.frames || [];
          docRef.current = { images: [...docRef.current.images, image], marks: docRef.current.marks, frames: nextFrames };
          imgCacheRef.current.set(image.id, el);
          setSelectedId(image.id);
          setSelectedIds([image.id]);
          if (!rectVisible(cam, view, image.x, image.y, image.w, image.h)) {
            camRef.current = fitCamera(docRef.current.images, view);
          }
          finishChange(true);
          return image;
        }

        /**
         * 估算「这次要出的图」会落在哪、多大 —— 只给画布上的**生成占位框**用。
         *
         * 分支与 `placeResultImage` 一一对应(生成框 → 锚点 → 主图右侧 → 已有图右侧 → 视口中央),
         * 免得出现"框画在这儿、图却落在别处"。真实像素要等出图才知道,所以高度按
         * `placeholderAspect` 估出来的比例算 —— 有生成框(直接用框)或勾了成品尺寸时是**精确**的,
         * 其余情况略有出入(落图时会按真实比例重算,幅面只差一点点)。
         * @param {object} opts - frame / exactSize / aspectRatio / sourceAspect / targetId / placement / offsetY。
         * @returns {{x: number, y: number, w: number, h: number}} 世界坐标下的矩形。
         */
        function previewPlaceholderRect(opts) {
          const o = opts || {};
          const frame = o.frame;
          if (frame) {
            return { x: frame.x, y: frame.y, w: Math.max(32, Math.round(frame.w)), h: Math.max(32, Math.round(frame.h)) };
          }
          const aspect = placeholderAspect({ exactSize: o.exactSize, aspectRatio: o.aspectRatio, sourceAspect: o.sourceAspect });
          const natural = parsePixelSize(o.exactSize) || parsePixelSize(o.aspectRatio);
          const target = docRef.current.images.find((im) => im.id === o.targetId) || null;
          const placement = o.placement;
          const offsetY = Number(o.offsetY) || 0;
          let w;
          let x;
          let y;
          if (placement) {
            w = Math.max(32, Math.round(placement.w));
            x = placement.x;
            y = placement.y + offsetY;
          } else if (target) {
            w = Math.max(32, Math.round(target.w));
            x = target.x + target.w + GAP;
            y = target.y + offsetY;
          } else {
            // 上游像素值不知道时按「典型出图长边」估一个宽度 —— 只影响框在屏幕上的观感,不影响落点
            const guess = aspect >= 1 ? 1024 : Math.round(1024 * aspect);
            w = Math.max(32, Math.round(Math.min(MAX_PLACE_SIZE, natural ? natural[0] : guess)));
            const box = imageBounds(docRef.current.images);
            if (box) {
              x = box.x1 + GAP;
              y = box.y0 + offsetY;
            } else {
              const hh = Math.max(32, Math.round(w / aspect));
              const [cx, cy] = screenToWorld(camRef.current, sizeRef.current.w / 2, sizeRef.current.h / 2);
              x = cx - w / 2;
              y = cy - hh / 2;
            }
          }
          return { x, y, w, h: Math.max(32, Math.round(w / aspect)) };
        }

        /**
         * 在画布上挂一个「生成中」的占位框。
         *
         * 它**不进 `doc.images`**(所以不写存档、不进撤销栈、不出现在图层面板与导出里),
         * 只活在 `pendingRef` 这个绘制专用的数组里 —— 出图、失败、打断都会把它摘掉,
         * 绝不会在画布上留下"取不回来的假图"。
         * @param {{x: number, y: number, w: number, h: number}} rect - 世界坐标矩形。
         * @param {string} label - 这次出图的尺寸标签(跨平台出图时是平台名)。
         * @returns {object|null} 注册进去的那一条(清理时要把它传回来)。
         */
        function addPlaceholder(rect, label) {
          if (!pendingRef || !Array.isArray(pendingRef.current)) return null;
          const entry = {
            id: uid('ph'),
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            startedAt: Date.now(),
            label: label || '',
            // 下面这三个是「画布上的框」和「任务」之间的接口:
            // state 决定框里写「排队中」还是百分比,cancel 就是框里那个「⏹ 打断」按下去要干的事。
            pct: 0,
            state: 'queued',
            cancel: null,
          };
          pendingRef.current = [...pendingRef.current, entry];
          if (scheduleDraw) scheduleDraw();
          return entry;
        }

        /** 把占位框摘掉(落图/失败/打断后都要走一遍,否则框会一直挂在画布上)。 */
        function clearPlaceholder(entry) {
          if (!entry || !pendingRef || !Array.isArray(pendingRef.current)) return;
          const list = pendingRef.current;
          const next = list.filter((item) => item.id !== entry.id);
          if (next.length === list.length) return;
          pendingRef.current = next;
          if (scheduleDraw) scheduleDraw();
        }

        /** 记一个未取回的任务(重开画布会接着查)。 */
        function addPendingTask(entry) {
          writePendingTasks([entry, ...readPendingTasks().filter((item) => item.id !== entry.id)]);
        }
        /** 任务取回或终局失败后清掉。 */
        function removePendingTask(id) {
          writePendingTasks(readPendingTasks().filter((item) => item.id !== id));
        }

        // ── 任务表:同时跑几张、谁在排队、每张的进度与打断 ──────────────────
        // 任务本体放 `jobsRef`(一个 ref),**不占 state**:这样连点几次「生成」不会互相顶掉,
        // 生成卡里那几行任务也直接读它。`busy` 只当"还有任务在跑"的汇总。
        // 跨渲染也安全:run()/runJob() 可能在这一次渲染里发起,之后组件重渲染换了新闭包,
        // 但任务表与取消旗子都在 ref / 对象里,按 id 找得到。

        /** 当前的任务表。 */
        function listJobs() {
          return jobsRef && Array.isArray(jobsRef.current) ? jobsRef.current : [];
        }

        /** 写回任务表并刷新汇总状态(phase/progress 只是"给界面看的那一句话")。 */
        function writeJobs(next) {
          if (!jobsRef) return;
          jobsRef.current = next;
          if (!next.length) {
            setBusy(false);
            setPhase('');
            setProgress(0);
          } else {
            const running = next.filter((job) => job.state !== 'queued');
            const active = running[0] || next[0];
            setBusy(true);
            setPhase(
              next.length > 1
                ? `正在生成 ${running.length}/${next.length} 张…`
                : (active && active.phase) || '生成中…',
            );
            setProgress((active && active.pct) || 0);
          }
          if (scheduleDraw) scheduleDraw();
        }

        /** 改一个任务的字段(状态/进度/文案)。 */
        function patchJob(id, fields) {
          let hit = false;
          const next = listJobs().map((job) => {
            if (job.id !== id) return job;
            hit = true;
            return Object.assign({}, job, fields);
          });
          if (hit) writeJobs(next);
        }

        /** 落图要排队:两张同时出图时若一起算位置,会算出同一个点、叠在一起。 */
        function withPlaceLock(fn) {
          const prev = (placeLockRef && placeLockRef.current) || Promise.resolve();
          const next = prev.then(fn, fn);
          if (placeLockRef) placeLockRef.current = next.then(() => undefined, () => undefined);
          return next;
        }

        /** 打断**某一张**(画布上那个框里的「⏹ 打断」按下去就是它)。 */
        function cancelJob(id) {
          const job = listJobs().find((item) => item.id === id);
          if (!job) return;
          if (job.cancelFlag) job.cancelFlag.current = true;
          // 还在排队的任务压根没发出去过:立刻出队,别等下一次 pump(那之前占位框会一直挂着)。
          if (job.state === 'queued') {
            if (job.ph) clearPlaceholder(job.ph);
            writeJobs(listJobs().filter((item) => item.id !== job.id));
            return;
          }
          if (job.ph) job.ph.state = 'cancelling';
          patchJob(id, { phase: '正在打断…' });
        }

        /** 任务收尾:摘占位框、从表里去掉、让排队的补位。 */
        function finishJob(job) {
          if (job.ph) clearPlaceholder(job.ph);
          writeJobs(listJobs().filter((item) => item.id !== job.id));
          pump();
        }

        let pumping = false;
        /**
         * 真正干活的那个函数由 run() 定义(它要用 run 里冻结好的上下文)。
         * 每次渲染都会新建一个 generate 实例,所以这里必须是"最近一次 run 挂上来的"那个。
         */
        let runJobRef = null;
        /** 有空位就把排队中的任务发出去(同时跑几张由设置里的「同时生成」决定,默认 MAX_CONCURRENT_JOBS)。 */
        function pump() {
          if (pumping) return;
          pumping = true;
          try {
            for (let guard = 0; guard < 50; guard += 1) {
              // 没挂上 runJob 就什么也别动:先把任务写成 submitting 再 return 的话,
              // 它既不会被下一次 pump 选中(state 不是 queued),也不会走 finishJob,
              // 并发槽永久 +1,两次之后整条队列就停死了。
              if (!runJobRef) return;
              const list = listJobs();
              const running = list.filter((job) => job.state !== 'queued').length;
              if (running >= concurrencyLimit()) return;
              const queued = list.find((job) => job.state === 'queued');
              if (!queued) return;
              // 排队时就被「撤掉」的任务直接出队:留着它 pump 会照样提交到上游,白花一次钱,
              // 而用户看到的已经是「已从队列里撤掉」。
              if (queued.cancelFlag && queued.cancelFlag.current) {
                if (queued.ph) clearPlaceholder(queued.ph);
                writeJobs(listJobs().filter((job) => job.id !== queued.id));
                continue;
              }
              patchJob(queued.id, { state: 'submitting', phase: '正在提交…', startedAt: Date.now() });
              const current = listJobs().find((job) => job.id === queued.id) || queued;
              runJobRef(current).catch(() => {});
            }
          } finally {
            pumping = false;
          }
        }

        /**
         * 打断**全部**在跑的任务。
         * 界面上的主按钮已经不再变成「打断」了 —— 每张图在自己的占位框里有个「⏹ 打断」;
         * 这个函数留给快捷键/兜底,cancelRef 同时管着续查那条路径。
         */
        function cancelGenerate() {
          cancelRef.current = true;
          const list = listJobs();
          if (!list.length) {
            setPhase('正在打断…');
            return;
          }
          list.forEach((job) => {
            if (job.cancelFlag) job.cancelFlag.current = true;
            if (job.ph) job.ph.state = 'cancelling';
          });
          writeJobs(list.map((job) => Object.assign({}, job, { phase: '正在打断…' })));
        }

        /** 提交一次生成(可连点:不等前一张跑完,多出来的排队)。 */
        async function run() {
          cancelRef.current = false;
          setError('');
          setNotice('');
          if (!apikey) {
            setShowSettings(true);
            setError('先在「设置」里填入 GrsAI APIKEY(在 grsai.com 获取)');
            return;
          }
          // 场景框(生成框):有框就按框生成,结果填进框里
          const frames = docRef.current.frames || [];
          // 扩图框优先:它是刚拉出来的那个,"生成扩图"要填的就是它。
          // 中间点过空白处会把 selectedFrameId 清掉,兜底的 frames[last] 又可能挑错框 ——
          // 一旦挑不到 frame,结果就会掉进"落到主图右侧"的默认分支(看着像另起一行)。
          const expandFrame = expandFrameRef && expandFrameRef.current
            ? frames.find((item) => item.id === expandFrameRef.current) || null
            : null;
          const chosenFrame = expandFrame || frames.find((item) => item.id === selectedFrameId) || frames[frames.length - 1];
          const frame = chosenFrame ? Object.assign({}, chosenFrame) : null;
          const target = selected;
          if (target && target.hidden) {
            setError('主图当前是隐藏状态 —— 先在图层面板里点「显」把它显示出来,再生成');
            return;
          }
          if (!target && !frame && !prompt.trim()) {
            setError('选中一张图、画个生成框,或者写一句提示词直接生成');
            return;
          }
          let submission = null;
          if (target) {
            try {
              submission = buildSubmission(target);
            } catch (e) {
              setError(String((e && e.message) || e));
              return;
            }
          }
          // 隐藏的参考图不参与提交(任务书 C 期:隐藏图不收集参考)
          const refImages = docRef.current.images.filter((im) => im.isRef && !im.hidden && im.id !== (target && target.id));
          const refs = refImages.map((im) => referenceDataUrl(im));
          const payloadImages = submission ? [submission.dataUrl, ...refs] : refs.slice();
          if (!payloadImages.length && !prompt.trim()) {
            setError('至少放一张图,或者写一句提示词');
            return;
          }
          // 体积自查:宁可在这里说清楚,也不要让浏览器把连接掐了报一句 Failed to fetch
          const payloadBytes = payloadImages.reduce((sum, item) => sum + item.length, 0);
          if (payloadBytes > MAX_SUBMIT_BYTES) {
            setError(
              `这次要发 ${(payloadBytes / 1048576).toFixed(1)} MB,超过 ${Math.round(MAX_SUBMIT_BYTES / 1048576)} MB 上限:` +
                '去掉几张参考图、取消勾选参考,或勾上「只提交标注范围(裁剪)」再试',
            );
            return;
          }
          const targetMarkList = target ? docRef.current.marks.filter((mk) => mk.targetId === target.id) : [];
          // 把标注翻译成文字说明:图像模型不像读图 agent 那样会"看懂箭头",得直接告诉它
          const annotationBrief = !(submission && submission.marks)
            ? ''
            : submission.cropped
              ? describeMarks(targetMarkList.filter((mk) => mk.kind === 'text'))
              : describeMarks(targetMarkList);
          const text = [
            activeSkill ? activeSkill.prompt : '',
            prompt.trim(),
            annotationBrief,
            submission && submission.marks && appendHint ? markHint(submission) : '',
          ]
            .filter(Boolean)
            .join('\n\n');
          // 参考图编号说明:用户在提示词里点了名("参考图 2"/"图 3"/"第 2 张")才补 ——
          // 画布角标和生成卡片上的「参考图 N」就是这里的 N,模型看到的顺序是
          // [主图, 参考图1, 参考图2 …],所以要把"你说的参考图 N 是第几张"讲明白,
          // 否则图像模型只会把它们当成一堆平等的图。没点名就不塞,省得每次请求多一段废话。
          const refLegend = (() => {
            if (!refImages.length) return '';
            // 正则故意写 `[ \t]` / `[0-9]` 而不是 `\s` / `\d`:check-deps.mjs 是按标识符取交集的,
            // `\d` / `\s` 里的字母会被当成主组件的变量(12-canvas-tab.js 里确实有 `const d` / `const s`),
            // 于是误报"漏传依赖"。
            if (!/参考[ \t]*图?[ \t]*[0-9]|图[ \t]*[0-9]|第[ \t]*[0-9]+[ \t]*张/.test(text)) return '';
            const base = submission ? 2 : 1;
            const head = submission
              ? '参考图编号说明:这次提交的第 1 张是主图(要改的那张),参考图从第 2 张开始'
              : '参考图编号说明:这次没有主图,提交的第 1 张就是参考图1';
            const lines = refImages.map((im, i) => `参考图${i + 1} = 第 ${i + base} 张(${im.name})`);
            return `${head};${lines.join(';')}。`;
          })();
          const fullText = refLegend ? `${text}\n\n${refLegend}` : text;
          // 尺寸最后再掰一次:不同模型吃的格式不一样(gpt-image-2-vip 只认像素值)。
          // 「原图比例」要的是**实际要发出去那张图**的比例:有主图就是主图(勾了裁剪就是裁出来那块,
          // submission 的宽高已经是裁剪后的),只发参考图时用第一张参考图的自然尺寸。
          const refImage = refImages[0];
          const sourceAspect = frame
            ? frame.w / frame.h
            : submission
              ? submission.width / submission.height
              : refImage && refImage.naturalW && refImage.naturalH
                ? refImage.naturalW / refImage.naturalH
                : 0;
          const submissionNote = submission ? `${submission.width}×${submission.height}` : `${refs.length} 张参考图`;
          // 「跨平台」勾了尺寸就一批一批出:每张的参数先冻结成 plan ——
          // runJob 里有 await,期间组件可能重渲染(闭包里的 p 会换新的),不冻住就会串味。
          const batch = Array.isArray(batchSizes) ? batchSizes.filter(Boolean) : [];
          const plans = (batch.length ? batch : [frame ? '' : customSize || '']).map((sizeValue, index) => ({
            model,
            text: fullText,
            payloadImages,
            ratio: frame ? SOURCE_SIZE : ratio,
            sourceAspect,
            outputSize: sizeValue || '',
            exactSize: sizeValue || (frame ? '' : customSize) || '',
            quality,
            background,
            imageSize,
            targetId: target ? target.id : null,
            frame: index === 0 ? frame : undefined,
            slot: index,
            submissionNote,
            payloadBytes,
            label: (COMMON_OUTPUT_SIZES.find((item) => item.value === sizeValue) || {}).label || sizeValue || '当前尺寸',
            // ↓ 入库/续查要用的**当次快照**。并发生成时 runJob 可能已经跑在"另一次渲染"里,
            //   那时候闭包里的 prompt/target/refImages 早换人了 —— 所以一律先冻在这儿。
            promptUser: prompt.trim(),
            skillId: activeSkill ? activeSkill.id : '',
            skillText: activeSkill ? activeSkill.prompt : '',
            sourceId: target ? target.id : '',
            sourceName: target ? target.name : '',
            refCount: refImages.length,
            refNames: refImages.map((im) => im.name),
            cropped: Boolean(submission && submission.cropped),
            marksCount: submission && Array.isArray(submission.marks) ? submission.marks.length : 0,
            textsCount: target && Array.isArray(target.texts) ? target.texts.length : 0,
            submitTexts: Boolean(submitTexts),
          }));
          // 每个 plan 的请求体与比例提前算好(原来是进了 runOne 才算):
          // 占位框要在**排队的时候**就画出来 —— 先有框、再慢慢跑,才叫"不用干等"。
          for (const plan of plans) {
            plan.body = buildGenerateBody({
              model: plan.model,
              prompt: plan.text,
              images: plan.payloadImages,
              ratio: plan.ratio,
              sourceAspect: plan.sourceAspect,
              outputSize: plan.outputSize,
              quality: plan.quality,
              background: plan.background,
              imageSize: plan.imageSize,
            });
            plan.aspect = placeholderAspect({
              exactSize: plan.exactSize,
              aspectRatio: plan.body.aspectRatio,
              sourceAspect: plan.sourceAspect,
            });
          }

          /** 跑一个任务:建任务 → 等结果 → 落图。并发的几张各跑各的,只有"落图"那一步排队。 */
          async function runJob(job) {
            const cfg = job.plan;
            const flag = job.cancelFlag || { current: false };
            let taskId = null;
            try {
              // 提交前先确认这一张还该不该提交。画布已经卸载、或者排队时就被撤掉的任务,
              // 一旦真发了 /generate 就是白花一次钱 —— 而「撤掉」的提示早就给过用户了。
              if (!aliveRef.current) throw new Error('画布已关闭,这张不再提交');
              if (flag.current) {
                const skip = new Error('已打断本次生成');
                skip.cancelled = true;
                throw skip;
              }
              patchJob(job.id, {
                phase: `创建任务(提交 ${cfg.submissionNote} · ${(cfg.payloadBytes / 1048576).toFixed(1)}MB · ${cfg.label})…`,
              });
              const created = await api('/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-grsai-key': apikey, 'x-grsai-base': apiBase },
                body: JSON.stringify(cfg.body),
              }, sessionRef.current);
              taskId = created && created.id;
              if (!taskId) throw new Error((created && (created.error || created.msg)) || '创建任务失败');
              setLastUpstream(JSON.stringify(created).slice(0, 260));
              // 先记下来:万一中途关页面/切标签,重开画布还能把这张图取回来
              addPendingTask({
                id: taskId, model: cfg.model, prompt: cfg.text.slice(0, 200), targetId: cfg.targetId, at: Date.now(),
                frame: cfg.frame, exactSize: cfg.exactSize, aspect: cfg.aspect,
                placement: job.rect ? { x: job.rect.x, y: job.rect.y, w: job.rect.w } : null, offsetY: 0,
              });
              // 任务刚建好就被人打断了:别进轮询,直接当取消处理
              if (flag.current) {
                const cancel = new Error('已打断本次生成');
                cancel.cancelled = true;
                throw cancel;
              }
              patchJob(job.id, { state: 'running', phase: '生成中…' });
              if (job.ph) job.ph.state = 'running';
              const url = await pollTask(taskId, apikey, {
                stop: () => flag.current,
                onProgress: (pct) => {
                  // 进度只回填到**这张自己的框**上 —— 同一条上游上还跑着别的图呢
                  if (job.ph) job.ph.pct = pct;
                  patchJob(job.id, { pct, phase: `生成中… ${pct}%` });
                },
              });
              setResults((prev) => [{ id: taskId, url, at: Date.now(), model: cfg.model, prompt: cfg.text.slice(0, 400) }, ...prev].slice(0, 30));
              patchJob(job.id, { state: 'placing', phase: '落图…' });
              if (job.ph) job.ph.state = 'placing';
              const dataUrl = await proxyImageDataUrl(url, sessionRef.current);
              let made;
              try {
                made = await withPlaceLock(() => {
                // 进锁之后再定落点:前一张已经写回 doc 了,这儿看得见它,两张才不会叠一起。
                // 用户拖过占位框就照他拖的位置落(不再避让);没拖过才按 freeSpotY 往下找空位。
                const spot = job.ph && job.ph.moved
                  ? {
                      placement: { x: job.ph.x, y: job.ph.y, w: job.ph.w },
                      offsetY: 0,
                    }
                  : job.rect
                    ? {
                        placement: {
                          x: job.rect.x,
                          y: freeSpotY(docRef.current.images, job.rect.x, job.rect.y, job.rect.w, job.rect.h),
                          w: job.rect.w,
                        },
                        offsetY: 0,
                      }
                    : { placement: null, offsetY: 0 };
                return placeResultImage(dataUrl, cfg.targetId, cfg.frame, {
                  exactSize: cfg.exactSize,
                  placement: spot.placement,
                  offsetY: spot.offsetY,
                  // 扩图框生成的图会把原先的框一起收掉,不会留个空框在原地。
                  clearFrames: Boolean(cfg.frame && cfg.frame.expand),
                });
                });
              } catch (e) {
                // 图已经下载到手、只是没能放进画布(解码失败/内存不足/尺寸超限):
                // 标记成终局失败,别留在 pending 里让下次重开画布白忙一遍。
                if (e) e.placeFailed = true;
                throw e;
              }
              removePendingTask(taskId);
              // 入库(第一期 A):正常生成与续查都汇到这里,快照只带白名单字段,
              // 不带任何 header/密钥/调试日志。异步执行,不阻塞别的任务,
              // 也不因为持久化失败而重跑生成(那是再花一次钱)。
              if (typeof onRecord === 'function' && made) {
                Promise.resolve(onRecord({
                  taskId,
                  url,
                  dataUrl,
                  w: Number(made.naturalW) || Number(made.w) || 0,
                  h: Number(made.naturalH) || Number(made.h) || 0,
                  model: cfg.model,
                  ratio: cfg.ratio,
                  quality: cfg.quality,
                  background: cfg.background,
                  imageSize: cfg.imageSize,
                  exactSize: cfg.exactSize,
                  outputSize: cfg.outputSize,
                  promptUser: cfg.promptUser,
                  promptFinal: cfg.text,
                  skillId: cfg.skillId,
                  skillText: cfg.skillText,
                  sourceId: cfg.sourceId,
                  sourceName: cfg.sourceName,
                  refCount: cfg.refCount,
                  refNames: cfg.refNames,
                  frame: Boolean(cfg.frame),
                  cropped: cfg.cropped,
                  marksCount: cfg.marksCount,
                  textsCount: cfg.textsCount,
                  submitTexts: cfg.submitTexts,
                })).catch(() => {});
              }
              setNotice(`${job.queueLabel ? `${job.queueLabel} · ` : ''}${cfg.label} 完成 🎉`);
              return made;
            } catch (e) {
              // 打断 / 上游明确失败:这张不用再续查了。网络抖一下留着让续查接着试;
              // 但「结果已经取回、只差放进画布」(placeFailed)也必须收口 —— 否则每次
              // 重开画布都会重新下载再失败一遍,而用户永远等不到那张图。
              if (taskId && e && (e.definitive || e.cancelled || e.placeFailed)) removePendingTask(taskId);
              if (e && e.cancelled) {
                setNotice(`已打断这一张${job.queueLabel ? `(${job.queueLabel})` : ''},结果不会取回`);
              } else {
                const message = String((e && e.message) || e);
                // 上游说「这个尺寸不支持」是常见坑(比例给了只认像素的模型):
                // 直接把尺寸换成合法值,用户再点一次就行,不用自己去研究该填什么
                const sizeFix = sizeErrorFix(cfg.model, cfg.ratio, `${message} ${(e && e.raw) || ''}`);
                if (sizeFix && sizeFix.size !== cfg.ratio) setRatio(sizeFix.size);
                setError([sizeFix ? sizeFix.hint : message, e && e.raw ? `上游返回:${e.raw}` : ''].filter(Boolean).join('\n'));
              }
              return null;
            } finally {
              // 出图/失败/打断都在这儿收口:占位框绝不留在画布上
              finishJob(job);
            }
          }
          // 挂给 pump —— 它是 createGenerate 作用域里的,看不到这儿的 runJob
          runJobRef = runJob;

          // ── 落点预排 ─────────────────────────────────────────────────────
          // 一次点出去的多张,先各自占一个框:顺序往下排,并且躲开画布上已经在跑/排队的框,
          // 免得两个占位框画在同一个位置、出来两张图又叠在一起。
          const occupied = listJobs().map((item) => item.rect).filter(Boolean);
          const startBox = imageBounds(docRef.current.images);
          let basePlacement = target
            ? { x: target.x + target.w + GAP, y: target.y, w: target.w }
            : startBox
              ? { x: startBox.x1 + GAP, y: startBox.y0, w: Math.min(MAX_PLACE_SIZE, parsePixelSize(plans[0].exactSize)?.[0] || MAX_PLACE_SIZE) }
              : null;
          let baseY = basePlacement ? basePlacement.y : 0;
          let nextOffset = 0;
          const fresh = plans.map((plan, index) => {
            // 生成框/成品尺寸能算出精确的落图尺寸;只给比例的模型只能按比例估(见 previewPlaceholderRect)
            let rect = previewPlaceholderRect({
              frame: plan.frame,
              exactSize: plan.exactSize,
              aspectRatio: plan.body.aspectRatio,
              sourceAspect: plan.sourceAspect,
              targetId: plan.targetId,
              placement: basePlacement,
              offsetY: nextOffset,
            });
            if (!plan.frame) {
              rect = Object.assign({}, rect, { y: freeSpotY(occupied, rect.x, rect.y, rect.w, rect.h) });
              occupied.push(rect);
              if (!basePlacement) {
                // 画布上什么都没有的时候:第一张落在哪儿,后面几张就跟成一列(和"排成一列"的老行为一致)
                basePlacement = { x: rect.x, y: rect.y, w: rect.w };
                baseY = rect.y;
              }
              nextOffset = rect.y - baseY + rect.h + GAP;
            }
            const ph = addPlaceholder(
              rect,
              // 单张时标签就是尺寸本身,不用再挂"当前尺寸";跨平台出图才标 "2/3 · 小红书 3:4"
              plans.length > 1 ? `${index + 1}/${plans.length} · ${plan.label}` : '',
            );
            const flag = { current: false };
            const job = {
              id: uid('job'),
              state: 'queued',
              label: plan.label,
              queueLabel: plans.length > 1 ? `${index + 1}/${plans.length}` : '',
              phase: '排队中…',
              pct: 0,
              startedAt: Date.now(),
              plan,
              rect,
              cancelFlag: flag,
              ph,
            };
            // 框与任务挂上钩:画布上那个「⏹ 打断」按下去,打断的就是这一个任务
            if (ph) {
              ph.jobId = job.id;
              ph.state = 'queued';
              ph.cancel = () => cancelJob(job.id);
            }
            return job;
          });

          // 入队即返回:按钮立刻又能点(想再出几张就再点,多的排队,不用干等一张跑完)
          writeJobs([...listJobs(), ...fresh]);
          pump();
        }

        return { buildSubmission, referenceDataUrl, pollTask, placeResultImage, withPlaceLock, addPendingTask, removePendingTask, previewPlaceholderRect, run, cancelGenerate };
      }

      return { createGenerate };
    });

    // ── 零件 42-images.js ────────────────────────────────────────────────────────────
/* 图片操作:选中/删除/清空、图层顺序(置顶/上移/下移/置底)、对齐与分布、批量导出(多选存/下载)、导出成品(存 / 下载 / 复制到剪贴板 / 分层导出)、结果导入,以及工作区图片的读取与挑选。
 *
 * 全局零件作用域里的 `api`/`stamp`/`drawImageTexts`/`decodeImage`/`layerPaths`/`parseExportSize`/`textLayerManifest`/`isFontAvailable`/`TEXT_DEFAULTS`/`clipboardPngBlob`/`proxyImageDataUrl`/`fetchAsDataUrl`/`routeUrl` 直接用;CanvasTab 内部的状态与 ref 由调用处经 `p` 注入(调用处见 `12-canvas-tab.js`);
 * 零件里的函数闭包的是**当次渲染**的 p,所以每渲染一次就建一次(和原来一模一样)。
 */
    definePart('images', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns {{ toggleRef, deleteSelected, reorderSelected, setImageFlag, renameImage, moveImageTo, alignSelected, clearMarks, clearCanvas, renderExportDataUrl, saveImageToWorkspace, saveSelectedToWorkspace, saveImageLayered, downloadImage, downloadSelected, copyImageToClipboard, importResult, openWorkspace, refreshWorkspace, pickWorkspace }} 这组动作。
       */
      function createImages(p) {
        const {
          addImageFromDataUrl,
          camRef,
          docRef,
          dpi,
          finishChange,
          imgCacheRef,
          layerSize,
          savePath,
          selected,
          selectedIds,
          sessionRef,
          setError,
          setNotice,
          setSelectedId,
          setSelectedIds,
          setDockOpen,
          setWsBusy,
          setWsFiles,
          wsFiles,
        } = p;

        function toggleRef() {
          const image = selected;
          if (!image) return;
          image.isRef = !image.isRef;
          finishChange(true);
          setNotice(image.isRef ? '已标记为参考图(提交时会一起发给模型)' : '已取消参考图');
        }
        /**
         * 精确改这张图的位置/尺寸(属性卡上那四个数字框用)。
         *
         * 只吃有限数字:框里被清空或打了别的字时**不要**写进 doc —— 一个 NaN 就会让图
         * 从画布上消失(worldToScreen 算出 NaN,canvas 静默不画),用户只会觉得图丢了。
         * @param {{x?:number|string,y?:number|string,w?:number|string,h?:number|string}} patch - 要改的字段。
         */
        function setGeometry(patch) {
          const target = selected;
          if (!target || !patch) return;
          if (target.locked) {
            setNotice('这张图锁着 —— 先在图层面板解锁再改位置/尺寸');
            return;
          }
          const image = docRef.current.images.find((im) => im.id === target.id);
          if (!image) return;
          const next = {};
          for (const key of ['x', 'y', 'w', 'h']) {
            if (patch[key] === undefined || patch[key] === null || patch[key] === '') continue;
            const value = Number(patch[key]);
            if (!Number.isFinite(value)) continue;
            // 宽高最小 8 像素:拖到 0 宽之后这张图就再也点不中,只能从图层面板删
            const rounded = key === 'w' || key === 'h' ? Math.max(8, Math.round(value)) : Math.round(value);
            if (rounded !== Math.round(Number(image[key]) || 0)) next[key] = rounded;
          }
          if (!Object.keys(next).length) return;
          Object.assign(image, next);
          finishChange(true);
        }

        function deleteSelected() {
          const ids = selectedIds.length ? selectedIds : selected ? [selected.id] : [];
          if (!ids.length) return;
          // 普通删除跳过锁定图(要删锁着的图,先在图层面板解锁)
          const byId = new Map(docRef.current.images.map((im) => [im.id, im]));
          const removable = ids.filter((id) => byId.get(id) && !byId.get(id).locked);
          const lockedCount = ids.length - removable.length;
          if (!removable.length) {
            setNotice(lockedCount > 1 ? `选中的 ${lockedCount} 张图都锁着 —— 先在图层面板解锁再删` : '这张图锁着 —— 先在图层面板解锁再删');
            return;
          }
          const keep = new Set(removable);
          const label = removable.length > 1 ? `${removable.length} 张图` : byId.get(removable[0]).name || '图片';
          docRef.current = {
            images: docRef.current.images.filter((im) => !keep.has(im.id)),
            marks: docRef.current.marks.filter((mk) => !keep.has(mk.targetId)),
            frames: docRef.current.frames,
          };
          // 删掉的图也从解码缓存里摘掉:不然几 MB 的 dataURL 和 Image 对象会一直挂在 Map 里,
          // 反复生成/删除之后内存只涨不降,最后浏览器开始掉帧。
          for (const id of removable) imgCacheRef.current.delete(id);
          setSelectedId(null);
          setSelectedIds([]);
          finishChange(true);
          setNotice(`已删除:${label}${lockedCount ? `(另有 ${lockedCount} 张锁定,已跳过)` : ''}`);
        }
        /**
         * 调图层顺序:上移/下移一格,或直接置顶/置底。
         *
         * 图层顺序就是 `doc.images` 的数组顺序 —— 排在后面的画在上面,所以「上移」= 往后挪一格。
         * 多选时整块一起挪,彼此之间不会踩来踩去。
         * @param {'up'|'down'|'top'|'bottom'} dir - 移动方向。
         */
        function reorderSelected(dir) {
          const list = docRef.current.images;
          const ids = selectedIds.length ? selectedIds : selected ? [selected.id] : [];
          if (!list.length || !ids.length) return;
          const set = new Set(ids);
          if (!list.some((im) => set.has(im.id))) return;
          let next;
          if (dir === 'top' || dir === 'bottom') {
            const picked = list.filter((im) => set.has(im.id));
            const rest = list.filter((im) => !set.has(im.id));
            next = dir === 'top' ? rest.concat(picked) : picked.concat(rest);
          } else {
            next = list.slice();
            if (dir === 'up') {
              // 从上层往下扫,免得同一张图在一次操作里被连着换两格
              for (let i = next.length - 2; i >= 0; i -= 1) {
                if (set.has(next[i].id) && !set.has(next[i + 1].id)) {
                  const tmp = next[i];
                  next[i] = next[i + 1];
                  next[i + 1] = tmp;
                }
              }
            } else {
              for (let i = 1; i < next.length; i += 1) {
                if (set.has(next[i].id) && !set.has(next[i - 1].id)) {
                  const tmp = next[i];
                  next[i] = next[i - 1];
                  next[i - 1] = tmp;
                }
              }
            }
          }
          if (next.every((im, i) => im === list[i])) {
            setNotice(dir === 'top' || dir === 'up' ? '已经在最上层了' : '已经在最下层了');
            return;
          }
          docRef.current = { images: next, marks: docRef.current.marks, frames: docRef.current.frames };
          finishChange(true);
          const label = { up: '上移一层', down: '下移一层', top: '置顶', bottom: '置底' }[dir] || dir;
          setNotice(ids.length > 1 ? `已把选中的 ${ids.length} 张图${label}` : `图已${label}`);
        }

        /** 对齐/分布的目标图:对齐至少 2 张,分布至少 3 张。 */
        function alignTargets(min) {
          const ids = selectedIds.length ? selectedIds : selected ? [selected.id] : [];
          const picked = docRef.current.images.filter((im) => ids.includes(im.id));
          if (picked.length < min) {
            setNotice(min === 2 ? '先选中 2 张以上图(Shift 点选)再对齐' : '等距分布至少要选 3 张');
            return null;
          }
          return picked;
        }

        /**
         * 对齐 / 分布选中图。
         *
         * 对齐以**整批图的包围盒**为基准(不是画布),所以图散在哪都能一次排齐;
         * 分布则是首尾两张留在原地、中间的等间距铺开 —— 所以至少要 3 张。
         * 图上的标注存的是归一化坐标(相对图片),图挪了标注自动跟着走。
         * @param {'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom'|'hdist'|'vdist'} kind - 对齐方式。
         */
        function alignSelected(kind) {
          const isDist = kind === 'hdist' || kind === 'vdist';
          const picked = alignTargets(isDist ? 3 : 2);
          if (!picked) return;
          const box = imageBounds(picked);
          if (!box) return;
          const round = (n) => Math.round(n);
          if (isDist) {
            const horiz = kind === 'hdist';
            const sorted = picked.slice().sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
            const span = horiz ? box.w : box.h;
            const used = sorted.reduce((acc, im) => acc + (horiz ? im.w : im.h), 0);
            const gap = (span - used) / (sorted.length - 1);
            if (!(gap > 0)) {
              setNotice('这几张图加起来已经占满整批范围了,排不开 —— 先把图缩小一点再分布');
              return;
            }
            let cursor = horiz ? box.x0 : box.y0;
            for (const im of sorted) {
              if (horiz) im.x = round(cursor);
              else im.y = round(cursor);
              cursor += (horiz ? im.w : im.h) + gap;
            }
          } else {
            for (const im of picked) {
              if (kind === 'left') im.x = round(box.x0);
              else if (kind === 'right') im.x = round(box.x1 - im.w);
              else if (kind === 'hcenter') im.x = round(box.x0 + (box.w - im.w) / 2);
              else if (kind === 'top') im.y = round(box.y0);
              else if (kind === 'bottom') im.y = round(box.y1 - im.h);
              else if (kind === 'vcenter') im.y = round(box.y0 + (box.h - im.h) / 2);
            }
          }
          finishChange(true);
          const label = { left: '左对齐', hcenter: '水平居中', right: '右对齐', top: '顶对齐', vcenter: '垂直居中', bottom: '底对齐', hdist: '水平等距排开', vdist: '垂直等距排开' }[kind] || '对齐';
          setNotice(`${picked.length} 张图已${label}(Ctrl+Z 可撤销)`);
        }

        function clearMarks() {
          const target = selected;
          if (!target) return;
          if (!docRef.current.marks.some((mk) => mk.targetId === target.id)) return;
          docRef.current = { images: docRef.current.images, marks: docRef.current.marks.filter((mk) => mk.targetId !== target.id), frames: docRef.current.frames };
          finishChange(true);
          setNotice('已清空这张图上的标注');
        }
        function clearCanvas() {
          const images = docRef.current.images;
          if (!images.length && !(docRef.current.frames || []).length && !docRef.current.marks.length) return;
          // 清空会连隐藏/锁定的图一起拿走,先让用户点一次头
          const hidden = images.filter((im) => im.hidden).length;
          const locked = images.filter((im) => im.locked).length;
          const extra = [hidden ? `隐藏 ${hidden} 张` : '', locked ? `锁定 ${locked} 张` : ''].filter(Boolean).join('、');
          const ok = window.confirm(
            `清空画布上的全部内容?共 ${images.length} 张图${extra ? `(含${extra})` : ''}、${(docRef.current.frames || []).length} 个生成框。\n清空后可以用 Ctrl+Z 撤销。`,
          );
          if (!ok) return;
          docRef.current = { images: [], marks: [], frames: [] };
          imgCacheRef.current = new Map();
          setSelectedId(null);
          setSelectedIds([]);
          camRef.current = { x: 0, y: 0, zoom: 1 };
          finishChange(true);
          setNotice('画布已清空(可以 Ctrl+Z 撤销)');
        }
        /**
         * 图层面板的显式开关:isRef / hidden / locked(后两个是 C 期新增的独立属性)。
         *
         * 锁定挡的是"改内容和位置"(拖动/缩放/标注/文字/改名/排序/普通删除);
         * 开关本身(显示⇄隐藏、锁定⇄解锁、参考标记)是显式面板操作,锁定图也放行 ——
         * 否则锁定的图就永远没法从提交集合里摘出来了。
         * @param {string} id - 图片 id。
         * @param {'isRef'|'hidden'|'locked'} key - 属性名。
         * @param {boolean} value - 目标值。
         */
        function setImageFlag(id, key, value) {
          const image = docRef.current.images.find((im) => im.id === id);
          if (!image) return;
          const next = Boolean(value);
          if (Boolean(image[key]) === next) return;
          image[key] = next;
          finishChange(true);
          const label = {
            isRef: next ? '已标记为参考图(提交时会一起发给模型)' : '已取消参考图',
            hidden: next ? '已隐藏(画布上不显示、不参与提交)' : '已显示',
            locked: next ? '已锁定(不能拖动/缩放/标注/删除)' : '已解锁',
          }[key] || '已更新';
          setNotice(`${label}:${image.name || '图片'}`);
        }
        /** 面板重命名:锁定图要先解锁;空名不改。 */
        function renameImage(id, name) {
          const image = docRef.current.images.find((im) => im.id === id);
          const next = String(name == null ? '' : name).trim();
          if (!image || !next || next === image.name) return;
          if (image.locked) {
            setNotice('这张图锁着 —— 先解锁再改名');
            return;
          }
          image.name = next;
          finishChange(true);
          setNotice(`已重命名为:${next}`);
        }
        /**
         * 面板拖动排序:把一张图插到某张图前面(`beforeId`;放到最后传空)。
         *
         * 面板顺序 = `doc.images` 数组顺序(首行 = 最底层),所以排序就是改数组。
         * 锁定图要先解锁才能挪(和改名一样,属"改位置"类操作)。
         * @param {string} id - 要挪的图片 id。
         * @param {string|null} beforeId - 插到这张图前面;null = 放到最顶层(末尾)。
         */
        function moveImageTo(id, beforeId) {
          const list = docRef.current.images;
          const from = list.findIndex((im) => im.id === id);
          if (from < 0) return;
          if (list[from].locked) {
            setNotice('这张图锁着 —— 先解锁再调整顺序');
            return;
          }
          const rest = list.filter((im) => im.id !== id);
          const at = beforeId ? rest.findIndex((im) => im.id === beforeId) : rest.length;
          if (at < 0) return; // 拖到自己身上 = 没动
          const next = rest.slice();
          next.splice(at, 0, list[from]);
          if (next.every((im, i) => im === list[i])) return;
          docRef.current = { images: next, marks: docRef.current.marks, frames: docRef.current.frames };
          finishChange(true);
          setNotice('已调整图层顺序(Ctrl+Z 可撤销)');
        }
        /**
         * 把「图片 (+ 它的文字图层)」合成成一张 dataURL(存 / 下载 / 分层导出用)。
         *
         * 这是"字不糊"的关键一步:文字是本地用本机字体矢量绘制的,**按目标分辨率**画 ——
         * 你要多大就按那个尺寸的坐标系画字,边缘永远清晰
         * —— 而让模型在图里"画字"是画像素,放多大都糊。
         * @param {object} image - 画布上的图片对象。
         * @param {{ onlyBase?: boolean, size?: { w: number, h: number } }} [opts] - `onlyBase` 只要底图(不画文字);`size` 按指定尺寸导出(缺省 = 原图分辨率)。
         * @returns {Promise<string>} dataURL。
         */
        async function renderExportDataUrl(image, opts) {
          const o = opts || {};
          const texts = Array.isArray(image.texts) ? image.texts : [];
          const want = o.size && Number(o.size.w) > 0 && Number(o.size.h) > 0
            ? { w: Math.round(Number(o.size.w)), h: Math.round(Number(o.size.h)) }
            : null;
          // 没文字、也没要求换尺寸 → 原图原样返回,省一次编解码
          if (!texts.length && !want) return image.dataUrl;
          const el = imgCacheRef.current.get(image.id) || (await decodeImage(image.dataUrl));
          const nw = el.naturalWidth || image.naturalW || image.w;
          const nh = el.naturalHeight || image.naturalH || image.h;
          const w = want ? want.w : nw;
          const h = want ? want.h : nh;
          // 只要底图、尺寸又没变 → 原图本身就是底图(文字图层从来没烧进 dataUrl)
          if (o.onlyBase && w === nw && h === nh) return image.dataUrl;
          const off = document.createElement('canvas');
          off.width = w;
          off.height = h;
          const c = off.getContext('2d');
          c.imageSmoothingEnabled = true;
          c.imageSmoothingQuality = 'high';
          c.drawImage(el, 0, 0, w, h);
          if (!o.onlyBase) drawImageTexts(c, texts, w, h);
          const out = off.toDataURL('image/png');
          return out && out.length > 64 ? out : image.dataUrl;
        }

        /** 导出目标清单:选了多张就按图层顺序整批返回,否则只返回主选中那张。 */
        function exportTargets() {
          if (selectedIds.length) {
            const want = new Set(selectedIds);
            return docRef.current.images.filter((im) => want.has(im.id));
          }
          return selected ? [selected] : [];
        }

        /** 批量存工作区时的文件名:同一秒里的多张图不能互相覆盖,所以带序号。 */
        function batchRelPath(image, idx, dataUrl) {
          const stem = (image.name || 'grsai').replace(/\.[a-z0-9]+$/i, '') || 'grsai';
          const tpl = savePath.trim();
          if (tpl) {
            const m = /^(.*?)(\.[a-z0-9]+)$/i.exec(tpl);
            return withImageExt(m ? `${m[1]}-${idx}${m[2]}` : `${tpl}-${idx}.png`, dataUrl);
          }
          return withImageExt(`画布输出/${stem}-${stamp()}-${idx}.png`, dataUrl);
        }

        async function saveImageToWorkspace(image) {
          if (!image) return;
          setError('');
          try {
            // 带文字图层时按原图分辨率把字烧进去(存下来的就是成品图)
            const dataUrl = await renderExportDataUrl(image);
            // 后缀跟着真实格式走:没有文字也没换尺寸时 renderExportDataUrl 会原样返回上游图,
            // 那张可能是 jpeg / webp,写死 .png 会被宿主按"内容和后缀对不上"拒掉。
            const rel = withImageExt(savePath.trim() || `画布输出/${(image.name || 'grsai').replace(/\.[a-z0-9]+$/i, '')}-${stamp()}.png`, dataUrl);
            const data = await api('/ws-save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: rel, dataUrl }),
            }, sessionRef.current);
            setNotice(`已保存:${data.path}${Array.isArray(image.texts) && image.texts.length ? '(文字按原图分辨率烧入)' : ''}`);
          } catch (e) {
            setError(String((e && e.message) || e));
          }
        }

        /**
         * 分层导出:一次落盘三个文件 —— 成品图 / 无文字底图 / 文字参数 JSON。
         *
         * 底图是位图(放大就糊),文字是矢量的(多清晰都行),所以分开存最划算:
         * 以后想换尺寸重出、想改字、想把同一套排版套到别的底图上,都还有得救;
         * 烧在一起的成品图就只能从头再来。
         * @param {object} image - 画布上的图片对象。
         */
        /**
         * 存工作区(多选版):选了多张就逐张落盘,一张失败不影响其余。
         *
         * 存的还是「存 / 下载」那张成品 —— 原图分辨率 + 文字图层。单张时直接走老路,
         * 多张时文件名带序号,免得同一秒里几笔写进同一个路径互相覆盖。
         */
        async function saveSelectedToWorkspace() {
          const list = exportTargets();
          if (!list.length) return;
          if (list.length === 1) return saveImageToWorkspace(list[0]);
          setError('');
          const done = [];
          const failed = [];
          for (let i = 0; i < list.length; i += 1) {
            const im = list[i];
            setNotice(`正在保存 ${i + 1}/${list.length}:${im.name || '图片'}…`);
            try {
              const dataUrl = await renderExportDataUrl(im);
              const rel = batchRelPath(im, i + 1, dataUrl);
              await api('/ws-save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: rel, dataUrl }),
              }, sessionRef.current);
              done.push(rel);
            } catch (e) {
              failed.push(`${im.name || '图片'}:${String((e && e.message) || e)}`);
            }
          }
          setNotice(done.length
            ? `已存 ${done.length}/${list.length} 张到工作区:${done.slice(0, 3).join('、')}${done.length > 3 ? ` 等 ${done.length} 个文件` : ''}`
            : '一张都没存上,看下面的报错');
          if (failed.length) setError(`这几张没存上 —— ${failed.join(';')}`);
        }

        async function saveImageLayered(image) {
          if (!image) return;
          setError('');
          const texts = Array.isArray(image.texts) ? image.texts : [];
          const natW = Number(image.naturalW || image.w) || 0;
          const natH = Number(image.naturalH || image.h) || 0;
          const want = parseExportSize(layerSize, dpi);
          const size = want ? { w: want.w, h: want.h } : natW > 0 && natH > 0 ? { w: natW, h: natH } : null;
          const baseRel = savePath.trim() || `画布输出/${(image.name || 'grsai').replace(/\.[a-z0-9]+$/i, '')}-${stamp()}.png`;
          // 导出时就把"这台机器到底有没有这个字体"记下来 —— 换台机器重出时一眼看得出来
          const fonts = {};
          for (const tx of texts) {
            const family = String(tx.font || TEXT_DEFAULTS.font);
            if (!(family in fonts)) fonts[family] = isFontAvailable(family);
          }
          try {
            const save = (target, dataUrl) => api('/ws-save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: target, dataUrl }),
            }, sessionRef.current);
            const done = [];
            // ① 成品:底图 + 文字,文字按导出尺寸矢量绘制
            const fullUrl = await renderExportDataUrl(image, size ? { size } : undefined);
            // 基名后缀按成品真实格式定(成品有文字时一定是 png;没文字没换尺寸时是上游原图)
            const paths = layerPaths(withImageExt(baseRel, fullUrl));
            await save(paths.full, fullUrl);
            done.push(paths.full);
            // ② 底图:一个字的痕迹都没有 —— 换尺寸/重排版都拿它当底
            const baseUrl = await renderExportDataUrl(image, Object.assign({ onlyBase: true }, size ? { size } : {}));
            const baseTarget = withImageExt(paths.base, baseUrl);
            await save(baseTarget, baseUrl);
            done.push(baseTarget);
            // ③ 文字参数:没有文字图层就不产生这个文件
            if (texts.length) {
              const json = JSON.stringify(textLayerManifest(image, size, fonts), null, 2);
              await save(paths.meta, `data:application/json,${encodeURIComponent(json)}`);
              done.push(paths.meta);
            }
            const missing = Object.keys(fonts).filter((family) => fonts[family] === false);
            const warn = missing.length ? `　⚠ 本机没有 ${missing.join('、')} —— 重出时会换成替代字体` : '';
            setNotice(`已分层导出 ${done.length} 个文件:${done.join('、')}${size ? `(按 ${size.w}×${size.h})` : ''}${want && want.shrunk ? '(超画布上限已等比缩小)' : ''}${warn}`);
          } catch (e) {
            setError(String((e && e.message) || e));
          }
        }

        async function downloadImage(image) {
          if (!image) return;
          let href = image.dataUrl;
          try {
            href = await renderExportDataUrl(image);
          } catch {
            href = image.dataUrl; // 合成失败就退回落原始图,别让下载点了没反应
          }
          const a = document.createElement('a');
          a.href = href;
          // 后缀按真实格式来(合成失败退化到上游原图时可能是 jpeg,别把 .png 写死)
          const stem = String(image.name || `grsai-${stamp()}`).replace(/\.[a-z0-9]+$/i, '');
          a.download = `${stem || 'grsai'}${imageExtOf(href)}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }

        /**
         * 复制一张图到系统剪贴板(Ctrl+C / 「复制」按钮)。
         *
         * 复制的是「存 / 下载」那张成品 —— 原图分辨率 + 文字图层,不是画布上那张缩略图,
         * 也不是带箭头红框的提交图:粘到微信/PPT/PS 里就是能直接用的图。
         * @param {object} image - 画布上的图片对象。
         * @param {string} [hint] - 提示语里额外带一句(多选时说清楚只复制了哪张)。
         */
        /**
         * 下载(多选版):逐张触发浏览器下载。
         *
         * 张与张之间留点间隔 —— 连着点太密,有的浏览器会把后面几个当弹窗拦掉。
         */
        async function downloadSelected() {
          const list = exportTargets();
          if (!list.length) return;
          if (list.length === 1) return downloadImage(list[0]);
          setError('');
          for (let i = 0; i < list.length; i += 1) {
            const im = list[i];
            let href = im.dataUrl;
            try {
              href = await renderExportDataUrl(im);
            } catch {
              href = im.dataUrl; // 合成失败就退回落原图,别让下载点了没反应
            }
            const stem = String(im.name || 'grsai').replace(/\.[a-z0-9]+$/i, '') || 'grsai';
            const a = document.createElement('a');
            a.href = href;
            a.download = `${stem}-${i + 1}${imageExtOf(href)}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            if (i < list.length - 1) await new Promise((resolve) => setTimeout(resolve, 350));
          }
          setNotice(`已开始下载 ${list.length} 张 —— 浏览器可能会问一次「是否允许下载多个文件」`);
        }

        async function copyImageToClipboard(image, hint) {
          if (!image) return;
          setError('');
          const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
          const Item = typeof ClipboardItem !== 'undefined' ? ClipboardItem : null;
          if (!clip || typeof clip.write !== 'function' || !Item) {
            setError('这个浏览器不让网页把图片写进剪贴板,用「下载」拿到文件再拖进去吧');
            return;
          }
          const makePng = () => renderExportDataUrl(image).then(clipboardPngBlob);
          try {
            // 先把 Promise 交出去:大图编码要几百毫秒,等编码完再写的话,按下 Ctrl+C 那次的
            // "用户手势"已经过期,浏览器会直接拒掉(NotAllowedError)。
            // ClipboardItem 收 Promise 就是为这种场景准备的。
            await clip.write([new Item({ 'image/png': makePng() })]);
          } catch (first) {
            try {
              // 少数实现不收 Promise(要求现成的 Blob):编码完再写一次。
              await clip.write([new Item({ 'image/png': await makePng() })]);
            } catch (second) {
              setError(`复制失败:${String((second && second.message) || second)}(可以先用「下载」)`);
              return;
            }
          }
          setNotice(`已复制「${image.name || '图片'}」到剪贴板,可直接粘到聊天/PPT/PS${hint || ''}`);
        }
        async function importResult(item) {
          try {
            const dataUrl = await proxyImageDataUrl(item.url, sessionRef.current);
            await addImageFromDataUrl(dataUrl, `结果-${stamp()}.png`, false);
          } catch (e) {
            setError(String((e && e.message) || e));
          }
        }
        async function openWorkspace() {
          setDockOpen('workspace');
          if (wsFiles) return;
          setWsBusy(true);
          try {
            const data = await api('/ws-list', undefined, sessionRef.current);
            setWsFiles(data.files || []);
          } catch (e) {
            setError(String((e && e.message) || e));
            setWsFiles([]);
          } finally {
            setWsBusy(false);
          }
        }
        async function refreshWorkspace() {
          setWsBusy(true);
          try {
            const data = await api('/ws-list', undefined, sessionRef.current);
            setWsFiles(data.files || []);
          } catch (e) {
            setError(String((e && e.message) || e));
          } finally {
            setWsBusy(false);
          }
        }
        async function pickWorkspace(rel) {
          setError('');
          try {
            const dataUrl = await fetchAsDataUrl(routeUrl(`/ws-file?path=${encodeURIComponent(rel)}`, sessionRef.current));
            await addImageFromDataUrl(dataUrl, rel.split('/').pop() || rel, false);
            setDockOpen('');
          } catch (e) {
            setError(String((e && e.message) || e));
          }
        }

        return { toggleRef, deleteSelected, reorderSelected, setImageFlag, setGeometry, renameImage, moveImageTo, alignSelected, clearMarks, clearCanvas, renderExportDataUrl, saveImageToWorkspace, saveSelectedToWorkspace, saveImageLayered, downloadImage, downloadSelected, copyImageToClipboard, importResult, openWorkspace, refreshWorkspace, pickWorkspace };
      }

      return { createImages };
    });

    // ── 零件 44-history-store.js ─────────────────────────────────────────────────────
/* 生成记录持久化(第一期 A):记录的快照结构、去重、裁剪与读写编队。
 *
 * 数据分两半:
 * - 结果图片本体:客户端生成成功后先经 /ws-save 落成 `画布/results/<记录ID>.<后缀>`
 *   (文件名由内部稳定 ID 生成,不信任远程 URL 里的任何路径成分;后缀跟着上游图真实格式走 ——
 *    /ws-save 会校验文件头,固定 .png 遇到 jpeg 结果会被拒);
 * - 清单:全部记录的元数据快照,固定走宿主 /history 路由(`画布/history.json`,
 *   路径由宿主决定,客户端传不了,天然没有越界风险)。
 *
 * 顺序铁律:**先保资源,再写清单**。清单写失败时记录还在本页内存里,只是没持久化;
 * 绝不因为持久化失败而重新发起生成(那是要再花一次钱的)。
 *
 * 快照语义(任务书):用户原始输入(promptUser)与最终提交提示词(promptFinal)分开存,
 * 恢复参数只回填不生成,旧记录缺字段就标缺失、不编造。
 *
 * 全局零件作用域里的 `api`/`uid` 直接用;CanvasTab 内部的状态与 ref 由调用处经 `p` 注入
 * (调用处见 `12-canvas-tab.js`)。
 */
    definePart('history-store', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns {{ enabled, normalizeRecord, normalizeList, buildRecord, saveResource, makePersister, trimRecords }} 这组动作。
       */
      function createHistoryStore(p) {
        const { sessionRef, onError } = p;

        /** 结果图片的落盘目录(相对工作区)。 */
        const RESULTS_DIR = '画布/results';
        /** 清单最多保留多少条(和宿主 MAX_HISTORY_RECORDS 对齐)。 */
        const MAX_RECORDS = 400;

        /** 旧宿主(没重启)没有 /history 能力:记录仅本页有效,明确告知。 */
        function enabled(features) {
          return Array.isArray(features) && features.includes('history');
        }

        /**
         * 把任意来源(磁盘旧档/上游)的一条记录洗成安全形状。
         * 缺的字段就让它缺(undefined),渲染层显示「—」—— **不编造默认值**,
         * 否则「旧记录没存过这个参数」和「当时就是这个值」就分不出来了。
         * @param {any} raw - 原始记录。
         * @returns {object|null} 安全记录;没有稳定 ID 的丢弃。
         */
        function normalizeRecord(raw) {
          if (!raw || typeof raw !== 'object') return null;
          const id = typeof raw.id === 'string' ? raw.id.trim() : '';
          if (!id) return null;
          const out = { id };
          const pickStr = (key, cap) => {
            const value = raw[key];
            if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, cap);
          };
          pickStr('taskId', 80);
          pickStr('promptUser', 4000);
          pickStr('promptFinal', 8000);
          pickStr('skillId', 100);
          pickStr('skillText', 4000);
          pickStr('model', 100);
          pickStr('ratio', 100);
          pickStr('quality', 100);
          pickStr('background', 100);
          pickStr('imageSize', 100);
          pickStr('exactSize', 100);
          pickStr('sourceId', 80);
          pickStr('sourceName', 200);
          pickStr('sourceUrl', 500);
          pickStr('file', 300);
          for (const key of ['at', 'w', 'h', 'refCount', 'marksCount', 'textsCount']) {
            const n = Number(raw[key]);
            if (Number.isFinite(n)) out[key] = n;
          }
          for (const key of ['frame', 'cropped', 'submitTexts', 'fav']) {
            if (raw[key] === true) out[key] = true;
          }
          if (Array.isArray(raw.refNames)) {
            const names = raw.refNames.filter((name) => typeof name === 'string' && name.trim()).slice(0, 10);
            if (names.length) out.refNames = names;
          }
          return out;
        }

        /**
         * 洗一整份清单:丢掉坏条目、按时间新→旧排、去重(同 taskId 只留最新一条)。
         * @param {any} raw - GET /history 回来的 records(或任何数组)。
         * @returns {{ records: object[], dropped: number }} 安全清单与丢弃数。
         */
        function normalizeList(raw) {
          const list = Array.isArray(raw) ? raw : [];
          const seenTask = new Set();
          const seenId = new Set();
          const out = [];
          let dropped = 0;
          for (const item of list) {
            const record = normalizeRecord(item);
            if (!record) { dropped += 1; continue; }
            const dupKey = record.taskId || `id:${record.id}`;
            if (seenTask.has(dupKey) || seenId.has(record.id)) { dropped += 1; continue; }
            seenTask.add(dupKey);
            seenId.add(record.id);
            out.push(record);
          }
          out.sort((a, b) => (b.at || 0) - (a.at || 0));
          return { records: out, dropped };
        }

        /**
         * 从一次成功生成里建一条记录(纯函数,不做 IO)。
         * @param {object} snap - 生成侧快照(见 12-canvas-tab 的 handleRecordResult)。
         * @returns {object} 新记录(id 稳定,后续资源/去重都靠它)。
         */
        function buildRecord(snap) {
          const record = normalizeRecord(Object.assign({ id: uid('rec'), at: Date.now() }, snap)) || { id: uid('rec'), at: Date.now() };
          return record;
        }

        /**
         * 把结果图落成工作区文件,成功时返回相对路径(清单里的 `file` 字段)。
         * @param {object} record - 记录(用 record.id 当文件名)。
         * @param {string} dataUrl - 结果图 dataURL。
         * @param {string} session - 发起时的会话(防切工作区串台)。
         * @returns {Promise<string>} 相对路径。
         */
        async function saveResource(record, dataUrl, session) {
          // 后缀按上游图的真实格式取:宿主 /ws-save 会嗅探文件头,内容与后缀不符直接拒写
          const rel = `${RESULTS_DIR}/${record.id}${imageExtOf(dataUrl)}`;
          const data = await api('/ws-save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: rel, dataUrl }),
          }, session);
          return String((data && data.path) || rel);
        }

        /**
         * 建一个**串行化**的持久化队列。
         * 收藏/删除/入库都可能连着来,并行写同一份清单会互相覆盖(后写的赢),
         * 所以全部写动作排队执行;队列里的每次写都取 `getRecords()` 的最新全量清单。
         * 「清单损坏后首次覆盖要先确认」由调用方经 `shouldOverride()` 决定 —— 这里只管排队与报错。
         * @param {object} io - { sessionRef, getRecords, onError, shouldOverride }。
         * @returns {{ push, load }} 队列动作。
         */
        function makePersister(io) {
          const { sessionRef, getRecords, onError, shouldOverride } = io;
          let chain = Promise.resolve();

          function push(reason) {
            const session = sessionRef.current;
            chain = chain.then(async () => {
              const records = getRecords();
              if (typeof shouldOverride === 'function' && !shouldOverride()) {
                throw new Error('清单已损坏且未确认覆盖:本次修改只留在本页,重启前请先处理');
              }
              const data = await api('/history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ records }),
              }, session);
              return data;
            }).catch((e) => {
              // 持久化失败不致命:记录还在内存里。但要说清楚,并且绝不重试生成
              if (onError) onError(`生成记录没有保存到工作区(${(e && e.message) || e}),重启画布前仍可在本页使用${reason ? `(触发:${reason})` : ''}`);
            });
            return chain;
          }

          /**
           * 启动时读清单。会话守卫:回来时工作区已切走就丢弃,不污染新工作区的状态。
           * @param {string} session - 发起时的会话。
           * @returns {Promise<{ records: object[], corrupted: boolean, stale: boolean }>} 清单。
           */
          async function load(session) {
            try {
              const data = await api('/history', undefined, session);
              if (sessionRef.current !== session) return { records: [], corrupted: false, stale: true };
              const parsed = normalizeList(data && data.records);
              return { records: parsed.records, corrupted: Boolean(data && data.corrupted), stale: false };
            } catch (e) {
              if (sessionRef.current !== session) return { records: [], corrupted: false, stale: true };
              throw e;
            }
          }

          return { push, load };
        }

        /**
         * 有界裁剪:超限时保全部收藏,剩余名额从新到旧填非收藏;
         * 收藏本身超限才动收藏(从最旧开始丢)—— 调用方要把 touchedFav 明确报出来,不静默。
         * @param {object[]} list - 当前清单(新→旧)。
         * @returns {{ records: object[], trimmed: number, touchedFav: number }} 裁剪结果。
         */
        function trimRecords(list) {
          if (list.length <= MAX_RECORDS) return { records: list, trimmed: 0, touchedFav: 0 };
          const fav = list.filter((item) => item.fav);
          const plain = list.filter((item) => !item.fav);
          let favKeep = fav;
          let touchedFav = 0;
          if (fav.length > MAX_RECORDS) {
            favKeep = fav.slice(0, MAX_RECORDS);
            touchedFav = fav.length - favKeep.length;
          }
          const room = Math.max(0, MAX_RECORDS - favKeep.length);
          const records = favKeep.concat(plain.slice(0, room));
          return { records, trimmed: list.length - records.length, touchedFav };
        }

        return { RESULTS_DIR, MAX_RECORDS, enabled, normalizeRecord, normalizeList, buildRecord, saveResource, makePersister, trimRecords };
      }

      return { createHistoryStore };
    });

    // ── 零件 99-entry.js ─────────────────────────────────────────────────────────────

    /** 标签页标题。 */
    function CanvasTitle() {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, '🎨', '画布');
    }

    /** 引导页/入口按钮的小图标。 */
    function CanvasGlyph(props) {
      const size = (props && props.size) || 16;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 1.5, y: 1.5, width: 13, height: 13, rx: 2.5, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 5.6, cy: 5.8, r: 1.5, fill: 'currentColor' }),
        h('path', { d: 'M2.2 12.4 6 8.6l2.6 2.6L11 8.9l2.8 3.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];

    /**
     * 画布 → 对话的桥:点击「图片分层(交给 Agent)」时,往当前会话发一条消息,
     * 效果等于替用户在输入框里按了回车,agent 随即收到并开始干活。
     *
     * 两个服务**惰性取**(点击那一刻才 `ctx.get`),而不是写进 `inject`:
     * 少了它们只是这一颗按钮不可用,不该把整个画布插件卡在依赖上。
     * `sessions.binding(id).session` 是会话实体,`conversation.sendSession`
     * 是 DSH 官方给客户端插件用的公开提交入口(mode: `queue` 不打断正在跑的回合)。
     *
     * @param ctx - 客户端根上下文。
     * @returns {{ send: (text: string, sessionId: string) => Promise<{ok: boolean, error?: string}> }} 桥。
     */
    function createAgentBridge(ctx) {
      return {
        async send(text, sessionId) {
          try {
            if (typeof ctx.get !== 'function') return { ok: false, error: '当前 DSH 版本没有会话服务' };
            const sessions = ctx.get('sessions');
            const conversation = ctx.get('conversation');
            if (!sessions || !conversation) {
              return { ok: false, error: '会话服务不可用:请在对话页打开画布,或直接对 agent 说「图片分层」' };
            }
            const binding = sessionId ? sessions.binding(sessionId) : undefined;
            if (!binding || !binding.session) {
              return { ok: false, error: '当前会话还没就绪:先点一下对话输入框再试' };
            }
            await conversation.sendSession(binding.session, text, [], 'queue');
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
          }
        },
        /**
         * 带图发一条(「帮我写提示词」用):把图注册成对话草稿附件,再连同文字一起提交。
         *
         * 图和话是同一条消息过去的 —— agent 收到时既看得到画布现状,也看得到你的要求。
         * 附件这条路走不通(老版本 DSH 没有 createDrafts)就退化成纯文字:
         * 提示词照样能写,只是 agent 看不到图。
         * @param text - 发给 agent 的话。
         * @param sessionId - 当前会话 id。
         * @param image - `{ dataUrl, name }`:要一起发过去的图。
         * @returns `withImage` 说明图到底带上了没有。
         */
        async sendWithImage(text, sessionId, image) {
          try {
            if (typeof ctx.get !== 'function') return { ok: false, error: '当前 DSH 版本没有会话服务' };
            const sessions = ctx.get('sessions');
            const conversation = ctx.get('conversation');
            if (!sessions || !conversation) {
              return { ok: false, error: '会话服务不可用:请在对话页打开画布,或直接对 agent 说「图片分层」' };
            }
            const binding = sessionId ? sessions.binding(sessionId) : undefined;
            if (!binding || !binding.session) {
              return { ok: false, error: '当前会话还没就绪:先点一下对话输入框再试' };
            }
            const ids = [];
            let withImage = false;
            if (image && image.dataUrl && typeof conversation.createDrafts === 'function') {
              try {
                const blob = await dataUrlToBlob(image.dataUrl);
                const file = new File([blob], image.name || `画布-${Date.now()}.png`, { type: blob.type || 'image/png' });
                const sid = (binding.session && binding.session.id) || sessionId;
                const drafts = await conversation.createDrafts(sid, [file]);
                for (const draft of drafts || []) {
                  if (draft && draft.id) ids.push(draft.id);
                }
                withImage = ids.length > 0;
              } catch {
                /* 附件注册失败就只发文字 */
              }
            }
            await conversation.sendSession(binding.session, text, ids, 'queue');
            return { ok: true, withImage };
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
          }
        },
      };
    }

    /**
     * 插件体:注册 tab 类型、面板体、标题和侧栏入口。
     * @param ctx - 客户端根上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const definition = {
        id: CANVAS_ID,
        kind: CANVAS_KIND,
        priority: 'extension',
        title: () => '画布',
        guide: [
          {
            order: 20,
            title: () => '画布',
            description: () => '无限画布改图:自由摆放、直接标注、结果放原图旁边对比',
            icon: CanvasGlyph,
          },
        ],
      };

      ctx.effect(() => ctx.sidebarRightTabs.register(definition), 'grsai-canvas: tab type');

      /** 画布 → 对话的桥(建一次就够,内部惰性取服务)。 */
      const agentBridge = createAgentBridge(ctx);

      /** 面板体:顺手把「弹成浮动面板」接到 sidebarRight 上。 */
      function CanvasBody(props) {
        const useTabInfo = props && props.useTabInfo;
        const info = typeof useTabInfo === 'function' ? useTabInfo() : null;
        const tabId = info && info.tab ? info.tab.id : null;
        const enhanced = Object.assign({}, props, {
          agentBridge,
          popOut: () => {
            if (!tabId) return;
            try {
              ctx.sidebarRight.float(tabId);
            } catch {
              /* 已浮动或没有面板时忽略 */
            }
          },
        });
        return h(CanvasTab, enhanced);
      }

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: CANVAS_ID }, CanvasBody),
          ),
        'grsai-canvas: tab body',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: CANVAS_ID }, CanvasTitle),
          ),
        'grsai-canvas: tab title',
      );

      /** 侧栏左下角入口。 */
      function OpenCanvasButton(props) {
        const wide = Boolean(props && props.wide);
        return h(
          'button',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: wide ? 'flex-start' : 'center',
              gap: 6,
              width: '100%',
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary, currentColor)',
              cursor: 'pointer',
              borderRadius: 8,
              padding: wide ? '7px 8px' : '6px',
              fontSize: 14,
              lineHeight: '22px',
              transition: 'background .12s',
            },
            title: '画布:用 GrsAI 改图',
            onClick: () => {
              try {
                ctx.sidebarRight.openTab(CANVAS_KIND);
              } catch {
                /* 面板没挂载时忽略 */
              }
            },
          },
          h('span', { style: { display: 'inline-flex' } }, h(CanvasGlyph, { size: 16 })),
          wide ? h('span', null, '画布') : null,
        );
      }

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register({ name: 'sidebar.footer.action', id: CANVAS_ID, order: 40, label: '画布' }, OpenCanvasButton),
          ),
        'grsai-canvas: sidebar entry',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    /** 给离线测试用的状态声明顺序。 */
    exports.__stateOrder = STATE_ORDER;
    /** 给离线测试用的纯函数(坐标/几何/标注绘制),运行时不用。 */
    exports.__internals = {
      worldToScreen,
      screenToWorld,
      imageBounds,
      fitCamera,
      rectVisible,
      normalizeRect,
      cloneDoc,
      marksBounds,
      markDistanceToPoint,
      renderMarks,
      screenMarkMap,
      naturalMarkMap,
      describeMarks,
      markHint,
      clamp,
      submissionSize,
      SUBMIT_MAX_SIDE,
      MAX_SUBMIT_BYTES,
      classifyStatus,
      pickImageUrl,
      readPendingTasks,
      writePendingTasks,
      LS_TASKS,
      BUILTIN_SKILLS,
      QUALITIES,
      BACKGROUNDS,
      IMAGE_SIZES,
      MODEL_CHOICES,
      // 按模型换算尺寸(比例 ↔ 像素)—— 上游同一个 aspectRatio 字段格式不同
      MODEL_SIZES,
      SIZE_LABELS,
      MODEL_SIZE_ALIAS,
      COMMON_SIZES,
      parsePixelSize,
      parseRatio,
      sizeAspect,
      sizeTableFor,
      sizeFormatOf,
      sizeOptionsFor,
      isValidSize,
      defaultSizeFor,
      nearestSize,
      normalizeSize,
      sizeWarning,
      sizeErrorFix,
      buildGenerateBody,
      pickClosestSize,
      // 「尺寸」里代表「跟随提交的那张图」的特殊值
      SOURCE_SIZE,
      SOURCE_TEXT,
      SOURCE_LABEL,
      sizeMenuGroups,
      COMMON_OUTPUT_SIZES,
      resizeDataUrl,
      // 「尺寸」框里的人类写法 → 上游值(输入 1080x1440 / 3:4 / 竖版 / 小红书 都能换算)
      parseHumanSize,
      convertSizeForModel,
      SIZE_KEYWORDS,
      SIZE_DIRECTIONS,
      // 实物尺寸(mm / cm / 英寸)→ 像素(DPI 可在设置里改)
      SIZE_UNITS,
      parseUnitSize,
      normalizeDpi,
      DEFAULT_DPI,
      MM_PER_INCH,
      // 超出浏览器 canvas 上限时自动换算(实物降 DPI / 裸像素等比缩小)
      fitScale,
      MAX_OUTPUT_SIDE,
      MAX_OUTPUT_PIXELS,
      MIN_DPI,
      // 提交前自检(把"老忘写"的要求列出来 + 给出可追加的句子)
      preflightChecks,
      // 草稿同步到工作区的落盘位置
      DRAFT_REL,
      // 文字图层(本机字体、本地矢量绘制)
      TEXT_DEFAULTS,
      FONT_CANDIDATES,
      textLines,
      estimateTextWidth,
      textLayerBounds,
      hitTextLayer,
      drawImageTexts,
      // 分层导出(成品图 / 无文字底图 / 文字参数 JSON)
      layerPaths,
      parseExportSize,
      textLayerManifest,
    };

    return module.exports;
  },
});
