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
