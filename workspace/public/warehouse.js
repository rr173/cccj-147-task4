/* warehouse.js —— 仓库端交互 */
'use strict';
const { api, getState, toast, badge, fmtTime, fmtNum, fmtMoney, esc, openModal, renderTopbar } = EWR;

let STATE = null;
let mergeIds = [];

document.getElementById('topbar').innerHTML = renderTopbar('wh');

async function refresh() {
  STATE = await getState();
  renderStats();
  renderOptions();
  renderReceipts();
  renderInspections();
  renderDeliveries();
}

function renderStats() {
  const a = STATE.audit;
  const html = [
    ['有效仓单', a.counts.validReceipts, '份'],
    ['在质仓单', a.counts.activePledges, '笔'],
    ['待补担保', a.counts.supplements, '项']
  ].map(([lbl, num, u]) => `
    <div class="card stat"><span class="num">${num}</span><span class="lbl">${lbl}(${u})</span></div>`).join('');
  document.getElementById('stats').innerHTML = html;
}

function renderOptions() {
  const locSel = document.getElementById('f-loc');
  if (!locSel.dataset.init) {
    locSel.innerHTML = STATE.locations.map((l) => {
      const c = STATE.commodities.find((x) => x.id === l.commodityId);
      return `<option value="${l.id}">${esc(l.name)} · 容量 ${l.capacity} 吨 · ${esc(c.name)}</option>`;
    }).join('');
    locSel.dataset.init = '1';
    locSel.addEventListener('change', syncGradeOptions);
  }
  const holderSel = document.getElementById('f-holder');
  if (!holderSel.dataset.init) {
    holderSel.innerHTML = STATE.parties.filter((p) => p.type === 'enterprise')
      .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    holderSel.dataset.init = '1';
  }
  syncGradeOptions();
}

function syncGradeOptions() {
  const locId = document.getElementById('f-loc').value;
  const loc = STATE.locations.find((l) => l.id === locId);
  const sel = document.getElementById('f-grade');
  const grades = STATE.grades.filter((g) => g.commodityId === loc.commodityId);
  sel.innerHTML = grades.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
}

function renderReceipts() {
  const tb = document.querySelector('#tbl-receipts tbody');
  const rows = [...STATE.receipts].sort((a, b) => a.id.localeCompare(b.id));
  tb.innerHTML = rows.map((r) => {
    const inMerge = mergeIds.includes(r.id);
    const pledgeCell = r.activePledge
      ? `${badge(r.activePledge.status === 'SUPPLEMENTING' ? 'SUPPLEMENTING' : r.activePledge.registrationNo ? 'REGISTERED' : 'LOCKED')}
         <div class="small muted">${esc(r.activePledge.financerId)}</div>
         ${r.activePledge.registrationNo ? '' : '<div class="small" style="color:#b45309">登记前·不得宣称生效</div>'}`
      : '<span class="muted small">无质押</span>';
    return `<tr>
      <td><b>${r.id}</b><div class="small muted">检验批 ${r.inspectionBatchId}</div></td>
      <td>${esc(r.locationName)}</td>
      <td>${esc(r.gradeName)}</td>
      <td>${esc(r.holderName)}</td>
      <td><span class="interval">[${fmtNum(r.startQty)}, ${fmtNum(r.endQty)})</span><div class="small muted">${fmtNum(r.qty)} 吨</div></td>
      <td>v${r.version}</td>
      <td>${badge(r.status)}</td>
      <td>${fmtMoney(r.marketValue)}</td>
      <td>${pledgeCell}</td>
      <td><div class="row-actions">
        <button onclick="askSplit('${r.id}')" ${r.status !== 'ACTIVE' && r.status !== 'DELIVERED_PARTIAL' ? 'disabled' : ''}>拆分</button>
        <button onclick="toggleMerge('${r.id}')" class="${inMerge ? 'primary' : ''}" ${r.status !== 'ACTIVE' ? 'disabled' : ''}>${inMerge ? '✓ 已选合并' : '加入合并'}</button>
        <button class="danger" onclick="askRecheck('${r.id}')" ${r.status !== 'ACTIVE' && r.status !== 'DELIVERED_PARTIAL' ? 'disabled' : ''}>复检降档/减量</button>
        <button onclick="askDeliver('${r.id}')" ${r.status !== 'ACTIVE' && r.status !== 'DELIVERED_PARTIAL' ? 'disabled' : ''}>出库</button>
        <button class="ghost" onclick="showLineage('${r.id}')">权利链</button>
      </div></td>
    </tr>`;
  }).join('');
  const m = document.getElementById('merge-sel');
  m.innerHTML = mergeIds.length
    ? mergeIds.map((id) => `<span class="badge blue">${id}</span>`).join(' ')
    : '尚未选择仓单(在下方列表点「加入合并」)';
}

