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
