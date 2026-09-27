'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RULES_DIR = path.join(__dirname, '..', 'rules');

let cache = null;

function findRulesFile() {
  try {
    const files = fs.readdirSync(RULES_DIR).filter((name) => name.toLowerCase().endsWith('.md'));
    if (!files.length) return '';
    const preferred = files.find((name) => /v0\.4\.3/.test(name)) || files[0];
    return path.join(RULES_DIR, preferred);
  } catch {
    return '';
  }
}

/** 读取规则蓝本原文（用于提示词与页面展示） */
function loadRules() {
  if (cache) return cache;
  const file = findRulesFile();
  let text = '';
  if (file) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
  }
  if (!text) {
    text = [
      '# 全正面买家评论 v0.4.3（内置精简版）',
      '每产品默认 10 条；A 组风格；全部正面；整批 7.5–8 表达力度；',
      '主体 55–85 字，含 1–2 条约 100 字（90–110 字）高度赞扬长评，另留少量短评；',
      '不补造参数、认证、治疗承诺与可核验的购买经历；不写成真实顾客反馈。',
    ].join('\n');
  }
  cache = { file, text };
  return cache;
}

module.exports = { loadRules };
