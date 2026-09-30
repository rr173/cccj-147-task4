/* financier.js —— 融资方端(金融机构 / 出质企业工作台)
 *
 * 可恢复操作会话:
 *  - sessionId 存 localStorage,每个写请求带 sessionId,服务端逐步留痕;
 *  - 提交前先把请求(含幂等键)登记为本地 PENDING 草稿:
 *      锁仓 reqId / 登记回执号 / 放行 reqId 均在发送前生成并持久化;
 *  - 刷新页面或服务重启后,/api/session 从落盘状态重建台账、步骤与原始回执,
 *    再用同一幂等键核对 PENDING 草稿;服务端已受理则展示其真实结果(成功/冲突/拒绝),
 *    确认未到达时只能以「同一幂等键」重发,任何路径都不会产生第二笔质押/登记/放行。
 */
'use strict';
const {
  api, getState, getJson, toast, badge, outcomeBadge, fmtTime, fmtNum, fmtMoney, esc,
  genRegNo, genReqId, openModal, renderTopbar,
  getSessionId, newSessionId, loadDrafts, saveDrafts
} = EWR;

let STATE = null;
let SESSION = null;
let sessionId = getSessionId();
let stepFilter = 'all';

document.getElementById('topbar').innerHTML = renderTopbar('fin');

const ACTION_CN = { lock: '锁仓', register: '质押登记', cancel: '撤回锁定', supplement: '补充担保', repay: '还款', release: '质权人放行' };
const IDEMPOTENCY_FIELDS = { lock: 'reqId', register: 'registrationNo', release: 'reqId' };

async function refresh(showToast = false) {
  STATE = await getState();
  SESSION = await getJson('/api/session?sessionId=' + encodeURIComponent(sessionId));
  await reconcileDrafts(showToast);
  renderForms();
  renderSession();
  renderSteps();
  renderPledges();
  renderSupplements();
  renderReleases();
  renderScenarioSelects();
}

/* ----------------------- PENDING 草稿核对(刷新/重启恢复) ----------------------- */
async function reconcileDrafts(announce) {
  const drafts = loadDrafts().filter((d) => d.sessionId === sessionId);
  const keep = [];
  let confirmed = 0;
  for (const d of drafts) {
    const hit = d.idempotencyKey
      ? SESSION.steps.find((s) => s.idempotencyKey === d.idempotencyKey)
      : inferKeylessStep(d);
    if (hit) {
      confirmed += 1;
      continue; // 服务端已有权威结论,本地草稿退役,结果在操作步骤中展示
    }
    keep.push(d);
  }
  const others = loadDrafts().filter((d) => d.sessionId !== sessionId);
  if (confirmed || keep.length !== drafts.length) {
    saveDrafts([...others, ...keep]);
    if (announce && confirmed) toast(`重建完成:已从服务端确认 ${confirmed} 个在途步骤的真实结果`, 'success');
  } else if (announce) {
    toast(keep.length ? `会话已重建,仍有 ${keep.length} 个待确认请求未在服务端查到记录(可同键重发)` : '会话已从服务端重建', 'info');
  }
}

/** repay/supplement/cancel 无幂等键:用台账状态判断之前的提交是否已生效,绝不自动补发 */
function inferKeylessStep(d) {
  const p = SESSION.ledger.pledges.find((x) => x.id === d.pledgeId);
  if (!p) return false;
  if (d.action === 'cancel') return p.status === 'CANCELLED';
  if (d.action === 'repay' || d.action === 'supplement') return (p.coveredAmount || 0) > (d.beforeCovered || 0) + 1e-6;
  return false;
}

function currentDrafts() {
  return loadDrafts().filter((d) => d.sessionId === sessionId);
}

