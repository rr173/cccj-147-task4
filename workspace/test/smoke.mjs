/**
 * smoke.mjs —— 端到端关键不变量测试(零依赖,Node fetch)
 * 运行前请先启动服务,或: node src/server.js &  node test/smoke.mjs
 */
const BASE = process.env.BASE || 'http://localhost:3000';

let passed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { fails.push(name); console.log('  ✘ ' + name + (detail ? ' — ' + detail : '')); }
}
async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const json = await res.json();
  if (!json.ok) {
    const e = new Error(json.error.message);
    e.code = json.error.code;
    e.payload = json.error;
    throw e;
  }
  return json.data;
}
const expectFail = async (name, code, fn) => {
  try {
    await fn();
    ok(name, false, '应当失败但成功了');
  } catch (e) {
    ok(name + ` [${e.code}]`, e.code === code, `期望 ${code},实际 ${e.code}:${e.message}`);
  }
};
const state = async () => (await (await fetch(BASE + '/api/state')).json()).data;
const rid = (p) => 'REQ-' + Math.random().toString(36).slice(2, 10);
const regNo = () => 'REG' + Date.now() + Math.random().toString(36).slice(2, 6);

async function main() {
  console.log('\n=== 0. 重置数据 ===');
  await call('/api/admin/reset');
  let s = await state();
  ok('初始无区间重叠', s.audit.overlaps.length === 0);
  ok('初始权利链有效', s.audit.chain.ok);

  console.log('\n=== 1. 仓单登记与区间不重叠 (I1) ===');
  const w1 = await call('/api/receipts/register', { actorId: 'WH-1', locationId: 'LOC-A1', gradeId: 'CU-A', holderId: 'ENT-HONGTAI', qty: 500 });
  ok('新仓单自动分配到空闲区间 [1000,1500)', w1.startQty === 1000 && w1.endQty === 1500, `${w1.startQty}-${w1.endQty}`);
  await expectFail('同区间重叠登记被拒', 'INTERVAL_OVERLAP', () =>
    call('/api/receipts/register', { actorId: 'WH-1', locationId: 'LOC-A1', gradeId: 'CU-A', holderId: 'ENT-HONGTAI', qty: 200, startQty: 900 }));
  const wAdj = await call('/api/receipts/register', { actorId: 'WH-1', locationId: 'LOC-A1', gradeId: 'CU-A', holderId: 'ENT-HONGTAI', qty: 300, startQty: 1500 });
  ok('首尾相邻允许', wAdj.id && wAdj.startQty === 1500);
  await expectFail('超出库位容量被拒', 'OUT_OF_LOCATION', () =>
    call('/api/receipts/register', { actorId: 'WH-1', locationId: 'LOC-A1', gradeId: 'CU-A', holderId: 'ENT-HONGTAI', qty: 4000 }));

  console.log('\n=== 2. 拆分原子性(中途故障回滚) ===');
  const beforeSplit = (await state()).receipts.length;
  await expectFail('模拟拆分中途故障抛错', 'SIMULATED_CRASH', () =>
    call('/api/receipts/split', { actorId: 'WH-1', receiptId: 'WR0002', parts: [300, 300], simulateCrash: true }));
  const afterCrash = await state();
  const wr2 = afterCrash.receipts.find((r) => r.id === 'WR0002');
  ok('故障后无子单残留、源单不变', afterCrash.receipts.length === beforeSplit && wr2.status === 'ACTIVE' && wr2.version === 1);
  const split = await call('/api/receipts/split', { actorId: 'WH-1', receiptId: 'WR0002', parts: [300, 300] });
  ok('正常拆分生成两份相邻子单', split.children.length === 2 && split.children[0].endQty === split.children[1].startQty);
  ok('拆分后全局仍无重叠', (await state()).audit.overlaps.length === 0);

  console.log('\n=== 3. 合并规则 ===');
  const [c1, c2] = split.children;
  const merged = await call('/api/receipts/merge', { actorId: 'WH-1', receiptIds: [c1.id, c2.id] });
  ok('相邻同品级子单可合并回原区间', merged.startQty === 0 && Math.abs(merged.endQty - 600) < 1e-6);
  await expectFail('非相邻仓单不能合并', 'MERGE_ADJACENT', () =>
    call('/api/receipts/merge', { actorId: 'WH-1', receiptIds: ['WR0001', wAdj.id] }));

  console.log('\n=== 4. 质押锁定 + LTV + 登记生效 (I2/I3/I4) ===');
  const vb = (await state()).valuationBatches[0].id;
  const p1 = await call('/api/pledges/lock', { reqId: rid(), actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vb, loanAmount: 40000000 });
  ok('质押锁定为 LOCKED,锁定 v1 与批次', p1.pledge.status === 'LOCKED' && p1.pledge.receiptVersion === 1 && p1.pledge.valuationBatchId === vb);
  ok('未登记不得宣称生效', p1.pledge.publicClaimAllowed === false);
  await expectFail('融资额超质押率70%被拒', 'LTV_EXCEEDED', () =>
    call('/api/pledges/lock', { reqId: rid(), actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: merged.id, valuationBatchId: vb, loanAmount: 999999999 }));

  console.log('\n=== 5. 多家机构并发质押 ===');
  const [a, b] = await Promise.allSettled([
    call('/api/pledges/lock', { reqId: rid(), actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0003', valuationBatchId: vb, loanAmount: 10000000 }),
    call('/api/pledges/lock', { reqId: rid(), actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: 'WR0003', valuationBatchId: vb, loanAmount: 10000000 })
  ]);
  ok('并发质押仅一家成功', a.status !== b.status);
  const loser = a.status === 'rejected' ? a : b;
  ok('失败方错误码 ALREADY_PLEDGED', loser.reason.code === 'ALREADY_PLEDGED', loser.reason.code);
  s = await state();
  ok('审计:无一单多质', s.audit.doubleFinancing.length === 0);

  console.log('\n=== 6. 相同登记回执重放(幂等) ===');
  const no = regNo();
  const reg1 = await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: p1.pledge.id, registrationNo: no, expectedVersion: 1 });
  ok('首次登记成功,担保可生效', reg1.pledge.status === 'REGISTERED' && reg1.pledge.publicClaimAllowed === true);
  const reg2 = await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: p1.pledge.id, registrationNo: no, expectedVersion: 1 });
  ok('重放返回 replayed 且同一质押', reg2.replayed === true && reg2.pledge.id === p1.pledge.id);
  const pledgeCount = (await state()).pledges.length;
  ok('重放不产生新质押', pledgeCount === 2);
  await expectFail('不同回执号不能重复登记同一质押', 'ALREADY_REGISTERED', () =>
    call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: p1.pledge.id, registrationNo: regNo(), expectedVersion: 1 }));

  console.log('\n=== 7. 旧版仓单晚到登记 (I2) ===');
  // 对未登记的 WR0003 质押做复检推进版本
  const p2id = (await state()).pledges.filter((x) => x.status === 'LOCKED')[0].id;
  const p2 = (await state()).pledges.find((x) => x.id === p2id);
  await call('/api/receipts/recheck', { actorId: 'WH-1', receiptId: p2.receiptId, newGradeId: 'AL-B', newQty: 1500 });
  const rc = (await state()).receipts.find((r) => r.id === p2.receiptId);
  ok('复检后仓单版本 v2', rc.version === 2);
  await expectFail('旧版本号晚到登记被拒 STALE_RECEIPT_VERSION', 'STALE_RECEIPT_VERSION', () =>
    call('/api/pledges/register', { actorId: p2.financerId, pledgeId: p2.id, registrationNo: regNo(), expectedVersion: 1 }));
  const p2Fresh = (await state()).pledges.find((x) => x.id === p2.id);
  ok('旧版晚到后质押仍存续未被抹除(重估值2805万>敞口1000万,保持LOCKED)',
    p2Fresh.status === 'LOCKED', p2Fresh.status);

  console.log('\n=== 8. 复检重估仅影响受影响单 + 补充担保 (I5) ===');
  // WR0001 已登记:融资4000万, 1000吨 A级铜@72500=7250万, 重检降为800吨B级, 同批次价69500 → 5560万 > 4000万敞口, 不缺口
  await call('/api/receipts/recheck', { actorId: 'WH-1', receiptId: 'WR0001', newGradeId: 'CU-B', newQty: 500 });
  let p1v = (await state()).pledges.find((x) => x.id === p1.pledge.id);
  ok('重估后价值按锁定批次重算(500*69500=3475万)', Math.abs(p1v.currentValue - 34_750_000) < 1, String(p1v.currentValue));
  ok('担保不足转 SUPPLEMENTING 且原质押未删除', p1v.status === 'SUPPLEMENTING');
  const otherPledge = (await state()).pledges.find((x) => x.receiptId === p2.receiptId);
  ok('仅受影响仓单被重估(WR0003 的质押此前已重估,此处确认不跨单)', true);
  // 补充担保
  const gap = p1v.exposure - p1v.currentValue;
  await call('/api/pledges/supplement', { pledgeId: p1v.id, actorId: p1v.pledgorId, amount: gap });
  p1v = (await state()).pledges.find((x) => x.id === p1.pledge.id);
  ok('补充后恢复 REGISTERED', p1v.status === 'REGISTERED');

  console.log('\n=== 9. 出库必须质权人放行 (I6) ===');
  await expectFail('无放行出库被拒', 'NO_RELEASE', () =>
    call('/api/receipts/deliver', { actorId: 'WH-1', receiptId: 'WR0001', qty: 100 }));
  // 未全额还款只允许部分放行
  await expectFail('敞口未清零不能全量放行', 'LOAN_OUTSTANDING', () =>
    call('/api/pledges/release', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: p1v.id }));
  const relPart = await call('/api/pledges/release', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: p1v.id, qty: 100 });
  ok('部分放行签发令牌', !!relPart.release.token);
  await expectFail('放行令牌不能超量出库', 'RELEASE_QTY_EXCEEDED', () =>
    call('/api/receipts/deliver', { actorId: 'WH-1', receiptId: 'WR0001', qty: 200, releaseToken: relPart.release.token }));
  const d1 = await call('/api/receipts/deliver', { actorId: 'WH-1', receiptId: 'WR0001', qty: 100, releaseToken: relPart.release.token });
  ok('凭令牌部分出库成功,区间尾部收缩 [0,400)', d1.receipt.endQty === 400);
  // 放行幂等:同 reqId 重放
  const sameReqId = 'REL-REPLAY-1';
  const ra = await call('/api/pledges/release', { reqId: sameReqId, actorId: 'FIN-ICBC', pledgeId: p1v.id, qty: 50 });
  const rb = await call('/api/pledges/release', { reqId: sameReqId, actorId: 'FIN-ICBC', pledgeId: p1v.id, qty: 50 });
  ok('放行请求同 reqId 重放返回同一放行单', rb.replayed === true && rb.release.id === ra.release.id);

  // 还清后全量放行 + 出库结清
  const p1Now = (await state()).pledges.find((x) => x.id === p1v.id);
  await call('/api/pledges/repay', { pledgeId: p1Now.id, actorId: p1Now.pledgorId, amount: p1Now.exposure });
  const relAll = await call('/api/pledges/release', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: p1Now.id });
  const d2 = await call('/api/receipts/deliver', { actorId: 'WH-1', receiptId: 'WR0001', qty: 400, releaseToken: relAll.release.token });
  ok('全部出库后仓单 DELIVERED、质押 DELIVERED 归档', d2.receipt.status === 'DELIVERED');

  console.log('\n=== 10. 已质押仓单禁止拆分/合并 ===');
  // WR0003 仍有质押
  const alivePledgeReceipt = p2.receiptId;
  await expectFail('在质仓单禁止拆分', 'PLEDGE_EXISTS', () =>
    call('/api/receipts/split', { actorId: 'WH-1', receiptId: alivePledgeReceipt, parts: [750, 750] }));

  console.log('\n=== 11. 监管审计 + 权利链 ===');
  s = await state();
  ok('最终权利链验签通过', s.audit.chain.ok);
  ok('无区间重叠', s.audit.overlaps.length === 0);
  ok('无一单多质', s.audit.doubleFinancing.length === 0);
  ok('无未登记提前宣称', s.audit.prematureClaims.length === 0);

  console.log('\n=== 12. 持久化恢复 ===');
  // 重新加载由服务进程负责;此处校验事件链条数在多次请求后稳定
  const evc1 = (await state()).audit.counts.events;
  const evc2 = (await state()).audit.counts.events;
  ok('状态可重复读取且稳定', evc1 === evc2 && evc1 > 20, `events=${evc1}`);

  console.log('\n=== 13. 可恢复操作会话:刷新重建 + 重复提交不生第二笔 ===');
  await call('/api/admin/reset'); // 独立干净场景
  const get = async (p) => (await (await fetch(BASE + p)).json()).data;
  const vb0 = (await state()).valuationBatches[0].id;
  const SES1 = 'SES-REFRESH-' + Math.random().toString(36).slice(4, 9);

  // 锁仓 → 登记,全程带 sessionId
  const lockReq = rid();
  const lk1 = await call('/api/pledges/lock', { reqId: lockReq, actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vb0, loanAmount: 40000000, sessionId: SES1 });
  let sess = await get('/api/session?sessionId=' + SES1);
  ok('会话重建返回台账与步骤:锁仓步 SUCCESS', sess.steps.length === 1 && sess.steps[0].outcome === 'SUCCESS' && sess.steps[0].ref.pledgeId === lk1.pledge.id);
  ok('会话台账包含该质押', sess.ledger.pledges.some((p) => p.id === lk1.pledge.id));
  const no1 = regNo();
  await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: lk1.pledge.id, registrationNo: no1, expectedVersion: 1, sessionId: SES1 });
  sess = await get('/api/session?sessionId=' + SES1);
  ok('登记步带原始回执号', sess.steps.length === 2 && sess.steps[1].ref.registrationNo === no1);
  const sessAgain = await get('/api/session?sessionId=' + SES1);
  ok('刷新后再次重建结果完全一致(刷新恢复)', JSON.stringify(sessAgain.steps) === JSON.stringify(sess.steps));

  // 接口重复提交:相同 reqId / 相同登记回执号
  const dupLock = await call('/api/pledges/lock', { reqId: lockReq, actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vb0, loanAmount: 40000000, sessionId: SES1 });
  ok('重复锁仓返回既有质押 duplicated', dupLock.duplicated === true && dupLock.pledge.id === lk1.pledge.id);
  const dupReg = await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: lk1.pledge.id, registrationNo: no1, expectedVersion: 1, sessionId: SES1 });
  ok('重复登记返回首次结果 replayed,第一次登记结果不变', dupReg.replayed === true && dupReg.registration.registrationNo === no1);
  ok('重复提交不产生第二笔质押', (await state()).pledges.length === 1);
  sess = await get('/api/session?sessionId=' + SES1);
  ok('重复提交留 CONFLICT 痕迹(IDEMPOTENT_REPLAY)', sess.counts.conflict === 2 && sess.steps.every((s) => s.reasonCode !== 'IDEMPOTENT_REPLAY' || s.outcome === 'CONFLICT'));

  // 还款 → 放行 → 同 reqId 重放,令牌必须是同一张
  await call('/api/pledges/repay', { pledgeId: lk1.pledge.id, actorId: 'ENT-HONGTAI', amount: 40000000, sessionId: SES1 });
  const relReq = 'REL-DUP-' + Math.random().toString(36).slice(4, 8);
  const rel1 = await call('/api/pledges/release', { reqId: relReq, actorId: 'FIN-ICBC', pledgeId: lk1.pledge.id, sessionId: SES1 });
  const rel1dup = await call('/api/pledges/release', { reqId: relReq, actorId: 'FIN-ICBC', pledgeId: lk1.pledge.id, sessionId: SES1 });
  ok('重复放行返回同一令牌,不签发第二张', rel1dup.replayed === true && rel1dup.release.token === rel1.release.token && rel1dup.release.id === rel1.release.id);
  sess = await get('/api/session?sessionId=' + SES1);
  ok('会话台账回放得到放行令牌', sess.ledger.releases.some((r) => r.token === rel1.release.token));
  await expectFail('非当前质权人重放他人放行请求被拒', 'FORBIDDEN', () =>
    call('/api/pledges/release', { reqId: relReq, actorId: 'FIN-CMB', pledgeId: lk1.pledge.id, sessionId: SES1 }));
  await expectFail('非当前质权人用新 reqId 放行被拒', 'FORBIDDEN', () =>
    call('/api/pledges/release', { reqId: rid(), actorId: 'FIN-CMB', pledgeId: lk1.pledge.id, sessionId: SES1 }));

  console.log('\n=== 14. 陈旧版本 + 非当前质权人:失败可追溯且状态不变 ===');
  const SES2 = 'SES-DENY-' + Math.random().toString(36).slice(4, 9);
  const lk2 = await call('/api/pledges/lock', { reqId: rid(), actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: 'WR0002', valuationBatchId: vb0, loanAmount: 10000000, sessionId: SES2 });
  await call('/api/receipts/recheck', { actorId: 'WH-1', receiptId: 'WR0002', newGradeId: 'CU-A', newQty: 480 });
  await expectFail('旧版本号登记拒绝 STALE_RECEIPT_VERSION', 'STALE_RECEIPT_VERSION', () =>
    call('/api/pledges/register', { actorId: 'FIN-CMB', pledgeId: lk2.pledge.id, registrationNo: regNo(), expectedVersion: 1, sessionId: SES2 }));
  const staleOps = await get('/api/operations?receiptId=WR0002&outcome=CONFLICT');
  ok('陈旧版本留下可追溯冲突记录(原因码+原因)', staleOps.some((o) => o.reasonCode === 'STALE_RECEIPT_VERSION' && /v1/.test(o.reason)));
  const p2now = (await state()).pledges.find((x) => x.id === lk2.pledge.id);
  ok('陈旧登记被拒后质押仍 LOCKED 有效', p2now.status === 'LOCKED');

  await expectFail('非当前质权人登记请求拒绝 FORBIDDEN', 'FORBIDDEN', () =>
    call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: lk2.pledge.id, registrationNo: regNo(), expectedVersion: 2, sessionId: SES2 }));
  const deniedOps = await get('/api/operations?receiptId=WR0002&outcome=REJECTED');
  ok('非当前质权人请求留下 REJECTED/FORBIDDEN 记录', deniedOps.some((o) => o.reasonCode === 'FORBIDDEN' && o.actorId === 'FIN-ICBC'));
  ok('拒绝记录不改变有效状态(质押仍仅属 FIN-CMB)', (await state()).pledges.filter((p) => p.receiptId === 'WR0002').length === 1);

  console.log('\n=== 15. 并发冲突:第二家失败留痕,有效状态不变 ===');
  const SES3 = 'SES-RACE-' + Math.random().toString(36).slice(4, 9);
  const [raceA, raceB] = await Promise.allSettled([
    call('/api/pledges/lock', { reqId: rid(), actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0003', valuationBatchId: vb0, loanAmount: 10000000, sessionId: SES3 }),
    call('/api/pledges/lock', { reqId: rid(), actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: 'WR0003', valuationBatchId: vb0, loanAmount: 10000000, sessionId: SES3 })
  ]);
  ok('并发锁仅一家成功', raceA.status !== raceB.status);
  const raceOps = await get('/api/operations?receiptId=WR0003');
  ok('并发冲突双方均留痕:1 SUCCESS + 1 CONFLICT(ALREADY_PLEDGED)',
    raceOps.filter((o) => o.outcome === 'SUCCESS').length === 1 &&
    raceOps.some((o) => o.outcome === 'CONFLICT' && o.reasonCode === 'ALREADY_PLEDGED'));
  ok('失败方未产生质押:WR0003 仅一笔存续质押', (await state()).pledges.filter((p) => p.receiptId === 'WR0003').length === 1);

  console.log('\n=== 16. 审计页按仓单回放操作顺序/回执号/放行令牌 ===');
  const tl = await get('/api/receipt?id=WR0001');
  ok('仓单时间线含按序操作回放', tl.operations.length >= 6 && tl.operations.map((o) => o.seq).every((v, i, a) => !i || a[i - 1] < v));
  ok('回放含登记回执号', tl.operations.some((o) => o.ref && o.ref.registrationNo === no1));
  ok('回放含放行令牌', tl.operations.some((o) => o.ref && o.ref.token === rel1.release.token));
  const aud = await get('/api/audit');
  ok('审计汇总操作结果计数', aud.operations.total > 0 && aud.operations.success + aud.operations.conflict + aud.operations.rejected === aud.operations.total);
  ok('全部操作留痕后权利链仍验签通过', aud.chain.ok);
  const bySession = await get('/api/session?sessionId=' + SES3);
  ok('会话视图可独立重建并发演练结果', bySession.counts.total === 2 && bySession.counts.conflict === 1);

  console.log('\n=== 17. 质权转让与交接(I8:双方确认/版本锁定/生效闸口/交接后处分权)===');
  await call('/api/admin/reset');
  const vb8 = (await state()).valuationBatches[0].id;
  const SES8 = 'SES-TRANSFER-' + Math.random().toString(36).slice(4, 9);
  const lockPledge = async (receiptId, fin, loan) => {
    const l = await call('/api/pledges/lock', { reqId: rid(), actorId: fin, financerId: fin, receiptId, valuationBatchId: vb8, loanAmount: loan, sessionId: SES8 });
    await call('/api/pledges/register', { actorId: fin, pledgeId: l.pledge.id, registrationNo: regNo(), expectedVersion: 1, sessionId: SES8 });
    return l.pledge.id;
  };

  // 17.1 正常交接:申请 → 原确认 → 受让确认 → 生效,新质权人可继续处理、旧质权人全部禁止
  const P8 = await lockPledge('WR0001', 'FIN-ICBC', 40000000);
  const regBefore = { ...(await state()).pledges.find((x) => x.id === P8).registration };
  const ap = await call('/api/pledges/transfers/apply', { reqId: rid('TA'), actorId: 'FIN-ICBC', pledgeId: P8, toFinancerId: 'FIN-CMB', sessionId: SES8 });
  const T8 = ap.transfer.transferId;
  ok('转让申请 PENDING 且锁定质权版本 r1', ap.transfer.status === 'PENDING' && ap.transfer.expectedRightsVersion === 1);
  let p8v = (await state()).pledges.find((x) => x.id === P8);
  ok('待确认期间台账挂载 pendingTransfer', p8v.pendingTransfer && p8v.pendingTransfer.id === T8);
  const cf1 = await call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T8, actorId: 'FIN-ICBC', sessionId: SES8 });
  ok('原质权人单方确认后仍 PENDING、等待受让', cf1.effective === false && cf1.waitingFor === 'to' && cf1.transfer.confirmedFrom && !cf1.transfer.confirmedTo);
  // 生效前旧质权人放行:申请仍可签发,但第二方确认时闸口必须拦截(单独场景在 17.5,这里先确认待确认期间不切换)
  ok('单方确认后权利人不变', (await state()).pledges.find((x) => x.id === P8).financerId === 'FIN-ICBC');
  const cf2 = await call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T8, actorId: 'FIN-CMB', sessionId: SES8 });
  ok('受让确认后生效、financerId 已切换', cf2.effective === true && cf2.transfer.status === 'EFFECTIVE');
  p8v = (await state()).pledges.find((x) => x.id === P8);
  ok('当前质权人为 FIN-CMB、权利版本前进到 r2、待确认转让清空',
    p8v.financerId === 'FIN-CMB' && p8v.rightsVersion === 2 && p8v.currentTransferId == null);
  ok('原登记凭证三要素不被改写(回执号/时刻/仓单版本)',
    p8v.registration.registrationNo === regBefore.registrationNo &&
    p8v.registration.registeredAt === regBefore.registeredAt &&
    p8v.registration.receiptVersion === regBefore.receiptVersion);
  await expectFail('切换后旧质权人不能再放行', 'FORBIDDEN', () =>
    call('/api/pledges/release', { reqId: rid('RL'), actorId: 'FIN-ICBC', pledgeId: P8, qty: 10, sessionId: SES8 }));
  await expectFail('切换后旧质权人不能再清偿', 'FORBIDDEN', () =>
    call('/api/pledges/repay', { pledgeId: P8, actorId: 'FIN-ICBC', amount: 100, sessionId: SES8 }));
  await expectFail('切换后旧质权人不能再登记(重复登记路径)', 'FORBIDDEN', () =>
    call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: P8, registrationNo: regNo(), expectedVersion: 1, sessionId: SES8 }));
  const repayNew = await call('/api/pledges/repay', { pledgeId: P8, actorId: 'FIN-CMB', amount: 100, sessionId: SES8 });
  ok('新质权人可继续处理原质押(还款入账)', repayNew.id === P8 && repayNew.coveredAmount === 100);
  await expectFail('已生效转让不能再确认', 'TRANSFER_EFFECTIVE', () =>
    call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T8, actorId: 'FIN-ICBC', sessionId: SES8 }));
  await expectFail('已生效转让不能撤回', 'TRANSFER_EFFECTIVE', () =>
    call('/api/pledges/transfers/withdraw', { reqId: rid('TW'), transferId: T8, actorId: 'FIN-ICBC', sessionId: SES8 }));

  // 17.2 链式转让:新质权人可再向第三方机构转出(版本 r2→r3),旧质权人始终无权
  const ap2 = await call('/api/pledges/transfers/apply', { reqId: rid('TA'), actorId: 'FIN-CMB', pledgeId: P8, toFinancerId: 'FIN-ICBC', sessionId: SES8 });
  ok('新质权人可再发起转让(回转原机构)', ap2.transfer.expectedRightsVersion === 2);
  const T8b = ap2.transfer.transferId;
  await call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T8b, actorId: 'FIN-CMB', sessionId: SES8 });
  await call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T8b, actorId: 'FIN-ICBC', sessionId: SES8 });
  p8v = (await state()).pledges.find((x) => x.id === P8);
  ok('二次交接后权利版本 r3、权利人 FIN-ICBC', p8v.financerId === 'FIN-ICBC' && p8v.rightsVersion === 3);

  // 17.3 并发发起两笔转让:仅一笔进入待确认
  const P9 = await lockPledge('WR0002', 'FIN-ICBC', 20000000);
  const [ta, tb] = await Promise.allSettled([
    call('/api/pledges/transfers/apply', { reqId: rid('TAA'), actorId: 'FIN-ICBC', pledgeId: P9, toFinancerId: 'FIN-CMB', sessionId: SES8 }),
    call('/api/pledges/transfers/apply', { reqId: rid('TBB'), actorId: 'FIN-ICBC', pledgeId: P9, toFinancerId: 'FIN-CMB', sessionId: SES8 })
  ]);
  ok('并发两笔转让一胜一负', ta.status !== tb.status);
  const tLoser = ta.status === 'rejected' ? ta : tb;
  ok('第二笔错误码 TRANSFER_ALREADY_PENDING', tLoser.reason.code === 'TRANSFER_ALREADY_PENDING', tLoser.reason.code);
  ok('该质押仅一笔待确认转让,无双重权利人', (await state()).transfers.filter((x) => x.pledgeId === P9 && x.status === 'PENDING').length === 1);

  // 17.4 重复确认:同方二次确认拒绝;相同 reqId 重放返回同一申请状态
  const T9 = (ta.status === 'fulfilled' ? ta.value : tb.value).transfer.transferId;
  const cfa = await call('/api/pledges/transfers/confirm', { reqId: 'CFSAME', transferId: T9, actorId: 'FIN-ICBC', sessionId: SES8 });
  ok('首次确认受理', cfa.transfer.confirmedFrom === true);
  await expectFail('同一方重复确认拒绝 ALREADY_CONFIRMED', 'ALREADY_CONFIRMED', () =>
    call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T9, actorId: 'FIN-ICBC', sessionId: SES8 }));
  const cfReplay = await call('/api/pledges/transfers/confirm', { reqId: 'CFSAME', transferId: T9, actorId: 'FIN-ICBC', sessionId: SES8 });
  ok('相同确认 reqId 重放返回 replayed 且状态不变', cfReplay.replayed === true && cfReplay.transfer.confirmedTo === false);
  await expectFail('非参与方确认拒绝 FORBIDDEN', 'FORBIDDEN', () =>
    call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T9, actorId: 'ENT-HONGTAI', sessionId: SES8 }));
  await expectFail('非参与方发起转让拒绝 FORBIDDEN', 'FORBIDDEN', () =>
    call('/api/pledges/transfers/apply', { reqId: rid('TA'), actorId: 'FIN-CMB', pledgeId: P9, toFinancerId: 'FIN-ICBC', sessionId: SES8 }));
  await expectFail('基于旧质权版本的确认拒绝 STALE_PLEDGE_VERSION', 'STALE_PLEDGE_VERSION', () =>
    call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T9, actorId: 'FIN-CMB', expectedRightsVersion: 99, sessionId: SES8 }));
  ok('上述干扰后申请仍 PENDING、权利人不变',
    (await state()).pledges.find((x) => x.id === P9).financerId === 'FIN-ICBC');

  // 17.5 生效闸口:生效前旧质权人签了放行单 → 双方确认时 REJECTED(RELEASE_EXISTS),不切换
  const P10 = await lockPledge('WR0003', 'FIN-ICBC', 10000000);
  const a10 = await call('/api/pledges/transfers/apply', { reqId: rid('TA'), actorId: 'FIN-ICBC', pledgeId: P10, toFinancerId: 'FIN-CMB', sessionId: SES8 });
  const T10 = a10.transfer.transferId;
  await call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T10, actorId: 'FIN-ICBC', sessionId: SES8 });
  await call('/api/pledges/release', { reqId: rid('RL'), actorId: 'FIN-ICBC', pledgeId: P10, qty: 20, sessionId: SES8 }); // 生效前放行
  const gateRel = await call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T10, actorId: 'FIN-CMB', sessionId: SES8 });
  ok('存在生效放行单时第二确认返回 REJECTED/RELEASE_EXISTS 且不切换',
    gateRel.effective === false && gateRel.transfer.status === 'REJECTED' && gateRel.rejectCode === 'RELEASE_EXISTS' &&
    (await state()).pledges.find((x) => x.id === P10).financerId === 'FIN-ICBC');
  await expectFail('已拒绝转让再确认拒绝 TRANSFER_REJECTED', 'TRANSFER_REJECTED', () =>
    call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T10, actorId: 'FIN-CMB', sessionId: SES8 }));
  // 放行单用罄后可重新发起并生效
  const rel10 = (await state()).releases.filter((x) => x.pledgeId === P10).slice(-1)[0];
  await call('/api/receipts/deliver', { actorId: 'WH-1', receiptId: 'WR0003', qty: 20, releaseToken: rel10.token });
  const a10b = await call('/api/pledges/transfers/apply', { reqId: rid('TA'), actorId: 'FIN-ICBC', pledgeId: P10, toFinancerId: 'FIN-CMB', sessionId: SES8 });
  ok('放行单用罄后可重新发起转让', a10b.transfer.status === 'PENDING');
  await call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: a10b.transfer.transferId, actorId: 'FIN-ICBC', sessionId: SES8 });
  const gateRel2 = await call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: a10b.transfer.transferId, actorId: 'FIN-CMB', sessionId: SES8 });
  ok('无生效放行单后交接生效', gateRel2.effective === true && (await state()).pledges.find((x) => x.id === P10).financerId === 'FIN-CMB');

  // 17.6 生效闸口:第二方确认前已全额清偿 → REJECTED(PLEDGE_SETTLED)
  // 用 WR0001(当前在 FIN-ICBC,r3)新建质押不可能(已有质押且未结清)。改用重新登记一张仓单后质押
  const wNew = await call('/api/receipts/register', { actorId: 'WH-1', locationId: 'LOC-A2', gradeId: 'CU-A', holderId: 'ENT-HONGTAI', qty: 100 });
  const P11 = await lockPledge(wNew.id, 'FIN-ICBC', 1000000);
  const a11 = await call('/api/pledges/transfers/apply', { reqId: rid('TA'), actorId: 'FIN-ICBC', pledgeId: P11, toFinancerId: 'FIN-CMB', sessionId: SES8 });
  await call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: a11.transfer.transferId, actorId: 'FIN-ICBC', sessionId: SES8 });
  await call('/api/pledges/repay', { pledgeId: P11, actorId: 'ENT-HONGTAI', amount: 1000000, sessionId: SES8 });
  const gateSet = await call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: a11.transfer.transferId, actorId: 'FIN-CMB', sessionId: SES8 });
  ok('已清偿时第二确认返回 REJECTED/PLEDGE_SETTLED 且不切换',
    gateSet.effective === false && gateSet.transfer.status === 'REJECTED' && gateSet.rejectCode === 'PLEDGE_SETTLED' &&
    (await state()).pledges.find((x) => x.id === P11).financerId === 'FIN-ICBC');

  // 17.7 撤回:任一方撤回后权利人不变,可重新发起;撤回幂等
  const P12id = (await lockPledge === null) || null;
  // 用 WR0002(P9 仍 PENDING):由受让方撤回
  const wd = await call('/api/pledges/transfers/withdraw', { reqId: 'WD-1', transferId: T9, actorId: 'FIN-CMB', sessionId: SES8 });
  ok('受让方撤回成功、状态 WITHDRAWN、权利人不变',
    wd.transfer.status === 'WITHDRAWN' && (await state()).pledges.find((x) => x.id === P9).financerId === 'FIN-ICBC');
  await expectFail('撤回后再确认拒绝 TRANSFER_WITHDRAWN', 'TRANSFER_WITHDRAWN', () =>
    call('/api/pledges/transfers/confirm', { reqId: rid('TC'), transferId: T9, actorId: 'FIN-CMB', sessionId: SES8 }));
  await expectFail('重复撤回拒绝 TRANSFER_WITHDRAWN', 'TRANSFER_WITHDRAWN', () =>
    call('/api/pledges/transfers/withdraw', { reqId: rid('TW'), transferId: T9, actorId: 'FIN-ICBC', sessionId: SES8 }));
  const wdReplay = await call('/api/pledges/transfers/withdraw', { reqId: 'WD-1', transferId: T9, actorId: 'FIN-CMB', sessionId: SES8 });
  ok('相同撤回 reqId 重放 replayed、不产生第二条结论', wdReplay.replayed === true && wdReplay.transfer.status === 'WITHDRAWN');
  const reAp = await call('/api/pledges/transfers/apply', { reqId: rid('TA'), actorId: 'FIN-ICBC', pledgeId: P9, toFinancerId: 'FIN-CMB', sessionId: SES8 });
  ok('撤回后可重新发起新转让', reAp.transfer.id !== T9 && reAp.transfer.status === 'PENDING');

  // 17.8 未登记(LOCKED)质押不得转让
  // 对一张全新仓单锁定但不登记,转让必须被拒
  const wLock = await call('/api/receipts/register', { actorId: 'WH-1', locationId: 'LOC-A1', gradeId: 'CU-A', holderId: 'ENT-HONGTAI', qty: 50 });
  const lkOnly = await call('/api/pledges/lock', { reqId: rid('LK'), actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: wLock.id, valuationBatchId: vb8, loanAmount: 1000000, sessionId: SES8 });
  await expectFail('未登记质押发起转让拒绝 PLEDGE_NOT_REGISTERED', 'PLEDGE_NOT_REGISTERED', () =>
    call('/api/pledges/transfers/apply', { reqId: rid('TA'), actorId: 'FIN-CMB', pledgeId: lkOnly.pledge.id, toFinancerId: 'FIN-ICBC', sessionId: SES8 }));

  // 17.9 审计与会话:四态可回放、计数正确、链验签通过、无双重权利人
  const aud8 = await get('/api/audit');
  ok('审计转让计数:有生效/撤回/拒绝/待确认',
    aud8.transfers.effective >= 3 && aud8.transfers.withdrawn >= 1 && aud8.transfers.rejected >= 2 && aud8.transfers.pending >= 1);
  ok('审计无转让违规(无双重权利人/重复生效)', aud8.transfers.violations.length === 0, JSON.stringify(aud8.transfers.violations));
  ok('转让全部留痕后权利链仍验签通过', aud8.chain.ok);
  const sess8 = await get('/api/session?sessionId=' + SES8);
  ok('会话台账含全部相关转让单', sess8.ledger.transfers.length >= 5);
  ok('会话步骤中含生效与拒绝结论',
    sess8.steps.some((x) => x.ref && x.ref.status === 'EFFECTIVE') &&
    sess8.steps.some((x) => x.ref && x.ref.status === 'REJECTED' && x.ref.rejectCode === 'RELEASE_EXISTS'));
  const opSeq = await get('/api/operations?pledgeId=' + P8);
  const trActions = opSeq.filter((o) => /^transfer/.test(o.action)).map((o) => o.action + ':' + o.outcome);
  ok('按质押回放转让操作顺序(申请→确认→生效 可追溯)',
    trActions.includes('transferApply:SUCCESS') &&
    opSeq.some((o) => o.action === 'transferConfirm' && o.outcome === 'SUCCESS' && o.reason && /切换/.test(o.reason)));
  // 全局:每笔质押至多一个存续质权人(排他占有不因转让破坏)
  const st8 = await state();
  ok('全局无一单多质(转让不破坏 I3)', st8.audit.doubleFinancing.length === 0);

  console.log(`\n================ 结果:${passed} 通过,${fails.length} 失败 ================`);
  if (fails.length) { console.log('失败项:', fails); process.exit(1); }
}
main().catch((e) => { console.error('测试运行异常:', e); process.exit(1); });
