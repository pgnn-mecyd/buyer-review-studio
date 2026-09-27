'use strict';

/** 从模型输出里尽量稳地取出 JSON（容忍 ```json 包裹、前后解释、尾随逗号） */

function stripFences(text) {
  let value = String(text || '').trim();
  const fence = value.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) value = fence[1].trim();
  return value;
}

function findBalancedJson(text) {
  const source = String(text || '');
  const start = source.search(/[[{]/);
  if (start < 0) return '';
  const openChar = source[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

function repairCommonIssues(text) {
  return String(text || '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function parseLooseJson(text) {
  const candidates = [];
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  candidates.push(trimmed);
  candidates.push(stripFences(trimmed));
  const balanced = findBalancedJson(trimmed);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    for (const variant of [candidate, repairCommonIssues(candidate)]) {
      try {
        return JSON.parse(variant);
      } catch {
        /* 试下一种 */
      }
    }
  }
  return null;
}

module.exports = { parseLooseJson };
