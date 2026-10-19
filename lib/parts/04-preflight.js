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
