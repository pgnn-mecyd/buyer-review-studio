'use strict';

/* =========================================================
   买家评论生成器 · 前端交互
   业务逻辑（接口、数据字段、生成规则）与重构前完全一致，
   这里只改变信息架构与交互方式。
   ========================================================= */

const $ = (selector) => document.querySelector(selector);

const STORAGE_KEY = 'buyer-review-studio-v2';

/** 规则蓝本允许的 A 组表达结构 */
const STRUCTURES = ['结果先行', '操作先行', '感官细节', '个人偏好', '明确场景', '简短直球'];

const COMMENT_TYPE_RULES = [
  [/功效|效果|变化|改善/, '功效型'],
  [/成分|配方|参数|规格|标签|净含量/, '参数型'],
  [/用量|取用|一泵|按压|泵头|容量|瓶身/, '用量型'],
  [/清爽|质地|气味|香味|口感|手感|颜色|外观|水感|黏/, '感官型'],
  [/步骤|顺手|省事|方便|时间|操作|速度|效率/, '操作型'],
  [/早晚|早上|晚上|通勤|出门|办公室|场景|季节/, '场景型'],
];

const state = {
  config: null,
  images: [],
  productName: '',
  productSpec: '',
  sellingPoints: [],
  factCard: null,
  comments: [],
  report: null,
  extraction: null,
  generation: { model: '', generatedAt: '', productName: '' },
  options: {
    strength: 8,
    style: '真实买家感',
    length: '自动',
    language: '中文',
    structure: [...STRUCTURES],
    banned: [],
  },
  history: [],
  streaming: false,
  streamAbort: null,
  streamTotal: 0,
  streamDone: 0,
  streamCandidates: [],
  streamGotAnyCandidate: false,
  streamGotFinal: false,
  editingIndex: -1,
  editDraft: '',
  regeneratingIndex: -1,
};

/* --------------------------------------------------------- *
 * 基础工具
 * --------------------------------------------------------- */

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

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function countChars(text) {
  return (String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]/g) || []).length;
}

let toastTimer = null;

/** toast 支持一个「撤销」类动作按钮 */
function toast(message, options = {}) {
  const el = $('#toast');
  el.className = `toast${options.bad ? ' bad' : ''}`;
  el.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  if (options.actionLabel && typeof options.onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = options.actionLabel;
    action.addEventListener('click', () => {
      el.classList.add('hidden');
      options.onAction();
    });
    el.appendChild(action);
  }
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), options.duration || 3200);
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
  const started = Date.now();
  const render = () => { $('#busy-sub').textContent = `${sub}${sub ? ' · ' : ''}已用时 ${Math.round((Date.now() - started) / 1000)} 秒`; };
  render();
  el.classList.remove('hidden');
  clearInterval(busyTimer);
  busyTimer = setInterval(render, 1000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.body ? 'POST' : 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const type = response.headers.get('content-type') || '';
  if (!response.ok) {
    if (type.includes('application/json')) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `请求失败（${response.status}）`);
    }
    throw new Error(`请求失败（${response.status}）`);
  }
  return type.includes('application/json') ? response.json() : response;
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
}

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

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 900)}px`;
}

/* --------------------------------------------------------- *
 * Chips 组件
 * --------------------------------------------------------- */

function startChipInput(container, placeholder, commit) {
  if (container.querySelector('.chip-input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chip-input';
  input.placeholder = placeholder || '输入后回车';
  container.appendChild(input);
  input.focus();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.remove();
    if (save && value) {
      const values = value.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean);
      commit(values);
    }
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    } else if (event.key === 'Escape') {
      // 先取消这个输入框，不要让 Esc 继续去关掉整个弹层
      event.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

/**
 * 渲染一组 chips。
 * items: string[]；removable: 是否可删除；addLabel: 添加按钮文案（不传则不显示）
 */
function renderChips(container, items, config = {}) {
  const { removable = true, addLabel = '', onAdd = null, onRemove = null, muted = false } = config;
  container.className = `tags${muted ? ' chips-muted' : ''}`;
  container.innerHTML = '';

  items.forEach((item, index) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = item;
    label.title = item;
    chip.appendChild(label);
    if (removable && onRemove) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-x';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `删除 ${item}`);
      remove.addEventListener('click', () => onRemove(index));
      chip.appendChild(remove);
    }
    container.appendChild(chip);
  });

  if (onAdd) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip-add';
    add.textContent = addLabel || '+ 添加';
    add.addEventListener('click', () => {
      startChipInput(container, '输入后回车', (values) => values.forEach((value) => onAdd(value)));
    });
    container.appendChild(add);
  }
}

/** 结构选择：可开关的 chips */
function renderToggleChips(container, all, selected, onToggle) {
  container.className = 'tags';
  container.innerHTML = '';
  all.forEach((item) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip chip-toggle ${selected.includes(item) ? 'on' : 'off'}`;
    chip.textContent = item;
    chip.addEventListener('click', () => onToggle(item));
    container.appendChild(chip);
  });
}

/* --------------------------------------------------------- *
 * 事实卡数据
 * --------------------------------------------------------- */

function emptyFactCard() {
  return {
    产品名称: '',
    品类: '',
    明确信息: [],
    待确认: [],
    允许表达的结果: [],
    允许场景与动作: [],
    感官信息: [],
    不得写的内容: [],
  };
}

function normalizeFactCard(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const card = emptyFactCard();
  card.产品名称 = toText(source.产品名称);
  card.品类 = toText(source.品类);

  const rows = (value, fields) => {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list.map((item) => {
      const row = {};
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        fields.forEach((field) => { row[field] = toText(item[field]); });
      } else {
        fields.forEach((field) => { row[field] = ''; });
        row[fields[0]] = toText(item);
      }
      return row;
    });
  };

  card.明确信息 = rows(source.明确信息, ['类别', '内容', '来源']);
  card.待确认 = rows(source.待确认, ['内容', '原因']);
  for (const key of ['允许表达的结果', '允许场景与动作', '感官信息', '不得写的内容']) {
    const list = Array.isArray(source[key]) ? source[key] : source[key] ? [source[key]] : [];
    card[key] = list.map((item) => toText(item)).filter(Boolean);
  }
  return card;
}

/* --------------------------------------------------------- *
 * 渲染：产品信息
 * --------------------------------------------------------- */

function renderThumbs() {
  const wrap = $('#thumbs');
  wrap.innerHTML = '';
  state.images.forEach((image, index) => {
    const item = document.createElement('div');
    item.className = 'thumb';
    item.title = image.name;
    const img = document.createElement('img');
    img.src = image.dataUrl;
    img.alt = image.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `移除 ${image.name}`);
    remove.addEventListener('click', () => {
      state.images.splice(index, 1);
      renderThumbs();
    });
    item.append(img, remove);
    wrap.appendChild(item);
  });
  $('#media-add-label').textContent = state.images.length ? '继续添加' : '添加产品图';
}

