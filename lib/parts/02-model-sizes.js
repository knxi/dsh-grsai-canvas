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
