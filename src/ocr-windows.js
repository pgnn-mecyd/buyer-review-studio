'use strict';

/**
 * 本地 OCR 兜底方案：调用 Windows 自带的 OCR 引擎（Windows.Media.Ocr，支持简体中文）。
 * 完全不联网、不消耗模型额度；只在「当前模型不支持图片」或视觉调用失败时使用。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PS51 = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

let cachedSupport = null;

function runPowerShell(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    execFile(
      PS51,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ error, stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

async function isAvailable() {
  if (cachedSupport) return cachedSupport;
  if (process.platform !== 'win32' || !fs.existsSync(PS51)) {
    cachedSupport = { ok: false, reason: '当前系统不是 Windows，或找不到 Windows PowerShell 5.1。' };
    return cachedSupport;
  }
  const script = [
    'try {',
    '  $t = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]',
    '  $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages',
    '  Write-Output ("LANGS=" + (($langs | ForEach-Object { $_.LanguageTag }) -join ","))',
    '} catch { Write-Output ("ERR=" + $_.Exception.Message) }',
  ].join('\n');
  const { stdout } = await runPowerShell(['-Command', script], 30000);
  const match = stdout.match(/LANGS=(.*)/);
  if (!match || !match[1].trim()) {
    cachedSupport = { ok: false, reason: 'Windows OCR 引擎不可用或未安装中文识别语言包。' };
    return cachedSupport;
  }
  const langs = match[1].trim().split(',').filter(Boolean);
  const zh = langs.find((tag) => /^zh/i.test(tag));
  cachedSupport = {
    ok: Boolean(zh),
    langs,
    language: zh || langs[0] || '',
    reason: zh ? '' : '系统 OCR 未安装中文语言包，可在「设置 → 时间和语言 → 语言」中添加中文后重试。',
  };
  return cachedSupport;
}

/** 清理 OCR 输出：去掉中文字符之间被引擎插入的空格，保留英文单词间空格 */
function tidyOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => {
      let out = line.replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])\s+(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, '$1');
      out = out.replace(/([\u4e00-\u9fff])\s+(?=[A-Za-z0-9])/g, '$1');
      out = out.replace(/([A-Za-z0-9])\s+(?=[\u4e00-\u9fff])/g, '$1');
      return out.trim();
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * 对图片做本地 OCR。
 * @param {Buffer} buffer 图片二进制
 * @param {string} [ext] 扩展名（默认 .png，仅用于临时文件）
 */
async function recognize(buffer, ext = '.png') {
  const support = await isAvailable();
  if (!support.ok) return { ok: false, error: support.reason, text: '' };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ocr-'));
  const suffix = /^\.[a-z0-9]{2,5}$/i.test(ext) ? ext : '.png';
  const file = path.join(dir, `image${suffix}`);
  fs.writeFileSync(file, buffer);
  try {
    const scriptPath = path.join(__dirname, 'ocr-ps51.ps1');
    const { stdout, stderr, error } = await runPowerShell(
      ['-File', scriptPath, '-Path', file, '-Language', support.language || 'zh-Hans-CN'],
      120000,
    );
    const text = tidyOcrText(stdout);
    if (!text) {
      return { ok: false, error: error ? `Windows OCR 执行失败：${stderr.slice(0, 300)}` : '本地 OCR 没有识别到文字。', text: '' };
    }
    return { ok: true, text, language: support.language };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时文件清理失败不影响主流程 */
    }
  }
}

module.exports = { isAvailable, recognize, tidyOcrText };
