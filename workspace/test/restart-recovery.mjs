/**
 * restart-recovery.mjs —— 服务进程重启恢复回归(零依赖,自起停服务)
 *
 * 流程:
 *  1. 用独立临时数据文件 EWR_DB_FILE 启动服务(不污染 data/db.json);
 *  2. 走完整融资方会话:锁仓 → 登记 → 并发冲突 → 陈旧版本 → 非当前质权人拒绝 → 还款 → 放行;
 *  3. SIGKILL 硬杀进程(模拟宕机/重启);
 *  4. 同库重启,校验:
 *     - 台账、登记回执号、放行令牌逐字节一致;不产生第二笔质押/第二张令牌;
 *     - 幂等表随盘恢复:相同 reqId/登记回执号重放返回 duplicated/replayed;
 *     - 失败留痕(冲突/拒绝)随盘恢复,可按仓单/会话审计回放;
 *     - 权利链链头哈希与宕机前完全一致,验签通过。
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';

const PORT = process.env.RESTART_PORT || '3199';
const BASE = 'http://localhost:' + PORT;
const DB_FILE = process.env.EWR_TEST_DB || '/tmp/ewr-restart-db.json';
const SESSION = 'SES-RESTART-PERSIST';

let passed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { fails.push(name); console.log('  ✘ ' + name + (detail ? ' — ' + detail : '')); }
}
async function call(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const json = await res.json();
  if (!json.ok) {
    const e = new Error(json.error.message);
    e.code = json.error.code;
    throw e;
  }
  return json.data;
}
const get = async (p) => (await (await fetch(BASE + p)).json()).data;
const rid = (p) => p + Math.random().toString(36).slice(4, 8);
const waitReady = async (up = true) => {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + '/api/audit');
      if (up && r.ok) return true;
    } catch (_) { /* not ready / shutting down */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
function startServer() {
  return spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT, EWR_DB_FILE: DB_FILE },
    stdio: 'ignore'
  });
}

