/**
 * dsh-grsai-canvas —— 提交前自检规则的离线回归测试。
 *
 * `lib/parts/04-preflight.js` 里那个 `preflightChecks()` 是纯函数(不碰 DOM 也不碰状态),
 * 所以可以脱离 DSH 单独跑 —— 改完规则先跑这个,别让"补过的要求又被反复提醒"这类问题溜回线上。
 *
 * 用法(在插件目录):
 *   node tools/check-preflight.mjs
 *
 * 断言方式:**只断言"该出现的出现、不该出现的不出现"**。
 * `sharpness` 与 `no-extra` 是无条件兜底项(只要提示词里没那几个词就会出现),
 * 几乎每次都在场,所以不参与断言,免得写一堆噪音预期。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PART = path.join(HERE, '..', 'lib', 'parts', '04-preflight.js');
const src = await fsp.readFile(PART, 'utf8');
/** 零件是"拼接片段",用 Function 包一层把纯函数取出来。 */
const preflightChecks = new Function(`${src}\nreturn preflightChecks;`)();

const ID_PHOTO =
  '把这张照片处理成标准证件照:纯白背景(不要阴影、不要渐变),人物正面免冠、居中,头肩比例符合证件照规范,光线均匀、肤色自然。保持人物的五官与真实长相一致 —— 不要换脸、不要过度美颜;衣服整理平整,不要添加任何文字、边框或水印。';
const ECOMMERCE =
  '把商品抠出来放到纯白背景上,保留真实的材质、颜色与细节(logo、纹理、反光都要在),加一层柔和自然的投影,构图居中、留出合适边距,适合做电商主图。不要添加任何文字或促销元素。';

/** [名称, 输入, 必须触发, 不能触发, 是否必须一条都没有]。 */
const CASES = [
  ['啥都没写', {}, ['prompt-empty'], []],
  ['画了箭头没写词', { marks: [{ kind: 'arrow' }] }, ['marks-no-prompt'], ['prompt-empty']],
  ['只写两个字', { prompt: '改一下' }, ['prompt-thin'], []],
  ['套证件照模板 → 不该说"太短"或"换脸"', { prompt: '改一下', skillId: 'id-photo-white', skillPrompt: ID_PHOTO }, [], ['prompt-thin', 'face-identity']],
  ['套商品白底模板 → 不该再要"保商标"', { skillId: 'ecommerce', skillPrompt: ECOMMERCE }, [], ['protect-brand']],
  ['人像没写不换脸', { prompt: '把背景换成海边', skillPrompt: '处理这张人像照片' }, ['face-identity'], []],
  ['人像写了不换脸', { prompt: '把背景换成海边,保持人物五官长相完全一致,不要换脸' }, [], ['face-identity']],
  ['商品没写保商标', { prompt: '把这个产品图换成深蓝色' }, ['protect-brand'], []],
  ['商品写了保商标', { prompt: '把商品换成深蓝色,保留商品上的商标与型号文字原样' }, [], ['protect-brand']],
  ['有目标图没写保持', { hasTarget: true, prompt: '把天空换成晚霞,颜色再暖一点' }, ['keep-subject'], []],
  ['写了保持主体', { hasTarget: true, prompt: '把天空换成晚霞,保持主体不变' }, [], ['keep-subject']],
  ['参考图没说用途', { refCount: 2, prompt: '把主图里的项链换成金色的' }, ['ref-usage'], []],
  ['图上有文字图层', { textCount: 2, hasTarget: true, prompt: '把背景换成浅灰色,保持主体不变' }, ['local-text'], []],
  ['勾了裁剪 + 有标注', { cropToMark: true, marks: [{ kind: 'rect' }], prompt: '把框里的东西修干净,保持主体不变' }, ['crop-marks'], []],
  [
    '写全了 → 一条都不该有',
    {
      hasTarget: true,
      refCount: 2,
      prompt:
        '把人物的背景换成海边黄昏,保持主体与五官长相完全一致、不要换脸;保留商品上的商标与型号文字原样;输出保持清晰锐利、不要模糊、不要噪点、不要拉伸变形、不要改变宽高比;不要添加任何文字、水印、边框;第一张是主图只改它,第二张仅参考配饰风格。',
    },
    [],
    [],
    true,
  ],
];

let pass = 0;
let fail = 0;
for (const [name, input, mustHave, mustNotHave, mustBeEmpty] of CASES) {
  const got = preflightChecks(input).issues.map((i) => i.id);
  const missing = mustHave.filter((id) => !got.includes(id));
  const extra = (mustNotHave || []).filter((id) => got.includes(id));
  const okEmpty = mustBeEmpty ? got.length === 0 : true;
  const ok = !missing.length && !extra.length && okEmpty;
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) {
    console.log(`     实际触发: [${got.join(', ') || '无'}]`);
    if (missing.length) console.log(`     少了: [${missing.join(', ')}]`);
    if (extra.length) console.log(`     不该有: [${extra.join(', ')}]`);
    if (!okEmpty) console.log('     预期一条都不该有');
  }
  ok ? (pass += 1) : (fail += 1);
}
console.log(`\n结果:${pass} 通过 / ${fail} 失败(共 ${CASES.length} 条)`);

// 回归:点一下「补上」之后,那些要求不该再被反复提醒
const first = preflightChecks({ hasTarget: true, prompt: '换个背景' }).issues;
const fixedPrompt = ['换个背景', ...first.filter((i) => i.fix).map((i) => i.fix)].join('\n');
const again = preflightChecks({ hasTarget: true, prompt: fixedPrompt }).issues.map((i) => i.id);
console.log('\n回归:补过要求之后再跑 →', again.length ? `仍然提醒 ${again.join(', ')} ❌` : '清零 ✅');

const afterSkill = preflightChecks({ hasTarget: true, skillId: 'id-photo-white', skillPrompt: ID_PHOTO, prompt: fixedPrompt }).issues.map((i) => i.id);
console.log('回归:套证件照模板 + 补过要求 →', afterSkill.length ? `仍然提醒 ${afterSkill.join(', ')} ❌` : '清零 ✅');

if (fail || again.length || afterSkill.length) process.exitCode = 1;
