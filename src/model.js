'use strict';

/**
 * 服务端模型客户端（OpenAI 兼容 /chat/completions）。
 * 前端只调用本服务的 /api/*，密钥始终留在服务端。
 */

const DEFAULT_TIMEOUT_MS = 600000;
const MAX_OUTPUT_TOKENS = 200000;

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  return `${base}${suffix}`;
}

function describeHttpError(status, bodyText) {
  let detail = bodyText || '';
  try {
    const json = JSON.parse(bodyText);
    detail = json?.error?.message || json?.message || detail;
  } catch {
    /* 保留原始文本 */
  }
  const hint =
    status === 401 || status === 403
      ? '（密钥无效或没有该模型的权限，请在「模型设置」中检查密钥）'
      : status === 404
        ? '（接口地址或模型 ID 可能不对，可在「模型设置」中列出该地址下的可用模型）'
        : status === 429
          ? '（请求过于频繁或额度不足）'
          : '';
  return `模型接口返回 ${status}${hint}：${String(detail).slice(0, 600)}`;
}

class ModelError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.retryable = retryable;
  }
}

async function postJson(url, { apiKey, body, timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ModelError(describeHttpError(response.status, text), {
        status: response.status,
        retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ModelError(`模型接口返回了非 JSON 内容：${text.slice(0, 300)}`);
    }
  } catch (err) {
    if (err instanceof ModelError) throw err;
    if (err && err.name === 'AbortError') {
      throw new ModelError('调用模型超时（可在设置里提高超时时间或减少生成条数后重试）', { retryable: true });
    }
    throw new ModelError(`无法连接模型接口：${err && err.message ? err.message : err}`, { retryable: true });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessageText(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return '';
  const message = choice.message || {};
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }
  if (typeof choice.text === 'string') return choice.text;
  return '';
}

function finishReasonOf(payload) {
  return payload?.choices?.[0]?.finish_reason || '';
}

/**
 * 调用对话补全。
 * @param {object} options
 * @param {object} options.config 运行时配置
 * @param {Array} options.messages OpenAI 兼容 messages
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 */
async function chat(options) {
  const { config, messages, maxTokens = 4096, temperature, retries = 2, onProgress } = options;
  if (!config.baseUrl) throw new ModelError('尚未配置模型接口地址，请在右上角「模型设置」中填写。');
  if (!config.apiKey) throw new ModelError('尚未配置模型密钥，请在右上角「模型设置」中填写。');
  if (!config.model) throw new ModelError('尚未配置模型 ID，请在右上角「模型设置」中填写或从列表中选择。');

  const body = {
    model: config.model,
    messages,
    stream: false,
  };
  const temp = temperature === undefined ? config.temperature : temperature;
  if (temp !== null && temp !== undefined && temp !== false) body.temperature = temp;

  let lastError;
  let budget = maxTokens;
  let attempt = 0;
  let escalations = 0;
  while (attempt <= retries) {
    body.max_tokens = budget;
    try {
      const payload = await postJson(joinUrl(config.baseUrl, '/chat/completions'), {
        apiKey: config.apiKey,
        body,
      });
      const text = extractMessageText(payload);
      const finishReason = finishReasonOf(payload);
      if (!text) {
        // 推理型模型可能把整个输出预算用在思考上，导致正文为空：自动加大预算重试
        if (finishReason === 'length' && budget < MAX_OUTPUT_TOKENS && escalations < 3) {
          escalations += 1;
          budget = Math.min(budget * 2, MAX_OUTPUT_TOKENS);
          if (onProgress) onProgress(`模型思考占满了输出预算，自动提高到 ${budget} tokens 重试…`);
          continue;
        }
        if (finishReason === 'length') {
          throw new ModelError(
            `模型把全部输出预算用在了推理上（max_tokens=${budget}），没有产生正文。请减少一次生成的条数，或在模型设置里提高输出上限。`,
            { retryable: false },
          );
        }
        throw new ModelError('模型返回了空内容，请重试。', { retryable: true });
      }
      if (finishReason === 'length') {
        lastError = new ModelError('模型输出被截断（finish_reason=length），内容可能不完整。', { retryable: true });
        attempt += 1;
        continue;
      }
      return { text, usage: payload.usage || null, model: payload.model || config.model, finishReason, raw: payload };
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ModelError ? err.retryable : true;
      if (!retryable || attempt === retries) break;
      await sleep(1200 * (attempt + 1));
    }
    attempt += 1;
  }
  throw lastError;
}

/** 列出接口地址下的真实模型 ID（用于设置面板，避免按显示名猜模型） */
async function listModels(config, { baseUrl, apiKey } = {}) {
  const url = joinUrl(baseUrl || config.baseUrl, '/models');
  const key = apiKey || config.apiKey;
  if (!url || !key) throw new ModelError('缺少接口地址或密钥，无法列出模型。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new ModelError(describeHttpError(response.status, text), { status: response.status });
    const json = JSON.parse(text);
    const data = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    return data.map((item) => ({
      id: item.id || item.slug || item.name,
      name: item.name || '',
      inputModalities: item.input_modalities || item.inputModalities || null,
    })).filter((item) => item.id);
  } catch (err) {
    if (err instanceof ModelError) throw err;
    throw new ModelError(`无法读取模型列表：${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 真实流式调用（SSE）。
 * 逐块回调 onContent(增量正文)，返回完整正文与用量；推理内容只统计长度，不往前端推。
 *
 * @param {object} options
 * @param {(delta: string) => void} [options.onContent] 每收到一段正文就回调
 * @param {() => void} [options.onFirstToken] 第一次收到正文时回调（用于统计首 token 耗时）
 */
async function chatStream(options) {
  const {
    config,
    messages,
    maxTokens = 32000,
    temperature,
    retries = 1,
    onContent,
    onFirstToken,
    signal,
  } = options;
  if (!config.baseUrl) throw new ModelError('尚未配置模型接口地址。');
  if (!config.apiKey) throw new ModelError('尚未配置模型密钥。');
  if (!config.model) throw new ModelError('尚未配置模型 ID。');

  const temp = temperature === undefined ? config.temperature : temperature;
  let budget = maxTokens;
  let escalations = 0;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const body = { model: config.model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: budget };
    if (temp !== null && temp !== undefined && temp !== false) body.temperature = temp;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(joinUrl(config.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}`, Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw new ModelError(describeHttpError(response.status, text), {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let text = '';
      let usage = null;
      let finishReason = '';
      let reasoningChars = 0;
      let firstToken = false;

      const handleData = (payload) => {
        if (!payload || payload === '[DONE]') return;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          return; // 单段解析失败不影响整体，跳过这块
        }
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (typeof delta.reasoning_content === 'string') reasoningChars += delta.reasoning_content.length;
        if (typeof delta.content === 'string' && delta.content) {
          if (!firstToken) {
            firstToken = true;
            if (onFirstToken) onFirstToken();
          }
          text += delta.content;
          if (onContent) onContent(delta.content);
        }
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.startsWith('data:')) handleData(line.slice(5).trim());
          index = buffer.indexOf('\n');
        }
      }
      if (buffer.trim().startsWith('data:')) handleData(buffer.trim().slice(5).trim());

      if (!text.trim()) {
        if (finishReason === 'length' && budget < MAX_OUTPUT_TOKENS && escalations < 3) {
          escalations += 1;
          budget = Math.min(budget * 2, MAX_OUTPUT_TOKENS);
          continue;
        }
        throw new ModelError(
          finishReason === 'length'
            ? `模型把全部输出预算用在了推理上（max_tokens=${budget}），没有产生正文。`
            : '流式返回结束了，但没有收到正文内容。',
          { retryable: false },
        );
      }
      return { text, usage, model: config.model, finishReason, reasoningChars };
    } catch (error) {
      lastError = error instanceof ModelError ? error : new ModelError(`流式请求失败：${error && error.message ? error.message : error}`, { retryable: true });
      if (!lastError.retryable || attempt === retries) break;
      await sleep(1200 * (attempt + 1));
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastError;
}

module.exports = { chat, chatStream, listModels, ModelError, joinUrl };