function renderInspections() {
  const tb = document.querySelector('#tbl-ib tbody');
  const gradeName = (id) => (STATE.grades.find((g) => g.id === id) || {}).name || id;
  // 检验批通过登记/复检/合并事件还原摘要
  const evs = STATE.events.filter((e) => e.type === 'RECEIPT_REGISTERED' || e.type === 'RECEIPT_RECHECKED' || e.type === 'RECEIPT_MERGE');
  const rows = evs.map((e) => {
    if (e.type === 'RECEIPT_REGISTERED')
      return { id: e.payload.inspectionBatchId, kind: '初检', receipt: e.receiptId, grade: gradeName(e.payload.gradeId), qty: e.payload.qty, ts: e.ts };
    if (e.type === 'RECEIPT_RECHECKED')
      return { id: `复检#${e.seq}`, kind: '复检', receipt: e.receiptId, grade: gradeName(e.payload.newGradeId), qty: e.payload.newQty, ts: e.ts };
    return { id: `合并#${e.seq}`, kind: '合并', receipt: e.payload.mergedId, grade: '—', qty: null, ts: e.ts };
  });
  tb.innerHTML = rows.map((x) => `<tr><td>${x.id}</td><td>${x.kind}</td><td>${x.receipt}</td><td>${esc(x.grade)}</td><td>${x.qty == null ? '—' : fmtNum(x.qty)}</td><td class="small">${fmtTime(x.ts)}</td></tr>`).join('');
}

