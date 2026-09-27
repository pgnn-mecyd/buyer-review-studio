'use strict';

/**
 * 买家评论生成工具 · 本地服务端
 * - 所有模型调用都在这里发生，密钥只存在服务端，前端拿不到。
 * - 图片识读优先用模型（若模型支持图片），否则回退 Windows 本地 OCR。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { loadConfig, saveConfig, maskKey } = require('./src/config');
const { chat, listModels, ModelError } = require('./src/model');
const { factCardMessages, candidateMessages, regenerateMessages, repairMessages } = require('./src/prompts');
const { parseLooseJson } = require('./src/jsonutil');
const { selectComments, evaluateCandidate } = require('./src/validate');
const { buildMarkdown, buildXlsx, safeFileName, timestamp } = require('./src/exporters');
const { loadRules } = require('./src/rules');
const ocr = require('./src/ocr-windows');

const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSETS_DIR = path.join(__dirname, 'assets');
const MAX_BODY_BYTES = 48 * 1024 * 1024;

/** 运行期能力缓存：模型是否真的能吃图片 */
const capabilities = { vision: null, visionNote: '', visionCheckedAt: '', ocr: null };

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大（超过 48MB），请减少图片数量或压缩图片。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buffer = await readBody(req);
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON。');
  }
}

function serveStatic(req, res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const candidates = [
    path.join(PUBLIC_DIR, relative),
    path.join(ASSETS_DIR, relative),
  ];
  for (const file of candidates) {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(PUBLIC_DIR)) && !resolved.startsWith(path.resolve(ASSETS_DIR))) continue;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
    const data = fs.readFileSync(resolved);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
    return true;
  }
  return false;
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  return { mime: match[1], base64: match[2].replace(/\s+/g, '') };
}

function normalizeImages(images) {
  const list = Array.isArray(images) ? images.slice(0, 8) : [];
  const parsed = [];
  for (const item of list) {
    const image = parseDataUrl(item?.dataUrl);
    if (!image) continue;
    const bytes = Math.floor((image.base64.length * 3) / 4);
    if (bytes > 12 * 1024 * 1024) continue;
    parsed.push({ name: String(item?.name || 'image'), ...image, bytes });
  }
  return parsed;
}

/** 判断错误是不是「模型不支持图片输入」 */
function looksLikeModalityError(error) {
  const message = String(error?.message || '').toLowerCase();
  if (error instanceof ModelError && ![400, 404, 415, 422].includes(error.status)) return false;
  return /image|vision|modal|multimodal|图片|图像|内容类型|content type|unsupported|invalid.*type/.test(message);
}

function factSummaryOf(factCard) {
  const known = Array.isArray(factCard?.明确信息) ? factCard.明确信息.length : 0;
  const pending = Array.isArray(factCard?.待确认) ? factCard.待确认.length : 0;
  const preview = (factCard?.明确信息 || [])
    .map((item) => (typeof item === 'string' ? item : item?.内容))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 3)
    .join('；');
  return `明确信息 ${known} 条、待确认 ${pending} 条${preview ? `（含：${preview}）` : ''}`;
}

function extractCandidates(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['候选', 'candidates', 'comments', '结果', '列表']) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [];
}

function normalizeCandidate(raw) {
  if (typeof raw === 'string') return { 文本: raw };
  if (!raw || typeof raw !== 'object') return null;
  const text = raw.文本 || raw.text || raw.内容 || raw.评论 || raw.comment || '';
  if (!text) return null;
  return {
    文本: String(text).trim(),
    主关注点: raw.主关注点 || raw.focus || '',
    正面结果: raw.正面结果 || raw.result || '',
    观察动作: raw.观察动作 || raw.action || '',
    开头方式: raw.开头方式 || raw.opening || '',
    收尾方式: raw.收尾方式 || raw.ending || '',
    情绪: raw.情绪 || raw.emotion || '明确满意',
  };
}

/** 调模型 + 解析 JSON，必要时让模型修复一次 */
async function askForJson(config, messages, { maxTokens = 12000, temperature } = {}) {
  const first = await chat({ config, messages, maxTokens, temperature });
  let parsed = parseLooseJson(first.text);
  let usedRepair = false;
  if (!parsed) {
    const repaired = await chat({ config, messages: repairMessages(first.text), maxTokens, temperature: 0 });
    parsed = parseLooseJson(repaired.text);
    usedRepair = true;
  }
  return { parsed, usedRepair, usage: first.usage, model: first.model, raw: first.text };
}