async function main() {
  if (existsSync(DB_FILE)) rmSync(DB_FILE);
  console.log('\n=== 重启恢复:首次启动并制造业务与对抗场景 ===');
  let srv = startServer();
  if (!(await waitReady(true))) throw new Error('服务首次启动超时');

  await call('/api/admin/reset');
  const vb = (await get('/api/state')).valuationBatches[0].id;

  // 正常流程(幂等键全部固定,用于重启后重放核对)
  const lockReq = 'LOCK-PERSIST-0001';
  const regNo = 'REG-PERSIST-0001';
  const relReq = 'REL-PERSIST-0001';
  const locked = await call('/api/pledges/lock', { reqId: lockReq, actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vb, loanAmount: 40000000, sessionId: SESSION });
  await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: locked.pledge.id, registrationNo: regNo, expectedVersion: 1, sessionId: SESSION });
  await call('/api/pledges/repay', { pledgeId: locked.pledge.id, actorId: 'ENT-HONGTAI', amount: 40000000, sessionId: SESSION });
  const released = await call('/api/pledges/release', { reqId: relReq, actorId: 'FIN-ICBC', pledgeId: locked.pledge.id, sessionId: SESSION });

  // 并发冲突(WR0003)
  await Promise.allSettled([
    call('/api/pledges/lock', { reqId: rid('LOCKA'), actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0003', valuationBatchId: vb, loanAmount: 10000000, sessionId: SESSION }),
    call('/api/pledges/lock', { reqId: rid('LOCKB'), actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: 'WR0003', valuationBatchId: vb, loanAmount: 10000000, sessionId: SESSION })
  ]);

  // 陈旧版本(WR0002):复检推进版本后旧版登记
  const lk2 = await call('/api/pledges/lock', { reqId: rid('LOCKS'), actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: 'WR0002', valuationBatchId: vb, loanAmount: 10000000, sessionId: SESSION });
  await call('/api/receipts/recheck', { actorId: 'WH-1', receiptId: 'WR0002', newGradeId: 'CU-A', newQty: 480 });
  try {
    await call('/api/pledges/register', { actorId: 'FIN-CMB', pledgeId: lk2.pledge.id, registrationNo: 'REG-STALE-0001', expectedVersion: 1, sessionId: SESSION });
  } catch (_) { /* 预期拒绝 */ }
  // 非当前质权人请求
  try {
    await call('/api/pledges/release', { reqId: rid('RELX'), actorId: 'FIN-ICBC', pledgeId: lk2.pledge.id, qty: 10, sessionId: SESSION });
  } catch (_) { /* 预期拒绝 */ }

  // 宕机前快照
  const before = await get('/api/state');
  const beforeSession = await get('/api/session?sessionId=' + SESSION);
  const beforeHead = before.audit.chain.head;
  const expected = {
    pledgeId: locked.pledge.id,
    pledgeCount: before.pledges.length,
    registrationNo: regNo,
    releaseId: released.release.id,
    token: released.release.token,
    opTotal: before.audit.operations.total
  };
  console.log('宕机前快照:', JSON.stringify(expected));

  console.log('\n=== SIGKILL 硬杀进程 ===');
  srv.kill('SIGKILL');
  await new Promise((r) => srv.on('exit', r));
  await waitReady(false);

  console.log('\n=== 同库重启,从落盘状态恢复 ===');
  srv = startServer();
  if (!(await waitReady(true))) throw new Error('服务重启超时');

  const after = await get('/api/state');
  const pledge = after.pledges.find((p) => p.id === expected.pledgeId);
  const rel = after.releases.find((x) => x.id === expected.releaseId);
  ok('质押台账恢复:质押笔数不变', after.pledges.length === expected.pledgeCount, `${after.pledges.length} vs ${expected.pledgeCount}`);
  ok('质押恢复为 REGISTERED 且权利人不变', pledge.status === 'REGISTERED' && pledge.financerId === 'FIN-ICBC');
  ok('第一次登记结果恢复:登记回执号一致', pledge.registration && pledge.registration.registrationNo === expected.registrationNo);
  ok('放行单恢复:同一放行令牌,未签发第二张', rel.token === expected.token && after.releases.filter((x) => x.pledgeId === pledge.id).length === 1);
  ok('权利链链头与宕机前完全一致', after.audit.chain.head === beforeHead);
  ok('重启后权利链验签通过', after.audit.chain.ok);
  ok('操作留痕总数随盘恢复', after.audit.operations.total === expected.opTotal);

  console.log('\n=== 重启后幂等表恢复:重复请求不生第二笔 ===');
  const dupLock = await call('/api/pledges/lock', { reqId: lockReq, actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vb, loanAmount: 40000000, sessionId: SESSION });
  ok('相同锁仓 reqId 重启后重放返回原质押', dupLock.duplicated === true && dupLock.pledge.id === expected.pledgeId);
  const dupReg = await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: expected.pledgeId, registrationNo: regNo, expectedVersion: 1, sessionId: SESSION });
  ok('相同登记回执号重启后重放:第一次登记结果不变', dupReg.replayed === true && dupReg.registration.registrationNo === regNo);
  const dupRel = await call('/api/pledges/release', { reqId: relReq, actorId: 'FIN-ICBC', pledgeId: expected.pledgeId, sessionId: SESSION });
  ok('相同放行 reqId 重启后重放:同一令牌', dupRel.replayed === true && dupRel.release.token === expected.token);
  const st = await get('/api/state');
  ok('全部重放后质押/放行数量均不增加', st.pledges.length === expected.pledgeCount && st.releases.length === after.releases.length);

  console.log('\n=== 重启后会话与审计回放恢复 ===');
  const sess = await get('/api/session?sessionId=' + SESSION);
  // 重启后的 3 次重放各自又追加了 CONFLICT 留痕,因此宕机前步骤应是当前序列的严格前缀
  ok('会话步骤序列与宕机前一致(顺序+结果),重放只追加冲突留痕',
    sess.steps.length >= beforeSession.steps.length &&
    beforeSession.steps.every((s, i) => s.outcome === sess.steps[i].outcome && s.action === sess.steps[i].action && s.seq === sess.steps[i].seq) &&
    sess.steps.slice(beforeSession.steps.length).every((s) => s.outcome === 'CONFLICT' && s.reasonCode === 'IDEMPOTENT_REPLAY'),
    `before=${beforeSession.steps.length} after=${sess.steps.length}`);
  ok('会话台账重建出登记回执号', sess.steps.some((x) => x.ref && x.ref.registrationNo === regNo));
  ok('会话台账重建出放行令牌', sess.ledger.releases.some((x) => x.token === expected.token));

  const raceOps = await get('/api/operations?receiptId=WR0003');
  ok('并发冲突留痕恢复:SUCCESS + ALREADY_PLEDGED',
    raceOps.some((o) => o.outcome === 'SUCCESS') && raceOps.some((o) => o.reasonCode === 'ALREADY_PLEDGED' && o.outcome === 'CONFLICT'));
  const staleOps = await get('/api/operations?receiptId=WR0002&outcome=CONFLICT');
  ok('陈旧版本冲突留痕恢复', staleOps.some((o) => o.reasonCode === 'STALE_RECEIPT_VERSION'));
  const denyOps = await get('/api/operations?receiptId=WR0002&outcome=REJECTED');
  ok('非当前质权人拒绝留痕恢复(FORBIDDEN)', denyOps.some((o) => o.reasonCode === 'FORBIDDEN' && o.actorId === 'FIN-ICBC'));
  const tl = await get('/api/receipt?id=WR0001');
  ok('按仓单审计回放:操作顺序/登记回执号/放行令牌齐全',
    tl.operations.length >= 4 &&
    tl.operations.some((o) => o.ref && o.ref.registrationNo === regNo) &&
    tl.operations.some((o) => o.ref && o.ref.token === expected.token));

  console.log('\n=== 质权转让:宕机前发起+单方确认,重启后恢复同一进度并继续交接 ===');
  // WR0002 上有一笔 FIN-CMB 的 LOCKED 质押(陈旧登记被拒),先正常登记再发起转让
  const vbPl2 = (await get('/api/state')).pledges.find((p) => p.receiptId === 'WR0002');
  const transferRegNo = 'REG-PERSIST-TRANSFER-0001';
  await call('/api/pledges/register', { actorId: 'FIN-CMB', pledgeId: vbPl2.id, registrationNo: transferRegNo, expectedVersion: 2, sessionId: SESSION });
  const applyReq = 'TA-PERSIST-0001';
  const confirmReqCmb = 'TC-PERSIST-CMB';
  const applied = await call('/api/pledges/transfer-apply', {
    reqId: applyReq, actorId: 'FIN-CMB', pledgeId: vbPl2.id,
    newFinancerId: 'FIN-ICBC', expectedVersion: 1, sessionId: SESSION
  });
  const transferId = applied.transfer.id;
  // 原质权人 CMB 先确认;受让机构 ICBC 宕机前尚未确认 —— 进度停在「单方已确认」
  await call('/api/pledges/transfer-confirm', { reqId: confirmReqCmb, actorId: 'FIN-CMB', transferId, sessionId: SESSION });
  const regBeforeRestart = (await get('/api/state')).pledges.find((p) => p.id === vbPl2.id).registration;
  const beforeTransfer = (await get('/api/state')).transfers.find((t) => t.id === transferId);
  ok('宕机前转让单为 PENDING 且仅 CMB 已确认',
    beforeTransfer.status === 'PENDING' &&
    beforeTransfer.confirmedBy['FIN-CMB'] === true &&
    beforeTransfer.confirmedBy['FIN-ICBC'] === false);
  const headBeforeTransfer = (await get('/api/audit')).chain.head;

  console.log('\n=== SIGKILL(第二次,交接进行中)===');
  srv.kill('SIGKILL');
  await new Promise((r) => srv.on('exit', r));
  await waitReady(false);
  srv = startServer();
  if (!(await waitReady(true))) throw new Error('服务重启超时');

  const afterTransfer = (await get('/api/state')).transfers.find((t) => t.id === transferId);
  ok('转让进度随盘恢复:同单号 PENDING、确认位一致、申请版本一致',
    afterTransfer.status === 'PENDING' &&
    afterTransfer.confirmedBy['FIN-CMB'] === true &&
    afterTransfer.confirmedBy['FIN-ICBC'] === false &&
    afterTransfer.pledgeVersion === 1 &&
    afterTransfer.financerId === 'FIN-CMB' && afterTransfer.newFinancerId === 'FIN-ICBC');
  const pledgeDuring = (await get('/api/state')).pledges.find((p) => p.id === vbPl2.id);
  ok('宕机重启后权利人未被切换(仍是 CMB),质押版本仍 v1',
    pledgeDuring.financerId === 'FIN-CMB' && pledgeDuring.version === 1);
  ok('转让恢复后链头与宕机前一致', (await get('/api/audit')).chain.head === headBeforeTransfer);
  // 幂等表随盘恢复
  const applyReplayAfter = await call('/api/pledges/transfer-apply', {
    reqId: applyReq, actorId: 'FIN-CMB', pledgeId: vbPl2.id, newFinancerId: 'FIN-ICBC', expectedVersion: 1, sessionId: SESSION
  });
  ok('相同转让申请 reqId 重启后重放:返回既有转让单,不生第二笔',
    applyReplayAfter.replayed === true && applyReplayAfter.transfer.id === transferId);
  const confirmReplayAfter = await call('/api/pledges/transfer-confirm', { reqId: confirmReqCmb, actorId: 'FIN-CMB', transferId, sessionId: SESSION });
  ok('相同确认 reqId 重启后重放:返回既有状态,不重复生效',
    confirmReplayAfter.replayed === true && confirmReplayAfter.transfer.status === 'PENDING');
  ok('重启后转让单仍只有一笔(无双重申请)', (await get('/api/state')).transfers.filter((t) => t.pledgeId === vbPl2.id).length === 1);

  // 受让机构重启后完成最后一次确认 → 生效
  const effAfter = await call('/api/pledges/transfer-confirm', { reqId: 'TC-PERSIST-ICBC', actorId: 'FIN-ICBC', transferId, expectedVersion: 1, sessionId: SESSION });
  ok('重启后补齐第二方确认即交接生效',
    effAfter.effective === true && effAfter.pledgeAfter.financerId === 'FIN-ICBC' && effAfter.pledgeAfter.version === 2);
  const pledgeAfter = (await get('/api/state')).pledges.find((p) => p.id === vbPl2.id);
  ok('原登记凭证不被交接改写(回执号/登记时刻/登记仓单版本保留)',
    pledgeAfter.registration.registrationNo === regBeforeRestart.registrationNo &&
    pledgeAfter.registration.registeredAt === regBeforeRestart.registeredAt &&
    pledgeAfter.registration.receiptVersion === regBeforeRestart.receiptVersion);
  // 旧质权人重启后仍不能处分
  try {
    await call('/api/pledges/release', { reqId: rid('RLAFTER'), actorId: 'FIN-CMB', pledgeId: vbPl2.id, qty: 10, sessionId: SESSION });
    ok('交接后旧质权人重启后放行仍被拒 FORBIDDEN', false);
  } catch (e) {
    ok('交接后旧质权人重启后放行仍被拒 FORBIDDEN', e.code === 'FORBIDDEN', e.code);
  }
  const tFinal = (await get('/api/state')).transfers.find((x) => x.id === transferId);
  ok('转让单终态 EFFECTIVE 且双方确认齐备、权利人为受让方',
    tFinal.status === 'EFFECTIVE' && tFinal.confirmedBy['FIN-CMB'] && tFinal.confirmedBy['FIN-ICBC']);
  const auditAfter = await get('/api/audit');
  ok('交接审计无异常、链验签通过', auditAfter.handoffIssues.length === 0 && auditAfter.chain.ok);

  srv.kill('SIGTERM');
  await new Promise((r) => srv.on('exit', r));
  rmSync(DB_FILE, { force: true });
  console.log(`\n================ 重启恢复:${passed} 通过,${fails.length} 失败 ================`);
  if (fails.length) { console.log('失败项:', fails); process.exit(1); }
}
main().catch((e) => { console.error('重启恢复测试运行异常:', e); process.exit(1); });
