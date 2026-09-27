'use strict';

/**
 * 流式生成性能测试：直接打 /api/comments/stream，逐事件打印时间线。
 * 用法：
 *   node scripts/perf-stream.js [count] [baseUrl]
 * 例：
 *   node scripts/perf-stream.js 10
 *   node scripts/perf-stream.js 10 http://127.0.0.1:8798   （测试补生成用的实例）
 */

const fs = require('node:fs');
const path = require('node:path');

const count = Number.parseInt(process.argv[2], 10) || 10;
const baseUrl = (process.argv[3] || 'http://127.0.0.1:8787').replace(/\/+$/, '');

const factCardPath = path.join(__dirname, 'sample-factcard.json');
const factCard = fs.existsSync(factCardPath)
  ? JSON.parse(fs.readFileSync(factCardPath, 'utf8'))
  : {
      产品名称: '沁润修护精华水 100ml',
      品类: '精华水',
      明确信息: [
        { 类别: '成分', 内容: '透明质酸钠、甘油、积雪草提取物配方', 来源: '文字输入' },
        { 类别: '规格', 内容: '净含量：100ml', 来源: '文字输入' },
        { 类别: '使用方法', 内容: '泵头按压取用，一次一泵', 来源: '文字输入' },
        { 类别: '其他', 内容: '质地清爽，涂开不黏手', 来源: '文字输入' },
        { 类别: '使用方法', 内容: '早晚洁面后取适量涂抹于面部', 来源: '文字输入' },
      ],
      待确认: [{ 内容: '产品功效的明确表述', 原因: '资料未提供' }],
      允许表达的结果: ['清爽', '涂开不黏手'],
      允许场景与动作: ['早晚洁面后取适量涂抹于面部', '泵头按压取用，一次一泵'],
      感官信息: ['质地清爽', '涂开不黏手'],
      不得写的内容: ['补水、保湿、修护等功效，资料未提供，禁止写入', '敏感肌可用，资料未提供，禁止写入'],
    };

async function main() {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/comments/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ factCard, count, options: { strength: 8, style: '真实买家感', length: '自动' } }),
  });
  if (!response.ok || !response.body) {
    console.log(`请求失败：HTTP ${response.status}`);
    process.exit(1);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const timeline = [];
  let finalPayload = null;
  let donePayload = null;
  let firstCandidateAt = null;
  let candidateCount = 0;

  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

  const handleFrame = (frame) => {
    const eventMatch = frame.match(/^event: (.+)$/m);
    const dataMatch = frame.match(/^data: ([\s\S]+)$/m);
    if (!eventMatch || !dataMatch) return;
    const event = eventMatch[1].trim();
    let data = null;
    try {
      data = JSON.parse(dataMatch[1]);
    } catch {
      data = { raw: dataMatch[1] };
    }
    const at = Date.now() - started;
    switch (event) {
      case 'generation_start':
        timeline.push(`${seconds(at)}  generation_start  目标 ${data.target} 条，首轮候选 ${data.candidates} 条，最多补 ${data.maxRefillRounds} 轮`);
        break;
      case 'candidate_complete':
        candidateCount += 1;
        if (firstCandidateAt === null) {
          firstCandidateAt = at;
          timeline.push(`${seconds(at)}  candidate_complete 第 ${data.index} 条完整候选到达（首批里最早的）`);
        }
        break;
      case 'generation_progress':
        if (data.generated % 4 === 0 || data.generated <= 2) {
          timeline.push(`${seconds(at)}  progress           已生成 ${data.generated} 条`);
        }
        break;
      case 'filtering':
        timeline.push(`${seconds(at)}  filtering          开始筛选（累计候选 ${data.candidates} 条）`);
        break;
      case 'refill_start':
        timeline.push(`${seconds(at)}  refill_start       缺 ${data.missing} 条，只补生成 ${data.generate} 条`);
        break;
      case 'final_reviews':
        finalPayload = data;
        timeline.push(`${seconds(at)}  final_reviews      最终 ${data.comments.length} 条`);
        break;
      case 'done':
        donePayload = data;
        timeline.push(`${seconds(at)}  done               共 ${data.count} 条，总耗时 ${seconds(data.duration)}`);
        break;
      case 'error':
        timeline.push(`${seconds(at)}  error              ${data.message}`);
        break;
      default:
        break;
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (frame.trim() && !frame.startsWith(':')) handleFrame(frame);
      index = buffer.indexOf('\n\n');
    }
  }

  console.log('===== 事件时间线 =====');
  timeline.forEach((line) => console.log(line));

  console.log('\n===== 性能数据 =====');
  const perf = donePayload || {};
  console.log(`总耗时            ${seconds(perf.duration || (Date.now() - started))}`);
  console.log(`首个事件          ${seconds(perf.firstEventMs || 0)}`);
  console.log(`首条完整候选      ${seconds(perf.firstCandidateMs || firstCandidateAt || 0)}`);
  console.log(`首轮耗时          ${seconds(finalPayload?.report?.perf?.firstRoundMs || 0)}`);
  console.log(`筛选耗时          ${seconds(finalPayload?.report?.perf?.filterMs || 0)}`);
  console.log(`首轮候选          ${finalPayload?.report?.perf?.initialCandidates ?? '—'} 条`);
  console.log(`首轮合格          ${finalPayload?.report?.perf?.validAfterFilter ?? '—'} 条`);
  console.log(`补生成轮数        ${finalPayload?.report?.perf?.refillRounds ?? 0} 轮（补 ${finalPayload?.report?.perf?.refillGenerated ?? 0} 条）`);
  console.log(`最终条数          ${finalPayload?.comments?.length ?? 0}`);
  const usage = perf.usage || finalPayload?.report?.perf?.usage || {};
  console.log(`input tokens      ${usage.input ?? '—'}`);
  console.log(`output tokens     ${usage.output ?? '—'}`);
  console.log(`reasoning tokens  ${usage.reasoning ?? '—'}`);
  console.log(`正文 tokens       ${usage.output && usage.reasoning ? usage.output - usage.reasoning : '—'}`);
  if (finalPayload?.comments?.length) {
    console.log('\n===== 最终评论 =====');
    finalPayload.comments.forEach((item, index) => console.log(`${String(index + 1).padStart(2, '0')}. (${item.chars}字) ${item.text}`));
  }
}

main().catch((error) => {
  console.error('测试失败：', error);
  process.exit(1);
});