/* ------------------------------------------------------------------ *
 * 图片文字提取
 * ------------------------------------------------------------------ */

async function runWindowsOcr(images) {
  if (!images.length) return { ok: false, error: '没有图片', texts: [] };
  const support = await ocr.isAvailable();
  capabilities.ocr = support;
  if (!support.ok) return { ok: false, error: support.reason, texts: [] };
  const texts = [];
  for (const image of images) {
    const ext = image.mime.includes('jpeg') ? '.jpg' : image.mime.includes('webp') ? '.png' : '.png';
    const result = await ocr.recognize(Buffer.from(image.base64, 'base64'), ext);
    texts.push({ name: image.name, ok: result.ok, text: result.text, error: result.error || '' });
  }
  const merged = texts
    .filter((item) => item.text)
    .map((item, index) => `【图片${index + 1}：${item.name}】\n${item.text}`)
    .join('\n\n');
  return { ok: Boolean(merged), texts, merged, error: merged ? '' : '本地 OCR 没有识别到文字。' };
}

async function runExternalOcr(config, images) {
  if (!config.ocr.baseUrl || !config.ocr.model) return { ok: false, error: '未配置外部 OCR 接口。', merged: '' };
  const ocrConfig = { ...config, baseUrl: config.ocr.baseUrl, apiKey: config.ocr.apiKey || config.apiKey, model: config.ocr.model, temperature: 0 };
  const content = [
    {
      type: 'text',
      text: '请只做文字提取：逐行输出图片上看得清的所有文字（含数字、单位、成分、批号）。看不清的地方写 [看不清]。不要解释、不要推断功效。',
    },
    ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } })),
  ];
  const result = await chat({ config: ocrConfig, messages: [{ role: 'user', content }], maxTokens: 3000, temperature: 0, retries: 0 });
  return { ok: Boolean(result.text.trim()), merged: result.text.trim(), error: result.text.trim() ? '' : '外部 OCR 没有返回文字。' };
}

/* ------------------------------------------------------------------ *
 * 事实卡
 * ------------------------------------------------------------------ */

