'use strict';

const $ = (selector) => document.querySelector(selector);

const state = {
  config: null,
  images: [],
  factCard: null,
  comments: [],
  report: null,
  extraction: null,
  generation: { model: '', generatedAt: '', productName: '' },
  showDiagnostics: false,
};

const FACT_SECTIONS = [
  {
    key: '明确信息',
    title: '明确信息（评论唯一可用的事实依据）',
    kind: 'objects',
    fields: ['类别', '内容'],
    cls: 'buildable',
    addLabel: '添加一条明确信息',
  },
  {
    key: '待确认',
    title: '待确认（识别不清或资料未提供，不会写进评论）',
    kind: 'objects',
    fields: ['内容', '原因'],
    cls: 'pending',
    addLabel: '添加一条待确认',
  },
  { key: '允许表达的结果', title: '允许表达的结果', kind: 'strings', cls: 'buildable', addLabel: '添加一条允许表达的结果' },
  { key: '允许场景与动作', title: '允许场景与动作', kind: 'strings', cls: 'buildable', addLabel: '添加一条场景或动作' },
  { key: '感官信息', title: '感官信息', kind: 'strings', cls: 'buildable', addLabel: '添加一条感官信息' },
  { key: '不得写的内容', title: '不得写的内容（严禁出现在评论里）', kind: 'strings', cls: '', addLabel: '添加一条禁止内容' },
];

/* ---------------- 基础工具 ---------------- */

function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', Boolean(bad));
  el.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

let busyTimer = null;

function busy(on, text = '处理中…', sub = '') {
  const el = $('#busy');
  if (!on) {
    el.classList.add('hidden');
    clearInterval(busyTimer);
    busyTimer = null;
    return;
  }
  $('#busy-text').textContent = text;
  $('#busy-sub').textContent = sub;
  el.classList.remove('hidden');
  const started = Date.now();
  clearInterval(busyTimer);
  busyTimer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    $('#busy-sub').textContent = `${sub}${sub ? ' · ' : ''}已用时 ${seconds} 秒`;
  }, 1000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.body ? 'POST' : 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      throw new Error(payload.error || `请求失败（${response.status}）`);
    }
    throw new Error(`请求失败（${response.status}）`);
  }
  if (contentType.includes('application/json')) return response.json();
  return response;
}

