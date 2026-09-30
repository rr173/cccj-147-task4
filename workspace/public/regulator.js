/* regulator.js —— 监管查询页 */
'use strict';
const { api, getState, getJson, toast, badge, outcomeBadge, fmtTime, fmtNum, fmtMoney, esc, shortHash, openModal, renderTopbar } = EWR;

let STATE = null;
let OPERATIONS = [];
document.getElementById('topbar').innerHTML = renderTopbar('reg');

const EVENT_CN = {
  RECEIPT_REGISTERED: '仓单登记', RECEIPT_SPLIT: '仓单拆分', RECEIPT_DERIVED: '派生子单',
  RECEIPT_MERGE: '仓单合并', RECEIPT_RECHECKED: '仓库复检', GOODS_DELIVERED: '货物出库',
  PLEDGE_LOCKED: '质押锁定', PLEDGE_CANCELLED: '质押撤回', PLEDGE_REGISTERED: '质押登记',
  PLEDGE_REVALUED: '担保重估', SUPPLEMENT_REQUESTED: '补充担保要求', COLLATERAL_SUPPLEMENTED: '补充担保到账',
  LOAN_REPAID: '偿还融资', RELEASE_GRANTED: '质权人放行', PLEDGE_CLOSED: '担保结清归档',
  VALUATION_BATCH_CREATED: '估值批次发布', ATTEMPT_LOGGED: '操作留痕'
};

const ACTION_CN = { lock: '锁仓', register: '质押登记', cancel: '撤回锁定', supplement: '补充担保', repay: '还款', release: '质权人放行' };

async function load() {
  STATE = await getState();
  renderChain();
  renderStats();
  renderBatches();
  renderAudit();
  renderReceipts();
  renderEvents();
  loadOperations();
}

function renderChain() {
  const c = STATE.audit.chain;
  const box = document.getElementById('chain-box');
  const banner = document.getElementById('chain-banner');
  if (c.ok) {
    box.innerHTML = `
      <dl class="kv">
        <dt>链上事件</dt><dd>${c.count} 条</dd>
        <dt>链头哈希</dt><dd class="chain-line">${c.head}</dd>
        <dt>校验结果</dt><dd><span class="tag-good">✔ 全部哈希衔接,载荷未被篡改</span></dd>
      </dl>`;
    banner.innerHTML = '<div class="banner ok">✔ 权利链验签通过:全部事件 prevHash 衔接,内容完整可核验。</div>';
  } else {
    box.innerHTML = `<span class="tag-bad">✘ 链断裂于 #${c.brokenAtSeq}:${esc(c.reason)}</span>`;
    banner.innerHTML = `<div class="banner warn">✘ 权利链验签失败:断裂于事件 #${c.brokenAtSeq}(<span id="chain-err">${esc(c.reason)}</span>)</div>`;
  }
}

function renderStats() {
  const c = STATE.audit.counts;
  const o = STATE.audit.operations;
  const items = [
    ['有效仓单', c.validReceipts], ['质押总额笔数', c.pledges], ['存续质押', c.activePledges],
    ['待补充担保', c.supplements], ['放行单', c.releases], ['出库单', c.deliveries],
    ['操作总步次', o.total], ['成功 / 冲突', `${o.success} / ${o.conflict}`], ['被拒绝', o.rejected],
    ['链上事件', c.events]
  ];
  document.getElementById('stats').className = 'grid cols-3';
  document.getElementById('stats').innerHTML = items
    .map(([l, n]) => `<div class="card stat"><span class="num">${n}</span><span class="lbl">${l}</span></div>`)
    .join('');
}

/* ----------------------------- 融资方操作审计 ----------------------------- */
window.loadOperations = async () => {
  const q = new URLSearchParams();
  const pick = (id) => document.getElementById(id).value.trim();
  if (pick('op-receipt')) q.set('receiptId', pick('op-receipt'));
  if (pick('op-pledge')) q.set('pledgeId', pick('op-pledge'));
  if (pick('op-actor')) q.set('actorId', pick('op-actor'));
  if (pick('op-session')) q.set('sessionId', pick('op-session'));
  if (pick('op-outcome')) q.set('outcome', pick('op-outcome'));
  if (pick('op-action')) q.set('action', pick('op-action'));
  OPERATIONS = await getJson('/api/operations?' + q.toString());
  renderOperations();
};

function opRefCell(o) {
  if (o.outcome === 'REJECTED') return '<span class="muted small">—(请求未生效)</span>';
  const r = o.ref;
  if (!r) return '<span class="muted small">—</span>';
  if (r.registrationNo)
    return `<b class="mono">${esc(r.registrationNo)}</b><div class="small muted">${esc(r.registrar || '登记中心')} · v${r.receiptVersion}</div>`;
  if (r.token)
    return `<b class="mono">${esc(r.token)}</b><div class="small muted">${esc(r.releaseId)} · ${fmtNum(r.qty)}吨 / 余 ${fmtNum(r.remaining)}吨</div>`;
  if (r.pledgeId) return `<span class="small mono">${esc(r.pledgeId)}</span>`;
  return '<span class="muted small">—</span>';
}