async function buildFactCard(config, { productName, sellingPoints, images }) {
  const started = Date.now();
  const noteParts = [];
  let ocrHint = '';
  let mode = 'text-only';

  if (images.length) {
    const wantsVision = config.visionMode !== 'off';
    let visionWorked = false;
    let visionError = '';

    if (wantsVision) {
      // 本地 OCR 与模型读图可以互补：OCR 结果作为辅助线索传给模型（失败也不影响）
      const local = await runWindowsOcr(images).catch(() => ({ ok: false, merged: '' }));
      if (local.ok) ocrHint = local.merged;

      const { system, userParts } = factCardMessages({
        productName,
        sellingPoints,
        ocrText: ocrHint,
        hasImages: true,
        imageCount: images.length,
      });
      const content = [
        ...userParts,
        ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } })),
      ];
      try {
        const result = await askForJson(
          config,
          [
            { role: 'system', content: system },
            { role: 'user', content },
          ],
          { maxTokens: 6000 },
        );
        if (result.parsed) {
          capabilities.vision = true;
          capabilities.visionCheckedAt = new Date().toISOString();
          capabilities.visionNote = '模型可读图片';
          mode = 'vision';
          visionWorked = true;
          noteParts.push(`已由模型 ${result.model} 读取 ${images.length} 张图片`);
          if (result.usedRepair) noteParts.push('模型输出经过一次 JSON 修复');
          return {
            factCard: result.parsed,
            usedRepair: result.usedRepair,
            extraction: {
              mode,
              images: images.length,
              model: result.model,
              usage: result.usage,
              elapsedMs: Date.now() - started,
              note: `${noteParts.join('；')}；识别不清的内容已放进「待确认」，不会写进评论。`,
              ocrPreview: ocrHint ? ocrHint.slice(0, 1500) : '',
            },
          };
        }
      } catch (error) {
        visionError = error.message;
        if (config.visionMode === 'on' || !looksLikeModalityError(error)) throw error;
      }
      if (!visionWorked) {
        capabilities.vision = false;
        capabilities.visionCheckedAt = new Date().toISOString();
        capabilities.visionNote = `模型未接受图片输入：${visionError.slice(0, 160)}`;
        noteParts.push(`当前模型不接受图片输入（${visionError.slice(0, 120)}），已自动改用图片文字提取方案`);
      }
    }

    // 回退一：外部 OCR / 视觉接口
    let extracted = '';
    if (config.ocr.baseUrl && config.ocr.model) {
      try {
        const external = await runExternalOcr(config, images);
        if (external.ok) {
          extracted = external.merged;
          mode = 'external-ocr';
          noteParts.push(`已用外部 OCR 接口（${config.ocr.model}）提取图片文字`);
        } else {
          noteParts.push(`外部 OCR 未返回文字（${external.error}）`);
        }
      } catch (error) {
        noteParts.push(`外部 OCR 调用失败（${error.message.slice(0, 120)}）`);
      }
    }

    // 回退二：Windows 本地 OCR
    if (!extracted) {
      const local = ocrHint ? { ok: true, merged: ocrHint } : await runWindowsOcr(images);
      if (local.ok && local.merged) {
        extracted = local.merged;
        mode = 'local-ocr';
        noteParts.push('已用 Windows 本机 OCR 引擎提取图片文字（离线、不消耗模型额度，但可能认错字，请逐条核对）');
        ocrHint = local.merged;
      } else {
        noteParts.push(`本机 OCR 也不可用（${local.error || '未知原因'}）`);
      }
    }

    if (!extracted) {
      return {
        factCard: {
          产品名称: productName || '',
          品类: '未确认',
          明确信息: sellingPoints ? [{ 类别: '卖点', 内容: sellingPoints, 来源: '文字输入' }] : [],
          待确认: [{ 内容: '图片文字未能提取', 原因: '当前模型不支持图片输入，且本机 OCR 不可用；请改用支持图片的模型、配置外部 OCR，或手工输入包装文字' }],
          允许表达的结果: [],
          允许场景与动作: [],
          感官信息: [],
          不得写的内容: ['资料未提供，禁止写入任何功效、参数与使用结果'],
        },
        extraction: {
          mode: 'failed',
          images: images.length,
          elapsedMs: Date.now() - started,
          note: `图片文字没有提取成功：${noteParts.join('；')}。你仍然可以手工填写事实卡。`,
        },
      };
    }

    const { system, userParts } = factCardMessages({
      productName,
      sellingPoints,
      ocrText: extracted,
      hasImages: false,
      imageCount: images.length,
    });
    const result = await askForJson(
      config,
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            ...userParts.map((part) => (part.type === 'text' ? { type: 'text', text: `${part.text}\n\n【已提取的图片文字（可能含 OCR 错字）】\n${extracted.slice(0, 8000)}` } : part)),
          ],
        },
      ],
      { maxTokens: 6000 },
    );
    if (!result.parsed) throw new Error('模型没有返回可解析的事实卡 JSON，请重试或换一个模型。');
    noteParts.push('图片文字由 OCR 提取后再交给文本模型整理，OCR 可能认错字，请在事实卡中核对');
    return {
      factCard: result.parsed,
      usedRepair: result.usedRepair,
      extraction: {
        mode,
        images: images.length,
        model: result.model,
        usage: result.usage,
        elapsedMs: Date.now() - started,
        note: `${noteParts.join('；')}。`,
        ocrPreview: extracted.slice(0, 2000),
      },
    };
  }

  const { system, userParts } = factCardMessages({ productName, sellingPoints, ocrText: '', hasImages: false, imageCount: 0 });
  const result = await askForJson(
    config,
    [
      { role: 'system', content: system },
      { role: 'user', content: userParts },
    ],
    { maxTokens: 6000 },
  );
  if (!result.parsed) throw new Error('模型没有返回可解析的事实卡 JSON，请重试或换一个模型。');
  return {
    factCard: result.parsed,
    usedRepair: result.usedRepair,
    extraction: {
      mode: 'text-only',
      images: 0,
      model: result.model,
      usage: result.usage,
      elapsedMs: Date.now() - started,
      note: '本次只用文字输入整理事实卡；没有上传图片。',
    },
  };
}

/* ------------------------------------------------------------------ *
 * 评论生成
 * ------------------------------------------------------------------ */

function candidatePlan(count) {
  if (count <= 5) return Math.max(6, count * 2);
  if (count >= 11 && count <= 15) return Math.ceil(count * 1.5);
  return Math.max(16, Math.min(20, count + 8));
}