/** 先把值转成字符串，避免模型返回对象/数字时页面渲染成 [object Object] */
function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join('；');
  return Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}：${toText(v)}`)
    .join('；');
}

function makeTextarea(value, placeholder, onInput, rows = 1) {
  const el = document.createElement('textarea');
  el.value = toText(value);
  el.rows = rows;
  el.placeholder = placeholder;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

function makeButton(label, className, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

/* ---------------- 配置 ---------------- */

async function loadConfig() {
  const data = await api('/api/config');
  state.config = data;
  const status = $('#model-status');
  const ready = data.ready;
  status.textContent = ready
    ? `已连接配置：${data.model || '未设模型'} · ${data.baseUrlHost || ''}${data.visionHint ? ` · ${data.visionHint}` : ''}`
    : `${data.message || '模型尚未配置'}（点右侧「模型设置」填写）`;
  status.className = `model-status ${ready ? 'ok' : 'bad'}`;

  $('#cfg-base-url').value = data.baseUrl || '';
  $('#cfg-model').value = data.model || '';
  $('#cfg-vision').value = data.visionMode || 'auto';
  $('#cfg-temperature').value = data.temperature ?? 0.95;
  $('#cfg-max-tokens').value = data.maxTokens ?? 32000;
  $('#cfg-ocr-url').value = data.ocr?.baseUrl || '';
  $('#cfg-ocr-model').value = data.ocr?.model || '';
  $('#cfg-api-key').placeholder = data.apiKeyMasked
    ? `已配置：${data.apiKeyMasked}（留空保持不变）`
    : '粘贴你的接口密钥';

  const sources = data.sources || {};
  $('#config-source').textContent = [
    `接口地址来源：${sources.baseUrl || '未知'}`,
    `模型 ID 来源：${sources.model || '未知'}`,
    `密钥来源：${sources.apiKey || '未知'}`,
    `本机 OCR：${data.localOcr?.ok ? `可用（${data.localOcr.language}）` : `不可用（${data.localOcr?.reason || '未知'}）`}`,
    `外部 OCR：${sources.ocr || '未配置'}`,
  ].join(' ｜ ');

  updateGenerateAvailability();
}

async function saveSettings() {
  const payload = {
    baseUrl: $('#cfg-base-url').value,
    model: $('#cfg-model').value,
    apiKey: $('#cfg-api-key').value,
    vision: $('#cfg-vision').value,
    temperature: $('#cfg-temperature').value,
    maxTokens: $('#cfg-max-tokens').value,
    ocr: { baseUrl: $('#cfg-ocr-url').value, model: $('#cfg-ocr-model').value, apiKey: $('#cfg-ocr-key').value },
  };
  $('#settings-status').textContent = '保存中…';
  try {
    await api('/api/config', { body: payload });
    $('#cfg-api-key').value = '';
    $('#cfg-ocr-key').value = '';
    await loadConfig();
    $('#settings-status').textContent = '已保存到服务端 config.json。';
    toast('设置已保存');
  } catch (err) {
    $('#settings-status').textContent = `保存失败：${err.message}`;
    toast(err.message, true);
  }
}

async function loadModels() {
  const output = $('#test-output');
  $('#settings-status').textContent = '正在读取模型列表…';
  try {
    const data = await api('/api/config/models', {
      body: {
        baseUrl: $('#cfg-base-url').value,
        apiKey: $('#cfg-api-key').value,
      },
    });
    const options = $('#model-options');
    options.innerHTML = '';
    data.models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      const modalities = model.inputModalities ? `（${model.inputModalities.join('/')}）` : '';
      option.label = `${model.name || model.id}${modalities}`;
      options.appendChild(option);
    });
    output.classList.remove('hidden');
    output.textContent = data.models
      .map((model) => `${model.id}${model.name ? ` — ${model.name}` : ''}${model.inputModalities ? ` ｜ 输入：${model.inputModalities.join('、')}` : ''}`)
      .join('\n');
    $('#settings-status').textContent = `读取到 ${data.models.length} 个模型，请从下拉里选择真实 ID。`;
  } catch (err) {
    output.classList.remove('hidden');
    output.textContent = `读取失败：${err.message}`;
    $('#settings-status').textContent = '读取模型列表失败。';
  }
}

async function testConnection() {
  const output = $('#test-output');
  output.classList.remove('hidden');
  output.textContent = '正在测试（会真实调用一次接口）…';
  $('#settings-status').textContent = '测试中…';
  try {
    const data = await api('/api/config/test', { body: { includeVisionProbe: true } });
    output.textContent = data.lines.join('\n');
    $('#settings-status').textContent = data.ok ? '测试通过。' : '测试未通过。';
  } catch (err) {
    output.textContent = `测试失败：${err.message}`;
    $('#settings-status').textContent = '测试失败。';
  }
}

/* ---------------- 图片 ---------------- */

function renderThumbs() {
  const wrap = $('#thumbs');
  wrap.innerHTML = '';
  state.images.forEach((image, index) => {
    const item = document.createElement('div');
    item.className = 'thumb';
    const img = document.createElement('img');
    img.src = image.dataUrl;
    img.alt = image.name;
    const name = document.createElement('span');
    name.className = 'thumb-name';
    name.textContent = image.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = '移除这张图片';
    remove.addEventListener('click', () => {
      state.images.splice(index, 1);
      renderThumbs();
    });
    item.append(img, name, remove);
    wrap.appendChild(item);
  });
}

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  if (state.images.length + files.length > 8) {
    toast('最多 8 张图片，多余的已忽略。', true);
  }
  const accepted = files.slice(0, Math.max(0, 8 - state.images.length));
  accepted.forEach((file) => {
    if (file.size > 12 * 1024 * 1024) {
      toast(`${file.name} 超过 12MB，已跳过。`, true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.images.push({ name: file.name, dataUrl: String(reader.result) });
      renderThumbs();
    };
    reader.readAsDataURL(file);
  });
}

/* ---------------- 事实卡 ---------------- */

function normalizeFactCard(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const card = {
    产品名称: toText(source.产品名称),
    品类: toText(source.品类),
    明确信息: [],
    待确认: [],
    允许表达的结果: [],
    允许场景与动作: [],
    感官信息: [],
    不得写的内容: [],
  };
  for (const section of FACT_SECTIONS) {
    const value = source[section.key];
    if (section.kind === 'objects') {
      const list = Array.isArray(value) ? value : value ? [value] : [];
      card[section.key] = list.map((item) => {
        const row = {};
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          section.fields.forEach((field) => {
            row[field] = toText(item[field]);
          });
        } else {
          row[section.fields[0]] = toText(item);
          row[section.fields[1]] = '';
        }
        return row;
      });
    } else {
      const list = Array.isArray(value) ? value : value ? [value] : [];
      card[section.key] = list.map((item) => toText(item)).filter(Boolean);
    }
  }
  return card;
}

function renderFactCard() {
  const card = state.factCard;
  if (!card) return;
  $('#facts-empty').classList.add('hidden');
  $('#facts-editor').classList.remove('hidden');
  $('#fact-name').value = card.产品名称 || '';
  $('#fact-category').value = card.品类 || '';

  const container = $('#fact-sections');
  container.innerHTML = '';

  for (const section of FACT_SECTIONS) {
    const box = document.createElement('section');
    box.className = `fact-section ${section.cls}`;

    const head = document.createElement('header');
    const title = document.createElement('h3');
    const count = Array.isArray(card[section.key]) ? card[section.key].length : 0;
    title.textContent = `${section.title}（${count}）`;
    head.appendChild(title);
    head.appendChild(
      makeButton(section.addLabel, 'btn btn-mini', () => {
        if (section.kind === 'objects') {
          const row = {};
          section.fields.forEach((field) => {
            row[field] = '';
          });
          card[section.key].push(row);
        } else {
          card[section.key].push('');
        }
        renderFactCard();
      }),
    );
    box.appendChild(head);

    const list = Array.isArray(card[section.key]) ? card[section.key] : [];
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '（无）';
      box.appendChild(empty);
    }
    list.forEach((item, index) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'fact-row';
      if (section.kind === 'objects') {
        section.fields.forEach((field) => {
          const wrap = document.createElement('div');
          wrap.style.flex = field === '内容' ? '3' : '1';
          wrap.appendChild(
            makeTextarea(
              item[field],
              field,
              (value) => {
                card[section.key][index][field] = value;
              },
              1,
            ),
          );
          rowEl.appendChild(wrap);
        });
      } else {
        const wrap = document.createElement('div');
        wrap.style.flex = '1';
        wrap.appendChild(
          makeTextarea(
            item,
            section.title,
            (value) => {
              card[section.key][index] = value;
            },
            1,
          ),
        );
        rowEl.appendChild(wrap);
      }
      rowEl.appendChild(
        makeButton('删除', 'btn btn-mini btn-danger-mini', () => {
          card[section.key].splice(index, 1);
          renderFactCard();
        }),
      );
      box.appendChild(rowEl);
    });
    container.appendChild(box);
  }
  updateGenerateAvailability();
  persist();
}

function updateGenerateAvailability() {
  const confirmed = $('#confirm-facts').checked;
  const hasCard = Boolean(state.factCard);
  const button = $('#btn-generate');
  button.disabled = !(hasCard && confirmed);
  $('#generate-hint').textContent = !hasCard
    ? '生成前请先核对事实卡。'
    : confirmed
      ? '将按规则先生成候选，再自检筛选。'
      : '请先勾选「我已核对以上事实卡」。';
}

async function extractFacts() {
  const productName = $('#product-name').value.trim();
  const sellingPoints = $('#selling-points').value.trim();
  if (!productName && !sellingPoints && !state.images.length) {
    toast('请至少填写产品名称、卖点文字或上传图片。', true);
    return;
  }
  busy(true, '正在识读产品资料…', state.images.length ? `${state.images.length} 张图片` : '文字输入');
  try {
    const data = await api('/api/facts', {
      body: { productName, sellingPoints, images: state.images.map((image) => ({ name: image.name, dataUrl: image.dataUrl })) },
    });
    state.factCard = normalizeFactCard(data.factCard);
    state.extraction = data.extraction;
    if (!state.factCard.产品名称 && productName) state.factCard.产品名称 = productName;
    $('#confirm-facts').checked = false;
    renderFactCard();
    const note = $('#extract-note');
    note.textContent = data.extraction?.note || '';
    note.classList.toggle('hidden', !data.extraction?.note);
    toast('事实卡已生成，请核对后勾选确认。');
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(false);
  }
}

/* ---------------- 生成评论 ---------------- */

function badgeClass(item) {
  if (item.band === 'long') return 'badge chars-long';
  if (item.chars < 20) return 'badge chars-warn';
  return 'badge chars-ok';
}

function renderComments() {
  const list = $('#comment-list');
  list.innerHTML = '';
  const comments = state.comments;
  $('#results-empty').classList.toggle('hidden', comments.length > 0);

  comments.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'comment-item';

    const head = document.createElement('header');
    const no = document.createElement('span');
    no.className = 'comment-no';
    no.textContent = `第 ${index + 1} 条`;
    head.appendChild(no);

    const chars = document.createElement('span');
    chars.className = badgeClass(item);
    chars.textContent = `${item.chars} 字`;
    head.appendChild(chars);

    if (item.meta?.emotion) {
      const emo = document.createElement('span');
      emo.className = 'badge';
      emo.textContent = item.meta.emotion;
      head.appendChild(emo);
    }
    const restored = document.createElement('span');
    restored.className = 'hint';
    restored.style.display = 'none';
    head.appendChild(restored);
    li.appendChild(head);

    const textarea = document.createElement('textarea');
    textarea.value = item.text;
    textarea.rows = Math.max(3, Math.ceil(item.text.length / 60));
    const counter = document.createElement('div');
    counter.className = 'item-diag';
    const refresh = () => {
      const charsValue = (textarea.value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]/g) || []).length;
      item.chars = charsValue;
      chars.textContent = `${charsValue} 字`;
      chars.className = badgeClass({ band: item.band, chars: charsValue });
      counter.textContent = state.showDiagnostics
        ? `主关注点：${item.meta?.focus || '—'} ｜ 正面结果：${item.meta?.result || '—'} ｜ 观察动作：${item.meta?.action || '—'} ｜ 开头：${item.meta?.opening || '—'} ｜ 收尾：${item.meta?.ending || '—'}`
        : '';
      counter.classList.toggle('hidden', !state.showDiagnostics);
    };
    textarea.addEventListener('input', () => {
      item.text = textarea.value;
      refresh();
      persist();
    });
    li.appendChild(textarea);

    const tools = document.createElement('div');
    tools.className = 'item-tools';
    tools.appendChild(makeButton('复制这条', 'btn btn-mini', () => copyText(item.text, '已复制该条评论')));
    tools.appendChild(makeButton('重新生成这条', 'btn btn-mini', () => regenerateOne(index, textarea, restored)));
    li.appendChild(tools);
    li.appendChild(counter);
    refresh();
    list.appendChild(li);
  });
}

async function regenerateOne(index, textarea, restoredLabel) {
  if (!state.factCard) return;
  const current = state.comments[index];
  const others = state.comments.filter((_, i) => i !== index);
  const targetLength =
    current.chars >= 88 ? '90–110 字（高度赞扬长评，全正面）' : current.chars >= 50 ? '55–85 字' : '20–50 字（短评）';
  busy(true, `正在重新生成第 ${index + 1} 条…`, '只重写这一条，其余不动');
  try {
    const data = await api('/api/comments/regenerate', {
      body: {
        factCard: state.factCard,
        index: index + 1,
        targetLength,
        targetEmotion: current.meta?.emotion || '明确满意',
        currentText: current.text,
        usedObservations: others.map((item) => `${item.meta?.focus || ''}|${item.meta?.result || ''}|${item.meta?.action || ''}`).filter(Boolean),
        avoidTexts: others.map((item) => item.text),
      },
    });
    state.comments[index] = data.comment;
    renderComments();
    if (data.warnings?.length) {
      restoredLabel.style.display = '';
      restoredLabel.textContent = `提示：${data.warnings.map((w) => `${w.type}（${w.detail}）`).join('；')}`;
    }
    toast('已重新生成这一条');
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(false);
  }
}

async function generateComments() {
  if (!state.factCard) return;
  if (!$('#confirm-facts').checked) {
    toast('请先勾选「我已核对以上事实卡」。', true);
    return;
  }
  const count = Math.min(20, Math.max(1, Number.parseInt($('#comment-count').value, 10) || 10));
  busy(true, '正在生成候选评论…', '先生成候选，再做事实、正面与去重筛选');
  try {
    const data = await api('/api/comments', { body: { factCard: state.factCard, count } });
    state.comments = (data.comments || []).map((item) => ({ ...item }));
    state.report = data.report;
    state.generation = {
      model: data.model,
      generatedAt: data.generatedAt,
      productName: state.factCard.产品名称 || $('#product-name').value.trim(),
    };
    renderComments();
    renderReport();
    persist();
    if (state.comments.length < count) {
      toast(`本次只产出 ${state.comments.length}/${count} 条合规评论，可查看自检报告后重试。`, true);
    } else {
      toast(`已生成 ${state.comments.length} 条模拟评论`);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(false);
  }
}

function renderReport() {
  const body = $('#report-body');
  const report = state.report;
  if (!report) {
    body.innerHTML = '<p class="hint">本次还没有生成记录。</p>';
    return;
  }
  const lines = [
    `模型：${report.model || '未记录'}　生成时间：${report.generatedAt || ''}　耗时：${(report.elapsedMs / 1000).toFixed(1)} 秒`,
    `候选 ${report.candidateCount} 条 → 通过事实与正面检查 ${report.passed} 条 → 语义去重后保留 ${report.selected} 条`,
    `篇幅分布：约 100 字长评 ${report.length.long} 条 ｜ 主体 55–85 字 ${report.length.main} 条 ｜ 短评 ${report.length.short} 条`,
    `情绪分布：${Object.entries(report.emotions || {}).map(([k, v]) => `${k} ${v}`).join('，') || '—'}`,
    `事实依据：${report.factSummary}`,
  ];
  if (report.warnings?.length) {
    lines.push(`需要人工复核：${report.warnings.map((w) => `第 ${w.index} 条 ${w.type}（${w.detail}）`).join('；')}`);
  } else {
    lines.push('需要人工复核：无');
  }
  if (report.fillerOveruse?.length) {
    lines.push(`口头禅超限：${report.fillerOveruse.map((f) => `${f.word}×${f.times}`).join('、')}`);
  }
  if (report.focusOveruse?.length) {
    lines.push(`同一卖点条数偏多（事实较少时属正常）：${report.focusOveruse.map((f) => `${f.focus}×${f.times}`).join('、')}`);
  }
  lines.push('');
  lines.push('说明：以上为一轮生成程序自检结果，不等于独立盲测、用户认可或跨品类验收。');

  const html = [`<pre>${lines.join('\n')}</pre>`];
  if (report.rejected?.length) {
    html.push('<details><summary>被筛掉的候选（节选，最多 40 条）</summary><ul class="reject-list">');
    report.rejected.slice(0, 20).forEach((item) => {
      html.push(`<li><strong>${item.stage}</strong>：${item.reason}<br />${escapeHtml(item.text.slice(0, 80))}</li>`);
    });
    html.push('</ul></details>');
  }
  body.innerHTML = html.join('');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/* ---------------- 复制与导出 ---------------- */

async function copyText(text, message) {
  const value = String(text || '');
  try {
    await navigator.clipboard.writeText(value);
    toast(message || '已复制');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = value;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
    toast(message || '已复制');
  }
}

function exportPayload() {
  const productName = state.factCard?.产品名称 || $('#product-name').value.trim() || '未命名产品';
  return {
    productName,
    comments: state.comments.map((item) => ({ text: item.text })),
    factCard: state.factCard,
    model: state.generation.model,
    generatedAt: state.generation.generatedAt,
    report: state.report
      ? {
          summaryText: `自检：候选 ${state.report.candidateCount} 条，通过 ${state.report.passed} 条，最终 ${state.report.selected} 条；长评 ${state.report.length.long} 条。`,
          factSummary: state.report.factSummary,
        }
      : null,
  };
}

async function exportMarkdown() {
  if (!state.comments.length) return toast('还没有可导出的评论。', true);
  try {
    const data = await api('/api/export/markdown', { body: exportPayload() });
    downloadBlob(new Blob([data.markdown], { type: 'text/markdown;charset=utf-8' }), data.filename);
  } catch (err) {
    toast(err.message, true);
  }
}

async function exportExcel() {
  if (!state.comments.length) return toast('还没有可导出的评论。', true);
  try {
    const response = await fetch('/api/export/excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportPayload()),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `导出失败（${response.status}）`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/i) || disposition.match(/filename="([^"]+)"/i);
    const filename = match ? decodeURIComponent(match[1]) : '模拟评论.xlsx';
    downloadBlob(blob, filename);
  } catch (err) {
    toast(err.message, true);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'download';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`已导出：${filename}`);
}

/* ---------------- 本地暂存 ---------------- */

function persist() {
  try {
    localStorage.setItem(
      'buyer-review-studio',
      JSON.stringify({
        productName: $('#product-name').value,
        sellingPoints: $('#selling-points').value,
        factCard: state.factCard,
        comments: state.comments,
        report: state.report,
        generation: state.generation,
        count: $('#comment-count').value,
      }),
    );
  } catch {
    /* 超出配额时忽略 */
  }
}

function restore() {
  try {
    const raw = localStorage.getItem('buyer-review-studio');
    if (!raw) return;
    const data = JSON.parse(raw);
    $('#product-name').value = data.productName || '';
    $('#selling-points').value = data.sellingPoints || '';
    $('#comment-count').value = data.count || 10;
    if (data.factCard) {
      state.factCard = normalizeFactCard(data.factCard);
      state.comments = Array.isArray(data.comments) ? data.comments : [];
      state.report = data.report || null;
      state.generation = data.generation || { model: '', generatedAt: '', productName: '' };
      renderFactCard();
      renderComments();
      renderReport();
    }
  } catch {
    /* 本地暂存损坏时忽略 */
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#btn-open-settings').addEventListener('click', () => $('#settings-modal').classList.remove('hidden'));
  $('#btn-close-settings').addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
  $('#settings-modal').addEventListener('click', (event) => {
    if (event.target === $('#settings-modal')) $('#settings-modal').classList.add('hidden');
  });
  $('#btn-save-config').addEventListener('click', saveSettings);
  $('#btn-test-config').addEventListener('click', testConnection);
  $('#btn-load-models').addEventListener('click', loadModels);

  $('#btn-choose-file').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (event) => {
    addFiles(event.target.files);
    event.target.value = '';
  });

  const dropzone = $('#dropzone');
  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('drag');
    }),
  );
  ['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('drag');
    }),
  );
  dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer?.files));

  document.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length) addFiles(files);
  });

  $('#btn-extract').addEventListener('click', extractFacts);
  $('#btn-generate').addEventListener('click', generateComments);
  $('#confirm-facts').addEventListener('change', updateGenerateAvailability);
  $('#fact-name').addEventListener('input', (event) => {
    if (state.factCard) state.factCard.产品名称 = event.target.value;
    persist();
  });
  $('#fact-category').addEventListener('input', (event) => {
    if (state.factCard) state.factCard.品类 = event.target.value;
    persist();
  });
  $('#product-name').addEventListener('input', persist);
  $('#selling-points').addEventListener('input', persist);
  $('#comment-count').addEventListener('input', persist);

  $('#btn-copy-all').addEventListener('click', () => {
    if (!state.comments.length) return toast('还没有可复制的评论。', true);
    const text = state.comments.map((item, index) => `${index + 1}. ${item.text}`).join('\n\n');
    copyText(text, '已复制全部评论');
  });
  $('#btn-export-md').addEventListener('click', exportMarkdown);
  $('#btn-export-xlsx').addEventListener('click', exportExcel);
  $('#toggle-diagnostics').addEventListener('change', (event) => {
    state.showDiagnostics = event.target.checked;
    $('#report-box').classList.toggle('hidden', !state.showDiagnostics);
    renderComments();
  });
}

async function init() {
  bindEvents();
  restore();
  renderThumbs();
  updateGenerateAvailability();
  try {
    await loadConfig();
  } catch (err) {
    $('#model-status').textContent = `读取配置失败：${err.message}`;
    $('#model-status').className = 'model-status bad';
  }
  try {
    const rules = await api('/api/rules');
    if (rules?.name) $('#rules-pill').textContent = `规则蓝本 ${rules.name}`;
  } catch {
    /* 忽略 */
  }
  $('#report-box').classList.add('hidden');
}

init();
