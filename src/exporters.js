'use strict';

const ExcelJS = require('exceljs');
const { stripTrailingPeriod } = require('./validate');

const DISCLAIMER =
  '本文件中的评论内容由 AI 生成，属于模拟评论文案，不代表任何真实顾客的反馈，也不是真实消费者已发表的评价。';

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function safeFileName(name) {
  const cleaned = String(name || '未命名产品').replace(/[\\/:*?"<>|\r\n]/g, '').trim();
  return cleaned.slice(0, 40) || '未命名产品';
}

function buildMarkdown({ productName, comments, model, generatedAt, report }) {
  const lines = [];
  lines.push(`# ${productName || '未命名产品'} · 模拟买家评论（AI 生成）`);
  lines.push('');
  lines.push(`> ${DISCLAIMER}`);
  lines.push('');
  lines.push(`- 生成时间：${generatedAt || new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 生成模型：${model || '未记录'}`);
  lines.push(`- 条数：${comments.length}`);
  if (report && report.factSummary) lines.push(`- 事实依据：${report.factSummary}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  comments.forEach((item, index) => {
    lines.push(`${index + 1}. ${String(item.text || '').trim()}`);
    lines.push('');
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

async function buildXlsx({ productName, comments, model, generatedAt, report, factCard }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '买家评论生成工具（本地）';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('评论');
  sheet.columns = [
    { header: '序号', key: 'no', width: 8 },
    { header: '产品名称', key: 'product', width: 28 },
    { header: '评论内容', key: 'text', width: 90 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  comments.forEach((item, index) => {
    const row = sheet.addRow({
      no: index + 1,
      product: productName || '',
      text: stripTrailingPeriod(item.text),
    });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell('no').alignment = { vertical: 'top', horizontal: 'center' };
    sheet.getRow(row.number).height = Math.max(30, Math.ceil(String(item.text || '').length / 42) * 18);
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const info = workbook.addWorksheet('说明');
  info.columns = [
    { header: '项目', key: 'k', width: 20 },
    { header: '内容', key: 'v', width: 90 },
  ];
  info.getRow(1).font = { bold: true };
  const rows = [
    ['文件说明', DISCLAIMER],
    ['产品名称', productName || ''],
    ['生成时间', generatedAt || new Date().toLocaleString('zh-CN')],
    ['生成模型', model || '未记录'],
    ['评论条数', String(comments.length)],
    ['处理规则', '《买家评论生成规则 v0.4.3 完整版》：A 组风格、全部正面、7.5–8 表达力度、1–2 条约 100 字长评'],
  ];
  if (report && report.summaryText) rows.push(['自检结论', report.summaryText]);
  if (report && report.factSummary) rows.push(['事实依据', report.factSummary]);
  if (factCard && Array.isArray(factCard.待确认) && factCard.待确认.length) {
    rows.push([
      '仍待确认的信息',
      factCard.待确认.map((item) => (typeof item === 'string' ? item : item.内容)).filter(Boolean).join('；'),
    ]);
  }
  rows.push(['格式说明', 'Excel 中每条评论已按规则去掉末尾最后一个句号，正文中间的句号保留。']);
  rows.forEach(([k, v]) => {
    const row = info.addRow({ k, v });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell('k').font = { bold: true };
  });

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildMarkdown, buildXlsx, safeFileName, timestamp, DISCLAIMER };
