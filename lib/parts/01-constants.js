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