function usedObservationNote(selection) {
  const rows = selection.comments.map((item) => `${item.meta.focus || '—'}|${item.meta.result || '—'}|${item.meta.action || '—'}`);
  const rejectedRows = selection.rejected
    .slice(0, 12)
    .map((item) => `被筛掉（${item.stage}：${item.reason}）`);
  return [
    '以下是上一轮已经使用或已经排除的内容，请避开这些关注点、结果与观察动作的组合，换用事实卡里尚未被使用的已知优点：',
    ...rows.map((row) => `- ${row}`),
    ...rejectedRows.map((row) => `- ${row}`),
    '如果事实卡里的已知优点已经用完，请用更短、更具体的表达区分侧重点，不要编造新事实，也不要加入缺点。',
  ].join('\n');
}

/** 每批的写作侧重：分开写能显著减少模型一次要处理的信息量，也能提高候选差异度 */
const BATCH_FOCUS = [
  '本批以「强烈满意」和「明确满意」为主，围绕操作便利与直接可见的结果来写；其中至少 1 条写成 90–110 字的高度赞扬长评。',
  '本批以「平静肯定」和「短直球」为主，篇幅整体偏短、语气平实；其中至少 1 条写成 90–110 字的高度赞扬长评。',
  '本批重点覆盖前面尚未使用的已知优点，换用不同的观察动作与开头方式，避免与已有候选重复。',
];

function sumUsage(list) {
  const result = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const usage of list) {
    if (!usage) continue;
    result.prompt_tokens += usage.prompt_tokens || 0;
    result.completion_tokens += usage.completion_tokens || 0;
    result.total_tokens += usage.total_tokens || 0;
  }
  return result;
}

