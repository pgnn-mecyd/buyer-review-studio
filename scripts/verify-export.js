'use strict';

/**
 * 校验导出文件：Markdown 的编号条数/声明，Excel 的表头/行数/结尾句号。
 * 用法：
 *   node scripts/verify-export.js "C:\Users\...\Downloads\xxx_模拟评论_xxx.xlsx"
 *   node scripts/verify-export.js "C:\Users\...\Downloads\xxx_模拟评论_xxx.md"
 */

const fs = require('node:fs');
const path = require('node:path');

async function verifyMarkdown(file) {
  const text = fs.readFileSync(file, 'utf8');
  const items = text.split('\n').filter((line) => /^\d+\.\s/.test(line.trim()));
  console.log('== Markdown 校验 ==');
  console.log('编号评论条数：', items.length);
  console.log('含 AI 生成声明：', /AI 生成/.test(text));
  console.log('含模型行：', /deepseek|模型/.test(text));
  console.log('含条数行：', /条数：\d+/.test(text));
  if (items.length) console.log('第 1 条：', items[0].slice(0, 50));
  return items.length === 10;
}

async function verifyXlsx(file) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet('评论');
  console.log('== Excel 校验 ==');
  console.log('工作表：', workbook.worksheets.map((w) => w.name).join(' | '));
  console.log('表头：', sheet.getRow(1).values.slice(1).join(' / '));
  const rows = sheet.rowCount - 1;
  console.log('数据行数：', rows);
  let trailingPeriod = 0;
  for (let i = 2; i <= sheet.rowCount; i += 1) {
    const text = String(sheet.getRow(i).getCell(3).value || '');
    if (text.endsWith('。')) trailingPeriod += 1;
    if (i <= 4) {
      console.log(`${sheet.getRow(i).getCell(1).value} | ${sheet.getRow(i).getCell(2).value} | ${text.slice(0, 26)}…`);
    }
  }
  console.log('末尾仍是句号的行数（应为 0）：', trailingPeriod);
  return rows === 10 && trailingPeriod === 0;
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.log('用法：node scripts/verify-export.js <导出的 .md 或 .xlsx 路径>');
    process.exit(1);
  }
  const ok = path.extname(file).toLowerCase() === '.md' ? await verifyMarkdown(file) : await verifyXlsx(file);
  console.log(ok ? '\n结果：通过 ✅' : '\n结果：不符合预期 ❌');
  process.exit(ok ? 0 : 2);
}

main().catch((error) => {
  console.error('校验失败：', error);
  process.exit(1);
});