function renderProductTags() {
  renderChips($('#tags-selling'), state.sellingPoints, {
    addLabel: '+ 添加卖点',
    onAdd: (value) => {
      if (state.sellingPoints.includes(value)) return;
      state.sellingPoints.push(value);
      renderProductTags();
      persist();
    },
    onRemove: (index) => {
      state.sellingPoints.splice(index, 1);
      renderProductTags();
      persist();
    },
  });

  const efficacy = state.factCard ? state.factCard['允许表达的结果'] : [];
  const efficacyContainer = $('#tags-efficacy');
  if (!state.factCard) {
    efficacyContainer.className = 'tags';
    efficacyContainer.innerHTML = '<span class="foot-note">识别后自动填入</span>';
  } else {
    renderChips(efficacyContainer, efficacy, {
      addLabel: '+ 添加功效',
      onAdd: (value) => {
        state.factCard['允许表达的结果'].push(value);
        renderProductTags();
        renderAdvancedTags();
        persist();
      },
      onRemove: (index) => {
        state.factCard['允许表达的结果'].splice(index, 1);
        renderProductTags();
        renderAdvancedTags();
        persist();
      },
    });
  }
  $('#product-hint').textContent = state.factCard ? '已生成事实卡' : '';
}

/* --------------------------------------------------------- *
 * 渲染：事实卡
 * --------------------------------------------------------- */

/* ---------------- 二层窗口：事实卡复核 / 高级设置 ---------------- */

function openFactsModal() {
  renderFactCard();
  $('#facts-modal').classList.remove('hidden');
}

function openAdvancedModal() {
  renderAdvancedTags();
  $('#advanced-modal').classList.remove('hidden');
}

/** 四个二层窗口统一关闭（Esc / 遮罩 / 关闭按钮都用它） */
function closeAllModals() {
  ['#facts-modal', '#advanced-modal', '#settings-modal', '#prompt-modal'].forEach((selector) => {
    $(selector).classList.add('hidden');
  });
}

function renderFactSections() {
  const container = $('#fact-sections');
  container.innerHTML = '';
  const card = state.factCard;
  if (!card) return;

  const section = (title, className = '') => {
    const box = document.createElement('section');
    box.className = `fact-section ${className}`;
    const head = document.createElement('header');
    const h3 = document.createElement('h3');
    h3.textContent = title;
    head.appendChild(h3);
    box.appendChild(head);
    container.appendChild(box);
    return { box, head };
  };

  // 明确信息
  {
    const { box, head } = section(`明确信息（${card.明确信息.length}）`);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-ghost btn-sm';
    add.textContent = '添加';
    add.addEventListener('click', () => {
      card.明确信息.push({ 类别: '', 内容: '', 来源: '手动补充' });
      renderFactSections();
      persist();
    });
    head.appendChild(add);

    card.明确信息.forEach((row, index) => {
      const line = document.createElement('div');
      line.className = 'fact-row';
      const category = document.createElement('div');
      category.className = 'fact-cat';
      const catInput = document.createElement('input');
      catInput.type = 'text';
      catInput.value = row.类别 || '';
      catInput.placeholder = '类别';
      catInput.addEventListener('input', () => { row.类别 = catInput.value; persist(); });
      category.appendChild(catInput);
      const content = document.createElement('div');
      const contentInput = document.createElement('textarea');
      contentInput.rows = 1;
      contentInput.value = row.内容 || '';
      contentInput.placeholder = '事实内容';
      contentInput.addEventListener('input', () => {
        row.内容 = contentInput.value;
        autoGrow(contentInput);
        persist();
      });
      content.appendChild(contentInput);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.textContent = '×';
      remove.title = '删除这条事实';
      remove.addEventListener('click', () => {
        card.明确信息.splice(index, 1);
        renderFactSections();
        persist();
      });
      line.append(category, content, remove);
      box.appendChild(line);
      requestAnimationFrame(() => autoGrow(contentInput));
    });
    if (!card.明确信息.length) box.insertAdjacentHTML('beforeend', '<p class="foot-note">还没有明确信息。</p>');
  }

  // 待确认
  {
    const { box } = section(`待确认（${card.待确认.length}）· 不会写进评论`, 'pending');
    card.待确认.forEach((row, index) => {
      const line = document.createElement('div');
      line.className = 'fact-row';
      const content = document.createElement('div');
      const contentInput = document.createElement('textarea');
      contentInput.rows = 1;
      contentInput.value = row.内容 || '';
      contentInput.placeholder = '待确认内容';
      contentInput.addEventListener('input', () => {
        row.内容 = contentInput.value;
        autoGrow(contentInput);
        persist();
      });
      content.appendChild(contentInput);
      const reason = document.createElement('div');
      const reasonInput = document.createElement('input');
      reasonInput.type = 'text';
      reasonInput.value = row.原因 || '';
      reasonInput.placeholder = '原因';
      reasonInput.addEventListener('input', () => { row.原因 = reasonInput.value; persist(); });
      reason.appendChild(reasonInput);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.textContent = '×';
      remove.title = '从待确认里移除';
      remove.addEventListener('click', () => {
        card.待确认.splice(index, 1);
        renderFactSections();
        persist();
      });
      line.append(content, reason, remove);
      box.appendChild(line);
      requestAnimationFrame(() => autoGrow(contentInput));
    });
    if (!card.待确认.length) box.insertAdjacentHTML('beforeend', '<p class="foot-note">没有待确认内容。</p>');
  }

  // 感官信息
  {
    const { box, head } = section(`感官信息（${card.感官信息.length}）`);
    const tags = document.createElement('div');
    tags.className = 'tags';
    box.appendChild(tags);
    renderChips(tags, card.感官信息, {
      addLabel: '+ 添加',
      onAdd: (value) => { card.感官信息.push(value); renderFactSections(); persist(); },
      onRemove: (index) => { card.感官信息.splice(index, 1); renderFactSections(); persist(); },
    });
    head.style.marginBottom = '6px';
  }
}

function renderFactCard() {
  const hasCard = Boolean(state.factCard);
  $('#facts-empty').classList.toggle('hidden', hasCard);
  $('#facts-editor').classList.toggle('hidden', !hasCard);
  if (hasCard) {
    $('#fact-name').value = state.factCard.产品名称 || '';
    $('#fact-category').value = state.factCard.品类 || '';
    renderFactSections();
    const known = state.factCard.明确信息.length;
    const pending = state.factCard.待确认.length;
    $('#facts-summary').textContent = `明确 ${known} 条 · 待确认 ${pending} 条`;
  } else {
    $('#facts-summary').textContent = '尚未生成';
  }
  renderProductTags();
  renderAdvancedTags();
}

/* --------------------------------------------------------- *
 * 渲染：高级设置
 * --------------------------------------------------------- */

