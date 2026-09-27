'use strict';

/**
 * 规则校验与筛选引擎：把《买家评论生成规则 v0.4.3》里可程序化检查的部分真正跑起来。
 * 覆盖：字数统计、全正面、事实边界、语义去重、篇幅与情绪分布、口头禅与首尾限频。
 */

/** 按规则统计：汉字、字母、数字，不计标点与空白 */
function countChars(text) {
  const matches = String(text || '').match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]/g);
  return matches ? matches.length : 0;
}

/** 降分／保留意见表达（整句含义检测的兜底词表） */
const LOWERING_PATTERNS = [
  '还行', '还可以', '还可以吧', '一般般', '一般化', '效果一般', '比较一般', '中规中矩', '无功无过',
  '凑合', '将就', '勉强', '至少', '够用', '能用', '可以说得过去', '说得过去',
  '失望', '遗憾', '美中不足', '缺点', '不足之处', '小缺点', '唯一不足', '就是有点', '就是稍微',
  '性价比一般', '性价比不高', '不太值', '不值这个价', '对得起价格', '这个价格就这样', '毕竟价格',
  '不抱希望', '没抱希望', '本来以为不好', '没想到居然', '居然还', '竟然还',
  '再看吧', '再看看', '待观察', '后续再', '先用用看', '用一段时间再说', '暂时', '期待别太高',
  '不太好', '不太行', '不算好', '不是很好', '不太满意', '不太适合', '不太明显', '不太理想',
  '偏小', '偏短', '有点小', '有点大', '有点吵', '有点重', '有点贵', '有点薄', '有点粗糙',
  '也就那样', '只能说', '算不上', '谈不上', '效果有限', '比较平淡', '闻多了', '用久了会',
];

/** 绝对化／医疗化／无法验证的强结论 */
const ABSOLUTE_PATTERNS = [
  '治愈', '根治', '治疗', '消炎', '杀菌', '抗菌', '抗过敏', '零刺激', '无刺激', '零风险', '无副作用',
  '百分之百', '100%', '100％', '绝对', '永久', '立竿见影', '立刻见效', '马上见效', '永不',
  '人人适合', '任何肤质都', '所有肤质都', '包治', '药效', '医用', '医美级', '顶级', '天花板',
];

/** 需要事实支持的购买经历／身份／第三方反馈 */
const EXPERIENCE_PATTERNS = [
  '回购', '复购', '第二次买', '第二次购买', '又买', '再次购买', '囤了', '买了好几', '入手第二',
  '快递', '物流', '发货', '客服', '卖家', '商家推荐', '朋友推荐', '同事', '闺蜜', '室友推荐',
  '用了一个月', '用了半年', '用了三个月', '用了一周', '用了几天', '用了两年', '用好几年', '常年用',
];

/** 品类常见功效词：出现即要求事实卡里也有对应依据 */
const CLAIM_DICTIONARY = [
  '美白', '淡斑', '祛斑', '祛痘', '抗痘', '抗老', '抗皱', '淡纹', '紧致', '提亮', '去黄', '控油',
  '补水', '保湿', '滋润', '修复', '修护', '舒缓', '镇静', '镇定', '抗敏', '敏感肌', '屏障',
  '去黑头', '收缩毛孔', '去角质', '防晒', 'spf', '隔离', '抗氧', '抗氧化', '促吸收', '渗透',
  '生发', '防脱', '去屑', '止痒', '去油', '控油', '留香', '持香', '前调', '中调', '后调',
  '续航', '待机', '快充', '闪充', '低延迟', '零延迟', '防水', '防尘', '降噪', '主动降噪', '无损',
  '兼容', '耐用', '寿命', '信号强', '穿墙', '散热',
  '低糖', '低脂', '低卡', '减肥', '瘦身', '代餐', '饱腹', '健康功效', '养胃', '助眠', '补钙', '高蛋白',
  '不缩水', '不起球', '不掉色', '不透', '显瘦', '显高', '遮肉', '塑形', '保暖', '透气', '柔软',
  '承重', '稳固', '结实', '容量', '大容量', '防潮', '防霉', '无毒', '食品级', '材质安全', '免安装',
  '痘痘', '痘印', '闭口', '粉刺', '斑点', '皱纹', '细纹', '黑头', '毛躁', '分叉', '头皮屑',
  '续航时间', '充电速度', '信号', '发热', '耗电', '卡顿', '掉线', '音质', '画质',
  '好吃不上火', '养生', '调理', '提神', '降火', '膳食纤维',
];