async function generateComments(config, { factCard, count, onProgress }) {
  const started = Date.now();
  const pool = [];
  let selection = null;
  let rounds = 0;
  let lastModel = config.model;
  const usages = [];
  let usedRepair = false;
  // 推理型模型会先消耗大量推理 token，单次预算给足才不会出现"只有推理没有正文"
  const perCallMaxTokens = Math.max(12000, Math.min(120000, config.maxTokens || 32000));

  for (let round = 1; round <= 3; round += 1) {
    rounds = round;
    const missing = Math.max(count, 1) - (selection ? selection.comments.length : 0);
    if (round > 1 && missing <= 0) break;
    const askTotal = round === 1 ? Math.max(candidatePlan(count), count) : Math.max(missing * 3, 8);
    const batchCount = askTotal >= 12 ? 2 : 1;
    const perBatch = Math.ceil(askTotal / batchCount);
    const extraNote = round === 1 ? '' : usedObservationNote(selection);

    if (onProgress) onProgress(`第 ${round} 轮：分 ${batchCount} 批并发生成候选`);
    const jobs = [];
    for (let index = 0; index < batchCount; index += 1) {
      jobs.push(
        askForJson(
          config,
          candidateMessages({
            factCard,
            count,
            candidateCount: perBatch,
            focusHint: round === 1 ? BATCH_FOCUS[index % BATCH_FOCUS.length] : BATCH_FOCUS[2],
            extraNote,
          }),
          { maxTokens: perCallMaxTokens },
        )
          .then((result) => ({
            candidates: extractCandidates(result.parsed).map(normalizeCandidate).filter(Boolean),
            model: result.model,
            usage: result.usage,
            usedRepair: result.usedRepair,
          }))
          .catch((error) => {
            if (batchCount === 1) throw error;
            // 单批失败不影响其它批次：记录后继续
            console.error(`候选批次 ${index + 1} 失败：`, error.message);
            return { candidates: [], error };
          }),
      );
    }
    const results = await Promise.all(jobs);
    const got = results.reduce((sum, item) => sum + item.candidates.length, 0);
    const failures = results.filter((item) => item.error);
    results.forEach((item) => {
      if (item.model) lastModel = item.model;
      if (item.usage) usages.push(item.usage);
      if (item.usedRepair) usedRepair = true;
      pool.push(...item.candidates);
    });
    if (!got) {
      if (failures.length && round === 3) throw failures[0].error;
      if (failures.length && round < 3) continue;
      if (round === 3) throw new Error('模型没有返回可解析的候选评论 JSON，请重试或换一个模型。');
      continue;
    }
    selection = selectComments(pool, { factCard, count, seed: Date.now() + round });
    if (selection.comments.length >= count) break;
  }

  if (!selection) throw new Error('生成失败：没有得到任何候选评论。');

  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const warnings = [];
  selection.comments.forEach((item, index) => {
    item.warnings.forEach((warning) => warnings.push({ index: index + 1, type: warning.type, detail: warning.detail }));
  });
  const report = {
    model: lastModel,
    generatedAt,
    elapsedMs: Date.now() - started,
    rounds,
    candidateCount: pool.length,
    passed: selection.stats.passed,
    rejectedCount: selection.stats.rejected,
    selected: selection.comments.length,
    length: { long: selection.stats.longCount, main: selection.stats.mainCount, short: selection.stats.shortCount },
    emotions: selection.stats.emotions,
    fillerOveruse: selection.stats.fillerOveruse,
    focusOveruse: selection.stats.focusOveruse,
    warnings,
    rejected: selection.rejected.map((item) => ({ stage: item.stage, reason: item.reason, text: item.text })),
    factSummary: factSummaryOf(factCard),
    usedRepair,
    usage: sumUsage(usages),
  };
  return { comments: selection.comments, report, model: lastModel, generatedAt };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

async function handleConfig(res) {
  const config = loadConfig();
  const localOcr = await ocr.isAvailable();
  capabilities.ocr = localOcr;
  let host = '';
  try {
    host = new URL(config.baseUrl).host;
  } catch {
    host = config.baseUrl ? config.baseUrl.replace(/^https?:\/\//, '').split('/')[0] : '';
  }
  const ready = Boolean(config.baseUrl && config.apiKey && config.model);
  sendJson(res, 200, {
    ready,
    message: ready ? '' : '还没有可用的模型配置',
    baseUrl: config.baseUrl,
    baseUrlHost: host,
    model: config.model,
    apiKeyMasked: maskKey(config.apiKey),
    visionMode: config.visionMode,
    visionHint:
      capabilities.vision === true
        ? '模型可读图片'
        : capabilities.vision === false
          ? '模型不接受图片，将回退图片文字提取'
          : '',
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    ocr: { baseUrl: config.ocr.baseUrl, model: config.ocr.model, hasKey: Boolean(config.ocr.apiKey) },
    sources: config.sources,
    codex: config.codex,
    localOcr: { ok: localOcr.ok, language: localOcr.language || '', reason: localOcr.reason || '' },
    rulesFile: loadRules().file,
  });
}

async function handleTestConnection(res, body) {
  const config = loadConfig();
  const lines = [];
  let ok = false;
  const started = Date.now();
  lines.push(`接口地址：${config.baseUrl || '（未配置）'}`);
  lines.push(`模型 ID：${config.model || '（未配置）'}`);
  lines.push(`密钥：${config.apiKey ? maskKey(config.apiKey) : '（未配置）'}`);
  lines.push(`来源：接口地址=${config.sources.baseUrl}；模型=${config.sources.model}；密钥=${config.sources.apiKey}`);
  try {
    const models = await listModels(config);
    lines.push(`模型列表：读到 ${models.length} 个 → ${models.map((m) => `${m.id}${m.inputModalities ? `(${m.inputModalities.join('/')})` : ''}`).join('，')}`);
    const listed = models.find((m) => m.id === config.model);
    if (!listed) lines.push(`提示：当前模型 ID「${config.model}」不在接口返回的列表里，请确认它确实是该接口的真实模型 ID。`);
    else if (listed.inputModalities) lines.push(`该模型声明的输入模态：${listed.inputModalities.join('、')}`);
  } catch (error) {
    lines.push(`读取模型列表失败：${error.message}`);
  }
  try {
    const reply = await chat({ config, messages: [{ role: 'user', content: '只回复两个字：连通' }], maxTokens: 64, temperature: 0, retries: 0 });
    lines.push(`文本调用：成功（${Date.now() - started} ms）→ "${reply.text.trim().slice(0, 30)}"`);
    ok = true;
  } catch (error) {
    lines.push(`文本调用失败：${error.message}`);
  }
  if (body?.includeVisionProbe) {
    const probePath = path.join(ASSETS_DIR, 'vision-probe.png');
    if (!fs.existsSync(probePath)) {
      lines.push('读图能力探测：跳过（缺少探测图片 assets/vision-probe.png）');
    } else {
      try {
        const base64 = fs.readFileSync(probePath).toString('base64');
        const reply = await chat({
          config,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '这张图片上有中文文字，请只输出第一行的文字内容，不要解释。' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
              ],
            },
          ],
          maxTokens: 128,
          temperature: 0,
          retries: 0,
        });
        const text = reply.text.trim();
        lines.push(`读图能力探测：成功 → "${text.slice(0, 60)}"`);
        capabilities.vision = true;
        capabilities.visionNote = '模型可读图片（已用探测图片验证）';
        capabilities.visionCheckedAt = new Date().toISOString();
      } catch (error) {
        lines.push(`读图能力探测：失败（${error.message}）`);
        capabilities.vision = false;
        capabilities.visionNote = `模型未接受图片输入：${error.message.slice(0, 160)}`;
        capabilities.visionCheckedAt = new Date().toISOString();
        lines.push('→ 图片流程会自动改用本机 OCR 或你配置的外部 OCR 接口。');
      }
    }
  }
  const localOcr = await ocr.isAvailable();
  lines.push(`Windows 本机 OCR：${localOcr.ok ? `可用（${localOcr.language}）` : `不可用（${localOcr.reason}）`}`);
  sendJson(res, 200, { ok, lines });
}