function renderAdvancedTags() {
  renderToggleChips($('#tags-structure'), STRUCTURES, state.options.structure, (item) => {
    const index = state.options.structure.indexOf(item);
    if (index >= 0) {
      if (state.options.structure.length <= 1) {
        toast('至少保留一种表达结构', { bad: true });
        return;
      }
      state.options.structure.splice(index, 1);
    } else {
      state.options.structure.push(item);
    }
    renderAdvancedTags();
    persist();
  });

  const card = state.factCard;
  const sceneBox = $('#tags-scene');
  const effectBox = $('#tags-effect');
  const bannedBox = $('#tags-banned');
  const forbiddenBox = $('#chips-forbidden');

  if (!card) {
    for (const box of [sceneBox, effectBox]) {
      box.className = 'tags';
      box.innerHTML = '<span class="foot-note">识别事实卡后自动填入</span>';
    }
    forbiddenBox.className = 'tags chips-muted';
    forbiddenBox.innerHTML = '<span class="foot-note">识别事实卡后自动生成</span>';
  } else {
    renderChips(sceneBox, card['允许场景与动作'], {
      addLabel: '+ 添加',
      onAdd: (value) => { card['允许场景与动作'].push(value); renderAdvancedTags(); persist(); },
      onRemove: (index) => { card['允许场景与动作'].splice(index, 1); renderAdvancedTags(); persist(); },
    });
    renderChips(effectBox, card['允许表达的结果'], {
      addLabel: '+ 添加',
      onAdd: (value) => { card['允许表达的结果'].push(value); renderAdvancedTags(); renderProductTags(); persist(); },
      onRemove: (index) => { card['允许表达的结果'].splice(index, 1); renderAdvancedTags(); renderProductTags(); persist(); },
    });
    renderChips(forbiddenBox, card['不得写的内容'], { removable: false, muted: true });
  }

  renderChips(bannedBox, state.options.banned, {
    addLabel: '+ 添加',
    onAdd: (value) => { state.options.banned.push(value); renderAdvancedTags(); persist(); },
    onRemove: (index) => { state.options.banned.splice(index, 1); renderAdvancedTags(); persist(); },
  });

  const counts = `${state.options.structure.length} 项结构 · ${card ? card['允许场景与动作'].length : 0} 个场景 · ${state.options.banned.length} 条禁用表达`;
  $('#advanced-hint').textContent = counts;
}

/* --------------------------------------------------------- *
 * 渲染：策略与 CTA
 * --------------------------------------------------------- */

function currentCount() {
  return Math.min(20, Math.max(1, Number.parseInt($('#comment-count').value, 10) || 10));
}

function renderStrategy() {
  const strength = state.options.strength;
  $('#strength').value = String(strength);
  $('#strength-value').textContent = Number(strength).toFixed(1);
  $('#strength-note').classList.toggle('hidden', Number(strength) <= 8);
  $('#style').value = state.options.style;
  $('#length-mode').value = state.options.length;
  updateCTA();
}

function updateCTA() {
  const count = currentCount();
  const button = $('#btn-generate');
  button.textContent = `生成 ${count} 条评论`;
  $('#cta-summary').textContent = `${count} 条 · 强度 ${Number(state.options.strength).toFixed(1)} · ${state.options.style}`;
  const hasCard = Boolean(state.factCard);
  const confirmed = $('#confirm-facts').checked;
  button.disabled = !(hasCard && confirmed);
  $('#generate-hint').textContent = !hasCard
    ? '先识别并核对事实卡'
    : confirmed
      ? '先生成候选，再按规则筛选 · Ctrl + Enter'
      : '请在「事实卡复核」里勾选确认';
}

/* --------------------------------------------------------- *
 * 渲染：评论结果
 * --------------------------------------------------------- */

function typeOf(item) {
  const source = `${item.meta?.focus || ''} ${item.meta?.result || ''} ${item.text || ''}`;
  for (const [pattern, label] of COMMENT_TYPE_RULES) {
    if (pattern.test(source)) return label;
  }
  return '体验型';
}

function charBadgeClass(chars) {
  if (chars >= 88 && chars <= 112) return 'is-long';
  if (chars < 20) return 'is-warn';
  return '';
}

let openMenuIndex = -1;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function renderComments() {
  const list = $('#review-list');
  list.innerHTML = '';
  const comments = state.comments;
  $('#results-empty').classList.toggle('hidden', comments.length > 0);
  $('#result-count').textContent = `${comments.length} 条`;

  comments.forEach((item, index) => {
    const card = el('li', 'review-card');
    if (openMenuIndex === index) card.classList.add('menu-open');
    const isRegenerating = state.regeneratingIndex === index;
    if (isRegenerating) card.classList.add('is-loading');

    // 头部：编号 + hover 快捷操作（复制/编辑）+ •••
    const head = el('header', 'review-card-head');
    head.appendChild(el('span', 'review-no', String(index + 1).padStart(2, '0')));
    const headRight = el('div', 'review-head-right');
    const quick = el('div', 'review-quick');
    quick.append(
      makeAction('复制', (event) => copyWithFeedback(event.currentTarget, item.text), 'quick-btn'),
      makeAction('编辑', () => startEdit(index), 'quick-btn'),
    );
    headRight.appendChild(quick);
    headRight.appendChild(
      makeAction('•••', (event) => {
        event.stopPropagation();
        openMenuIndex = openMenuIndex === index ? -1 : index;
        renderComments();
      }, 'icon-btn menu-trigger'),
    );
    head.appendChild(headRight);
    card.appendChild(head);

    if (isRegenerating) card.appendChild(el('div', 'review-loading', '正在重新生成这一条…'));

    // 正文：展示态 / 编辑态
    if (state.editingIndex === index) {
      const editor = el('div', 'review-editor');
      const textarea = el('textarea', 'review-text');
      textarea.value = state.editDraft;
      textarea.addEventListener('input', () => {
        state.editDraft = textarea.value;
        autoGrow(textarea);
      });
      textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          cancelEdit();
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          saveEdit(index);
        }
      });
      const actions = el('div', 'editor-actions');
      actions.append(
        makeAction('取消', () => cancelEdit(), 'btn btn-ghost btn-sm'),
        makeAction('保存', () => saveEdit(index), 'btn btn-primary btn-sm'),
      );
      editor.append(textarea, actions);
      card.appendChild(editor);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        autoGrow(textarea);
      });
    } else {
      const body = el('div', 'review-body');
      body.appendChild(el('p', 'review-text-display', item.text));
      card.appendChild(body);
    }

    // 元数据：字数（普通灰字）+ 类型 / 满意度（浅灰 chip）
    const chars = countChars(item.text);
    const meta = el('footer', 'review-meta');
    meta.append(
      el('span', `meta-chars ${charBadgeClass(chars)}`, `${chars} 字`),
      el('span', 'chip-sm', typeOf(item)),
      el('span', 'chip-sm', item.meta?.emotion || '明确满意'),
    );
    card.appendChild(meta);

    // ••• 菜单：复制 / 编辑 / 重新生成这一条 / 删除（低频操作藏在菜单里）
    if (openMenuIndex === index) {
      const menu = el('div', 'review-menu');
      menu.append(
        menuButton('复制', () => {
          closeMenu();
          copyText(item.text, '已复制该条评论');
        }),
        menuButton('编辑', () => {
          closeMenu();
          startEdit(index);
        }),
        menuButton('重新生成这一条', () => {
          closeMenu();
          regenerateOne(index);
        }),
      );
      menu.appendChild(el('div', 'menu-sep'));
      menu.appendChild(
        menuButton('删除', () => {
          closeMenu();
          deleteComment(index);
        }, 'danger'),
      );
      card.appendChild(menu);
    }

    list.appendChild(card);
  });
}