/** 场景／动作词：没有资料支持时给出提醒（不直接判死） */
const SCENE_PATTERNS = [
  '早上', '晚上', '夜里', '洗澡后', '洗脸后', '洗完脸', '睡前', '出门前', '通勤', '上班', '办公室',
  '宿舍', '出差', '旅行', '健身房', '运动后', '夏天', '冬天', '换季', '车里', '厨房', '浴室', '卧室',
  '键盘', '电脑', '办公桌', '书桌', '床头', '洗手台', '化妆台', '包里', '口袋', '冰箱', '衣柜', '阳台',
  '地铁', '公交', '排队', '开会', '午休', '周末',
];

/** 场景别名：事实卡里写了左边任何一个，右边这些同义说法都算有依据 */
const SCENE_ALIASES = {
  早上: ['早晚', '早上', '早晨', '清晨'],
  晚上: ['早晚', '晚上', '夜间', '睡前'],
  睡前: ['睡前', '晚上', '夜间'],
  洗脸后: ['洁面', '洗脸', '洗完脸'],
  洗完脸: ['洁面', '洗脸', '洗完脸'],
  洗澡后: ['洗澡', '沐浴', '洗澡后'],
  出门前: ['出门', '外出', '出门前'],
  办公室: ['办公', '办公室', '上班'],
  上班: ['上班', '办公', '通勤'],
  通勤: ['通勤', '上班', '出行'],
  夏天: ['夏天', '夏季', '天热'],
  冬天: ['冬天', '冬季', '天冷'],
};

const FILLER_WORDS = [
  '真的', '明显', '非常', '特别', '超级', '总体来说', '不得不说', '最让我惊喜的是', '值得一提的是',
];

/** 常见夸词：同一条里反复堆叠就是凑字数，要降权或淘汰 */
const PRAISE_WORDS = [
  '清爽', '舒服', '方便', '顺手', '省事', '干净', '好用', '满意', '自然', '轻松',
  '简单', '合适', '顺滑', '细腻', '柔软', '轻便', '省心', '舒服多了',
];

/**
 * 检查「夸词堆砌」与「短句堆叠」：规则蓝本要求不要靠重复同一夸词凑长。
 * 同夸词 ≥3 次、或小句极短且堆叠时判为违规；轻度重复降权处理。
 */
function checkRepetition(text) {
  const violations = [];
  const warnings = [];
  const repeated = [];
  for (const word of PRAISE_WORDS) {
    const count = (text.match(new RegExp(word, 'g')) || []).length;
    if (count >= 2) repeated.push({ word, count });
  }
  const heavy = repeated.filter((item) => item.count >= 3);
  if (heavy.length) {
    violations.push({ type: '同一夸词重复堆叠', detail: heavy.map((item) => `${item.word}×${item.count}`).join('、') });
  }

  const clauses = text.split(/[，。！？；、]/).filter((item) => item.trim());
  const chars = countChars(text);
  const average = clauses.length ? chars / clauses.length : chars;
  if (clauses.length >= 6 && average < 5.5) {
    violations.push({ type: '短句堆叠、信息密度低', detail: `${clauses.length} 个小句，平均 ${average.toFixed(1)} 字` });
  } else if (clauses.length >= 6 && average < 8) {
    warnings.push({ type: '句式偏碎、夸词偏多', detail: `${clauses.length} 个小句，平均 ${average.toFixed(1)} 字`, weight: 6 });
  }

  const mild = repeated.filter((item) => item.count === 2).map((item) => item.word);
  if (mild.length >= 2) {
    warnings.push({ type: '同一批夸词重复偏多', detail: mild.join('、'), weight: 4 });
  }
  return { violations, warnings };
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）()【】《》,.!?;:~…—\-]/g, '')
    .toLowerCase();
}