function renderOperations() {
  const tb = document.querySelector('#tbl-ops tbody');
  tb.innerHTML = OPERATIONS.map((o) => `<tr>
    <td>${o.seq}<div class="small muted mono">#${o.id}</div></td>
    <td class="small">${fmtTime(o.at)}</td>
    <td>${esc(ACTION_CN[o.action] || o.action)}${o.pledgeStatusNow ? `<div class="small muted">质押现态 ${o.pledgeStatusNow}</div>` : ''}</td>
    <td class="small">${esc(o.actorName || o.actorId || '—')}</td>
    <td class="mono small">${esc(o.receiptId || '—')}${o.pledgeId ? `<br>${esc(o.pledgeId)}` : ''}</td>
    <td>${outcomeBadge(o.outcome)}</td>
    <td>${o.reasonCode ? `<b>${esc(o.reasonCode)}</b><br>` : ''}<span class="small">${esc(o.reason || '—')}</span></td>
    <td>${opRefCell(o)}</td>
    <td class="chain-line">${esc(o.sessionId || '—')}${o.idempotencyKey ? `<br>${esc(o.idempotencyKey)}` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="muted">无匹配操作记录</td></tr>';
}
document.querySelectorAll('#op-receipt,#op-pledge,#op-actor,#op-session,#op-outcome,#op-action').forEach((el) => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadOperations(); });
});

function renderBatches() {
  const gradeName = (id) => (STATE.grades.find((g) => g.id === id) || {}).name || id;
  const tb = document.querySelector('#tbl-batch tbody');
  tb.innerHTML = STATE.valuationBatches.map((b) => `<tr>
    <td class="mono">${b.id}</td><td>${esc(b.note)}</td>
    <td class="small">${Object.entries(b.prices).map(([g, p]) => `${esc(gradeName(g))}:${fmtMoney(p)}`).join('<br>')}</td>
    <td class="small">${fmtTime(b.createdAt)}</td></tr>`).join('');
}

function renderAudit() {
  const a = STATE.audit;
  const overlap = document.getElementById('audit-overlap');
  overlap.innerHTML = `<b>① 物理区间重叠</b><div class="hr" style="margin:6px 0"></div>` +
    (a.overlaps.length
      ? `<div class="tag-bad">发现 ${a.overlaps.length} 处重叠</div>` + a.overlaps.map((o) => `<div class="small mono">${o.locationId}: ${o.a} ↔ ${o.b}</div>`).join('')
      : '<div class="tag-good">✔ 零重叠</div><div class="small muted">所有库位有效仓单区间两两不相交</div>');

  const dbl = document.getElementById('audit-double');
  dbl.innerHTML = `<b>② 重复融资(一单多质)</b><div class="hr" style="margin:6px 0"></div>` +
    (a.doubleFinancing.length
      ? `<div class="tag-bad">发现 ${a.doubleFinancing.length} 起</div>` + a.doubleFinancing.map((d) => `<div class="small mono">${d.receiptId}: ${d.pledges.join(', ')}</div>`).join('')
      : '<div class="tag-good">✔ 无一单多质</div><div class="small muted">每份仓单至多一笔存续质押</div>');

  const claim = document.getElementById('audit-claim');
  claim.innerHTML = `<b>③ 未登记即宣称生效</b><div class="hr" style="margin:6px 0"></div>` +
    (a.prematureClaims.length
      ? `<div class="tag-bad">发现 ${a.prematureClaims.length} 起</div>` + a.prematureClaims.map((x) => `<div class="small mono">${x.pledgeId} @ ${x.receiptId}</div>`).join('')
      : '<div class="tag-good">✔ 无提前宣称</div><div class="small muted">所有可对外主张的担保均已登记</div>');
}

function renderReceipts() {
  const q = (document.getElementById('filter').value || '').trim().toLowerCase();
  const rows = STATE.receipts.filter((r) => {
    if (!q) return true;
    return [r.id, r.locationName, r.holderName, r.gradeName].some((x) => String(x).toLowerCase().includes(q));
  });
  const tb = document.querySelector('#tbl tbody');
  tb.innerHTML = rows.map((r) => {
    const p = r.activePledge;
    const fin = p
      ? `${esc(p.financerId)}${p.registrationNo ? `<div class="small mono">${esc(p.registrationNo)}</div>` : '<div class="small" style="color:#b45309">未登记·不生效</div>'}`
      : '<span class="muted">—</span>';
    return `<tr>
      <td><b>${r.id}</b></td><td>${esc(r.locationId)}</td>
      <td><span class="interval">[${fmtNum(r.startQty)},${fmtNum(r.endQty)})</span></td>
      <td>${esc(r.gradeName)}</td><td>${fmtNum(r.qty)}</td><td>v${r.version}</td>
      <td>${badge(r.status)}</td><td>${esc(r.holderName)}</td><td>${fin}</td>
      <td><button class="ghost" onclick="lineage('${r.id}')">谱系 / 时间线</button></td>
    </tr>`;
  }).join('');
}

function renderEvents() {
  const tb = document.querySelector('#tbl-events tbody');
  const evs = [...STATE.events].reverse();
  tb.innerHTML = evs.map((e) => `<tr>
    <td>${e.seq}</td><td class="small">${fmtTime(e.ts)}</td>
    <td>${EVENT_CN[e.type] || e.type}</td>
    <td class="mono small">${e.receiptId || ''}</td><td class="mono small">${e.pledgeId || ''}</td>
    <td class="small">${e.actorId || ''}</td>
    <td class="chain-line">${esc(JSON.stringify(e.payload))}</td>
    <td class="chain-line">${shortHash(e.hash, 12)}</td>
  </tr>`).join('');
}

window.lineage = async (id) => {
  const res = await fetch('/api/receipt?id=' + id);
  const json = await res.json();
  if (!json.ok) return toast(json.error.message, 'error');
  const { lineage, events, operations } = json.data;
  const byDepth = {};
  lineage.nodes.forEach((n) => ((byDepth[n.depth] ||= []).push(n)));
  const cols = Object.keys(byDepth).sort((a, b) => b - a)
    .map((d) => `<div class="scenario" style="min-width:160px"><b>第 ${Number(d) + 1} 代</b><div class="hr" style="margin:6px 0"></div>
      ${byDepth[d].map((n) => `<div class="mono">${n.id} v${n.version}<br><span class="muted">${fmtNum(n.qty)}吨 ${n.status}</span></div>`).join('<div style="height:8px"></div>')}</div>`)
    .join('<div style="display:flex;align-items:center;color:#94a3b8">→</div>');
  const opRows = (operations || []).map((o) => `<li>
      <div class="ev-type">${o.seq}. ${esc(ACTION_CN[o.action] || o.action)} ${outcomeBadge(o.outcome)}
        <span class="muted small">#${esc(o.id)}</span></div>
      <div class="ev-meta">${fmtTime(o.at)} · 主体 ${esc(o.actorName || o.actorId || '系统')}${o.pledgeId ? ' · ' + o.pledgeId : ''}${o.sessionId ? ' · 会话 ' + esc(o.sessionId) : ''}</div>
      ${o.reasonCode ? `<div class="small"><b>${esc(o.reasonCode)}</b>:${esc(o.reason || '')}</div>` : ''}
      ${o.ref && o.ref.registrationNo ? `<div class="small tag-good">登记回执号:${esc(o.ref.registrationNo)} @ ${fmtTime(o.ref.registeredAt)}(仓单 v${o.ref.receiptVersion})</div>` : ''}
      ${o.ref && o.ref.token ? `<div class="small tag-good">放行令牌:${esc(o.ref.token)}(${esc(o.ref.releaseId)},${fmtNum(o.ref.qty)} 吨,余 ${fmtNum(o.ref.remaining)} 吨)</div>` : ''}
    </li>`).join('');
  openModal(`
    <h2>权属穿透 · ${id}</h2>
    <div style="display:flex;gap:8px;align-items:stretch;overflow:auto">${cols}</div>
    <h3>融资方操作回放(严格按发生顺序,含登记回执号与放行令牌)</h3>
    <ul class="timeline">${opRows || '<li class="muted small">该仓单暂无融资方操作</li>'}</ul>
    <h3>不可抵赖权利链事件</h3>
    <ul class="timeline">
      ${events.map((e) => `<li>
        <div class="ev-type">${EVENT_CN[e.type] || e.type} <span class="muted small">#${e.seq}</span></div>
        <div class="ev-meta">${fmtTime(e.ts)} · 主体 ${e.actorId || '系统'}${e.pledgeId ? ' · ' + e.pledgeId : ''}</div>
        <div class="chain-line">payload ${esc(JSON.stringify(e.payload))}</div>
        <div class="chain-line">hash ${e.hash}<br>prev ${e.prevHash}</div>
      </li>`).join('')}
    </ul>`);
};

window.verify = async () => {
  await load();
  toast(STATE.audit.chain.ok ? '权利链验签通过' : '权利链异常', STATE.audit.chain.ok ? 'success' : 'error');
};

window.showChainTail = () => {
  const ev = STATE.events[STATE.events.length - 1];
  openModal(`<h2>链尾事件 #${ev.seq}</h2>
    <dl class="kv">
      <dt>类型</dt><dd>${EVENT_CN[ev.type] || ev.type}</dd>
      <dt>hash</dt><dd class="chain-line">${ev.hash}</dd>
      <dt>prevHash</dt><dd class="chain-line">${ev.prevHash}</dd>
    </dl>`);
};

window.newBatch = async () => {
  const prices = {};
  STATE.grades.forEach((g) => { prices[g.id] = g.basePrice; });
  try {
    const b = await api('/api/valuation-batch', {
      actorId: 'REG-1',
      note: document.getElementById('vb-note').value || '监管发布价格快照',
      prices
    });
    toast('新估值批次已发布:' + b.id + '。已存续质押仍锁定原批次,新质押可选用。', 'success', 6000);
    document.getElementById('vb-note').value = '';
    load();
  } catch (e) { toast(e.message, 'error'); }
};

document.getElementById('filter').addEventListener('input', renderReceipts);
load();