function menuButton(label, onClick, className = '') {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function closeMenu() {
  openMenuIndex = -1;
  renderComments();
}

function copyWithFeedback(button, text) {
  copyText(text, '已复制该条评论');
  if (!button) return;
  const original = button.textContent;
  button.textContent = '已复制';
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

/* ---------------- 单条内联编辑 ---------------- */

function startEdit(index) {
  if (state.regeneratingIndex === index) {
    toast('这一条正在重新生成，稍等再编辑', { bad: true });
    return;
  }
  state.editingIndex = index;
  state.editDraft = state.comments[index]?.text || '';
  openMenuIndex = -1;
  renderComments();
}

function cancelEdit() {
  state.editingIndex = -1;
  state.editDraft = '';
  renderComments();
}

function saveEdit(index) {
  const value = String(state.editDraft || '').trim();
  if (!value) {
    toast('评论内容不能为空', { bad: true });
    return;
  }
  const item = state.comments[index];
  if (!item) return;
  item.text = value;
  item.chars = countChars(value);
  state.editingIndex = -1;
  state.editDraft = '';
  renderComments();
  persist();
  touchHistorySnapshot();
  toast('已保存这一条，复制与导出都会用新内容');
}

/** 让最新一条历史记录与当前编辑结果保持一致，避免"历史里还是旧文案" */
function touchHistorySnapshot() {
  const latest = state.history[0];
  if (!latest) return;
  const sameRun =
    !latest.generation?.generatedAt ||
    !state.generation.generatedAt ||
    latest.generation.generatedAt === state.generation.generatedAt;
  if (!sameRun) return;
  latest.comments = state.comments.map((entry) => ({ ...entry }));
  renderHistory();
  persist();
}

function makeAction(label, onClick, className = 'quick-btn') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function deleteComment(index) {
  const removed = state.comments[index];
  state.comments.splice(index, 1);
  if (state.editingIndex === index) {
    state.editingIndex = -1;
    state.editDraft = '';
  } else if (state.editingIndex > index) {
    state.editingIndex -= 1;
  }
  openMenuIndex = -1;
  renderComments();
  persist();
  touchHistorySnapshot();
  toast(`已删除第 ${index + 1} 条评论`, {
    actionLabel: '撤销',
    onAction: () => {
      state.comments.splice(index, 0, removed);
      renderComments();
      persist();
      touchHistorySnapshot();
      toast('已恢复');
    },
  });
}

/* --------------------------------------------------------- *
 * 渲染：自检报告
 * --------------------------------------------------------- */

function renderReport() {
  const body = $('#report-body');
  const report = state.report;
  if (!report) {
    body.innerHTML = '<p class="foot-note">本次还没有生成记录。</p>';
    $('#report-hint').textContent = '程序自检，不等于独立盲测';
    $('#report-box').classList.add('hidden');
    return;
  }
  $('#report-box').classList.remove('hidden');
  // 折叠状态下的摘要：通过条数 · 淘汰候选 · 需人工复核
  $('#report-hint').textContent = [
    `${report.selected} 条通过`,
    `淘汰 ${report.rejectedCount} 条候选`,
    report.warnings?.length ? `需复核 ${report.warnings.length} 项` : '无需人工复核',
  ].join(' · ');
  const lines = [
    `模型：${report.model || '未记录'}　生成时间：${report.generatedAt || ''}　耗时：${(report.elapsedMs / 1000).toFixed(1)} 秒`,
    `候选 ${report.candidateCount} 条 → 通过事实与正面检查 ${report.passed} 条 → 语义去重后保留 ${report.selected} 条`,
    `篇幅分布：约 100 字长评 ${report.length.long} 条 ｜ 主体 55–85 字 ${report.length.main} 条 ｜ 短评 ${report.length.short} 条`,
    `情绪分布：${Object.entries(report.emotions || {}).map(([k, v]) => `${k} ${v}`).join('，') || '—'}`,
    `事实依据：${report.factSummary}`,
    `需要人工复核：${report.warnings?.length ? report.warnings.map((w) => `第 ${w.index} 条 ${w.type}（${w.detail}）`).join('；') : '无'}`,
  ];
  if (report.preferenceNote) {
    lines.push(`本次生效的评论策略：${String(report.preferenceNote).replace(/\n/g, ' ')}`);
  }
  if (report.perf) {
    const perf = report.perf;
    const sec = (ms) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`);
    lines.push('');
    lines.push(
      `性能：总耗时 ${sec(perf.totalMs)}　首条完整候选 ${sec(perf.firstCandidateMs)}　首轮候选 ${perf.initialCandidates} 条 → 合格 ${perf.validAfterFilter} 条　补生成 ${perf.refillRounds} 轮（${perf.refillGenerated} 条）`,
    );
    lines.push(
      `token：input ${perf.usage?.input ?? '—'}　output ${perf.usage?.output ?? '—'}（推理 ${perf.usage?.reasoning ?? '—'} · 正文 ${perf.tokenTokens ?? Math.max(0, (perf.usage?.output || 0) - (perf.usage?.reasoning || 0))}）`,
    );
  }
  if (report.focusOveruse?.length) {
    lines.push(`同一卖点条数偏多（事实较少时属正常）：${report.focusOveruse.map((f) => `${f.focus}×${f.times}`).join('、')}`);
  }
  lines.push('说明：以上为一轮生成程序自检结果，不等于独立盲测、用户认可或跨品类验收。');

  const html = [`<pre>${escapeHtml(lines.join('\n'))}</pre>`];
  if (report.rejected?.length) {
    html.push('<details class="reject-list"><summary>被筛掉的候选（节选 20 条）</summary><ul>');
    report.rejected.slice(0, 20).forEach((item) => {
      html.push(`<li><strong>${escapeHtml(item.stage)}</strong>：${escapeHtml(item.reason)}<br />${escapeHtml(String(item.text).slice(0, 80))}</li>`);
    });
    html.push('</ul></details>');
  }
  body.innerHTML = html.join('');
}

/* --------------------------------------------------------- *
 * 历史记录
 * --------------------------------------------------------- */

function saveHistory() {
  if (!state.comments.length) return;
  const snapshot = {
    id: Date.now(),
    at: new Date().toLocaleString('zh-CN', { hour12: false }),
    productName: state.factCard?.产品名称 || state.productName || '未命名产品',
    count: state.comments.length,
    comments: state.comments.map((item) => ({ ...item })),
    factCard: state.factCard ? JSON.parse(JSON.stringify(state.factCard)) : null,
    report: state.report,
    generation: { ...state.generation },
    options: { ...state.options },
  };
  state.history = [snapshot, ...state.history].slice(0, 20);
  renderHistory();
  persist();
}

function renderHistory() {
  const list = $('#history-list');
  list.innerHTML = '';
  if (!state.history.length) {
    list.innerHTML = '<p class="foot-note">还没有历史记录。生成一次评论后会自动存档。</p>';
    return;
  }
  state.history.forEach((snapshot) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = snapshot.productName;
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = `${snapshot.at} · ${snapshot.count} 条 · ${snapshot.generation?.model || ''}`;
    info.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'btn btn-ghost btn-sm';
    restore.textContent = '载入';
    restore.addEventListener('click', () => restoreHistory(snapshot));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-ghost btn-sm';
    remove.textContent = '删除';
    remove.addEventListener('click', () => {
      state.history = state.history.filter((entry) => entry.id !== snapshot.id);
      renderHistory();
      persist();
    });
    actions.append(restore, remove);
    item.append(info, actions);
    list.appendChild(item);
  });
}

function currentSnapshot() {
  return {
    productName: state.productName,
    productSpec: state.productSpec,
    sellingPoints: [...state.sellingPoints],
    factCard: state.factCard ? JSON.parse(JSON.stringify(state.factCard)) : null,
    comments: state.comments.map((item) => ({ ...item })),
    report: state.report,
    generation: { ...state.generation },
    options: { ...state.options },
  };
}

function applySnapshot(snapshot) {
  state.productName = snapshot.productName || '';
  state.productSpec = snapshot.productSpec || '';
  state.sellingPoints = Array.isArray(snapshot.sellingPoints) ? [...snapshot.sellingPoints] : [];
  state.factCard = snapshot.factCard || null;
  state.comments = Array.isArray(snapshot.comments) ? snapshot.comments.map((item) => ({ ...item })) : [];
  state.report = snapshot.report || null;
  state.generation = snapshot.generation || { model: '', generatedAt: '', productName: '' };
  if (snapshot.options) state.options = { ...state.options, ...snapshot.options };
  $('#product-name').value = state.productName;
  $('#product-spec').value = state.productSpec;
  renderFactCard();
  renderStrategy();
  renderComments();
  renderReport();
  updateCTA();
  persist();
}

function restoreHistory(snapshot) {
  const previous = currentSnapshot();
  applySnapshot(snapshot);
  $('#history-drawer').classList.add('hidden');
  toast('已载入历史记录', {
    actionLabel: '撤销',
    onAction: () => {
      applySnapshot(previous);
      toast('已恢复到载入前的状态');
    },
  });
}

/* --------------------------------------------------------- *
 * 产品资料与事实卡流程
 * --------------------------------------------------------- */

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  if (state.images.length + files.length > 8) toast('最多 8 张图片，多余的已忽略', { bad: true });
  files.slice(0, Math.max(0, 8 - state.images.length)).forEach((file) => {
    if (file.size > 12 * 1024 * 1024) {
      toast(`${file.name} 超过 12MB，已跳过`, { bad: true });
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

/** 产品规格会作为一行资料一起送进事实卡提取 */
function sellingPointsPayload() {
  const lines = [...state.sellingPoints];
  if (state.productSpec.trim()) lines.unshift(`产品规格：${state.productSpec.trim()}`);
  return lines.join('\n');
}

async function extractFacts() {
  const productName = $('#product-name').value.trim();
  const sellingPoints = sellingPointsPayload();
  if (!productName && !sellingPoints && !state.images.length) {
    toast('请至少填写产品名称、卖点或上传图片', { bad: true });
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
    openFactsModal();
    renderFactCard();
    $('#extract-note').textContent = data.extraction?.note || '';
    toast('事实卡已生成，请核对后勾选确认');
  } catch (error) {
    toast(error.message, { bad: true });
  } finally {
    busy(false);
  }
}

/* --------------------------------------------------------- *
 * 生成与导出
 * --------------------------------------------------------- */

async function generateComments() {
  if (!state.factCard) return toast('请先识别并核对事实卡', { bad: true });
  if (!$('#confirm-facts').checked) return toast('请先在「事实卡复核」里勾选核对确认', { bad: true });
  const count = currentCount();
  if (state.streaming) {
    // 用户连点或中途重新生成：先中断上一轮
    state.streamAbort?.abort();
  }
  const controller = new AbortController();
  const token = (state.streamToken || 0) + 1;
  state.streamToken = token;
  state.streamAbort = controller;
  state.streaming = true;
  setGenerating(true);
  resetStreamPanel();
  try {
    await streamGenerate(count, controller);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      toast('已取消上一次生成');
      return;
    }
    if (state.streamGotFinal) return;
    // 流式链路本身失败（网络/代理不支持等）→ 回退到普通接口，不让用户白等
    if (!state.streamGotAnyCandidate) {
      try {
        const data = await api('/api/comments', { body: { factCard: state.factCard, count, options: state.options } });
        applyGenerationResult(data);
        toast('流式不可用，已用普通模式完成生成');
        return;
      } catch (fallbackError) {
        toast(fallbackError.message, { bad: true });
        return;
      }
    }
    toast(`生成中断：${error.message}`, { bad: true });
  } finally {
    // 中途重新生成时，旧请求的收尾不能影响新一轮的界面状态
    if (state.streamToken !== token) return;
    state.streaming = false;
    setGenerating(false);
    hideStreamPanel();
  }
}

function applyGenerationResult(data) {
  state.comments = (data.comments || []).map((item) => ({ ...item }));
  state.report = data.report;
  state.generation = {
    model: data.model,
    generatedAt: data.generatedAt,
    productName: state.factCard?.产品名称 || state.productName,
  };
  openMenuIndex = -1;
  state.editingIndex = -1;
  state.editDraft = '';
  state.regeneratingIndex = -1;
  renderComments();
  renderReport();
  saveHistory();
  persist();
}

function setGenerating(on) {
  const button = $('#btn-generate');
  const total = state.streamTotal || currentCount();
  button.disabled = on;
  button.textContent = on ? `生成中… ${state.streamDone || 0}/${total}` : `生成 ${currentCount()} 条评论`;
  if (on) {
    $('#stream-status').classList.remove('hidden');
    $('#stream-status').textContent = `正在生成候选 0 / ${total}`;
  } else {
    $('#stream-status').classList.add('hidden');
    updateCTA();
  }
}

function resetStreamPanel() {
  state.streamTotal = currentCount();
  state.streamDone = 0;
  state.streamGotAnyCandidate = false;
  state.streamGotFinal = false;
  state.streamCandidates = [];
  const panel = $('#stream-panel');
  panel.classList.remove('hidden');
  $('#stream-text').textContent = '正在分析产品信息，准备生成候选…';
  $('#stream-list').innerHTML = '';
}

function hideStreamPanel() {
  $('#stream-panel').classList.add('hidden');
  $('#stream-status').classList.add('hidden');
}

function setStreamStatus(text) {
  $('#stream-text').textContent = text;
}

function renderStreamList() {
  const list = $('#stream-list');
  const items = state.streamCandidates;
  list.innerHTML = '';
  const show = items.slice(-3);
  const hiddenCount = items.length - show.length;
  show.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'stream-item';
    li.dataset.index = `${String(item.index).padStart(2, '0')}　`;
    li.textContent = item.text;
    list.appendChild(li);
  });
  if (hiddenCount > 0) {
    const more = document.createElement('li');
    more.className = 'stream-more';
    more.textContent = `前面还有 ${hiddenCount} 条候选已完成（完整内容会在筛选后统一展示）`;
    list.insertBefore(more, list.firstChild);
  }
}

/** 真实流式接收：SSE 事件驱动，只接收完整候选 */
async function streamGenerate(count, controller) {
  const response = await fetch('/api/comments/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ factCard: state.factCard, count, options: state.options }),
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`流式接口返回 ${response.status}${detail ? `：${detail.slice(0, 120)}` : ''}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let streamError = null;

  const handleFrame = (frame) => {
    const eventMatch = frame.match(/^event: (.+)$/m);
    const dataMatch = frame.match(/^data: ([\s\S]+)$/m);
    if (!eventMatch || !dataMatch) return;
    const event = eventMatch[1].trim();
    let data = {};
    try {
      data = JSON.parse(dataMatch[1]);
    } catch {
      return;
    }

    if (event === 'generation_start') {
      state.streamTotal = data.candidates || count;
      setStreamStatus(`正在生成候选 0 / ${state.streamTotal}（首轮 ${data.candidates} 条，不足只补缺口）`);
      $('#stream-status').textContent = `正在生成候选 0 / ${state.streamTotal}`;
      $('#btn-generate').textContent = `生成中… 0/${state.streamTotal}`;
      return;
    }
    if (event === 'candidate_complete') {
      state.streamGotAnyCandidate = true;
      state.streamDone += 1;
      state.streamCandidates.push({ index: data.index, text: data.text });
      renderStreamList();
      setStreamStatus(`已生成候选 ${state.streamDone} / ${state.streamTotal}，正在继续…`);
      $('#stream-status').textContent = `正在生成候选 ${state.streamDone} / ${state.streamTotal}`;
      $('#btn-generate').textContent = `生成中… ${state.streamDone}/${state.streamTotal}`;
      return;
    }
    if (event === 'filtering') {
      setStreamStatus(`候选已收齐（${data.candidates} 条），正在做事实、正面与去重筛选…`);
      return;
    }
    if (event === 'refill_start') {
      setStreamStatus(`合格评论还差 ${data.missing} 条，正在只补生成 ${data.generate} 条候选…`);
      return;
    }
    if (event === 'final_reviews') {
      state.streamGotFinal = true;
      applyGenerationResult(data);
      hideStreamPanel();
      const total = data.comments?.length || 0;
      toast(total < count ? `本次产出 ${total}/${count} 条合规评论，可看自检报告` : `已生成 ${total} 条模拟评论`, { bad: total < count });
      return;
    }
    if (event === 'done') {
      setStreamStatus(`完成：${data.count} 条 · 总耗时 ${(data.duration / 1000).toFixed(1)} 秒`);
      return;
    }
    if (event === 'error') {
      streamError = new Error(data.message || '生成失败');
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
      if (frame.trim() && !frame.trimStart().startsWith(':')) handleFrame(frame);
      index = buffer.indexOf('\n\n');
    }
  }
  if (streamError) throw streamError;
}

async function regenerateOne(index) {
  const current = state.comments[index];
  if (!state.factCard || !current) return;
  // 并发保护：同一条被连续点击时直接忽略，其他卡片不受影响
  if (state.regeneratingIndex === index) return;
  // 正在编辑这一条时先阻止，避免未保存的草稿被覆盖
  if (state.editingIndex === index) {
    toast('请先保存或取消这一条的编辑，再重新生成', { bad: true });
    return;
  }
  state.regeneratingIndex = index;
  const others = state.comments.filter((_, i) => i !== index);
  const chars = countChars(current.text);
  const targetLength = chars >= 88 ? '90–110 字（高度赞扬长评，全正面）' : chars >= 50 ? '55–85 字' : '20–50 字（短评）';
  openMenuIndex = -1;
  state.editingIndex = -1;
  renderComments();
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
    persist();
    touchHistorySnapshot();
    if (data.warnings?.length) {
      toast(`已重新生成，需复核：${data.warnings.map((w) => w.type).join('、')}`, { bad: true });
    } else {
      toast('已重新生成这一条');
    }
  } catch (error) {
    // 失败时保留原评论，只给一条轻提示
    toast(`这一条没换成：${error.message}`, { bad: true });
  } finally {
    state.regeneratingIndex = -1;
    renderComments();
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
  if (!state.comments.length) return toast('还没有可导出的评论', { bad: true });
  try {
    const data = await api('/api/export/markdown', { body: exportPayload() });
    downloadBlob(new Blob([data.markdown], { type: 'text/markdown;charset=utf-8' }), data.filename);
    toast(`已导出：${data.filename}`);
  } catch (error) {
    toast(error.message, { bad: true });
  }
}

async function exportExcel() {
  if (!state.comments.length) return toast('还没有可导出的评论', { bad: true });
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
    toast(`已导出：${filename}`);
  } catch (error) {
    toast(error.message, { bad: true });
  }
}

/* --------------------------------------------------------- *
 * 设置
 * --------------------------------------------------------- */

async function loadConfig() {
  const data = await api('/api/config');
  state.config = data;
  const status = $('#model-status');
  status.className = `model-status ${data.ready ? 'ok' : 'bad'}`;
  status.innerHTML = '<span class="dot"></span>';
  status.appendChild(document.createTextNode(data.ready ? `${data.model} · ${data.baseUrlHost}` : '模型未配置，点「设置」'));

  $('#cfg-base-url').value = data.baseUrl || '';
  $('#cfg-model').value = data.model || '';
  $('#cfg-vision').value = data.visionMode || 'auto';
  $('#cfg-temperature').value = data.temperature ?? 0.95;
  $('#cfg-max-tokens').value = data.maxTokens ?? 32000;
  $('#cfg-ocr-url').value = data.ocr?.baseUrl || '';
  $('#cfg-ocr-model').value = data.ocr?.model || '';
  $('#cfg-api-key').placeholder = data.apiKeyMasked ? `已配置：${data.apiKeyMasked}（留空保持不变）` : '粘贴你的接口密钥';

  const sources = data.sources || {};
  $('#config-source').textContent = [
    `接口地址：${sources.baseUrl || '未知'}`,
    `模型 ID：${sources.model || '未知'}`,
    `密钥：${sources.apiKey || '未知'}`,
    `本机 OCR：${data.localOcr?.ok ? `可用（${data.localOcr.language}）` : '不可用'}`,
  ].join('　｜　');
}

async function saveSettings() {
  $('#settings-status').textContent = '保存中…';
  try {
    await api('/api/config', {
      body: {
        baseUrl: $('#cfg-base-url').value,
        model: $('#cfg-model').value,
        apiKey: $('#cfg-api-key').value,
        vision: $('#cfg-vision').value,
        temperature: $('#cfg-temperature').value,
        maxTokens: $('#cfg-max-tokens').value,
        ocr: { baseUrl: $('#cfg-ocr-url').value, model: $('#cfg-ocr-model').value, apiKey: $('#cfg-ocr-key').value },
      },
    });
    $('#cfg-api-key').value = '';
    $('#cfg-ocr-key').value = '';
    await loadConfig();
    $('#settings-status').textContent = '已保存到服务端 config.json';
    toast('设置已保存');
  } catch (error) {
    $('#settings-status').textContent = `保存失败：${error.message}`;
    toast(error.message, { bad: true });
  }
}

async function loadModels() {
  const output = $('#test-output');
  output.classList.remove('hidden');
  output.textContent = '正在读取模型列表…';
  try {
    const data = await api('/api/config/models', {
      body: { baseUrl: $('#cfg-base-url').value, apiKey: $('#cfg-api-key').value },
    });
    const options = $('#model-options');
    options.innerHTML = '';
    data.models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.label = `${model.name || model.id}${model.inputModalities ? `（${model.inputModalities.join('/')}）` : ''}`;
      options.appendChild(option);
    });
    output.textContent = data.models
      .map((model) => `${model.id}${model.name ? ` — ${model.name}` : ''}${model.inputModalities ? `　输入：${model.inputModalities.join('、')}` : ''}`)
      .join('\n');
    $('#settings-status').textContent = `读取到 ${data.models.length} 个模型`;
  } catch (error) {
    output.textContent = `读取失败：${error.message}`;
    $('#settings-status').textContent = '读取模型列表失败';
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
    $('#settings-status').textContent = data.ok ? '测试通过' : '测试未通过';
  } catch (error) {
    output.textContent = `测试失败：${error.message}`;
    $('#settings-status').textContent = '测试失败';
  }
}

