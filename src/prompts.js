'use strict';

const { loadRules } = require('./rules');

const FACT_CARD_SCHEMA = `{
  "产品名称": "string",
  "品类": "string（只按资料里能确定的信息写，不确定写\"未确认\"）",
  "明确信息": [{"类别": "卖点|参数|成分|规格|使用方法|包装文字|其他", "内容": "string", "来源": "图片|文字输入|本地OCR"}],
  "待确认": [{"内容": "string", "原因": "图片模糊|资料未提供|字迹被遮挡"}],
  "允许表达的结果": ["string（资料明确允许的主观结果，没有就给空数组）"],
  "允许场景与动作": ["string（资料明确给出的使用场景或动作）"],
  "感官信息": ["string（资料给出的质地、气味、口感、声音等感官描述）"],
  "不得写的内容": ["string（本产品资料没有支持、因此禁止写入的内容）"]
}`;

function factCardMessages({ productName, sellingPoints, ocrText, hasImages, imageCount }) {
  const system = [
    '你是电商产品资料整理助手。你的唯一任务是把用户给出的产品名称、卖点文字和包装图片上的文字，整理成一张「产品事实卡」。',
    '',
    '硬性要求：',
    '1. 只写资料中明确出现的信息。图片里看不清、被遮挡、无法确认的文字，必须放进「待确认」，不要猜、不要补全。',
    '2. 不根据外观、包装颜色、品类常识或成分类推功效。例如看到“精华水”不能推断“补水、修复、敏感肌可用”。',
    '3. 不补造参数、认证、成分含量、时长、适用人群、销量、生产厂家信息。',
    '4. 把「已有资料」和「未知信息」分开记录；未知不等于可以推测。',
    '5. 「允许表达的结果」只放资料里明确允许表达的主观结果（例如资料写了“不黏手”才可以写不黏手）；没有就返回空数组。',
    '6. 「不得写的内容」列出本产品资料未支持、因此禁止写入其他文案的内容，用“资料未提供，禁止写入”这类明确表述。',
    '7. 只输出 JSON，不要输出 Markdown 代码块，不要写解释文字。',
    '',
    'JSON 结构：',
    FACT_CARD_SCHEMA,
  ].join('\n');

  const userParts = [];
  const lines = [];
  lines.push(`产品名称（用户填写）：${productName ? productName : '（未填写）'}`);
  lines.push(`卖点文字（用户填写）：${sellingPoints ? sellingPoints : '（未填写）'}`);
  if (!hasImages) lines.push('包装图片：未上传');
  else lines.push(`包装图片：已上传 ${imageCount} 张，请逐张读取图上看得清的文字。`);
  if (ocrText) {
    lines.push('');
    lines.push('以下是本机 OCR 引擎对图片的原始识别结果（可能有错字、漏字、断行，只作为辅助线索）：');
    lines.push('"""');
    lines.push(ocrText.slice(0, 6000));
    lines.push('"""');
    lines.push('OCR 结果若与图片内容冲突，以图片为准；OCR 里读不通、明显错乱的片段要放进「待确认」。');
  }
  if (!hasImages && !sellingPoints && !productName) {
    lines.push('');
    lines.push('用户没有提供任何资料，请返回空的事实卡，并在「待确认」里提示需要补充产品名称、卖点和包装图。');
  }
  lines.push('');
  lines.push('请按上面的 JSON 结构输出产品事实卡。');
  userParts.push({ type: 'text', text: lines.join('\n') });
  return { system, userParts };
}

function buildCandidateSystem() {
  const { text } = loadRules();
  return [
    '你是中文电商模拟评论写手。你写的是「AI 生成的模拟评论文案」，不是真实顾客的反馈，不得写成真实消费者已发表的评价。',
    '',
    '必须严格遵守下面的规则蓝本（《买家评论生成规则 v0.4.3 完整版》）：',
    '<<<规则蓝本开始>>>',
    text,
    '<<<规则蓝本结束>>>',
    '',
    '补充的硬性约束（优先级高于你的写作习惯）：',
    'A. 全部评论必须正面：不写缺点、限制、失望、效果不足、性价比遗憾、勉强接受、先贬后夸、未来再观察、“够用/还行/一般/至少/还可以”。',
    'B. 事实边界：只能使用「产品事实卡」里明确存在的信息。事实卡没写的参数、成分、功效、时长、身份、复购、物流、客服、第三方反馈、价格，一律不能写。',
    'C. 不写购买经历：不得出现回购、复购、第二次买、用了多久、快递、物流、客服、朋友推荐、同事评价等。',
    'D. 允许第一人称的强烈、即时感受：可以写“涂上就感觉清爽”“按一泵下去就有感觉”“用了第一次就很舒服”这类直接、笃定的个人体验，不强制每条都带“我/感觉/对我来说/用了之后”等主观锚点，句子可以更直接。',
    'D2. 但禁止两类写法：① 医疗化、绝对化（治愈、根治、消炎、杀菌、无刺激、零风险、100%、绝对、永久、顶级等）；② 把个人体验改写成对所有人都成立的客观保证（人人适合、所有肤质、谁用都行、保证有效、所有人都能等）——个人感受只能落在“这一次、这一瓶、我自己用着”的范围里。',
    'E. 每条一段，口语自然，不用 emoji、不用话题标签、不用“亲/宝贝/姐妹们”等称呼，不写带货收尾（闭眼冲、劝你试试、继续囤、推荐给大家）。',
    'F. 整批不出现相同的开头逻辑或相同的收尾逻辑超过 2 条；同一口头禅（真的/明显/非常/特别/总之）最多 1 条出现。',
    'G. 字数按汉字、字母、数字统计，不含标点与空白；写完自己核对字数，不要把 60 字说成约 100 字。',
    'H. 只输出 JSON，不要 Markdown 代码块，不要解释。',
    'I. 直接产出候选文案，不要在脑内反复推翻重写；筛选、去重、字数核对由程序完成，你只需要一次写清楚。',
  ].join('\n');
}

