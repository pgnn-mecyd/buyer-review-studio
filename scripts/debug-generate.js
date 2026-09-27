'use strict';

/**
 * 调试脚本：看一眼模型在生成候选评论时到底返回了什么。
 * 用法： node scripts/debug-generate.js [maxTokens] [reasoningEffort] [candidateCount]
 */

const { loadConfig } = require('../src/config');
const { candidateMessages } = require('../src/prompts');

const factCard = {
  产品名称: '沁润修护精华水 100ml',
  品类: '精华水',
  明确信息: [
    { 类别: '成分', 内容: '透明质酸钠、甘油、积雪草提取物配方', 来源: '文字输入' },
    { 类别: '参数', 内容: '净含量：100ml', 来源: '文字输入' },
    { 类别: '使用方法', 内容: '泵头按压取用，一次一泵', 来源: '文字输入' },
    { 类别: '其他', 内容: '质地清爽，涂开不黏手', 来源: '文字输入' },
  ],
  待确认: [],
  允许表达的结果: ['清爽', '涂开不黏手'],
  允许场景与动作: ['早晚洁面后取适量涂抹于面部', '泵头按压取用'],
  感官信息: ['质地清爽', '涂开不黏手'],
  不得写的内容: ['补水、保湿、修护等功效，资料未提供，禁止写入'],
};

async function main() {
  const maxTokens = Number.parseInt(process.argv[2], 10) || 16000;
  const reasoningEffort = process.argv[3] || '';
  const candidateCount = Number.parseInt(process.argv[4], 10) || 18;
  const config = loadConfig();
  const messages = candidateMessages({ factCard, count: 10, candidateCount, extraNote: '' });
  const body = { model: config.model, messages, max_tokens: maxTokens, stream: false, temperature: config.temperature };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  const started = Date.now();
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`HTTP ${response.status} · ${elapsed}s · max_tokens=${maxTokens} · 候选=${candidateCount} · reasoning_effort=${reasoningEffort || '（未传）'}`);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    console.log('非 JSON 响应：', text.slice(0, 800));
    return;
  }
  const choice = json.choices?.[0];
  console.log(
    JSON.stringify(
      {
        错误: json.error || null,
        finish_reason: choice?.finish_reason,
        usage: json.usage,
        推理占比: json.usage?.completion_tokens
          ? `${(((json.usage.completion_tokens_details?.reasoning_tokens || 0) / json.usage.completion_tokens) * 100).toFixed(1)}%`
          : null,
        输出速度: json.usage?.completion_tokens ? `${(json.usage.completion_tokens / Number(elapsed)).toFixed(0)} tokens/秒` : null,
        content_length: typeof choice?.message?.content === 'string' ? choice.message.content.length : null,
        reasoning_length: typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content.length : null,
        content_head: typeof choice?.message?.content === 'string' ? choice.message.content.slice(0, 300) : null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error('调试失败：', error);
  process.exit(1);
});