/* --------------------------------------------------------- *
 * 提示词预览
 * --------------------------------------------------------- */

let promptTab = 'preview';
let promptCache = null;

async function openPromptModal() {
  $('#prompt-modal').classList.remove('hidden');
  promptTab = 'preview';
  promptCache = null;
  renderPromptTabs();
  await renderPromptBody();
}

function renderPromptTabs() {
  document.querySelectorAll('#prompt-tabs .tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === promptTab);
  });
}

async function renderPromptBody() {
  const body = $('#prompt-body');
  const note = $('#prompt-note');
  body.innerHTML = '<p class="foot-note">正在生成预览…</p>';

  if (promptTab === 'rules') {
    try {
      const rules = await api('/api/rules');
      note.textContent = `规则蓝本原文（${rules.file ? rules.file.split('\\').pop() : '内置版本'}），完整嵌入生成时的系统提示里。`;
      body.innerHTML = '';
      const block = document.createElement('div');
      block.className = 'prompt-block';
      const pre = document.createElement('pre');
      pre.className = 'prompt-pre';
      pre.textContent = rules.text;
      block.appendChild(pre);
      body.appendChild(block);
      promptCache = rules.text;
    } catch (error) {
      note.textContent = `读取失败：${error.message}`;
    }
    return;
  }

  if (promptCache && promptCache.kind === 'preview') {
    renderPromptPreview(promptCache.data);
    return;
  }

  try {
    const data = await api('/api/prompt-preview', {
      body: { factCard: state.factCard || {}, count: currentCount(), options: state.options },
    });
    promptCache = { kind: 'preview', data };
    renderPromptPreview(data);
  } catch (error) {
    note.textContent = `预览失败：${error.message}`;
    body.innerHTML = '';
  }
}