function buildCandidateUser({ factCard, count, candidateCount, extraNote, focusHint }) {
  const lines = [];
  lines.push('【产品事实卡（唯一事实来源）】');
  lines.push(JSON.stringify(factCard, null, 2));
  lines.push('');
  lines.push('【本次任务】');
  lines.push(`最终需要 ${count} 条，请先写 ${candidateCount} 条候选，供后续筛选。`);
  lines.push('篇幅要求：约 6–7 条主体 55–85 字；1–2 条 90–110 字的高度赞扬长评（必须全正面、观察充分）；其余保留较短评论（20–55 字，其中至少 1 条短直球）。');
  lines.push('情绪参考分布（不要按顺序机械分配）：2 条强烈满意、5 条明确满意、2 条平静肯定、1 条短直球。');
  lines.push('去重要求：两两比较主关注点、正面结果、观察动作；三者都相同的候选不要重复提交。');
  lines.push('主题分配要求：事实卡里的同一条已知信息最多写 3 条；优先把不同的已知信息分配到不同条目上。');
  lines.push('如果事实较少，请靠不同的观察动作（取用、涂开、看瓶身规格、看配方表、早晚各一次）和不同的结果落点（用量好掌握、手上干净、脸上清爽、步骤省事、摆放顺手）来区分，不要反复围绕同一个结果写。');
  lines.push('事实不足时：保持表达短而具体，不要编造新事实填满字数。');
  if (focusHint) {
    lines.push('');
    lines.push('【本批侧重】');
    lines.push(focusHint);
  }
  if (extraNote) {
    lines.push('');
    lines.push('【补充要求】');
    lines.push(extraNote);
  }
  lines.push('');
  lines.push('【输出 JSON 结构】');
  lines.push(`{
  "候选": [
    {
      "文本": "一条完整的一段式评论",
      "主关注点": "这条评论主要围绕哪个已知卖点或观察",
      "正面结果": "这条评论表达的正面结果或体验",
      "观察动作": "用户做了什么动作得出这个观察",
      "情绪": "强烈满意|明确满意|平静肯定|短直球",
      "字数": 0
    }
  ]
}`);
  return lines.join('\n');
}

/** 组装候选生成消息（事实卡 + 要求） */
function candidateMessages(options) {
  return [
    { role: 'system', content: buildCandidateSystem() },
    { role: 'user', content: buildCandidateUser(options) },
  ];
}

/** 单条重新生成 */
function regenerateMessages({ factCard, index, targetLength, targetEmotion, usedObservations, avoidTexts }) {
  const system = [
    '你是中文电商模拟评论写手。你写的是 AI 生成的模拟评论文案，不是真实顾客反馈。',
    '',
    '严格遵守下面的规则蓝本：',
    '<<<规则蓝本开始>>>',
    loadRules().text,
    '<<<规则蓝本结束>>>',
    '',
    '补充硬性约束：全部正面；只用事实卡里的信息；不写购买经历与绝对化／医疗化表达；一条一段；不用 emoji；不写带货收尾；只输出 JSON。',
  ].join('\n');
  const lines = [];
  lines.push('【产品事实卡（唯一事实来源）】');
  lines.push(JSON.stringify(factCard, null, 2));
  lines.push('');
  lines.push('【任务】只重写 1 条评论，替换原批次的第 ' + index + ' 条。');
  lines.push(`目标篇幅：${targetLength}`);
  lines.push(`目标情绪：${targetEmotion}`);
  lines.push('直接写出来即可，不要反复推翻重写。');
  if (usedObservations && usedObservations.length) {
    lines.push('');
    lines.push('【同批其他评论已经使用的关注点，必须避开】');
    usedObservations.forEach((item) => lines.push(`- ${item}`));
  }
  if (avoidTexts && avoidTexts.length) {
    lines.push('');
    lines.push('【不要与以下现有评论语义重复】');
    avoidTexts.forEach((item) => lines.push(`- ${item}`));
  }
  lines.push('');
  lines.push('【输出 JSON 结构】');
  lines.push('{"文本":"...","主关注点":"...","正面结果":"...","观察动作":"...","情绪":"...","字数":0}');
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** 让模型把不合规的 JSON 原样修好 */
function repairMessages(rawText) {
  return [
    {
      role: 'system',
      content: '你是 JSON 修复器。把用户给你的内容整理成合法 JSON 原样返回，不要增删信息，不要输出解释或代码块。',
    },
    { role: 'user', content: String(rawText || '').slice(0, 20000) },
  ];
}

module.exports = {
  FACT_CARD_SCHEMA,
  factCardMessages,
  candidateMessages,
  regenerateMessages,
  repairMessages,
  buildCandidateSystem,
};