function firstMatch(text, list) {
  for (const item of list) {
    if (text.includes(item)) return item;
  }
  return '';
}

function charBigrams(text) {
  const normalized = normalizeText(text);
  const map = new Map();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const gram = normalized.slice(i, i + 2);
    map.set(gram, (map.get(gram) || 0) + 1);
  }
  return map;
}

/** 字符二元组 Dice 相似度（0–1） */
function similarity(a, b) {
  const left = charBigrams(a);
  const right = charBigrams(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  let totalLeft = 0;
  let totalRight = 0;
  for (const count of left.values()) totalLeft += count;
  for (const count of right.values()) totalRight += count;
  for (const [gram, count] of left.entries()) {
    const other = right.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (totalLeft + totalRight);
}

/** 事实卡里「被授权」的文字（不含待确认项） */
function authorizedFactText(factCard) {
  if (!factCard || typeof factCard !== 'object') return '';
  const parts = [factCard.产品名称, factCard.品类];
  for (const key of ['明确信息', '允许表达的结果', '允许场景与动作', '感官信息']) {
    const value = factCard[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') parts.push(item);
        else if (item && typeof item === 'object') parts.push(item.内容 || item.描述 || '');
      }
    } else if (typeof value === 'string') {
      parts.push(value);
    }
  }
  return parts.filter(Boolean).join(' ');
}

function numbersIn(text) {
  return String(text || '').match(/\d+(?:\.\d+)?\s*(?:ml|mL|ML|g|G|kg|KG|毫克|克|毫升|升|片|粒|支|cm|CM|mm|寸|小时|分钟|天|个月|年|%|％|元|块|米|斤|两)?/g) || [];
}

/** 单条评论的事实边界检查 */
function checkFacts(text, factCard) {
  const violations = [];
  const warnings = [];
  const authorized = authorizedFactText(factCard);
  const authorizedNormalized = normalizeText(authorized);
  const authorizedRaw = authorized.toLowerCase();

  const absolute = firstMatch(text, ABSOLUTE_PATTERNS);
  if (absolute) violations.push({ type: '绝对化或医疗化表达', detail: absolute });
  if (/不[会再]?有?任何/.test(text)) violations.push({ type: '绝对化或医疗化表达', detail: '任何…都' });

  const experience = firstMatch(text, EXPERIENCE_PATTERNS);
  if (experience) violations.push({ type: '补造购买经历或第三方反馈', detail: experience });

  for (const number of new Set(numbersIn(text))) {
    const compact = number.replace(/\s+/g, '');
    if (!authorizedRaw.includes(compact.toLowerCase()) && !authorized.includes(compact)) {
      violations.push({ type: '出现事实卡里没有的参数', detail: compact });
    }
  }

  const claims = [];
  for (const claim of CLAIM_DICTIONARY) {
    if (!text.includes(claim)) continue;
    const inFacts = authorized.includes(claim) || authorizedNormalized.includes(claim.toLowerCase());
    if (!inFacts) claims.push(claim);
  }
  if (claims.length) {
    violations.push({ type: '功效／性能说法缺少事实依据', detail: [...new Set(claims)].join('、') });
  }

  const scenes = [];
  for (const scene of SCENE_PATTERNS) {
    if (!text.includes(scene)) continue;
    const aliases = SCENE_ALIASES[scene] || [scene];
    const supported = aliases.some((alias) => authorized.includes(alias));
    if (!supported) scenes.push(scene);
  }
  if (scenes.length) warnings.push({ type: '场景未经资料确认', detail: [...new Set(scenes)].join('、') });

  return { violations, warnings };
}

/** 全正面检查 */
function checkPositive(text) {
  const violations = [];
  const warnings = [];
  const lowering = firstMatch(text, LOWERING_PATTERNS);
  if (lowering) violations.push({ type: '出现降分或保留意见表达', detail: lowering });

  // “但 / 不过 / 然而”多用于缺点转折，需要提醒复核；含正面否定（不黏、不油）不算问题
  if (/(但|不过|然而)/.test(text) && !/(不黏|不油|不占|不刺鼻|不呛|不吵|不重|不闷|不掉|不勒|不晃)/.test(text)) {
    warnings.push({ type: '出现转折词，需人工确认不是缺点转折', detail: (text.match(/(但|不过|然而)/) || [''])[0] });
  }

  const negativeVerb = text.match(/(不|没|无)(好|美|舒服|方便|满意|明显|好看|合适|顺利)/);
  if (negativeVerb) violations.push({ type: '出现否定式负向评价', detail: negativeVerb[0] });

  return { violations, warnings };
}

function fillerHits(text) {
  return FILLER_WORDS.filter((word) => text.includes(word));
}

function normalizeFocus(value) {
  return normalizeText(value).slice(0, 40);
}

const ACTION_HEAD = /^(按压|按一下|按一泵|拧开|拧|打开|拉开|撕开|取出|拿起|拿|倒出|装上|装|插上|插|接上|按下|点击|挂上|挂|铺开|铺|穿上|穿上|戴上|涂上|涂|抹开|敷|喷|贴|贴上|拆开|拆|放|摆|装进|收进|翻|翻开|合上)/;
const SENSE_HEAD = /^(味道|香味|气味|质地|手感|颜色|口感|声音|涂上|抹开|闻起来|摸上去|看上去|喷上|入口)/;
const RESULT_HEAD = /^(涂完|用完|装完|贴上后|换上|穿上|戴上|打开后|放上去|摆上|收拾完|按完|接上后|连上|清理完|擦完)/;

/** 模型不再输出“开头方式/收尾方式”，由程序从文本本身归纳，避免让模型做无谓推理 */
function deriveOpening(text) {
  const head = String(text || '').trim();
  if (RESULT_HEAD.test(head)) return '结果先行';
  if (ACTION_HEAD.test(head)) return '操作先行';
  if (SENSE_HEAD.test(head)) return '感官细节';
  if (/^(比|和|跟|相比)/.test(head)) return '对比';
  return '陈述式';
}

function deriveEnding(text) {
  return normalizeText(text).slice(-8);
}

/** 评估一条候选 */
function evaluateCandidate(candidate, factCard) {
  const text = String(candidate?.文本 || candidate?.text || '').trim();
  const meta = {
    focus: normalizeFocus(candidate?.主关注点 || candidate?.focus || text.slice(0, 12)),
    result: normalizeFocus(candidate?.正面结果 || candidate?.result || ''),
    action: normalizeFocus(candidate?.观察动作 || candidate?.action || ''),
    opening: normalizeFocus(candidate?.开头方式 || '') || deriveOpening(text),
    ending: normalizeFocus(candidate?.收尾方式 || '') || deriveEnding(text),
    emotion: String(candidate?.情绪 || '').trim() || '明确满意',
  };
  const factResult = checkFacts(text, factCard);
  const positiveResult = checkPositive(text);
  const repetitionResult = checkRepetition(text);
  const chars = countChars(text);
  const violations = [...factResult.violations, ...positiveResult.violations, ...repetitionResult.violations];
  const warnings = [...factResult.warnings, ...positiveResult.warnings, ...repetitionResult.warnings];
  if (chars < 12) violations.push({ type: '文本过短或为空', detail: `${chars} 字` });
  // 规则蓝本的长度上限：主体 55–85 字、长评 90–110 字，超过 120 字明显越界
  if (chars > 120) violations.push({ type: '超出规则长度上限', detail: `${chars} 字（上限 120）` });
  else if (chars > 112) warnings.push({ type: '略超长评上限', detail: `${chars} 字`, weight: 5 });
  if (/[#*`]|emoji|😀|😂|❤️|✨|🔥/.test(text) || /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) {
    violations.push({ type: '出现表情或标记符号', detail: '需去掉 emoji/符号' });
  }
  return {
    text,
    meta,
    chars,
    violations,
    warnings,
    fillers: fillerHits(text),
    band: chars >= 88 && chars <= 112 ? 'long' : chars >= 50 ? 'main' : 'short',
  };
}

function isSemanticDuplicate(a, b) {
  const sameTriple =
    a.meta.focus && a.meta.focus === b.meta.focus &&
    a.meta.result && a.meta.result === b.meta.result &&
    a.meta.action && a.meta.action === b.meta.action;
  if (sameTriple) return '关注点、结果、观察动作完全相同';
  const samePair =
    (a.meta.focus && a.meta.focus === b.meta.focus) && (a.meta.action && a.meta.action === b.meta.action);
  if (samePair && similarity(a.text, b.text) > 0.55) return '关注点与观察动作重复';
  const score = similarity(a.text, b.text);
  if (score >= 0.72) return `文字高度相似（${score.toFixed(2)}）`;
  const sameFocus = a.meta.focus && a.meta.focus === b.meta.focus;
  const sameResult = a.meta.result && a.meta.result === b.meta.result;
  if ((sameFocus || sameResult) && score >= 0.6) return `关注点或结果相同且表达接近（${score.toFixed(2)}）`;
  return '';
}

function shuffleWithSeed(list, seed) {
  const arr = [...list];
  let state = seed || 1;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 从候选池里挑选最终评论。
 * 目标：数量正确、全正面、事实合规、语义尽量不重复、篇幅与情绪有节奏。
 */
function selectComments(rawCandidates, { factCard, count = 10, seed = Date.now() } = {}) {
  const evaluated = (Array.isArray(rawCandidates) ? rawCandidates : []).map((item) => evaluateCandidate(item, factCard));
  const rejected = [];
  const accepted = [];

  for (const item of evaluated) {
    if (item.violations.length) {
      rejected.push({ ...item, reason: item.violations.map((v) => `${v.type}：${v.detail}`).join('；'), stage: '事实与正面检查' });
      continue;
    }
    let duplicateReason = '';
    for (const kept of accepted) {
      duplicateReason = isSemanticDuplicate(item, kept);
      if (duplicateReason) break;
    }
    if (duplicateReason) {
      rejected.push({ ...item, reason: duplicateReason, stage: '语义去重' });
      continue;
    }
    accepted.push(item);
  }

  const longPool = accepted.filter((item) => item.band === 'long');
  const mainPool = accepted.filter((item) => item.band === 'main');
  const shortPool = accepted.filter((item) => item.band === 'short');

  const targetLong = Math.max(1, Math.min(2, longPool.length, Math.max(1, Math.round(count * 0.15))));
  const targetShort = Math.max(1, Math.min(shortPool.length, Math.round(count * 0.2)));
  let targetMain = count - targetLong - targetShort;

  const chosen = [];
  const fillerCount = new Map();
  const openingCount = new Map();
  const endingCount = new Map();
  const emotionCount = new Map();
  const focusCount = new Map();
  const resultCount = new Map();
  /** 同一主卖点的条数上限（10 条时约 3 条）。事实不足时会自动放宽，保证条数优先 */
  let focusCap = Math.max(2, Math.floor(count / 3));

  const takeFrom = (pool, allowedBands) => {
    let best = null;
    let bestScore = -Infinity;
    for (const item of pool) {
      if (chosen.includes(item)) continue;
      let score = 0;
      score -= item.warnings.reduce((sum, warning) => sum + (warning.weight || 2.2), 0);
      if ((focusCount.get(item.meta.focus) || 0) >= focusCap) score -= 14;
      if ((resultCount.get(item.meta.result) || 0) >= focusCap) score -= 9;
      const fillerPenalty = item.fillers.reduce((sum, word) => sum + (fillerCount.get(word) || 0) * 3, 0);
      score -= fillerPenalty;
      score -= (openingCount.get(item.meta.opening) || 0) * 1.6;
      score -= (endingCount.get(item.meta.ending) || 0) * 1.2;
      score -= (emotionCount.get(item.meta.emotion) || 0) * 0.35;
      let minSimilarity = 1;
      for (const picked of chosen) minSimilarity = Math.min(minSimilarity, similarity(item.text, picked.text));
      score += (1 - minSimilarity) * 6;
      if (allowedBands && allowedBands.includes(item.band)) score += 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    if (!best) return false;
    chosen.push(best);
    for (const word of best.fillers) fillerCount.set(word, (fillerCount.get(word) || 0) + 1);
    openingCount.set(best.meta.opening, (openingCount.get(best.meta.opening) || 0) + 1);
    endingCount.set(best.meta.ending, (endingCount.get(best.meta.ending) || 0) + 1);
    emotionCount.set(best.meta.emotion, (emotionCount.get(best.meta.emotion) || 0) + 1);
    focusCount.set(best.meta.focus, (focusCount.get(best.meta.focus) || 0) + 1);
    resultCount.set(best.meta.result, (resultCount.get(best.meta.result) || 0) + 1);
    return true;
  };

  for (let i = 0; i < targetLong; i += 1) takeFrom(longPool, ['long']);
  for (let i = 0; i < targetMain; i += 1) takeFrom(mainPool, ['main']);
  for (let i = 0; i < targetShort; i += 1) takeFrom(shortPool, ['short']);

  // 不足时放宽主卖点上限，再从剩余候选补齐（条数优先于主题限频）
  focusCap = Number.POSITIVE_INFINITY;
  let guard = 0;
  while (chosen.length < count && guard < accepted.length * 3) {
    guard += 1;
    const remaining = accepted.filter((item) => !chosen.includes(item));
    if (!remaining.length) break;
    if (!takeFrom(remaining, null)) break;
  }

  const ordered = shuffleWithSeed(chosen, seed);
  const fillerOveruse = [];
  for (const [word, times] of fillerCount.entries()) {
    if (times > 1) fillerOveruse.push({ word, times });
  }
  const emotionSummary = {};
  for (const item of ordered) {
    emotionSummary[item.meta.emotion] = (emotionSummary[item.meta.emotion] || 0) + 1;
  }
  return {
    comments: ordered.map((item, index) => ({
      index: index + 1,
      text: item.text,
      chars: item.chars,
      meta: item.meta,
      warnings: item.warnings,
      band: item.band,
    })),
    stats: {
      candidateCount: evaluated.length,
      passed: accepted.length,
      rejected: rejected.length,
      longCount: ordered.filter((item) => item.band === 'long').length,
      mainCount: ordered.filter((item) => item.band === 'main').length,
      shortCount: ordered.filter((item) => item.band === 'short').length,
      emotions: emotionSummary,
      fillerOveruse,
      focusOveruse: [...focusCount.entries()].filter(([, times]) => times > Math.max(2, Math.floor(count / 3))).map(([focus, times]) => ({ focus, times })),
      targetMain,
    },
    rejected: rejected.slice(0, 40),
  };
}

function stripTrailingPeriod(text) {
  return String(text || '').replace(/。\s*$/, '');
}

module.exports = {
  countChars,
  checkFacts,
  checkPositive,
  evaluateCandidate,
  selectComments,
  similarity,
  stripTrailingPeriod,
  authorizedFactText,
  normalizeText,
};