async function handleFacts(res, body) {
  const config = loadConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) {
    sendError(res, 400, '模型尚未配置：请先在「模型设置」中填写接口地址、模型 ID 和密钥。');
    return;
  }
  const images = normalizeImages(body.images);
  const result = await buildFactCard(config, {
    productName: String(body.productName || '').trim(),
    sellingPoints: String(body.sellingPoints || '').trim(),
    images,
  });
  sendJson(res, 200, { factCard: result.factCard, extraction: result.extraction });
}

async function handleComments(res, body) {
  const config = loadConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) {
    sendError(res, 400, '模型尚未配置：请先在「模型设置」中填写接口地址、模型 ID 和密钥。');
    return;
  }
  const factCard = body.factCard;
  if (!factCard || typeof factCard !== 'object') {
    sendError(res, 400, '缺少产品事实卡，请先生成并核对事实卡。');
    return;
  }
  const count = Math.min(20, Math.max(1, Number.parseInt(body.count, 10) || 10));
  const result = await generateComments(config, { factCard, count });
  sendJson(res, 200, result);
}

async function handleRegenerate(res, body) {
  const config = loadConfig();
  const factCard = body.factCard;
  if (!factCard) {
    sendError(res, 400, '缺少产品事实卡。');
    return;
  }
  const index = Math.max(1, Number.parseInt(body.index, 10) || 1);
  const messages = regenerateMessages({
    factCard,
    index,
    targetLength: body.targetLength || '55–85 字',
    targetEmotion: body.targetEmotion || '明确满意',
    usedObservations: Array.isArray(body.usedObservations) ? body.usedObservations.slice(0, 30) : [],
    avoidTexts: Array.isArray(body.avoidTexts) ? body.avoidTexts.slice(0, 30) : [],
  });
  let result = await askForJson(config, messages, { maxTokens: 4000 });
  let candidate = normalizeCandidate(result.parsed);
  if (!candidate) {
    const raw = typeof result.raw === 'string' ? result.raw.trim() : '';
    if (raw) candidate = { 文本: raw, 主关注点: '', 正面结果: '', 观察动作: '', 情绪: body.targetEmotion || '明确满意' };
  }
  if (!candidate) {
    sendError(res, 502, '模型没有返回可用的评论内容，请重试。');
    return;
  }

  let evaluated = evaluateCandidate(candidate, factCard);
  if (evaluated.violations.length) {
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify({ 文本: candidate.文本 }) },
      {
        role: 'user',
        content: `上面这条违反规则：${evaluated.violations.map((v) => `${v.type}（${v.detail}）`).join('；')}。请重写一条完全合规的评论，仍然只输出 JSON。`,
      },
    ];
    const retry = await askForJson(config, retryMessages, { maxTokens: 4000 });
    const retried = normalizeCandidate(retry.parsed);
    if (retried) {
      candidate = retried;
      evaluated = evaluateCandidate(candidate, factCard);
    }
  }
  sendJson(res, 200, {
    comment: {
      index,
      text: candidate.文本,
      chars: evaluated.chars,
      meta: evaluated.meta,
      band: evaluated.band,
      warnings: evaluated.warnings,
    },
    violations: evaluated.violations,
    model: result.model,
  });
}