/** 统一执行一个质押操作步骤:登记草稿 → 请求 → 按响应决定草稿去向 */
async function runStep(action, path, body, opts = {}) {
  const keyField = IDEMPOTENCY_FIELDS[action];
  if (keyField && body[keyField] == null) body[keyField] = action === 'register' ? genRegNo() : genReqId(action === 'lock' ? 'LOCK' : 'REL');
  const idempotencyKey = {
    lock: 'pledge-lock:' + body.reqId,
    register: 'register:' + body.registrationNo,
    release: 'release:' + body.reqId
  }[action] || null;
  body.sessionId = sessionId;

  const pledge = STATE.pledges.find((p) => p.id === body.pledgeId);
  const draft = {
    sessionId,
    action,
    label: ACTION_CN[action] || action,
    path,
    body,
    idempotencyKey,
    at: Date.now(),
    pledgeId: body.pledgeId || null,
    receiptId: body.receiptId || (pledge ? pledge.receiptId : null),
    beforeCovered: pledge ? pledge.coveredAmount || 0 : 0
  };
  saveDrafts([...loadDrafts(), draft]);
  renderSteps();
  renderSession();
  try {
    const data = await api(path, body);
    return data; // 成功或冲突(重放)都由服务端留痕;refresh 会用权威结果替换 PENDING 草稿
  } catch (e) {
    // 拿到了服务端响应(业务拒绝):失败留痕在服务端,本地草稿可退役;
    // 网络层错误(TypeError)说明响应未知,保留 PENDING 等待重建核对。
    if (e.code) {
      if (!opts.silent) toast(`步骤「${draft.label}」被${e.code === 'FORBIDDEN' ? '拒绝' : '判为冲突'}:${e.message}`, 'error', 7000);
    } else {
      toast(`步骤「${draft.label}」未收到服务端响应,已保留为待确认;请点「从服务端重建会话」核对`, 'error', 8000);
      throw e;
    }
    throw e;
  } finally {
    await refresh();
  }
}

window.resendDraft = async (at) => {
  const d = currentDrafts().find((x) => x.at === Number(at));
  if (!d) return;
  if (!d.idempotencyKey) { toast('该步骤无幂等键,为防重复请依据台账人工核对后重新发起', 'error'); return; }
  toast(`以同一幂等键重发「${d.label}」:服务端若已处理将返回原结果,不会产生第二笔`, 'info', 6000);
  try {
    const data = await api(d.path, d.body);
    const replayed = data.duplicated || data.replayed;
    toast(replayed ? '服务端返回首次的原始结果(识别为重放),状态未重复改变' : '重发成功,服务端已记录', 'success', 6000);
  } catch (e) {
    toast(`重发返回:${e.message}`, e.code ? 'error' : 'info', 7000);
  }
  refresh();
};
window.dismissDraft = (at) => {
  saveDrafts(loadDrafts().filter((x) => !(x.sessionId === sessionId && x.at === Number(at))));
  renderSteps();
  renderSession();
};

/* ------------------------------- 会话信息 ------------------------------- */
function renderSession() {
  const box = document.getElementById('session-box');
  const pending = currentDrafts();
  const c = SESSION.counts;
  box.innerHTML = `
    <dl class="kv">
      <dt>会话号</dt><dd class="mono">${esc(sessionId)}</dd>
      <dt>服务端重建时刻</dt><dd>${fmtTime(SESSION.rebuiltAt)} · 链头 <span class="chain-line">${esc(String(SESSION.chainHead).slice(0, 24))}…</span></dd>
      <dt>台账</dt><dd>质押 <b>${SESSION.ledger.pledges.length}</b> 笔 · 放行单 <b>${SESSION.ledger.releases.length}</b> 张 · 补充要求 <b>${SESSION.ledger.supplements.length}</b> 条</dd>
      <dt>步骤结论</dt><dd>${outcomeBadge('SUCCESS')} ${c.success} · ${outcomeBadge('CONFLICT')} ${c.conflict} · ${outcomeBadge('REJECTED')} ${c.rejected} · ${outcomeBadge('PENDING')} ${pending.length}</dd>
    </dl>
    ${pending.length ? `<div class="banner warn" style="margin-top:10px">有 <b>${pending.length}</b> 个步骤未收到服务端确认。已用幂等键自动核对;核对不到的步骤只能「同键重发」,不会生成第二笔质押/登记/放行。</div>` : ''}`;
}