function renderPromptPreview(data) {
  const body = $('#prompt-body');
  const note = $('#prompt-note');
  note.textContent = [
    `按下生成后，会并发发送 ${data.batchCount} 批请求，共约 ${data.candidateCount} 条候选`,
    `每批 ${data.perBatch} 条`,
    data.warning || '',
  ].filter(Boolean).join('　｜　');

  body.innerHTML = '';
  data.batches.forEach((batch) => {
    const block = document.createElement('div');
    block.className = 'prompt-block';

    const header = document.createElement('header');
    const title = document.createElement('span');
    title.textContent = `批次 ${batch.index} 侧重`;
    const hint = document.createElement('span');
    hint.className = 'foot-note';
    hint.textContent = batch.focusHint;
    header.append(title, hint);
    block.appendChild(header);

    batch.messages.forEach((message) => {
      const part = document.createElement('div');
      part.className = 'prompt-part';
      const h4 = document.createElement('h4');
      h4.textContent = message.role === 'system' ? '系统提示（含规则蓝本全文）' : '用户提示（含事实卡与本次策略）';
      const size = document.createElement('span');
      size.className = 'foot-note';
      size.textContent = `${message.chars} 字符`;
      h4.appendChild(size);
      const pre = document.createElement('pre');
      pre.className = 'prompt-pre';
      pre.textContent = message.content;
      part.append(h4, pre);
      block.appendChild(part);
    });

    body.appendChild(block);
  });
  promptCache = { kind: 'preview', data };
}