async function handleValidate(res, body) {
  const factCard = body.factCard || {};
  const comments = Array.isArray(body.comments) ? body.comments : [];
  const results = comments.map((item, index) => {
    const evaluated = evaluateCandidate({ 文本: typeof item === 'string' ? item : item.text }, factCard);
    return {
      index: index + 1,
      chars: evaluated.chars,
      violations: evaluated.violations,
      warnings: evaluated.warnings,
      band: evaluated.band,
    };
  });
  sendJson(res, 200, { results });
}

async function handleExportMarkdown(res, body) {
  const comments = Array.isArray(body.comments) ? body.comments : [];
  if (!comments.length) {
    sendError(res, 400, '没有可导出的评论。');
    return;
  }
  const productName = String(body.productName || '未命名产品');
  const markdown = buildMarkdown({
    productName,
    comments,
    model: body.model,
    generatedAt: body.generatedAt,
    report: body.report,
  });
  sendJson(res, 200, { markdown, filename: `${safeFileName(productName)}_模拟评论_${timestamp()}.md` });
}

async function handleExportExcel(res, body) {
  const comments = Array.isArray(body.comments) ? body.comments : [];
  if (!comments.length) {
    sendError(res, 400, '没有可导出的评论。');
    return;
  }
  const productName = String(body.productName || '未命名产品');
  const buffer = await buildXlsx({
    productName,
    comments,
    model: body.model,
    generatedAt: body.generatedAt,
    report: body.report,
    factCard: body.factCard,
  });
  const filename = `${safeFileName(productName)}_模拟评论_${timestamp()}.xlsx`;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="reviews.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.end(Buffer.from(buffer));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  try {
    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }
    if (pathname === '/api/rules') {
      const rules = loadRules();
      sendJson(res, 200, { file: rules.file, name: 'v0.4.3', text: rules.text });
      return;
    }
    if (pathname === '/api/config' && req.method === 'GET') {
      await handleConfig(res);
      return;
    }
    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      saveConfig(body);
      await handleConfig(res);
      return;
    }
    if (pathname === '/api/config/models' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const config = loadConfig();
      const models = await listModels(config, {
        baseUrl: body.baseUrl || config.baseUrl,
        apiKey: body.apiKey || config.apiKey,
      });
      sendJson(res, 200, { models });
      return;
    }
    if (pathname === '/api/config/test' && req.method === 'POST') {
      const body = await readJsonBody(req);
      await handleTestConnection(res, body);
      return;
    }
    if (pathname === '/api/facts' && req.method === 'POST') {
      await handleFacts(res, await readJsonBody(req));
      return;
    }
    if (pathname === '/api/comments' && req.method === 'POST') {
      await handleComments(res, await readJsonBody(req));
      return;
    }
    if (pathname === '/api/comments/regenerate' && req.method === 'POST') {
      await handleRegenerate(res, await readJsonBody(req));
      return;
    }
    if (pathname === '/api/validate' && req.method === 'POST') {
      await handleValidate(res, await readJsonBody(req));
      return;
    }
    if (pathname === '/api/export/markdown' && req.method === 'POST') {
      await handleExportMarkdown(res, await readJsonBody(req));
      return;
    }
    if (pathname === '/api/export/excel' && req.method === 'POST') {
      await handleExportExcel(res, await readJsonBody(req));
      return;
    }
    if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
    sendError(res, 404, '页面或接口不存在。');
  } catch (error) {
    const status = error instanceof ModelError ? (error.status && error.status >= 400 && error.status < 600 ? 502 : 502) : 500;
    console.error(`[${new Date().toLocaleTimeString('zh-CN')}] ${req.method} ${pathname} 失败：`, error.message);
    sendError(res, status, error.message || '服务端错误');
  }
});

function start(port, attemptsLeft = 10) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`端口 ${port} 已被占用，尝试 ${port + 1} …`);
      start(port + 1, attemptsLeft - 1);
      return;
    }
    console.error('启动失败：', error.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const rules = loadRules();
    console.log('');
    console.log('==============================================');
    console.log(' 买家评论生成工具（本地运行）');
    console.log(` 打开地址： http://127.0.0.1:${port}`);
    console.log(` 规则蓝本： ${rules.file ? path.basename(rules.file) : '内置精简版'}`);
    console.log(' 关闭服务： 在本窗口按 Ctrl + C');
    console.log('==============================================');
    console.log('');
  });
}

const PORT = Number.parseInt(process.env.BUYER_REVIEW_PORT, 10) || 8787;
start(PORT);