function renderDeliveries() {
  const tb = document.querySelector('#tbl-dl tbody');
  tb.innerHTML = STATE.deliveries.map((d) => `<tr>
    <td>${d.id}</td><td>${d.receiptId}</td><td>${fmtNum(d.qty)} 吨</td>
    <td>${d.releaseId ? `<span class="badge green">${d.releaseId}</span>` : '<span class="muted">无质押直出</span>'}</td>
    <td class="small">${fmtTime(d.at)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">暂无出库</td></tr>';

  const tr = document.querySelector('#tbl-rl tbody');
  tr.innerHTML = STATE.releases.map((r) => `<tr>
    <td>${r.id}</td><td>${r.receiptId}</td><td>${r.financerId}</td><td>${fmtNum(r.qty)} 吨</td>
    <td class="mono">${r.token}${r.consumed ? ' <span class="badge gray">已用罄</span>' : ''}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">暂无放行单</td></tr>';
}

/* ------------------------------- 操作 ------------------------------- */
document.getElementById('btn-register').onclick = async () => {
  try {
    const startRaw = document.getElementById('f-start').value;
    const data = await api('/api/receipts/register', {
      actorId: 'WH-1',
      locationId: document.getElementById('f-loc').value,
      gradeId: document.getElementById('f-grade').value,
      holderId: document.getElementById('f-holder').value,
      qty: Number(document.getElementById('f-qty').value),
      startQty: startRaw === '' ? null : Number(startRaw)
    });
    toast(`仓单登记成功:${data.id}  区间 [${fmtNum(data.startQty)}, ${fmtNum(data.endQty)}) v1`, 'success');
    document.getElementById('f-qty').value = '';
    document.getElementById('f-start').value = '';
    refresh();
  } catch (e) { toast(`登记失败:${e.message}`, 'error', 6000); }
};

window.toggleMerge = (id) => {
  const i = mergeIds.indexOf(id);
  if (i >= 0) mergeIds.splice(i, 1);
  else mergeIds.push(id);
  renderReceipts();
};
document.getElementById('btn-merge-clear').onclick = () => { mergeIds = []; renderReceipts(); };
document.getElementById('btn-merge').onclick = async () => {
  if (mergeIds.length < 2) return toast('请至少选择两份仓单', 'error');
  try {
    const m = await api('/api/receipts/merge', { actorId: 'WH-1', receiptIds: mergeIds });
    toast(`合并成功,新仓单 ${m.id} 区间 [${fmtNum(m.startQty)}, ${fmtNum(m.endQty)})`, 'success');
    mergeIds = [];
    refresh();
  } catch (e) { toast(`合并失败:${e.message}`, 'error', 6000); }
};

window.askSplit = (id) => {
  const r = STATE.receipts.find((x) => x.id === id);
  openModal(`
    <h2>拆分仓单 ${id}</h2>
    <p class="small muted">当前数量 <b>${fmtNum(r.qty)}</b> 吨,区间 <span class="interval">[${fmtNum(r.startQty)},${fmtNum(r.endQty)})</span>。
    输入各份数量(逗号分隔),之和必须等于原数量。已质押仓单不得拆分。</p>
    <label class="fld">拆分数量(吨,逗号分隔)
      <input id="sp-parts" value="${(r.qty / 2).toFixed(3)},${(r.qty / 2).toFixed(3)}">
    </label>
    <div class="hr"></div>
    <div class="row-actions">
      <button class="primary" onclick="doSplit('${id}', false)">执行拆分</button>
      <button class="danger" onclick="doSplit('${id}', true)">⚠ 模拟拆分中途故障</button>
      <button onclick="closeModal()">取消</button>
    </div>
    <p class="small" style="color:#b91c1c;margin-top:10px">「中途故障」会在子单生成后、源单失效前抛错,事务整体回滚 —— 用于证明不会留下半截仓单。</p>`);
};
window.doSplit = async (id, crash) => {
  try {
    const parts = document.getElementById('sp-parts').value.split(',').map((s) => Number(s.trim()));
    const data = await api('/api/receipts/split', { actorId: 'WH-1', receiptId: id, parts, simulateCrash: crash });
    toast(`拆分成功:${id} → ${data.children.map((c) => c.id).join('、')}`, 'success');
    closeModal();
    refresh();
  } catch (e) {
    toast(`${crash ? '模拟故障已被事务拦截' : '拆分失败'}:${e.message}`, 'error', 6500);
    if (crash) { closeModal(); refresh(); }
  }
};

window.askRecheck = (id) => {
  const r = STATE.receipts.find((x) => x.id === id);
  const grades = STATE.grades.filter((g) => g.commodityId === r.commodityId);
  openModal(`
    <h2>复检仓单 ${id} <span class="small muted">(当前 v${r.version} · ${fmtNum(r.qty)} 吨 · ${esc(r.gradeName)})</span></h2>
    <div class="form-row">
      <label class="fld">复检后品级
        <select id="rc-grade">${grades.map((g) => `<option value="${g.id}" ${g.id === r.gradeId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
      </label>
      <label class="fld">复检后数量(吨,不得增加)
        <input id="rc-qty" type="number" step="0.001" value="${r.qty}">
      </label>
    </div>
    <div class="hr"></div>
    <div class="row-actions">
      <button class="danger" onclick="doRecheck('${id}')">提交复检结论</button>
      <button onclick="closeModal()">取消</button>
    </div>
    <p class="small muted" style="margin-top:10px">复检只重估本单在质融资;担保不足时转为「需补充担保」,<b>原质押与登记关系保留</b>。</p>`);
};
window.doRecheck = async (id) => {
  try {
    const data = await api('/api/receipts/recheck', {
      actorId: 'WH-1',
      receiptId: id,
      newGradeId: document.getElementById('rc-grade').value,
      newQty: Number(document.getElementById('rc-qty').value)
    });
    const sup = data.supplements.length
      ? `\n已生成补充担保要求 ${data.supplements.map((x) => x.id).join('、')},缺口 ${fmtMoney(data.supplements[0].shortfall)}`
      : '';
    toast(`复检完成:${id} 升至 v${data.receipt.version},数量 ${fmtNum(data.receipt.endQty - data.receipt.startQty)} 吨,重估质押 ${data.revaluations.length} 笔${sup}`, data.supplements.length ? 'error' : 'success', 6500);
    closeModal();
    refresh();
  } catch (e) { toast(`复检失败:${e.message}`, 'error', 6500); }
};

window.askDeliver = (id) => {
  const r = STATE.receipts.find((x) => x.id === id);
  openModal(`
    <h2>货物出库 · ${id}</h2>
    <p class="small">在库 ${fmtNum(r.qty)} 吨。
    ${r.activePledge
      ? `该单存在质押 <b>${r.activePledge.id}</b>(质权人 ${r.activePledge.financerId}),必须粘贴其在融资方端签发的<b>放行令牌</b>。`
      : '该单无有效质押,可直接出库。'}</p>
    <div class="form-row">
      <label class="fld">出库数量(吨)<input id="dl-qty" type="number" step="0.001" value="${r.qty}"></label>
      <label class="fld">质权人放行令牌${r.activePledge ? '' : '(无需)'}<input id="dl-token" placeholder="${r.activePledge ? 'TKN-XXXX-XXXXXXXX' : '无质押免填'}"></label>
    </div>
    <div class="hr"></div>
    <div class="row-actions">
      <button class="primary" onclick="doDeliver('${id}')">办理出库</button>
      <button onclick="closeModal()">取消</button>
    </div>`);
};
window.doDeliver = async (id) => {
  try {
    const data = await api('/api/receipts/deliver', {
      actorId: 'WH-1',
      receiptId: id,
      qty: Number(document.getElementById('dl-qty').value),
      releaseToken: document.getElementById('dl-token').value.trim() || null
    });
    toast(`出库成功:${data.delivery.id},${fmtNum(data.delivery.qty)} 吨${data.usedRelease ? `,核销放行单 ${data.usedRelease}` : ''}`, 'success');
    closeModal();
    refresh();
  } catch (e) {
    toast(`出库被拒:${e.message}`, 'error', 6500);
    if (e.code === 'NO_RELEASE' || e.code === 'RELEASE_FROM_WRONG_HOLDER') closeModal();
  }
};

window.showLineage = async (id) => {
  const res = await fetch('/api/receipt?id=' + id);
  const json = await res.json();
  if (!json.ok) return toast(json.error.message, 'error');
  const { lineage, events } = json.data;
  const byDepth = {};
  lineage.nodes.forEach((n) => ((byDepth[n.depth] ||= []).push(n)));
  const cols = Object.keys(byDepth).sort((a, b) => b - a)
    .map((d) => `<div class="scenario" style="min-width:170px"><b>第 ${Number(d) + 1} 代</b><div class="hr" style="margin:6px 0"></div>
      ${byDepth[d].map((n) => `<div class="mono">${n.id} v${n.version}<br><span class="muted">${fmtNum(n.qty)}吨 ${n.status}</span></div>`).join('<div style="height:8px"></div>')}</div>`)
    .join('<div style="display:flex;align-items:center;color:#94a3b8">→</div>');
  openModal(`
    <h2>权利链与派生谱系 · ${id}</h2>
    <div style="display:flex;gap:8px;align-items:stretch;overflow:auto;padding-bottom:6px">${cols}</div>
    <h3>事件时间线(append-only · SHA-256 哈希链)</h3>
    <ul class="timeline">
      ${events.map((e) => `<li>
        <div class="ev-type">${eventName(e.type)}</div>
        <div class="ev-meta">#${e.seq} · ${fmtTime(e.ts)} · ${e.actorId || '系统'}${e.pledgeId ? ' · ' + e.pledgeId : ''}</div>
        <div class="chain-line">hash ${EWR.shortHash(e.hash, 18)}…<br>prev ${EWR.shortHash(e.prevHash, 18)}</div>
      </li>`).join('')}
    </ul>`);
};

function eventName(t) {
  return {
    RECEIPT_REGISTERED: '仓单登记', RECEIPT_SPLIT: '仓单拆分', RECEIPT_DERIVED: '派生子单',
    RECEIPT_MERGE: '仓单合并', RECEIPT_RECHECKED: '仓库复检', GOODS_DELIVERED: '货物出库',
    PLEDGE_LOCKED: '质押锁定', PLEDGE_CANCELLED: '质押撤回', PLEDGE_REGISTERED: '质押登记(担保生效)',
    PLEDGE_REVALUED: '担保重估', SUPPLEMENT_REQUESTED: '发起补充担保', COLLATERAL_SUPPLEMENTED: '补充担保到账',
    LOAN_REPAID: '偿还融资', RELEASE_GRANTED: '质权人放行', PLEDGE_CLOSED: '担保结清归档',
    VALUATION_BATCH_CREATED: '估值批次发布'
  }[t] || t;
}

document.getElementById('btn-refresh').onclick = refresh;
document.getElementById('btn-reset').onclick = async () => {
  if (!confirm('确定重置全部演示数据?')) return;
  await api('/api/admin/reset', {});
  mergeIds = [];
  toast('演示数据已重置', 'success');
  refresh();
};

refresh();