window.copySessionId = () => {
  navigator.clipboard?.writeText(sessionId);
  toast('会话号已复制', 'success', 2000);
};
window.newSession = () => {
  if (!confirm('新建会话将切换工作台视图(历史步骤仍保留在服务端,可按会话号在审计页查询)。继续?')) return;
  sessionId = newSessionId();
  refresh(true);
};
window.reconcileSession = () => refresh(true);

document.querySelectorAll('#step-filters button').forEach((btn) => {
  btn.onclick = () => { stepFilter = btn.dataset.f; renderSteps(); };
});

/* ------------------------------- 操作步骤表 ------------------------------- */
function refSummary(step) {
  if (step.outcome !== 'SUCCESS' && step.outcome !== 'CONFLICT') {
    return `<span class="tag-bad">${esc(step.reasonCode || 'REJECTED')}</span> <span class="muted">${esc(step.reason || '')}</span>`;
  }
  const r = step.ref;
  if (!r) return esc(step.reason || '成功');
  if (r.registrationNo)
    return `<span class="tag-good">登记回执号 ${esc(r.registrationNo)}</span><div class="small muted">${esc(r.registrar || '登记中心')} @ ${fmtTime(r.registeredAt)} · 仓单 v${r.receiptVersion}</div>`;
  if (r.token)
    return `<span class="tag-good">放行令牌 ${esc(r.token)}</span><div class="small muted">${esc(r.releaseId)} · ${fmtNum(r.qty)} 吨 · 余 ${fmtNum(r.remaining)} 吨</div>`;
  if (step.action === 'lock')
    return `质押 ${esc(r.pledgeId)} · 锁定 v${r.receiptVersion} · 批次 ${esc(r.valuationBatchId)}`;
  if (r.status)
    return `质押 ${esc(r.pledgeId || step.pledgeId)} 状态 → ${badge(r.status)}${r.exposure != null ? ` · 敞口 ${fmtMoney(r.exposure)}` : ''}`;
  return '成功';
}

