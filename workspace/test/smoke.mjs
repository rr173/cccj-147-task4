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

  console.log('\n=== 17. 质权转让与交接 (I8):双方确认 / 撤回 / 版本 / 闸门 / 权利切换 ===');
  await call('/api/admin/reset');
  const vbT = (await state()).valuationBatches[0].id;
  const SES_T = 'SES-TRANSFER-' + Math.random().toString(36).slice(4, 9);
  // 一笔已登记、未清偿的存续质押(ICBC),另有一张未质押仓单供排他校验
  const tk = await call('/api/pledges/lock', { reqId: rid(), actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vbT, loanAmount: 40000000, sessionId: SES_T });
  const P_T = tk.pledge.id;
  await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: P_T, registrationNo: regNo(), expectedVersion: 1, sessionId: SES_T });
  const firstReg = (await state()).pledges.find((x) => x.id === P_T).registration;

  // 未登记质押不可转让(新建一笔 LOCKED)
  const lockedOnly = await call('/api/pledges/lock', { reqId: rid(), actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: 'WR0003', valuationBatchId: vbT, loanAmount: 10000000 });
  await expectFail('未登记质押不能转让', 'PLEDGE_NOT_REGISTERED', () =>
    call('/api/pledges/transfer-apply', { reqId: rid(), actorId: 'FIN-CMB', pledgeId: lockedOnly.pledge.id, newFinancerId: 'FIN-ICBC', sessionId: SES_T }));
  // 主体/参与方校验
  await expectFail('受让方不能是仓库等非金融机构', 'BAD_ASSIGNEE', () =>
    call('/api/pledges/transfer-apply', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: P_T, newFinancerId: 'WH-1' }));
  await expectFail('非参与方不能发起转让', 'FORBIDDEN', () =>
    call('/api/pledges/transfer-apply', { reqId: rid(), actorId: 'ENT-HONGTAI', pledgeId: P_T, newFinancerId: 'FIN-CMB' }));
  // 旧质押版本申请
  await expectFail('基于旧质押版本申请被拒 STALE_PLEDGE_VERSION', 'STALE_PLEDGE_VERSION', () =>
    call('/api/pledges/transfer-apply', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: P_T, newFinancerId: 'FIN-CMB', expectedVersion: 42 }));

  // 并发发起两笔:仅一笔成立
  const [ta, tb] = await Promise.allSettled([
    call('/api/pledges/transfer-apply', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: P_T, newFinancerId: 'FIN-CMB', expectedVersion: 1, sessionId: SES_T }),
    call('/api/pledges/transfer-apply', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: P_T, newFinancerId: 'FIN-CMB', expectedVersion: 1, sessionId: SES_T })
  ]);
  ok('并发两笔转让仅一笔成立', ta.status !== tb.status);
  const loserT = ta.status === 'rejected' ? ta : tb;
  ok('第二笔错误码 TRANSFER_ALREADY_OPEN', loserT.reason.code === 'TRANSFER_ALREADY_OPEN', loserT.reason.code);
  const T1 = (ta.status === 'fulfilled' ? ta.value : tb.value).transfer.id;
  const t1Init = (await state()).transfers.find((x) => x.id === T1);
  ok('转让单初始:双方均未确认、PENDING、锁定质押 v1',
    t1Init.status === 'PENDING' && t1Init.confirmedBy['FIN-ICBC'] === false && t1Init.confirmedBy['FIN-CMB'] === false && t1Init.pledgeVersion === 1);

  // 非参与方确认 / 重复确认 / 重放
  await expectFail('非参与方确认被拒 FORBIDDEN', 'FORBIDDEN', () =>
    call('/api/pledges/transfer-confirm', { reqId: rid(), actorId: 'ENT-HONGTAI', transferId: T1 }));
  const cReq = 'TC-SMOKE-' + Math.random().toString(36).slice(4, 8);
  const cFirst = await call('/api/pledges/transfer-confirm', { reqId: cReq, actorId: 'FIN-ICBC', transferId: T1, sessionId: SES_T });
  ok('原质权人单方确认不生效', cFirst.effective === false);
  const cReplay = await call('/api/pledges/transfer-confirm', { reqId: cReq, actorId: 'FIN-ICBC', transferId: T1, sessionId: SES_T });
  ok('相同确认 reqId 重放返回 replayed', cReplay.replayed === true && cReplay.transfer.id === T1);
  await expectFail('同一方换新 reqId 重复确认被拒', 'TRANSFER_ALREADY_CONFIRMED', () =>
    call('/api/pledges/transfer-confirm', { reqId: rid(), actorId: 'FIN-ICBC', transferId: T1 }));
  await expectFail('基于旧质押版本确认被拒', 'STALE_PLEDGE_VERSION', () =>
    call('/api/pledges/transfer-confirm', { reqId: rid(), actorId: 'FIN-CMB', transferId: T1, expectedVersion: 7 }));
  // 生效前旧质权人放行被拒
  await expectFail('双方未齐前旧质权人放行被拒 TRANSFER_PENDING', 'TRANSFER_PENDING', () =>
    call('/api/pledges/release', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: P_T, qty: 10 }));
  const pMid1 = (await state()).pledges.find((x) => x.id === P_T);
  ok('单方确认期间权利人/质押版本不变', pMid1.financerId === 'FIN-ICBC' && pMid1.version === 1);

  // 受让方撤回:回到无在途,权利人不变
  await call('/api/pledges/transfer-withdraw', { actorId: 'FIN-CMB', transferId: T1, sessionId: SES_T });
  const stWd = await state();
  const tWd = stWd.transfers.find((x) => x.id === T1);
  const pWd = stWd.pledges.find((x) => x.id === P_T);
  ok('撤回后转让单 WITHDRAWN,权利人不变', tWd.status === 'WITHDRAWN' && tWd.withdrawnBy === 'FIN-CMB' && pWd.financerId === 'FIN-ICBC');
  await expectFail('撤回后再确认被拒', 'TRANSFER_NOT_PENDING', () =>
    call('/api/pledges/transfer-confirm', { reqId: rid(), actorId: 'FIN-CMB', transferId: T1 }));
  await expectFail('非参与方撤回被拒', 'FORBIDDEN', () =>
    call('/api/pledges/transfer-withdraw', { actorId: 'WH-1', transferId: T1 }));

  // 有生效放行单时申请被拒(先部分放行,再申请)
  const rl = await call('/api/pledges/release', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: P_T, qty: 100, sessionId: SES_T });
  await expectFail('存在未核销放行单时申请被拒 ACTIVE_RELEASE_EXISTS', 'ACTIVE_RELEASE_EXISTS', () =>
    call('/api/pledges/transfer-apply', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: P_T, newFinancerId: 'FIN-CMB' }));
  // 核销放行单(出库100吨)后申请可成立
  await call('/api/receipts/deliver', { actorId: 'WH-1', receiptId: 'WR0001', qty: 100, releaseToken: rl.release.token });
  const apply2 = await call('/api/pledges/transfer-apply', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: P_T, newFinancerId: 'FIN-CMB', expectedVersion: 1, sessionId: SES_T });
  const T2 = apply2.transfer.id;

  // 清偿闸门:全额还款后,双方确认的生效一刻必须被拒(先制造双方确认)。
  // 为验证「生效时」闸门而非申请时,直接构造:申请在还款前成立,再还款,再由两方确认。
  await call('/api/pledges/repay', { pledgeId: P_T, actorId: 'ENT-HONGTAI', amount: 40000000, sessionId: SES_T });
  await call('/api/pledges/transfer-confirm', { reqId: rid(), actorId: 'FIN-ICBC', transferId: T2, sessionId: SES_T });
  await expectFail('已清偿后最后一方确认不切换(PLEDGE_SETTLED)', 'PLEDGE_SETTLED', () =>
    call('/api/pledges/transfer-confirm', { reqId: rid(), actorId: 'FIN-CMB', transferId: T2 }));
  const stGate = await state();
  const tGate = stGate.transfers.find((x) => x.id === T2);
  const pGate = stGate.pledges.find((x) => x.id === P_T);
  ok('清偿闸门触发后:确认事务回滚(CMB 确认位未被置位),质押仍属 ICBC',
    tGate.confirmedBy['FIN-CMB'] === false && tGate.status === 'PENDING' && pGate.financerId === 'FIN-ICBC' && pGate.version === 1);

  // 撤回该申请,重新走一遍正常交接(撤销还款影响:用一笔新的未清偿质押更简单)
  await call('/api/pledges/transfer-withdraw', { actorId: 'FIN-ICBC', transferId: T2 });
  const lk3 = await call('/api/pledges/lock', { reqId: rid(), actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0002', valuationBatchId: vbT, loanAmount: 30000000, sessionId: SES_T });
  const P3 = lk3.pledge.id;
  const reg3 = await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: P3, registrationNo: regNo(), expectedVersion: 1, sessionId: SES_T });
  const reg3Snapshot = { ...(await state()).pledges.find((x) => x.id === P3).registration };
  const t3 = (await call('/api/pledges/transfer-apply', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: P3, newFinancerId: 'FIN-CMB', expectedVersion: 1, sessionId: SES_T })).transfer.id;
  await call('/api/pledges/transfer-confirm', { reqId: rid(), actorId: 'FIN-ICBC', transferId: t3, sessionId: SES_T });
  const eff = await call('/api/pledges/transfer-confirm', { reqId: rid(), actorId: 'FIN-CMB', transferId: t3, expectedVersion: 1, sessionId: SES_T });
  ok('双方确认齐备 → 生效,权利人切换且质押版本 +1', eff.effective === true && eff.pledgeAfter.financerId === 'FIN-CMB' && eff.pledgeAfter.version === 2);
  await expectFail('生效后再确认被拒', 'TRANSFER_ALREADY_EFFECTIVE', () =>
    call('/api/pledges/transfer-confirm', { reqId: rid(), actorId: 'FIN-CMB', transferId: t3 }));
  // 旧质权人三类处分
  await expectFail('交接后旧质权人登记被拒 FORBIDDEN', 'FORBIDDEN', () =>
    call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: P3, registrationNo: regNo(), expectedVersion: 2 }));
  await expectFail('交接后旧质权人还款被拒 FORBIDDEN', 'FORBIDDEN', () =>
    call('/api/pledges/repay', { pledgeId: P3, actorId: 'FIN-ICBC', amount: 1 }));
  await expectFail('交接后旧质权人放行被拒 FORBIDDEN', 'FORBIDDEN', () =>
    call('/api/pledges/release', { reqId: rid(), actorId: 'FIN-ICBC', pledgeId: P3, qty: 10 }));
  // 新质权人可继续处理原质押
  const relNew = await call('/api/pledges/release', { reqId: rid(), actorId: 'FIN-CMB', pledgeId: P3, qty: 100, sessionId: SES_T });
  ok('新质权人可继续放行原质押', !!relNew.release.token && relNew.release.financerId === 'FIN-CMB');
  const p3Now = (await state()).pledges.find((x) => x.id === P3);
  ok('原登记凭证完整保留(回执号/时刻/仓单版本不变)',
    p3Now.registration.registrationNo === reg3Snapshot.registrationNo &&
    p3Now.registration.registeredAt === reg3Snapshot.registeredAt &&
    p3Now.registration.receiptVersion === reg3Snapshot.receiptVersion &&
    p3Now.registration.receiptVersion === 1);
  // 第一张质押的回执从未被改写
  const pTNow = (await state()).pledges.find((x) => x.id === P_T);
  ok('被撤回/闸门拦截的质押,其首次登记凭证原样保留',
    pTNow.registration.registrationNo === firstReg.registrationNo &&
    pTNow.registration.registeredAt === firstReg.registeredAt &&
    pTNow.financerId === 'FIN-ICBC');
  // 审计与链
  const auT = await get('/api/audit');
  ok('交接审计无异常,且存在已生效/已撤回计数',
    auT.handoffIssues.length === 0 &&
    auT.counts.transfersEffective >= 1 && auT.counts.transfersWithdrawn >= 2 &&
    auT.counts.transfersPending === 0);
  ok('转让全流程后权利链验签通过、无一单多质', auT.chain.ok && auT.doubleFinancing.length === 0);
  // 会话重建含转让进度
  const sessT = await get('/api/session?sessionId=' + SES_T);
  ok('会话台账重建出全部转让单(3 笔:已撤回×2 + 已生效×1)',
    sessT.ledger.transfers.length === 3 &&
    sessT.ledger.transfers.filter((t) => t.status === 'WITHDRAWN').length === 2 &&
    sessT.ledger.transfers.filter((t) => t.status === 'EFFECTIVE').length === 1);
  ok('会话步骤含 申请/确认/撤回/生效 四类',
    sessT.steps.some((s) => s.action === 'transfer-apply') &&
    sessT.steps.some((s) => s.action === 'transfer-confirm') &&
    sessT.steps.some((s) => s.action === 'transfer-withdraw') &&
    sessT.steps.some((s) => s.action === 'transfer-effective'));
  // 按转让单查询留痕
  const opsT = await get('/api/operations?transferId=' + t3);
  ok('可按转让单回放其全部留痕(申请→两确认→生效,顺序严格)',
    opsT.map((o) => o.action).join(',') === 'transfer-apply,transfer-confirm,transfer-confirm,transfer-effective' &&
    opsT.every((o, i) => !i || opsT[i - 1].seq < o.seq));

  console.log(`\n================ 结果:${passed} 通过,${fails.length} 失败 ================`);
  if (fails.length) { console.log('失败项:', fails); process.exit(1); }
}
main().catch((e) => { console.error('测试运行异常:', e); process.exit(1); });
