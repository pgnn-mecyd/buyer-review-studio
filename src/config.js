'use strict';

/**
 * 配置解析：把「网页设置 / .env / 环境变量 / Codex 现有配置」合成一份运行时配置。
 *
 * 优先级（高 → 低）：
 *   1. 进程环境变量 BUYER_REVIEW_*
 *   2. 项目目录 config.json（网页「模型设置」写入的文件）
 *   3. 项目目录 .env
 *   4. 自动复用 Codex 现有配置（只读，仅用于读取接口地址与密钥）
 *   5. 内置默认值
 *
 * 密钥只保存在服务端，永远不会返回给浏览器。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const ENV_FILE = path.join(ROOT, '.env');

const ENV_KEYS = {
  baseUrl: 'BUYER_REVIEW_BASE_URL',
  apiKey: 'BUYER_REVIEW_API_KEY',
  model: 'BUYER_REVIEW_MODEL',
  vision: 'BUYER_REVIEW_VISION',
  temperature: 'BUYER_REVIEW_TEMPERATURE',
  maxTokens: 'BUYER_REVIEW_MAX_TOKENS',
  ocrBaseUrl: 'BUYER_REVIEW_OCR_BASE_URL',
  ocrApiKey: 'BUYER_REVIEW_OCR_API_KEY',
  ocrModel: 'BUYER_REVIEW_OCR_MODEL',
};

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJsonSafe(file) {
  const raw = readTextSafe(file);
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    return { __parseError: String(err && err.message) };
  }
}

/** 解析 .env（KEY=VALUE，忽略 # 注释与引号） */
function parseDotEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function unquote(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 只解析本工具需要的那部分 Codex config.toml：
 * 顶层 model / model_provider / model_catalog_json，以及 [model_providers.x] 块。
 */
function parseCodexConfigToml(text) {
  const result = { model: '', modelProvider: '', catalogPath: '', providers: {} };
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      const providerMatch = section.match(/^model_providers\.(.+)$/);
      if (providerMatch) {
        const name = unquote(providerMatch[1]);
        if (!result.providers[name]) result.providers[name] = { name };
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_."'-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = unquote(kv[1]);
    const value = unquote(kv[2]);
    const providerMatch = section.match(/^model_providers\.(.+)$/);
    if (providerMatch) {
      const name = unquote(providerMatch[1]);
      result.providers[name][key] = value;
    } else if (section === '') {
      if (key === 'model') result.model = value;
      else if (key === 'model_provider') result.modelProvider = value;
      else if (key === 'model_catalog_json') result.catalogPath = value;
    }
  }
  return result;
}

function codexHome() {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME.trim()
    : path.join(os.homedir(), '.codex');
}

/** 读取模型目录（models.json / models_cache.json），用于核对真实模型 ID 与图片能力 */
function readCatalog(catalogPath) {
  const candidates = [];
  if (catalogPath) candidates.push(catalogPath);
  candidates.push(path.join(codexHome(), 'models.json'));
  candidates.push(path.join(codexHome(), 'models_cache.json'));
  for (const file of candidates) {
    const json = readJsonSafe(file);
    if (json && !json.__parseError && Array.isArray(json.models)) {
      return { path: file, models: json.models };
    }
  }
  return { path: '', models: [] };
}

/**
 * 自动复用 Codex 现有模型配置（只读）。
 * 只读取「接口地址 + 密钥 + 模型中转配置」，不复制 Codex 的对话或登录态。
 */
function detectFromCodex() {
  const home = codexHome();
  const configPath = path.join(home, 'config.toml');
  const toml = readTextSafe(configPath);
  const parsed = toml ? parseCodexConfigToml(toml) : { providers: {}, model: '', modelProvider: '', catalogPath: '' };

  const providerName = parsed.modelProvider || 'openai';
  const provider = parsed.providers[providerName] || {};
  const catalog = readCatalog(parsed.catalogPath);

  let apiKey = '';
  let keySource = '';
  if (provider.experimental_bearer_token) {
    apiKey = provider.experimental_bearer_token;
    keySource = `Codex 配置 model_providers.${providerName}.experimental_bearer_token`;
  } else if (provider.api_key) {
    apiKey = provider.api_key;
    keySource = `Codex 配置 model_providers.${providerName}.api_key`;
  } else if (provider.env_key && process.env[provider.env_key]) {
    apiKey = process.env[provider.env_key];
    keySource = `环境变量 ${provider.env_key}`;
  } else {
    const authJson = readJsonSafe(path.join(home, 'auth.json'));
    if (authJson && typeof authJson.OPENAI_API_KEY === 'string' && authJson.OPENAI_API_KEY) {
      apiKey = authJson.OPENAI_API_KEY;
      keySource = 'Codex auth.json: OPENAI_API_KEY';
    }
  }

  const baseUrl = provider.base_url || '';
  const catalogModel = catalog.models.find((m) => m && m.slug === parsed.model);
  const visionCapable = catalogModel
    ? Boolean((catalogModel.input_modalities || []).includes('image'))
    : null;

  return {
    available: Boolean(baseUrl && apiKey),
    configPath,
    providerName,
    baseUrl,
    apiKey,
    keySource,
    model: parsed.model || '',
    catalogPath: catalog.path,
    /** 目录里的能力声明只是提示，最终以真实接口探测为准 */
    catalogVisionCapable: visionCapable,
    wireApi: provider.wire_api || 'chat',
  };
}

function fromEnv(env) {
  return {
    baseUrl: env[ENV_KEYS.baseUrl] || '',
    apiKey: env[ENV_KEYS.apiKey] || '',
    model: env[ENV_KEYS.model] || '',
    vision: env[ENV_KEYS.vision] || '',
    temperature: env[ENV_KEYS.temperature] || '',
    maxTokens: env[ENV_KEYS.maxTokens] || '',
    ocrBaseUrl: env[ENV_KEYS.ocrBaseUrl] || '',
    ocrApiKey: env[ENV_KEYS.ocrApiKey] || '',
    ocrModel: env[ENV_KEYS.ocrModel] || '',
  };
}

function fromFileConfig(json) {
  if (!json || typeof json !== 'object' || json.__parseError) return {};
  const ocr = json.ocr && typeof json.ocr === 'object' ? json.ocr : {};
  return {
    baseUrl: typeof json.baseUrl === 'string' ? json.baseUrl : '',
    apiKey: typeof json.apiKey === 'string' ? json.apiKey : '',
    model: typeof json.model === 'string' ? json.model : '',
    vision: typeof json.vision === 'string' ? json.vision : '',
    temperature: json.temperature === undefined || json.temperature === null ? '' : String(json.temperature),
    maxTokens: json.maxTokens === undefined || json.maxTokens === null ? '' : String(json.maxTokens),
    ocrBaseUrl: typeof ocr.baseUrl === 'string' ? ocr.baseUrl : '',
    ocrApiKey: typeof ocr.apiKey === 'string' ? ocr.apiKey : '',
    ocrModel: typeof ocr.model === 'string' ? ocr.model : '',
  };
}

function firstNonEmpty(candidates) {
  for (const item of candidates) {
    if (item && item.value) return { value: item.value, source: item.source };
  }
  for (const item of candidates) {
    if (item && item.value !== undefined && item.value !== null && item.fallback) {
      return { value: item.value, source: item.source };
    }
  }
  return { value: '', source: '未配置' };
}

function normalizeBaseUrl(url) {
  const trimmed = String(url || '').trim().replace(/\s+/g, '');
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

function loadConfig() {
  const processEnv = fromEnv(process.env);
  const fileConfig = fromFileConfig(readJsonSafe(CONFIG_FILE));
  const fileEnv = fromEnv(parseDotEnv(readTextSafe(ENV_FILE)));
  const codex = detectFromCodex();

  const baseUrl = firstNonEmpty([
    { value: normalizeBaseUrl(processEnv.baseUrl), source: `环境变量 ${ENV_KEYS.baseUrl}` },
    { value: normalizeBaseUrl(fileConfig.baseUrl), source: 'config.json（网页设置）' },
    { value: normalizeBaseUrl(fileEnv.baseUrl), source: '.env' },
    { value: normalizeBaseUrl(codex.baseUrl), source: `Codex 配置 model_providers.${codex.providerName}` },
    { value: '', source: '未配置', fallback: true },
  ]);
  const apiKey = firstNonEmpty([
    { value: processEnv.apiKey, source: `环境变量 ${ENV_KEYS.apiKey}` },
    { value: fileConfig.apiKey, source: 'config.json（网页设置）' },
    { value: fileEnv.apiKey, source: '.env' },
    { value: codex.apiKey, source: codex.keySource || 'Codex 配置' },
    { value: '', source: '未配置', fallback: true },
  ]);
  const model = firstNonEmpty([
    { value: processEnv.model, source: `环境变量 ${ENV_KEYS.model}` },
    { value: fileConfig.model, source: 'config.json（网页设置）' },
    { value: fileEnv.model, source: '.env' },
    { value: codex.model, source: 'Codex 配置 model' },
    { value: '', source: '未配置', fallback: true },
  ]);
  const vision = firstNonEmpty([
    { value: processEnv.vision, source: `环境变量 ${ENV_KEYS.vision}` },
    { value: fileConfig.vision, source: 'config.json（网页设置）' },
    { value: fileEnv.vision, source: '.env' },
    { value: 'auto', source: '默认值', fallback: true },
  ]);
  const temperature = firstNonEmpty([
    { value: processEnv.temperature, source: `环境变量 ${ENV_KEYS.temperature}` },
    { value: fileConfig.temperature, source: 'config.json（网页设置）' },
    { value: fileEnv.temperature, source: '.env' },
    { value: '0.95', source: '默认值', fallback: true },
  ]);
  const ocrBaseUrl = firstNonEmpty([
    { value: normalizeBaseUrl(processEnv.ocrBaseUrl), source: `环境变量 ${ENV_KEYS.ocrBaseUrl}` },
    { value: normalizeBaseUrl(fileConfig.ocrBaseUrl), source: 'config.json（网页设置）' },
    { value: normalizeBaseUrl(fileEnv.ocrBaseUrl), source: '.env' },
    { value: '', source: '未配置（回退 Windows 本地 OCR）', fallback: true },
  ]);
  const ocrApiKey = firstNonEmpty([
    { value: processEnv.ocrApiKey, source: `环境变量 ${ENV_KEYS.ocrApiKey}` },
    { value: fileConfig.ocrApiKey, source: 'config.json（网页设置）' },
    { value: fileEnv.ocrApiKey, source: '.env' },
    { value: '', source: '未配置', fallback: true },
  ]);
  const ocrModel = firstNonEmpty([
    { value: processEnv.ocrModel, source: `环境变量 ${ENV_KEYS.ocrModel}` },
    { value: fileConfig.ocrModel, source: 'config.json（网页设置）' },
    { value: fileEnv.ocrModel, source: '.env' },
    { value: '', source: '未配置', fallback: true },
  ]);

  const tempNumber = Number.parseFloat(temperature.value);
  const maxTokens = firstNonEmpty([
    { value: processEnv.maxTokens, source: `环境变量 ${ENV_KEYS.maxTokens}` },
    { value: fileConfig.maxTokens, source: 'config.json（网页设置）' },
    { value: fileEnv.maxTokens, source: '.env' },
    { value: '32000', source: '默认值', fallback: true },
  ]);
  const maxTokensNumber = Number.parseInt(maxTokens.value, 10);

  return {
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    model: model.value,
    visionMode: (vision.value || 'auto').toLowerCase(),
    temperature: Number.isFinite(tempNumber) ? Math.min(Math.max(tempNumber, 0), 2) : 0.95,
    maxTokens: Number.isFinite(maxTokensNumber) && maxTokensNumber >= 8000 ? Math.min(maxTokensNumber, 200000) : 32000,
    ocr: { baseUrl: ocrBaseUrl.value, apiKey: ocrApiKey.value, model: ocrModel.value },
    sources: {
      baseUrl: baseUrl.source,
      apiKey: apiKey.source,
      model: model.source,
      vision: vision.source,
      temperature: temperature.source,
      ocr: ocrBaseUrl.source === '未配置（回退 Windows 本地 OCR）' ? 'Windows 本地 OCR' : ocrBaseUrl.source,
    },
    codex: {
      configPath: codex.configPath,
      providerName: codex.providerName,
      detected: codex.available,
      catalogPath: codex.catalogPath,
      catalogVisionCapable: codex.catalogVisionCapable,
      wireApi: codex.wireApi,
    },
    files: { configFile: CONFIG_FILE, envFile: ENV_FILE },
  };
}

function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 5)}****${value.slice(-4)}`;
}

/** 保存网页里填写的配置。密钥为空时保留原值。 */
function saveConfig(patch) {
  const current = readJsonSafe(CONFIG_FILE);
  const base = current && !current.__parseError && typeof current === 'object' ? current : {};
  const next = { ...base };
  if (typeof patch.baseUrl === 'string') next.baseUrl = patch.baseUrl.trim();
  if (typeof patch.model === 'string') next.model = patch.model.trim();
  if (typeof patch.vision === 'string') next.vision = patch.vision.trim();
  if (patch.temperature !== undefined && patch.temperature !== null && patch.temperature !== '') {
    const temp = Number.parseFloat(patch.temperature);
    if (Number.isFinite(temp)) next.temperature = Math.min(Math.max(temp, 0), 2);
  }
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  if (patch.maxTokens !== undefined && patch.maxTokens !== null && patch.maxTokens !== '') {
    const tokens = Number.parseInt(patch.maxTokens, 10);
    if (Number.isFinite(tokens)) next.maxTokens = Math.min(Math.max(tokens, 8000), 200000);
  }
  if (patch.ocr && typeof patch.ocr === 'object') {
    const ocr = { ...(base.ocr || {}) };
    if (typeof patch.ocr.baseUrl === 'string') ocr.baseUrl = patch.ocr.baseUrl.trim();
    if (typeof patch.ocr.model === 'string') ocr.model = patch.ocr.model.trim();
    if (typeof patch.ocr.apiKey === 'string' && patch.ocr.apiKey.trim()) ocr.apiKey = patch.ocr.apiKey.trim();
    next.ocr = ocr;
  }
  next._说明 =
    '本文件由本地网页「模型设置」写入，只保存在你自己的电脑上。也可以手工编辑或改用 .env / 环境变量覆盖。';
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

module.exports = {
  ROOT,
  CONFIG_FILE,
  ENV_FILE,
  ENV_KEYS,
  loadConfig,
  saveConfig,
  maskKey,
  readJsonSafe,
  codexHome,
};