function currentPromptText() {
  if (promptTab === 'rules') return typeof promptCache === 'string' ? promptCache : '';
  if (promptCache && promptCache.kind === 'preview') {
    return promptCache.data.batches
      .map((batch) => [`===== 批次 ${batch.index}｜${batch.focusHint} =====`, ...batch.messages.map((m) => `--- ${m.role} ---\n${m.content}`)].join('\n\n'))
      .join('\n\n\n');
  }
  return '';
}

/* --------------------------------------------------------- *
 * 本地暂存
 * --------------------------------------------------------- */

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        productName: $('#product-name').value,
        productSpec: $('#product-spec').value,
        sellingPoints: state.sellingPoints,
        factCard: state.factCard,
        comments: state.comments,
        report: state.report,
        generation: state.generation,
        options: state.options,
        history: state.history,
        count: $('#comment-count').value,
      }),
    );
  } catch {
    /* 配额不足时忽略 */
  }
}

function restore() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('buyer-review-studio');
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    state.productName = data.productName || '';
    state.productSpec = data.productSpec || '';
    state.sellingPoints = Array.isArray(data.sellingPoints)
      ? data.sellingPoints
      : String(data.sellingPoints || '').split('\n').map((line) => line.trim()).filter(Boolean);
    state.options = { ...state.options, ...(data.options || {}) };
    state.history = Array.isArray(data.history) ? data.history : [];
    $('#product-name').value = state.productName;
    $('#product-spec').value = state.productSpec;
    if (data.count) $('#comment-count').value = data.count;
    if (data.factCard) {
      state.factCard = normalizeFactCard(data.factCard);
      state.comments = Array.isArray(data.comments) ? data.comments : [];
      state.report = data.report || null;
      state.generation = data.generation || { model: '', generatedAt: '', productName: '' };
    }
  } catch {
    /* 本地数据损坏时忽略 */
  }
}