function renderSteps() {
  const tb = document.querySelector('#tbl-steps tbody');
  const draftRows = currentDrafts()
    .filter((d) => !d.idempotencyKey || !SESSION.steps.some((s) => s.idempotencyKey === d.idempotencyKey))
    .map((d) => ({ isDraft: true, ...d }));
  const rows = [
    ...SESSION.steps.map((s) => ({ isDraft: false, ...s })),
    ...draftRows.filter((d) => !d.idempotencyKey || !inferKeylessStep(d))
  ].sort((a, b) => a.at - b.at || a.seq - b.seq);

  const shown = rows.filter((r) => stepFilter === 'all' || (r.isDraft ? stepFilter === 'PENDING' : r.outcome === stepFilter));
  tb.innerHTML = shown.map((r, i) => {
    if (r.isDraft) {
      return `<tr style="background:#eff6ff">
        <td class="muted">…</td><td class="small">${fmtTime(r.at)}</td><td>${esc(r.label)}</td>
        <td>${esc(r.body.actorId || '')}</td><td class="mono small">${esc(r.receiptId || '')}${r.pledgeId ? '<br>' + esc(r.pledgeId) : ''}</td>
        <td>${outcomeBadge('PENDING')}</td>
        <td><span class="small muted">响应未知,等待与服务端核对</span>
          <div class="row-actions" style="margin-top:4px">
            ${r.idempotencyKey ? `<button class="primary" onclick="resendDraft(${r.at})">同键重发</button>` : `<button class="ghost" onclick="reconcileSession()">重新核对台账</button>`}
            <button class="ghost" onclick="dismissDraft(${r.at})">标记已人工核对</button>
          </div></td>
        <td class="chain-line">${esc(r.idempotencyKey || '(无幂等键,按台账核对)')}</td></tr>`;
    }
    return `<tr>
      <td>${r.seq}</td><td class="small">${fmtTime(r.at)}</td>
      <td>${esc(r.actionLabel)}<div class="small muted mono">#${esc(r.id)}</div></td>
      <td class="small">${esc(r.actorName || r.actorId || '')}</td>
      <td class="mono small">${esc(r.receiptId || '')}${r.pledgeId ? '<br>' + esc(r.pledgeId) : ''}</td>
      <td>${outcomeBadge(r.outcome)}${r.pledgeStatusNow ? `<div class="small muted">现态:${r.pledgeStatusNow}</div>` : ''}</td>
      <td>${refSummary(r)}</td>
      <td class="chain-line">${esc(r.idempotencyKey || '—')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">本会话暂无操作步骤</td></tr>';
}

function renderForms() {
  const fin = document.getElementById('p-fin');
  if (!fin.dataset.init) {
    fin.innerHTML = STATE.parties.filter((p) => p.type === 'financer')
      .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    fin.dataset.init = '1';
  }
  const batch = document.getElementById('p-batch');
  batch.innerHTML = STATE.valuationBatches
    .map((b) => `<option value="${b.id}">${b.id} · ${esc(b.note)} · ${fmtTime(b.createdAt)}</option>`).join('');
  const rc = document.getElementById('p-receipt');
  const valid = STATE.receipts.filter((r) => r.status === 'ACTIVE' || r.status === 'DELIVERED_PARTIAL');
  const prev = rc.value;
  rc.innerHTML = valid.map((r) => `<option value="${r.id}">${r.id} · ${esc(r.locationName)} · ${esc(r.gradeName)} · ${fmtNum(r.qty)}吨${r.activePledge ? ' · (已有质押)' : ''}</option>`).join('');
  if (prev && valid.some((r) => r.id === prev)) rc.value = prev;
}

function renderScenarioSelects() {
  const lockable = STATE.pledges.filter((p) => p.status === 'LOCKED');
  document.getElementById('stale-pledge').innerHTML = lockable.length
    ? lockable.map((p) => `<option value="${p.id}">${p.id} @ ${p.receiptId}(锁 v${p.receiptVersion},当前 v${p.receiptCurrentVersion})</option>`).join('')
    : '<option value="">(无 LOCKED 质押,请先发起质押且勿登记)</option>';
  document.getElementById('replay-pledge').innerHTML = lockable.length
    ? lockable.map((p) => `<option value="${p.id}">${p.id} @ ${p.receiptId}</option>`).join('')
    : '<option value="">(无 LOCKED 质押)</option>';
  const valid = STATE.receipts.filter((r) => r.status === 'ACTIVE' && !r.activePledge);
  document.getElementById('race-receipt').innerHTML = valid.length
    ? valid.map((r) => `<option value="${r.id}">${r.id} · ${fmtNum(r.qty)}吨 · 无质押</option>`).join('')
    : '<option value="">(无未质押仓单,可先重置数据)</option>';
}

function renderPledges() {
  const tb = document.querySelector('#tbl-pledges tbody');
  const rows = [...STATE.pledges].sort((a, b) => b.createdAt - a.createdAt);
  tb.innerHTML = rows.map((p) => {
    const stale = p.versionStale;
    const claimCell = p.canPubliclyClaimEffective
      ? '<div class="small tag-good">✓ 可对外主张担保生效</div>'
      : '<div class="small" style="color:#b45309">🔒 未登记,不得对外宣称生效</div>';
    return `<tr>
      <td><b>${p.id}</b>${p.registration ? `<div class="small muted mono">${esc(p.registration.registrationNo)}</div>` : ''}</td>
      <td>${p.receiptId}<div class="small ${stale ? 'tag-bad' : 'muted'}">锁 v${p.receiptVersion} / 当前 v${p.receiptCurrentVersion}${stale ? ' · 仓单已变更' : ''}</div></td>
      <td>${esc(nameOf(p.financerId))}<div class="small muted">出质:${esc(nameOf(p.pledgorId))}</div></td>
      <td>${fmtMoney(p.loanAmount)}<div class="small muted">率上限 ${Math.round(p.ltvCap / p.lockedValue * 100)}%</div></td>
      <td class="mono small">${p.valuationBatchId}</td>
      <td>${fmtMoney(p.currentValue)}${p.currentValue !== p.latestValue ? `<div class="small muted">最新批次 ${fmtMoney(p.latestValue)}</div>` : ''}</td>
      <td>${fmtMoney(p.exposure)}</td>
      <td>${badge(p.status)}${claimCell}</td>
      <td><div class="row-actions">
        ${p.status === 'LOCKED' ? `<button class="primary" onclick="askRegister('${p.id}')">登记</button>` : ''}
        ${p.status === 'LOCKED' ? `<button class="danger" onclick="cancelPledge('${p.id}')">撤回锁定</button>` : ''}
        ${['REGISTERED', 'SUPPLEMENTING', 'LOCKED'].includes(p.status) ? `<button onclick="askRepay('${p.id}')">还款</button>` : ''}
        ${['REGISTERED', 'SUPPLEMENTING'].includes(p.status) ? `<button onclick="askRelease('${p.id}')">放行出库</button>` : ''}
        ${p.status === 'SUPPLEMENTING' ? `<button class="danger" onclick="askSupplement('${p.id}')">补充担保</button>` : ''}
        <button class="ghost" onclick="showPledge('${p.id}')">详情</button>
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="muted">暂无质押</td></tr>';
}

function renderSupplements() {
  const tb = document.querySelector('#tbl-sup tbody');
  tb.innerHTML = STATE.supplements.map((s) => `<tr>
    <td>${s.id}</td><td>${s.pledgeId}</td><td>${fmtMoney(s.exposure)}</td>
    <td>${fmtMoney(s.collateralValue)}</td><td class="tag-bad">${fmtMoney(s.shortfall)}</td><td>${badge(s.status)}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无补充担保要求</td></tr>';
}

function renderReleases() {
  const tb = document.querySelector('#tbl-rl tbody');
  tb.innerHTML = STATE.releases.map((r) => `<tr>
    <td>${r.id}${r.consumed ? ' <span class="badge gray">已用罄</span>' : ' <span class="badge green">有效</span>'}</td>
    <td>${r.receiptId}</td><td>${fmtNum(r.qty)} 吨</td>
    <td class="mono">${r.token}<div class="small muted">余 ${fmtNum(Math.max(0, r.qty - (r.usedQty || 0)))} 吨</div></td>
  </tr>`).join('') || '<tr><td colspan="4" class="muted">暂未签发放行单</td></tr>';
}

function nameOf(id) {
  const p = STATE.parties.find((x) => x.id === id);
  return p ? p.name : id;
}

/* ------------------------------- 发起质押 ------------------------------- */
document.getElementById('btn-lock').onclick = async () => {
  const amount = Number(document.getElementById('p-amount').value);
  if (!(amount > 0)) return toast('请输入融资额', 'error');
  try {
    const data = await runStep('lock', '/api/pledges/lock', {
      reqId: genReqId('LOCK'),
      actorId: document.getElementById('p-fin').value,
      financerId: document.getElementById('p-fin').value,
      receiptId: document.getElementById('p-receipt').value,
      valuationBatchId: document.getElementById('p-batch').value,
      loanAmount: amount
    });
    if (data.duplicated) toast('检测到重复请求,返回既有锁定(未产生第二笔)', 'error', 6000);
    else toast(`质押已锁定 ${data.pledge.id}(内部状态,未登记前不得宣称生效)\n仓单版本 v${data.pledge.receiptVersion} · 批次 ${data.pledge.valuationBatchId} · 可贷 ${fmtMoney(data.pledge.ltvCap)}`, 'success', 6000);
    document.getElementById('p-amount').value = '';
  } catch (e) { /* runStep 已提示 */ }
};

/* ------------------------------- 登记 ------------------------------- */
window.askRegister = (id) => {
  const p = STATE.pledges.find((x) => x.id === id);
  openModal(`
    <h2>质押登记 · ${id}</h2>
    <dl class="kv">
      <dt>仓单</dt><dd>${p.receiptId}(登记将校验:锁定 v${p.receiptVersion} = 当前 v${p.receiptCurrentVersion})</dd>
      <dt>估值批次</dt><dd class="mono">${p.valuationBatchId}</dd>
      <dt>权利人</dt><dd>${esc(nameOf(p.financerId))}</dd>
      <dt>登记回执号</dt><dd><input id="reg-no" value="${genRegNo()}"></dd>
    </dl>
    <div class="hr"></div>
    <div class="row-actions">
      <button class="primary" onclick="doRegister('${id}', false)">提交登记(回执将去重)</button>
      <button class="danger" onclick="doRegister('${id}', true)">用旧版本号 v${Math.max(1, p.receiptCurrentVersion - 1)} 登记(演练晚到)</button>
      <button onclick="closeModal()">取消</button>
    </div>`);
};
window.doRegister = async (id, stale) => {
  const p = STATE.pledges.find((x) => x.id === id);
  const regNoInput = document.getElementById('reg-no').value.trim();
  if (!regNoInput) return toast('登记回执号必填', 'error');
  try {
    const data = await runStep('register', '/api/pledges/register', {
      actorId: p.financerId,
      pledgeId: id,
      registrationNo: regNoInput,
      expectedVersion: stale ? Math.max(1, p.receiptCurrentVersion - 1) : p.receiptCurrentVersion
    });
    if (data.replayed) toast(`⚠ 相同登记回执重放被识别:返回原登记结果 ${data.registration.registrationNo},未产生新担保`, 'error', 6500);
    else toast(`登记成功,担保物权自登记时生效:${data.registration.registrationNo}`, 'success');
    closeModal();
  } catch (e) {
    if (e.code === 'STALE_RECEIPT_VERSION') closeModal();
  }
};

window.cancelPledge = async (id) => {
  if (!confirm('撤回该笔锁定?')) return;
  try {
    await runStep('cancel', '/api/pledges/cancel', { pledgeId: id, actorId: null });
    toast('锁定已撤回,仓单恢复可处分', 'success');
  } catch (e) { /* 已提示 */ }
};

/* ------------------------------- 还款 / 补充 / 放行 ------------------------------- */
window.askRepay = (id) => {
  const p = STATE.pledges.find((x) => x.id === id);
  openModal(`
    <h2>偿还融资 · ${id}</h2>
    <p class="small">当前敞口 <b>${fmtMoney(p.exposure)}</b>。全额清偿后方可全量放行。</p>
    <label class="fld">还款金额(元)<input id="rp-amount" type="number" value="${p.exposure}"></label>
    <div class="hr"></div>
    <button class="primary" onclick="doRepay('${id}')">确认还款</button>`);
};
window.doRepay = async (id) => {
  try {
    const p0 = STATE.pledges.find((x) => x.id === id);
    const p = await runStep('repay', '/api/pledges/repay', {
      pledgeId: id, actorId: p0.pledgorId, amount: Number(document.getElementById('rp-amount').value)
    });
    toast(`还款已记录,剩余敞口 ${fmtMoney(p.exposure)}${p.exposure === 0 ? ',已具备全额放行条件' : ''}`, 'success');
    closeModal();
  } catch (e) { /* 已提示 */ }
};

window.askSupplement = (id) => {
  const p = STATE.pledges.find((x) => x.id === id);
  const gap = Math.max(0, p.exposure - p.currentValue);
  openModal(`
    <h2>补充担保 · ${id}</h2>
    <p class="small">复检后担保值 ${fmtMoney(p.currentValue)} &lt; 敞口 ${fmtMoney(p.exposure)},缺口 <b class="tag-bad">${fmtMoney(gap)}</b>。
    原质押保持有效,补足缺口或追加保证金后状态恢复。</p>
    <label class="fld">追加金额(元)<input id="sp-amount" type="number" value="${Math.max(0, Math.ceil(gap))}"></label>
    <div class="hr"></div>
    <button class="primary" onclick="doSupplement('${id}')">提交补充</button>`);
};
window.doSupplement = async (id) => {
  try {
    const p0 = STATE.pledges.find((x) => x.id === id);
    const p = await runStep('supplement', '/api/pledges/supplement', {
      pledgeId: id, actorId: p0.pledgorId, amount: Number(document.getElementById('sp-amount').value)
    });
    toast(`补充到账,质押状态:${p.status}`, p.status === 'REGISTERED' ? 'success' : 'error');
    closeModal();
  } catch (e) { /* 已提示 */ }
};

window.askRelease = (id) => {
  const p = STATE.pledges.find((x) => x.id === id);
  const r = STATE.receipts.find((x) => x.id === p.receiptId);
  openModal(`
    <h2>质权人放行 · ${id}</h2>
    <dl class="kv">
      <dt>质权人</dt><dd>${esc(nameOf(p.financerId))}</dd>
      <dt>仓单</dt><dd>${p.receiptId} · 在库 ${fmtNum(r.qty)} 吨</dd>
      <dt>剩余敞口</dt><dd>${fmtMoney(p.exposure)}${p.exposure === 0 ? '(已清偿,可全量放行)' : '(未清偿,仅可部分放行)'}</dd>
    </dl>
    <label class="fld">放行数量(吨,已清偿时可留空=全量)<input id="rl-qty" type="number" step="0.001"></label>
    <div class="hr"></div>
    <button class="primary" onclick="doRelease('${id}')">签发放行单</button>`);
};
window.doRelease = async (id) => {
  const p = STATE.pledges.find((x) => x.id === id);
  const v = document.getElementById('rl-qty').value;
  try {
    const data = await runStep('release', '/api/pledges/release', {
      reqId: genReqId('REL'),
      actorId: p.financerId,
      pledgeId: id,
      qty: v === '' ? null : Number(v)
    });
    if (data.replayed) { toast('重复放行请求,返回原放行单与原令牌(幂等)', 'error', 6500); closeModal(); return; }
    toast(`放行单已签发 ${data.release.id}\n令牌:${data.release.token}\n请将令牌交仓库端办理出库`, 'success', 8000);
    closeModal();
  } catch (e) { /* 已提示 */ }
};

window.showPledge = (id) => {
  const p = STATE.pledges.find((x) => x.id === id);
  openModal(`
    <h2>质押详情 ${id}</h2>
    <dl class="kv">
      <dt>状态</dt><dd>${badge(p.status)}</dd>
      <dt>仓单版本锁定</dt><dd>v${p.receiptVersion} → 当前 v${p.receiptCurrentVersion} ${p.versionStale ? '<span class="tag-bad">(已发生复检/出库)</span>' : ''}</dd>
      <dt>估值批次锁定</dt><dd class="mono">${p.valuationBatchId}</dd>
      <dt>锁定时担保值</dt><dd>${fmtMoney(p.lockedValue)}</dd>
      <dt>当前担保值</dt><dd>${fmtMoney(p.currentValue)}(重估 ${p.revaluationCount || 0} 次)</dd>
      <dt>融资额 / 已覆盖</dt><dd>${fmtMoney(p.loanAmount)} / ${fmtMoney(p.coveredAmount)}</dd>
      <dt>登记回执</dt><dd class="mono">${p.registration ? esc(p.registration.registrationNo) + ' @ ' + fmtTime(p.registration.registeredAt) : '— 未登记 —'}</dd>
      <dt>对外效力</dt><dd>${p.canPubliclyClaimEffective ? '<span class="tag-good">登记生效,可对外主张</span>' : '<span style="color:#b45309">未登记,不得宣称担保生效</span>'}</dd>
    </dl>`);
};

/* ------------------------------- 对抗演练 ------------------------------- */
// ① 并发:同一微任务内同时发出两个 POST(各自独立 reqId 与 PENDING 草稿),
//    服务端 FIFO 串行执行,第二家必被拒并留下 CONFLICT 留痕。
window.scenarioRace = async () => {
  const receiptId = document.getElementById('race-receipt').value;
  if (!receiptId) return;
  toast('两家机构对 ' + receiptId + ' 同时发起质押…', 'info');
  const payload = (fin) => ({
    reqId: genReqId('LOCK'),
    actorId: fin, financerId: fin, receiptId,
    valuationBatchId: STATE.valuationBatches[0].id,
    loanAmount: 100000,
    sessionId
  });
  const [a, b] = await Promise.allSettled([
    api('/api/pledges/lock', payload('FIN-ICBC')),
    api('/api/pledges/lock', payload('FIN-CMB'))
  ]);
  const winner = a.status === 'fulfilled' ? '鼎信银行' : '远航银行';
  const loser = a.status === 'fulfilled' ? b : a;
  toast(`并发质押结果:${winner}锁定成功;\n第二家被拒:${loser.reason.message}\n仓单排他占有,重复融资被阻止,失败已留痕可审计。`, 'success', 8000);
  refresh();
};

// ② 旧版晚到:取一笔 LOCKED,先对仓单做复检(版本+1),再以旧版本号登记
window.scenarioStale = async () => {
  const id = document.getElementById('stale-pledge').value;
  if (!id) return toast('请先创建一笔 LOCKED 状态质押', 'error');
  const p = STATE.pledges.find((x) => x.id === id);
  toast('步骤1/2:仓库对 ' + p.receiptId + ' 复检减量,仓单版本前进…', 'info');
  try {
    const r = STATE.receipts.find((x) => x.id === p.receiptId);
    await api('/api/receipts/recheck', {
      actorId: 'WH-1', receiptId: r.id,
      newGradeId: r.gradeId,
      newQty: Math.max(1, +(r.qty * 0.8).toFixed(3))
    });
    toast('步骤2/2:金融机构持「旧版本号 v' + p.receiptVersion + '」登记晚到包到达…', 'info');
    await api('/api/pledges/register', {
      actorId: p.financerId, pledgeId: id,
      registrationNo: genRegNo(),
      expectedVersion: p.receiptVersion,
      sessionId
    });
    toast('异常:旧版登记竟然成功?', 'error');
  } catch (e) {
    toast(`旧版晚到被阻止:${e.message}\n拒绝记录已留痕,机构须基于最新仓单重新评估后再登记。`, 'success', 8000);
  }
  refresh();
};

// ③ 回执重放:成功登记后,用完全相同的登记回执号再提交一次
window.scenarioReplay = async () => {
  const id = document.getElementById('replay-pledge').value;
  if (!id) return toast('请先创建一笔 LOCKED 状态质押', 'error');
  const p = STATE.pledges.find((x) => x.id === id);
  const no = genRegNo();
  try {
    const first = await api('/api/pledges/register', {
      actorId: p.financerId, pledgeId: id,
      registrationNo: no, expectedVersion: p.receiptCurrentVersion, sessionId
    });
    toast('首次登记成功:' + no, 'success');
    const second = await api('/api/pledges/register', {
      actorId: p.financerId, pledgeId: id,
      registrationNo: no, expectedVersion: p.receiptCurrentVersion, sessionId
    });
    toast(`相同回执重放:系统返回 replayed=true,对应原质押 ${second.pledge.id},未产生第二笔担保;冲突留痕可审计。`, 'success', 8000);
  } catch (e) {
    toast('演练异常:' + e.message, 'error', 7000);
  }
  refresh();
};

document.getElementById('btn-refresh').onclick = () => refresh();
refresh();
