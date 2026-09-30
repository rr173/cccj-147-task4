/* common.js —— 三个工作台共享工具
 * 注意:本文件以 IIFE 包裹,工具函数只挂到 window.EWR(及 window.closeModal)。
 * 浏览器经典脚本共享同一全局词法环境,若在此处使用顶层 const/let/function,
 * 会与各页面脚本顶部的 `const { api, ... } = EWR` 重名冲突,导致
 * 「Identifier 'api' has already been declared」整脚本解析失败(下拉无数据、按钮无响应)。
 */
'use strict';
(function () {
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(json.error.message);
    err.code = json.error.code;
    err.extra = json.error.extra;
    throw err;
  }
  return json.data;
}

async function getState() {
  const res = await fetch('/api/state');
  const json = await res.json();
  return json.data;
}

async function getJson(path) {
  const res = await fetch(path);
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(json.error.message);
    err.code = json.error.code;
    throw err;
  }
  return json.data;
}

/* ----------------------- 可恢复的融资方操作会话 -----------------------
 * sessionId 持久化于浏览器 localStorage:刷新页面、重开标签后仍按同一身份
 * 从服务端 /api/session 重建台账与操作步骤;也可手动新建会话隔离演练。
 */
const SESSION_STORE_KEY = 'ewr-financier-session';
const DRAFTS_STORE_KEY = 'ewr-financier-drafts';
function getSessionId() {
  let id = localStorage.getItem(SESSION_STORE_KEY);
  if (!id) {
    id = 'SES-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    localStorage.setItem(SESSION_STORE_KEY, id);
  }
  return id;
}
function newSessionId() {
  const id = 'SES-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  localStorage.setItem(SESSION_STORE_KEY, id);
  return id;
}
function loadDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFTS_STORE_KEY) || '[]'); }
  catch (_) { return []; }
}
function saveDrafts(list) {
  // 仅保留最近 60 条,避免无限膨胀
  localStorage.setItem(DRAFTS_STORE_KEY, JSON.stringify(list.slice(-60)));
}

const OUTCOME_BADGE = {
  SUCCESS: ['green', '成功'],
  CONFLICT: ['amber', '冲突/重放'],
  REJECTED: ['red', '拒绝'],
  PENDING: ['blue', '待确认']
};
function outcomeBadge(outcome) {
  const [cls, text] = OUTCOME_BADGE[outcome] || ['gray', outcome];
  return `<span class="badge ${cls}">${text}</span>`;
}

function toast(message, kind = 'info', ms = 4200) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const STATUS_BADGE = {
  ACTIVE: ['green', '有效'],
  DELIVERED_PARTIAL: ['amber', '部分出库'],
  DELIVERED: ['gray', '已出库'],
  SPLIT: ['gray', '已拆分'],
  MERGED: ['gray', '已合并'],
  LOCKED: ['amber', '已锁定·未登记'],
  REGISTERED: ['green', '已登记·担保生效'],
  SUPPLEMENTING: ['red', '需补充担保'],
  RELEASED: ['gray', '已解除'],
  CANCELLED: ['gray', '已撤回'],
  OPEN: ['red', '待补充'],
  SATISFIED: ['green', '已弥补']
};

function badge(status) {
  const [cls, text] = STATUS_BADGE[status] || ['gray', status];
  return `<span class="badge ${cls}">${text}</span>`;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtNum(n, d = 3) {
  if (n == null) return '—';
  return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
function fmtMoney(n) {
  if (n == null) return '—';
  return '¥' + Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortHash(h, n = 10) {
  return h ? h.slice(0, n) : '';
}
function genRegNo() {
  return 'REG' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}
function genReqId(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function openModal(html) {
  let mask = document.getElementById('modal-mask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'modal-mask';
    mask.className = 'modal-mask';
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => {
      if (e.target === mask) closeModal();
    });
  }
  mask.innerHTML = `<div class="modal"><span class="close-x" onclick="closeModal()">✕</span>${html}</div>`;
  mask.classList.add('show');
}
function closeModal() {
  const mask = document.getElementById('modal-mask');
  if (mask) mask.classList.remove('show');
}
window.closeModal = closeModal;

function renderTopbar(active) {
  return `
  <header class="topbar">
    <div class="logo">🏛 大宗商品电子仓单登记与质押协同平台</div>
    <nav>
      <a href="/warehouse.html" class="${active === 'wh' ? 'active' : ''}">仓库端</a>
      <a href="/financier.html" class="${active === 'fin' ? 'active' : ''}">融资方端</a>
      <a href="/regulator.html" class="${active === 'reg' ? 'active' : ''}">监管查询</a>
    </nav>
    <div class="spacer"></div>
    <div class="who">演示环境 · 数据持久化于 data/db.json</div>
  </header>`;
}

window.EWR = {
  api, getState, getJson, toast, badge, outcomeBadge, fmtTime, fmtNum, fmtMoney, esc, shortHash,
  genRegNo, genReqId, openModal, closeModal, renderTopbar,
  getSessionId, newSessionId, loadDrafts, saveDrafts,
  SESSION_STORE_KEY, DRAFTS_STORE_KEY
};
})();