/* --------------------------------------------------------- *
 * 事件绑定
 * --------------------------------------------------------- */

function bindEvents() {
  // 产品信息
  $('#btn-choose-file').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (event) => {
    addFiles(event.target.files);
    event.target.value = '';
  });
  $('#product-name').addEventListener('input', (event) => {
    state.productName = event.target.value;
    persist();
  });
  $('#product-spec').addEventListener('input', (event) => {
    state.productSpec = event.target.value;
    persist();
  });
  document.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length) addFiles(files);
  });

  // 事实卡
  $('#btn-extract').addEventListener('click', extractFacts);
  $('#fact-name').addEventListener('input', (event) => {
    if (state.factCard) state.factCard.产品名称 = event.target.value;
    persist();
  });
  $('#fact-category').addEventListener('input', (event) => {
    if (state.factCard) state.factCard.品类 = event.target.value;
    persist();
  });
  $('#confirm-facts').addEventListener('change', () => {
    updateCTA();
    persist();
  });

  // 策略
  const clampCount = (value) => Math.min(20, Math.max(1, value));
  $('#count-minus').addEventListener('click', () => {
    $('#comment-count').value = clampCount(currentCount() - 1);
    updateCTA();
    persist();
  });
  $('#count-plus').addEventListener('click', () => {
    $('#comment-count').value = clampCount(currentCount() + 1);
    updateCTA();
    persist();
  });
  $('#comment-count').addEventListener('input', () => {
    updateCTA();
    persist();
  });
  $('#strength').addEventListener('input', (event) => {
    state.options.strength = Number(event.target.value);
    renderStrategy();
    persist();
  });
  $('#style').addEventListener('change', (event) => {
    state.options.style = event.target.value;
    updateCTA();
    persist();
  });
  $('#length-mode').addEventListener('change', (event) => {
    state.options.length = event.target.value;
    persist();
  });

  // 生成
  $('#btn-generate').addEventListener('click', generateComments);
  $('#btn-regenerate-all').addEventListener('click', generateComments);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!$('#btn-generate').disabled) generateComments();
    }
  });

  // 结果操作
  $('#btn-copy-all').addEventListener('click', () => {
    if (!state.comments.length) return toast('还没有可复制的评论', { bad: true });
    copyText(state.comments.map((item, index) => `${index + 1}. ${item.text}`).join('\n\n'), '已复制全部评论');
  });
  // 导出下拉：Excel / Markdown 收进同一个入口
  $('#btn-export').addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = $('#export-menu');
    menu.classList.toggle('hidden');
    $('#btn-export').setAttribute('aria-expanded', String(!menu.classList.contains('hidden')));
  });
  $('#export-menu').addEventListener('click', (event) => {
    const item = event.target.closest('button[data-export]');
    if (!item) return;
    $('#export-menu').classList.add('hidden');
    $('#btn-export').setAttribute('aria-expanded', 'false');
    if (item.dataset.export === 'xlsx') exportExcel();
    else exportMarkdown();
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('#export-dropdown')) return;
    if ($('#export-menu').classList.contains('hidden')) return;
    $('#export-menu').classList.add('hidden');
    $('#btn-export').setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', (event) => {
    if (openMenuIndex < 0) return;
    if (!event.target.closest('.review-menu') && !event.target.closest('.menu-trigger')) {
      openMenuIndex = -1;
      renderComments();
    }
  });

  // 设置
  $('#btn-open-settings').addEventListener('click', () => $('#settings-modal').classList.remove('hidden'));
  $('#btn-close-settings').addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
  $('#settings-modal').addEventListener('click', (event) => {
    if (event.target === $('#settings-modal')) $('#settings-modal').classList.add('hidden');
  });
  $('#btn-save-config').addEventListener('click', saveSettings);
  $('#btn-test-config').addEventListener('click', testConnection);
  $('#btn-load-models').addEventListener('click', loadModels);

  // 二层窗口：事实卡复核 / 高级设置
  $('#btn-open-facts').addEventListener('click', openFactsModal);
  $('#btn-close-facts').addEventListener('click', () => $('#facts-modal').classList.add('hidden'));
  $('#facts-modal').addEventListener('click', (event) => {
    if (event.target === $('#facts-modal')) $('#facts-modal').classList.add('hidden');
  });
  $('#btn-open-advanced').addEventListener('click', openAdvancedModal);
  $('#btn-close-advanced').addEventListener('click', () => $('#advanced-modal').classList.add('hidden'));
  $('#advanced-modal').addEventListener('click', (event) => {
    if (event.target === $('#advanced-modal')) $('#advanced-modal').classList.add('hidden');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllModals();
  });

  // 历史记录
  $('#btn-history').addEventListener('click', () => {
    renderHistory();
    $('#history-drawer').classList.remove('hidden');
  });
  $('#btn-close-history').addEventListener('click', () => $('#history-drawer').classList.add('hidden'));
  $('#history-drawer').addEventListener('click', (event) => {
    if (event.target === $('#history-drawer')) $('#history-drawer').classList.add('hidden');
  });

  // 提示词预览
  $('#btn-prompt').addEventListener('click', openPromptModal);
  $('#btn-prompt-inline').addEventListener('click', openPromptModal);
  $('#btn-close-prompt').addEventListener('click', () => $('#prompt-modal').classList.add('hidden'));
  $('#prompt-modal').addEventListener('click', (event) => {
    if (event.target === $('#prompt-modal')) $('#prompt-modal').classList.add('hidden');
  });
  $('#prompt-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    promptTab = tab.dataset.tab;
    renderPromptTabs();
    renderPromptBody();
  });
  $('#btn-copy-prompt').addEventListener('click', () => {
    const text = currentPromptText();
    if (!text) return toast('还没有可复制的内容', { bad: true });
    copyText(text, '已复制提示词');
  });
}

/* --------------------------------------------------------- *
 * 启动
 * --------------------------------------------------------- */

async function init() {
  bindEvents();
  restore();
  renderThumbs();
  renderStrategy();
  renderFactCard();
  renderComments();
  renderReport();
  renderHistory();
  updateCTA();
  try {
    await loadConfig();
  } catch (error) {
    $('#model-status').className = 'model-status bad';
    $('#model-status').innerHTML = `<span class="dot"></span>读取配置失败：${escapeHtml(error.message)}`;
  }
  try {
    const rules = await api('/api/rules');
    if (rules?.name) $('#rules-pill').textContent = `规则 ${rules.name}`;
  } catch {
    /* 忽略 */
  }
}

init();
