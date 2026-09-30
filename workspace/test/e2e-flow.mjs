/**
 * e2e-flow.mjs —— 覆盖三页(仓库端 / 融资方端 / 监管端)串联流程的端到端测试。
 *
 * 零依赖,自起停服务(独立临时数据文件,不污染 data/db.json),并通过 test/mini-dom.mjs
 * 在 Node 中真实执行 public/common.js + 三个页面脚本:
 *
 *  A. 脚本联合运行:common.js 与各页脚本同页加载不再出现
 *     「Identifier 'api' has already been declared」,下拉由 /api/state 填充、按钮可点击;
 *  B. 三页串联:仓库端建仓单 → 融资方端 锁定→登记→清偿→授权(放行)→ 仓库端凭令牌出库,
 *     监管端按发生先后看到全部记录、链验签通过;
 *  C. 任何「页面刷新/角色跳转」都重新拉取后端既有状态,改后端再刷新必然看到新状态,
 *     不依赖(且不信任)任何前端缓存;
 *  D. 重复点击、竞争抢占、旧版本提交、越权请求一律显示原有拒绝信息,
 *     不造成额外质押,首次登记凭证(登记回执号、登记时间、登记时仓单版本)不被修改。
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { createBrowser } from './mini-dom.mjs';

const PORT = process.env.E2E_PORT || '3198';
const BASE = 'http://localhost:' + PORT;
const DB_FILE = process.env.EWR_E2E_DB || '/tmp/ewr-e2e-db.json';
const SESSION = 'SES-E2E-MAIN';

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
const rid = (p) => p + Math.random().toString(36).slice(4, 8).toUpperCase();
const regNo = () => 'REG-E2E-' + Math.random().toString(36).slice(2, 8).toUpperCase();
const waitReady = async () => {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/audit')).ok) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

/** 取页面最近一条 toast 文本(toast-host 是页面运行时创建的) */
function lastToast(browser) {
  const host = browser.find((el) => el.attrs.id === 'toast-host');
  if (!host || !host.children.length) return '';
  return host.children[host.children.length - 1].textContent;
}
const findBtn = (browser, text) =>
  browser.find((el) => el.tag === 'button' && el._text.includes(text));
const setVal = (browser, id, v) => { browser.byId(id).value = String(v); };

async function main() {
  if (existsSync(DB_FILE)) rmSync(DB_FILE);
  const srv = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT, EWR_DB_FILE: DB_FILE },
    stdio: 'ignore'
  });
  try {
    if (!(await waitReady())) throw new Error('服务启动超时');
    await call('/api/admin/reset');

    /* ============ A. 脚本联合运行:三页同 HTML 顺序加载,无全局词法冲突 ============ */
    console.log('\n=== A. 页面脚本联合运行(骨架复活:下拉有数据、按钮可点)===');
    for (const [script, selects] of [
      ['warehouse.js', [['f-loc', 3], ['f-grade', 2], ['f-holder', 2]]],
      ['financier.js', [['p-fin', 2], ['p-receipt', 3], ['p-batch', 1]]],
      ['regulator.js', []]
    ]) {
      const b = createBrowser(BASE);
      b.load('common.js');
      b.load(script); // 修复前此处抛 SyntaxError: Identifier 'api' has already been declared
      await b.flush(120);
      ok(`${script} 与 common.js 同页加载成功并完成首屏渲染`, true);
      for (const [id, n] of selects) {
        const opts = b.byId(id).querySelectorAll('option');
        ok(`${script} 下拉 #${id} 由后端数据填充(${n} 项)`, opts.length === n, `实际 ${opts.length}`);
      }
    }
    const wh = createBrowser(BASE); wh.load('common.js'); wh.load('warehouse.js'); await wh.flush(120);
    const finBoot = createBrowser(BASE); finBoot.load('common.js'); finBoot.load('financier.js'); await finBoot.flush(120);
    ok('仓库端「登记仓单」按钮已绑定事件', typeof wh.byId('btn-register').onclick === 'function');
    ok('融资方端「锁定质押」按钮已绑定事件', typeof finBoot.byId('btn-lock').onclick === 'function');
    const reg = createBrowser(BASE); reg.load('common.js'); reg.load('regulator.js'); await reg.flush(150);
    ok('监管端首屏权利链验签通过(统计卡渲染)', reg.byId('stats').querySelectorAll('.card').length === 10);
    /* ============ B. 三页串联:建仓单 → 锁定 → 登记 → 清偿 → 授权 → 出库 → 监管可见 ============ */
    console.log('\n=== B. 三页串联(仓库建单 → 金融锁定/登记/清偿/授权 → 仓库出库 → 监管留痕)===');
    const vb = (await get('/api/state')).valuationBatches[0].id;

    // B1. 经办人在仓库端页面点「登记仓单」
    setVal(wh, 'f-loc', 'LOC-A1');
    wh.byId('f-loc').value = 'LOC-A1'; // 触发后需重算品级下拉(syncGradeOptions 由 change 事件驱动,此处直接重设品级)
    wh.byId('f-grade').value = 'CU-A';
    wh.byId('f-holder').value = 'ENT-HONGTAI';
    setVal(wh, 'f-qty', '700');
    await wh.click(wh.byId('btn-register'));
    await wh.flush(150);
    ok('仓库端登记成功提示新仓单号', /WR\d{4}/.test(lastToast(wh)), lastToast(wh));
    const sAfterReg = await get('/api/state');
    const newReceipt = sAfterReg.receipts.find((r) => r.qty === 700 && r.locationId === 'LOC-A1');
    ok('仓单确实落库(后端存在,非前端伪造)', !!newReceipt && newReceipt.status === 'ACTIVE', newReceipt?.id);
    const NEW_R = newReceipt.id;
    const loan = Math.floor(newReceipt.marketValue * 0.7); // 70% 以内

    // B2. 融资方端:锁定 —— 走页面表单点击,会话号固定为 SESSION
    const finPage = createBrowser(BASE);
    finPage.localStorage.set('ewr-financier-session', SESSION);
    finPage.load('common.js'); finPage.load('financier.js');
    await finPage.flush(150);
    finPage.byId('p-fin').value = 'FIN-ICBC';
    finPage.byId('p-receipt').value = NEW_R;
    finPage.byId('p-batch').value = vb;
    finPage.byId('p-amount').value = String(loan);
    await finPage.click(finPage.byId('btn-lock'));
    await finPage.flush(180);
    ok('页面锁定成功且提示未登记不得宣称生效', /已锁定/.test(lastToast(finPage)) && !/已登记/.test(lastToast(finPage)), lastToast(finPage));
    const pledgesAfterLock = (await get('/api/state')).pledges.filter((p) => p.receiptId === NEW_R);
    ok('后端仅产生一笔 LOCKED 质押', pledgesAfterLock.length === 1 && pledgesAfterLock[0].status === 'LOCKED');
    const P = pledgesAfterLock[0];
    ok('锁定仓单版本/估值批次/权利人三要素', P.receiptVersion === 1 && P.valuationBatchId === vb && P.financerId === 'FIN-ICBC');
    ok('登记前 canPubliclyClaimEffective=false', P.canPubliclyClaimEffective === false);

    // B3. 登记:点台账「登记」→ 弹窗 → 提交
    let rowBtn = finPage.find((el) => el.tag === 'button' && el._text === '登记');
    ok('LOCKED 质押台账出现「登记」按钮', !!rowBtn);
    await finPage.click(rowBtn);
    await finPage.flush(60);
    const regNoInput = finPage.byId('reg-no');
    ok('登记弹窗已渲染(登记回执号输入框存在)', !!regNoInput && /REG/.test(regNoInput.value));
    const REG_NO = regNoInput.value.trim();
    const submitReg = findBtn(finPage, '提交登记');
    await finPage.click(submitReg);
    await finPage.flush(180);
    ok('页面提示登记成功、担保生效', /登记成功/.test(lastToast(finPage)), lastToast(finPage));
    let pNow = (await get('/api/state')).pledges.find((x) => x.id === P.id);
    ok('后端质押 REGISTERED 且回执号即弹窗中的回执号',
      pNow.status === 'REGISTERED' && pNow.registration.registrationNo === REG_NO);
    const FIRST_REG = { ...pNow.registration };

    // B4. 清偿:点「还款」→ 弹窗 → 默认按敞口全额还
    const repayBtn = findBtn(finPage, '还款');
    await finPage.click(repayBtn);
    await finPage.flush(60);
    const rpAmount = finPage.byId('rp-amount');
    ok('还款弹窗默认填入当前敞口', Number(rpAmount.value) === loan, rpAmount.value);
    await finPage.click(findBtn(finPage, '确认还款'));
    await finPage.flush(180);
    ok('页面提示剩余敞口 0', /剩余敞口\s*¥?0/.test(lastToast(finPage)), lastToast(finPage));
    pNow = (await get('/api/state')).pledges.find((x) => x.id === P.id);
    ok('后端敞口已清零', pNow.exposure === 0 && pNow.coveredAmount === loan);

    // B5. 授权:点「放行出库」→ 弹窗 → 留空(=全额)签发
    await finPage.click(findBtn(finPage, '放行出库'));
    await finPage.flush(60);
    await finPage.click(findBtn(finPage, '签发放行单'));
    await finPage.flush(180);
    ok('页面签发放行单并给出令牌', /放行单已签发/.test(lastToast(finPage)) && /TKN-/.test(lastToast(finPage)), lastToast(finPage));
    const releases = (await get('/api/state')).releases.filter((r) => r.pledgeId === P.id);
    ok('后端仅一张放行单(全额)', releases.length === 1 && releases[0].remaining === 0 && !!releases[0].token);
    const TOKEN = releases[0].token;

    // B6. 仓库端凭令牌出库(刷新仓库页后操作 —— 状态全部来自后端)
    await wh.click(wh.byId('btn-refresh'));
    await wh.flush(150);
    const whRow = wh.find((el) => el.tag === 'button' && el.attrs.onclick?.includes(`askDeliver('${NEW_R}')`));
    ok('仓库页刷新后出现新仓单的「出库」按钮', !!whRow);
    await wh.click(whRow);
    await wh.flush(60);
    setVal(wh, 'dl-token', TOKEN);
    await wh.click(findBtn(wh, '办理出库'));
    await wh.flush(180);
    ok('仓库端凭金融端令牌出库成功', /出库成功/.test(lastToast(wh)), lastToast(wh));
    const finalReceipt = (await get('/api/state')).receipts.find((r) => r.id === NEW_R);
    pNow = (await get('/api/state')).pledges.find((x) => x.id === P.id);
    ok('仓单 DELIVERED、质押随全部出库结清归档', finalReceipt.status === 'DELIVERED' && pNow.status === 'DELIVERED');

    /* ============ C. 刷新/角色跳转:全部重显后端既有状态,无前端缓存伪造 ============ */
    console.log('\n=== C. 页面刷新/角色跳转后按后端既有状态重建 ===');
    // 全新浏览器上下文(无任何前端缓存)打开三页,均显示后端既有结果
    const whFresh = createBrowser(BASE); whFresh.load('common.js'); whFresh.load('warehouse.js'); await whFresh.flush(150);
    ok('仓库端刷新后仍显示新仓单(DELIVERED)', !!whFresh.find((el) => el.tag === 'b' && el._text === NEW_R));
    const finFresh = createBrowser(BASE);
    finFresh.localStorage.set('ewr-financier-session', SESSION);
    finFresh.load('common.js'); finFresh.load('financier.js'); await finFresh.flush(150);
    ok('融资方端刷新后由 /api/session 重建同一会话(锁/登/还/放 4 步齐全)',
      /会话号/.test(finFresh.byId('session-box').innerHTML) &&
      finFresh.byId('tbl-steps').querySelectorAll('tr').length === 4,
      'trs=' + finFresh.byId('tbl-steps').querySelectorAll('tr').length);
    ok('融资方端刷新后步骤中含首次登记回执号与放行令牌',
      finFresh.byId('tbl-steps').innerHTML.includes(REG_NO) &&
      finFresh.byId('tbl-steps').innerHTML.includes(TOKEN));
    const regFresh = createBrowser(BASE); regFresh.load('common.js'); regFresh.load('regulator.js'); await regFresh.flush(200);
    ok('监管端刷新即展示最新验签结果与事件流',
      /全部哈希衔接/.test(regFresh.byId('chain-box').innerHTML) &&
      regFresh.byId('tbl-events').querySelectorAll('tr').length > 5);

    // 反向证明:直接在后端制造变化(再登记一张仓单),刷新页面必须看到 —— 不靠前端缓存
    const extra = await call('/api/receipts/register', {
      actorId: 'WH-1', locationId: 'LOC-A2', gradeId: 'CU-A', holderId: 'ENT-HONGTAI', qty: 123
    });
    ok('后端直接新增仓单成功', !!extra.id);
    ok('刷新前页面看不到新单(前端状态是旧的)', !whFresh.byId('tbl-receipts').innerHTML.includes(extra.id));
    await whFresh.click(whFresh.byId('btn-refresh'));
    await whFresh.flush(150);
    ok('刷新后立即显示后端新单(状态以服务端为准)', whFresh.byId('tbl-receipts').innerHTML.includes(extra.id));

    /* ============ D. 对抗:重复点击 / 竞争抢占 / 旧版本 / 越权,只显原拒绝、不生额外质押 ============ */
    console.log('\n=== D. 对抗场景(原拒绝信息可见,无额外质押,首次登记凭证不变)===');
    // 为每个对抗场景准备独立仓单,互不污染(经后端创建,随后全部经页面操作)
    const mkReceipt = async (loc, qty) =>
      (await call('/api/receipts/register', {
        actorId: 'WH-1', locationId: loc, gradeId: loc === 'LOC-B1' ? 'AL-A' : 'CU-A',
        holderId: 'ENT-HONGTAI', qty
      })).id;
    const [R_CLICK, R_RACE, R_STALE, R_REPLAY, R_FORBID] = await Promise.all([
      mkReceipt('LOC-A1', 300), mkReceipt('LOC-A2', 300),
      mkReceipt('LOC-A1', 320), mkReceipt('LOC-A2', 320), mkReceipt('LOC-B1', 500)
    ]);

    // 页面内的拒绝路径与页面脚本一致(common.js 的 api 抛出 code/message),断言「原有拒绝信息」
    const pageReject = async (browser, payload) => {
      try {
        await browser.evalAsync(
          `EWR.api(${JSON.stringify(payload.path)}, ${JSON.stringify(payload.body)})`
        );
        return null;
      } catch (e) {
        return { code: e.code, message: e.message };
      }
    };

    const adv = createBrowser(BASE);
    adv.localStorage.set('ewr-financier-session', 'SES-E2E-ADV');
    adv.load('common.js'); adv.load('financier.js'); await adv.flush(150);

    // D1. 重复点击「锁定质押」:第一次成功,第二次显示原有拒绝(ALREADY_PLEDGED 原文)
    adv.byId('p-fin').value = 'FIN-ICBC';
    adv.byId('p-receipt').value = R_CLICK;
    adv.byId('p-batch').value = vb;
    adv.byId('p-amount').value = '10000000';
    await adv.click(adv.byId('btn-lock'));
    await adv.flush(200);
    const lockToast1 = lastToast(adv);
    ok('首次锁定成功', /质押已锁定/.test(lockToast1), lockToast1);
    const clickP = (await get('/api/state')).pledges.filter((p) => p.receiptId === R_CLICK).pop();
    // runStep 结束后页面按后端刷新并清空金额,模拟用户连点前重新输入
    adv.byId('p-amount').value = '10000000';
    await adv.click(adv.byId('btn-lock'));
    await adv.flush(200);
    const lockToast2 = lastToast(adv);
    ok('重复点击锁定显示原有拒绝信息(ALREADY_PLEDGED 原文)',
      /已存在/.test(lockToast2) && /禁止重复融资/.test(lockToast2), lockToast2);
    ok('重复点击未产生第二笔质押(该仓单仍仅 1 笔存续)',
      (await get('/api/state')).pledges.filter((p) => p.receiptId === R_CLICK &&
        ['LOCKED', 'REGISTERED', 'SUPPLEMENTING'].includes(p.status)).length === 1);

    // D2. 竞争抢占:页面「两家机构并发质押」演练,仅一家成功、另一家显示原拒绝
    await adv.evalInPage('refresh()');
    await adv.flush(200);
    const beforeRacePledges = (await get('/api/state')).pledges.length;
    adv.byId('race-receipt').value = R_RACE;
    await adv.evalInPage('scenarioRace()');
    await adv.flush(350);
    const raceToast = lastToast(adv);
    ok('竞争抢占演练显示:一家成功、第二家被拒原文',
      /并发质押结果/.test(raceToast) && /禁止重复融资/.test(raceToast), raceToast);
    ok('竞争抢占未产生额外质押(全局总数只 +1)',
      (await get('/api/state')).pledges.length === beforeRacePledges + 1);
    const raceOps = await get('/api/operations?receiptId=' + R_RACE);
    ok('竞争双方均留痕:1 SUCCESS + 1 CONFLICT(ALREADY_PLEDGED)',
      raceOps.filter((o) => o.outcome === 'SUCCESS').length === 1 &&
      raceOps.some((o) => o.outcome === 'CONFLICT' && o.reasonCode === 'ALREADY_PLEDGED'));

    // D3. 旧版本提交:页面「用旧版本号登记」演练(先复检推版本,再持旧 v1 登记)
    const staleLockReq = rid('LOCKSTALE');
    await call('/api/pledges/lock', {
      reqId: staleLockReq, actorId: 'FIN-CMB', financerId: 'FIN-CMB',
      receiptId: R_STALE, valuationBatchId: vb, loanAmount: 1000000, sessionId: 'SES-E2E-ADV'
    });
    const staleP = (await get('/api/state')).pledges.find((p) => p.receiptId === R_STALE);
    await adv.evalInPage('refresh()'); // 页面 STATE 从后端重建,演练下拉方可识别新建质押
    await adv.flush(200);
    adv.byId('stale-pledge').value = staleP.id;
    await adv.evalInPage('scenarioStale()');
    await adv.flush(400);
    const staleToast = lastToast(adv);
    ok('旧版本晚到登记显示 STALE_RECEIPT_VERSION 原拒绝',
      /旧版晚到被阻止/.test(staleToast) &&
      /登记基于仓单版本 v1,但当前已为 v2/.test(staleToast), staleToast);
    const stalePNow = (await get('/api/state')).pledges.find((p) => p.id === staleP.id);
    ok('旧版被拒后质押仍存续 LOCKED,未被抹除', stalePNow.status === 'LOCKED', stalePNow.status);
    const staleOps = await get('/api/operations?pledgeId=' + staleP.id + '&outcome=CONFLICT');
    ok('旧版拒绝留痕含具体版本号原因(v1→v2)',
      staleOps.some((o) => o.reasonCode === 'STALE_RECEIPT_VERSION' && /v1/.test(o.reason) && /v2/.test(o.reason)));

    // D4. 相同登记回执重放(页面演练):首次登记后同号再放,显示原回执、不产生新担保
    const replayLockReq = rid('LOCKREPLAY');
    await call('/api/pledges/lock', {
      reqId: replayLockReq, actorId: 'FIN-ICBC', financerId: 'FIN-ICBC',
      receiptId: R_REPLAY, valuationBatchId: vb, loanAmount: 1000000, sessionId: 'SES-E2E-ADV'
    });
    const replayP = (await get('/api/state')).pledges.find((p) => p.receiptId === R_REPLAY);
    await adv.evalInPage('refresh()'); // 演练下拉重建后才包含刚经 API 锁定的新质押
    await adv.flush(200);
    adv.byId('replay-pledge').value = replayP.id;
    const pledgeCountBeforeReplay = (await get('/api/state')).pledges.length;
    await adv.evalInPage('scenarioReplay()');
    await adv.flush(400);
    const replayToast = lastToast(adv);
    ok('相同回执重放显示:返回原登记结果、未产生第二笔担保',
      /replayed=true/.test(replayToast) && /未产生第二笔/.test(replayToast), replayToast);
    ok('重放未产生新质押,WR 仍仅一笔且已登记',
      (await get('/api/state')).pledges.filter((p) => p.receiptId === R_REPLAY).length === 1 &&
      (await get('/api/state')).pledges.length === pledgeCountBeforeReplay);
    const replayRegistered = (await get('/api/state')).pledges.find((p) => p.receiptId === R_REPLAY);
    const FIRST_ADV_REG_NO = replayRegistered.registration.registrationNo;

    // D5. 越权请求:非当前质权人登记 / 放行 / 重放,均显示 FORBIDDEN 原文
    await call('/api/pledges/lock', {
      reqId: rid('LOCKFORBID'), actorId: 'FIN-ICBC', financerId: 'FIN-ICBC',
      receiptId: R_FORBID, valuationBatchId: vb, loanAmount: 1000000, sessionId: 'SES-E2E-ADV'
    });
    const forbidP = (await get('/api/state')).pledges.find((p) => p.receiptId === R_FORBID);
    // 走页面内 api(与按钮点击同一拒绝路径),非当前质权人 FIN-CMB 试图登记
    const denyReg = await pageReject(adv, {
      path: '/api/pledges/register',
      body: { actorId: 'FIN-CMB', pledgeId: forbidP.id, registrationNo: regNo(), expectedVersion: 1, sessionId: 'SES-E2E-ADV' }
    });
    ok('越权登记显示原拒绝 FORBIDDEN(仅当前质权人)',
      denyReg && denyReg.code === 'FORBIDDEN' && /仅当前质权人\s*FIN-ICBC\s*可登记/.test(denyReg.message), denyReg?.message);
    // 非当前质权人用新 reqId 放行
    const denyRel = await pageReject(adv, {
      path: '/api/pledges/release',
      body: { reqId: rid('RELX'), actorId: 'FIN-CMB', pledgeId: forbidP.id, qty: 10, sessionId: 'SES-E2E-ADV' }
    });
    ok('越权放行显示原拒绝 FORBIDDEN(可放行货物)',
      denyRel && denyRel.code === 'FORBIDDEN' && /可放行货物/.test(denyRel.message), denyRel?.message);
    // 非原请求方持他人锁仓 reqId 重放同样拒绝(不得借重放窥得/操作他人质押)
    const denyReplay = await pageReject(adv, {
      path: '/api/pledges/lock',
      body: { reqId: replayLockReq, actorId: 'FIN-CMB', financerId: 'FIN-CMB', receiptId: R_REPLAY,
        valuationBatchId: vb, loanAmount: 1000000, sessionId: 'SES-E2E-ADV' }
    });
    ok('非原请求方重放他人锁仓请求显示 FORBIDDEN',
      denyReplay && denyReplay.code === 'FORBIDDEN' && /可重放/.test(denyReplay.message), denyReplay?.message);
    ok('全部越权请求后各仓单仍仅原机构一笔质押,状态未变',
      (await get('/api/state')).pledges.filter((p) => p.receiptId === R_FORBID).length === 1 &&
      (await get('/api/state')).pledges.find((p) => p.id === replayP.id).registration.registrationNo === FIRST_ADV_REG_NO);

    /* ============ E. 监管端看到对应先后记录,首次登记凭证不变,链验签通过 ============ */
    console.log('\n=== E. 监管端:先后顺序 / 回执 / 令牌 / 拒绝留痕 / 首次登记凭证 ===');
    // 监管页加载时即调 loadOperations()(无过滤=全部);再触发一次「查询」确认按钮路径同样工作
    await regFresh.evalInPage('loadOperations()');
    await regFresh.flush(200);
    ok('监管操作表加载全部留痕(成功+冲突+拒绝)', regFresh.byId('tbl-ops').querySelectorAll('tr').length > 8);
    const opsMain = await get('/api/operations?sessionId=' + SESSION);
    const seqMain = opsMain.map((o) => o.seq);
    ok('主会话留痕严格按发生先后排序', seqMain.every((v, i) => !i || seqMain[i - 1] < v));
    const actionOrder = opsMain.map((o) => o.action);
    ok('先后顺序为 锁定→登记→还款→放行',
      actionOrder.indexOf('lock') < actionOrder.indexOf('register') &&
      actionOrder.indexOf('register') < actionOrder.indexOf('repay') &&
      actionOrder.indexOf('repay') < actionOrder.indexOf('release'),
      actionOrder.join(','));
    const tl = await get('/api/receipt?id=' + NEW_R);
    ok('该仓单时间线回放含登记回执号', tl.operations.some((o) => o.ref && o.ref.registrationNo === REG_NO));
    ok('该仓单时间线回放含放行令牌', tl.operations.some((o) => o.ref && o.ref.token === TOKEN));

    // 首次登记凭证不被任何对抗操作修改
    const pledgeFinal = (await get('/api/state')).pledges.find((x) => x.id === P.id);
    ok('首次登记凭证三要素(回执号/登记时刻/登记时仓单版本)未被修改',
      pledgeFinal.registration.registrationNo === FIRST_REG.registrationNo &&
      pledgeFinal.registration.registeredAt === FIRST_REG.registeredAt &&
      pledgeFinal.registration.receiptVersion === FIRST_REG.receiptVersion);
    ok('全部质押中该回执号仅出现一次(无第二笔登记担保)',
      (await get('/api/state')).pledges.filter((p) => p.registration?.registrationNo === REG_NO).length === 1);

    // 拒绝记录均可在监管端按结果过滤检索,且未改业务状态
    const rejected = await get('/api/operations?outcome=REJECTED');
    ok('全部越权请求均留下 REJECTED/FORBIDDEN 记录',
      rejected.filter((o) => o.reasonCode === 'FORBIDDEN').length >= 3);
    const conflicts = await get('/api/operations?outcome=CONFLICT');
    ok('重复/竞争/旧版均留下 CONFLICT 记录',
      conflicts.some((o) => o.reasonCode === 'ALREADY_PLEDGED') &&
      conflicts.some((o) => o.reasonCode === 'STALE_RECEIPT_VERSION') &&
      conflicts.some((o) => o.reasonCode === 'IDEMPOTENT_REPLAY'));

    const audit = await get('/api/audit');
    ok('最终权利链验签通过', audit.chain.ok);
    ok('无一单多质 / 无区间重叠 / 无提前宣称',
      audit.doubleFinancing.length === 0 && audit.overlaps.length === 0 && audit.prematureClaims.length === 0);

    /* ============ F. 质权转让与交接(I8):双方确认/撤回/对抗/刷新恢复/监管回放 ============ */
    console.log('\n=== F. 质权转让与交接(双方确认 · 撤回 · 对抗 · 刷新恢复 · 监管回放)===');
    const R_TR = (await call('/api/receipts/register', {
      actorId: 'WH-1', locationId: 'LOC-B1', gradeId: 'AL-A', holderId: 'ENT-LVYE', qty: 900
    })).id;
    const trLock = await call('/api/pledges/lock', {
      reqId: rid('LOCKTR'), actorId: 'FIN-ICBC', financerId: 'FIN-ICBC',
      receiptId: R_TR, valuationBatchId: vb, loanAmount: 5000000, sessionId: 'SES-E2E-TRANSFER'
    });
    const TR_P = trLock.pledge.id;
    await call('/api/pledges/register', {
      actorId: 'FIN-ICBC', pledgeId: TR_P, registrationNo: 'REG-TRANSFER-1',
      expectedVersion: 1, sessionId: 'SES-E2E-TRANSFER'
    });
    const TR_FIRST_REG = { ...(await get('/api/state')).pledges.find((x) => x.id === TR_P).registration };

    // 页面刷新即从后端恢复:全新页面上下文能看到该质押与「质权转让」按钮
    const trPage = createBrowser(BASE);
    trPage.localStorage.set('ewr-financier-session', 'SES-E2E-TRANSFER');
    trPage.load('common.js'); trPage.load('financier.js'); await trPage.flush(180);
    ok('融资方页面渲染转让面板与在途表(表头在)',
      trPage.byId('tbl-transfers').querySelectorAll('tbody tr').length === 1);
    ok('已登记质押台账出现「质权转让」按钮', !!trPage.find((el) => el.tag === 'button' && el._text === '质权转让'));

    // 经页面 api 走完整对抗矩阵,断言「明确结果 + 不产生双重权利人/不重复生效/不改原凭证」
    const apiPage = async (path, body) => pageReject(trPage, { path, body }).then((e) => e);
    const applyOk = async (body) => trPage.evalAsync(`EWR.api(${JSON.stringify('/api/pledges/transfer-apply')}, ${JSON.stringify(body)})`);
    const confirmOk = async (body) => trPage.evalAsync(`EWR.api(${JSON.stringify('/api/pledges/transfer-confirm')}, ${JSON.stringify(body)})`);
    const withdrawOk = async (body) => trPage.evalAsync(`EWR.api(${JSON.stringify('/api/pledges/transfer-withdraw')}, ${JSON.stringify(body)})`);
    async function expectPageReject(name, code, p) {
      try { await p; ok(name, false, '应当失败但成功了'); }
      catch (e) { ok(name + ` [${e.code}]`, e.code === code, `期望 ${code},实际 ${e.code}`); }
    }

    // F1. 未登记质押不可转让(用此前场景里的 LOCKED 质押,如无则跳过——必有 staleP)
    await expectPageReject('未登记质押不能转让(PLEDGE_NOT_REGISTERED)', 'PLEDGE_NOT_REGISTERED',
      applyOk({ reqId: rid('TA'), actorId: 'FIN-CMB', pledgeId: staleP.id, newFinancerId: 'FIN-ICBC', sessionId: 'SES-E2E-TRANSFER' }));
    // F2. 非参与方发起被拒
    await expectPageReject('非参与方发起转让被拒 FORBIDDEN', 'FORBIDDEN',
      applyOk({ reqId: rid('TA'), actorId: 'ENT-LVYE', pledgeId: TR_P, newFinancerId: 'FIN-CMB', sessionId: 'SES-E2E-TRANSFER' }));
    // F3. 并发两笔转让(各自 reqId,几乎同时):仅一笔成立
    const [aa, ab] = await Promise.allSettled([
      applyOk({ reqId: rid('TA'), actorId: 'FIN-ICBC', pledgeId: TR_P, newFinancerId: 'FIN-CMB', expectedVersion: 1, sessionId: 'SES-E2E-TRANSFER' }),
      applyOk({ reqId: rid('TA'), actorId: 'FIN-ICBC', pledgeId: TR_P, newFinancerId: 'FIN-CMB', expectedVersion: 1, sessionId: 'SES-E2E-TRANSFER' })
    ]);
    // evalAsync 成功 resolve 数据,失败 reject 跨realm 错误(code/message)
    const results = [aa, ab].map((x) => (x.status === 'fulfilled' ? x.value : { code: x.reason.code, message: x.reason.message }));
    ok('并发两笔转让:恰好一笔成功', results.filter((x) => x && x.transfer).length === 1, JSON.stringify(results.map((x) => x && (x.code || x.transfer?.id))));
    ok('第二笔返回 TRANSFER_ALREADY_OPEN', results.some((x) => x && x.code === 'TRANSFER_ALREADY_OPEN'));
    const TR_T = results.find((x) => x && x.transfer).transfer.id;

    // F4. 非参与方确认 / 同一方重复确认 / 相同确认 reqId 重放
    const denyConfirm = await apiPage('/api/pledges/transfer-confirm', { reqId: rid('TC'), actorId: 'ENT-LVYE', transferId: TR_T, sessionId: 'SES-E2E-TRANSFER' });
    ok('非参与方确认被拒 FORBIDDEN(明确结果)', denyConfirm && denyConfirm.code === 'FORBIDDEN', denyConfirm?.code);
    const confirmReq = rid('TC');
    const c1 = await confirmOk({ reqId: confirmReq, actorId: 'FIN-ICBC', transferId: TR_T, sessionId: 'SES-E2E-TRANSFER' });
    ok('原质权人首次确认:未生效,等待受让机构', c1.effective === false && c1.transfer.confirmedBy['FIN-CMB'] === false);
    const c1replay = await confirmOk({ reqId: confirmReq, actorId: 'FIN-ICBC', transferId: TR_T, sessionId: 'SES-E2E-TRANSFER' });
    ok('同一确认再次提交(相同 reqId)识别为重放', c1replay.replayed === true && c1replay.transfer.id === TR_T);
    const dupConfirm = await apiPage('/api/pledges/transfer-confirm', { reqId: rid('TC'), actorId: 'FIN-ICBC', transferId: TR_T, sessionId: 'SES-E2E-TRANSFER' });
    ok('同一方换新 reqId 重复确认返回 TRANSFER_ALREADY_CONFIRMED', dupConfirm && dupConfirm.code === 'TRANSFER_ALREADY_CONFIRMED', dupConfirm?.code);

    // F5. 生效前旧质权人放行被拒
    const earlyRel = await apiPage('/api/pledges/release', { reqId: rid('RL'), actorId: 'FIN-ICBC', pledgeId: TR_P, qty: 10, sessionId: 'SES-E2E-TRANSFER' });
    ok('双方未齐前旧质权人放行被拒 TRANSFER_PENDING', earlyRel && earlyRel.code === 'TRANSFER_PENDING', earlyRel?.code);
    let pMid = (await get('/api/state')).pledges.find((x) => x.id === TR_P);
    ok('单方确认期间权利人不变、质押版本不变', pMid.financerId === 'FIN-ICBC' && pMid.version === 1);

    // F6. 任一方撤回:受让机构撤回 → 状态 WITHDRAWN,权利人不变;再确认/再撤回均有明确结果
    await withdrawOk({ actorId: 'FIN-CMB', transferId: TR_T, sessionId: 'SES-E2E-TRANSFER' });
    pMid = (await get('/api/state')).pledges.find((x) => x.id === TR_P);
    ok('撤回后权利人仍为 FIN-ICBC、质押版本仍 v1', pMid.financerId === 'FIN-ICBC' && pMid.version === 1);
    const confirmAfterWd = await apiPage('/api/pledges/transfer-confirm', { reqId: rid('TC'), actorId: 'FIN-CMB', transferId: TR_T, sessionId: 'SES-E2E-TRANSFER' });
    ok('撤回后再确认返回 TRANSFER_NOT_PENDING', confirmAfterWd && confirmAfterWd.code === 'TRANSFER_NOT_PENDING', confirmAfterWd?.code);

    // F7. 重新发起:基于旧质押版本(v1 仍是当前版本,用 v99 制造陈旧)与当前版本
    const staleConfirm = await apiPage('/api/pledges/transfer-apply', { reqId: rid('TA'), actorId: 'FIN-ICBC', pledgeId: TR_P, newFinancerId: 'FIN-CMB', expectedVersion: 99, sessionId: 'SES-E2E-TRANSFER' });
    ok('基于旧质押版本发起被拒 STALE_PLEDGE_VERSION', staleConfirm && staleConfirm.code === 'STALE_PLEDGE_VERSION', staleConfirm?.code);
    const apply2 = await applyOk({ reqId: rid('TA'), actorId: 'FIN-ICBC', pledgeId: TR_P, newFinancerId: 'FIN-CMB', expectedVersion: 1, sessionId: 'SES-E2E-TRANSFER' });
    ok('撤回后可重新发起转让(新转让单 PENDING)', apply2.transfer.status === 'PENDING' && apply2.transfer.id !== TR_T, apply2.transfer?.id);
    const TR_T2 = apply2.transfer.id;

    // F8. 在途唯一性:另一参与方再发一笔仍被拒;相同申请 reqId 重放返回首次结论
    const thirdApply = await apiPage('/api/pledges/transfer-apply', { reqId: rid('TA'), actorId: 'FIN-CMB', pledgeId: TR_P, newFinancerId: 'FIN-ICBC', sessionId: 'SES-E2E-TRANSFER' });
    // 注:CMB 不能把质权转给自己也不能转给 ICBC(=当前质权人)由 BAD_ASSIGNEE 拦;
    // 在途唯一性的权威断言用「同一对主体的第二个 reqId」,下两行即覆盖。
    ok('在途期间任何额外申请都被明确拒绝(不静默丢弃)',
      thirdApply.code === 'BAD_ASSIGNEE' || thirdApply.code === 'TRANSFER_ALREADY_OPEN', thirdApply.code);
    const applyReq2 = 'TA-REPLAY-' + Math.random().toString(36).slice(2, 8);
    const applyFirst = await applyOk({ reqId: applyReq2, actorId: 'FIN-ICBC', pledgeId: TR_P, newFinancerId: 'FIN-CMB', expectedVersion: 1, sessionId: 'SES-E2E-TRANSFER' }).catch((e) => ({ __rejected: e.code }));
    // 此时已有在途单,首次调用必然冲突;真正验证的是「同 reqId 重放始终返回同一结论」
    const applySecond = await apiPage('/api/pledges/transfer-apply', { reqId: applyReq2, actorId: 'FIN-ICBC', pledgeId: TR_P, newFinancerId: 'FIN-CMB', expectedVersion: 1, sessionId: 'SES-E2E-TRANSFER' });
    ok('相同申请 reqId 重放返回首次结论(TRANSFER_ALREADY_OPEN),不产生第二笔',
      applyFirst.__rejected === 'TRANSFER_ALREADY_OPEN' && applySecond.code === 'TRANSFER_ALREADY_OPEN',
      `${applyFirst.__rejected}/${applySecond.code}`);

    // F9. 双方确认齐备(本次为最后一方)→ 生效;旧质权人三类处分全被拒;新质权人可继续
    await confirmOk({ reqId: rid('TC'), actorId: 'FIN-ICBC', transferId: TR_T2, sessionId: 'SES-E2E-TRANSFER' });
    const eff = await confirmOk({ reqId: rid('TC'), actorId: 'FIN-CMB', transferId: TR_T2, expectedVersion: 1, sessionId: 'SES-E2E-TRANSFER' });
    ok('双方确认 → 交接生效,质押版本 +1', eff.effective === true && eff.pledgeAfter.financerId === 'FIN-CMB' && eff.pledgeAfter.version === 2, JSON.stringify(eff.pledgeAfter));
    const confirmAfterEff = await apiPage('/api/pledges/transfer-confirm', { reqId: rid('TC'), actorId: 'FIN-CMB', transferId: TR_T2, sessionId: 'SES-E2E-TRANSFER' });
    ok('生效后再确认返回 TRANSFER_ALREADY_EFFECTIVE', confirmAfterEff && confirmAfterEff.code === 'TRANSFER_ALREADY_EFFECTIVE', confirmAfterEff?.code);
    const oldRegister = await apiPage('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: TR_P, registrationNo: 'REG-HACK', expectedVersion: 2, sessionId: 'SES-E2E-TRANSFER' });
    const oldRepay = await apiPage('/api/pledges/repay', { pledgeId: TR_P, actorId: 'FIN-ICBC', amount: 1, sessionId: 'SES-E2E-TRANSFER' });
    const oldRelease = await apiPage('/api/pledges/release', { reqId: rid('RL'), actorId: 'FIN-ICBC', pledgeId: TR_P, qty: 10, sessionId: 'SES-E2E-TRANSFER' });
    ok('旧质权人登记/清偿/放行全部 FORBIDDEN',
      oldRegister.code === 'FORBIDDEN' && oldRepay.code === 'FORBIDDEN' && oldRelease.code === 'FORBIDDEN',
      `${oldRegister.code}/${oldRepay.code}/${oldRelease.code}`);
    const pEff = (await get('/api/state')).pledges.find((x) => x.id === TR_P);
    ok('原登记凭证不被改写(回执号/登记时刻/登记仓单版本)',
      pEff.registration.registrationNo === TR_FIRST_REG.registrationNo &&
      pEff.registration.registeredAt === TR_FIRST_REG.registeredAt &&
      pEff.registration.receiptVersion === TR_FIRST_REG.receiptVersion);
    // 新质权人可继续处理原质押:部分放行(未清偿)
    const newRel = await trPage.evalAsync(`EWR.api(${JSON.stringify('/api/pledges/release')}, ${JSON.stringify({ reqId: rid('RL'), actorId: 'FIN-CMB', pledgeId: TR_P, qty: 20, sessionId: 'SES-E2E-TRANSFER' })})`);
    ok('新质权人可继续对原质押放行(签发新令牌)', !!newRel.release.token && newRel.release.financerId === 'FIN-CMB');
    ok('全库仅一个当前权利人(无双重权利人)',
      (await get('/api/state')).pledges.filter((p) => p.id === TR_P && p.financerId === 'FIN-CMB').length === 1);

    // F10. 页面刷新(全新上下文)后从后端恢复同一转让进度:待确认/已撤回/已生效三类都可见
    await trPage.evalInPage('refresh()');
    await trPage.flush(200);
    const trTableHtml = trPage.byId('tbl-transfers').innerHTML;
    ok('融资方页面展示已撤回与已生效两笔转让及双方动作',
      trTableHtml.includes(TR_T) && trTableHtml.includes(TR_T2) &&
      trTableHtml.includes('已撤回') && trTableHtml.includes('已生效') &&
      /FIN-ICBC\(原\)/.test(trTableHtml) && /FIN-CMB\(受让\)/.test(trTableHtml),
      'transfer rows missing');
    const rebuiltSession = await get('/api/session?sessionId=SES-E2E-TRANSFER');
    ok('刷新后会话从后端恢复转让台账(两笔,状态正确)',
      rebuiltSession.ledger.transfers.length === 2 &&
      rebuiltSession.ledger.transfers.some((t) => t.id === TR_T && t.status === 'WITHDRAWN') &&
      rebuiltSession.ledger.transfers.some((t) => t.id === TR_T2 && t.status === 'EFFECTIVE'));
    ok('会话步骤按序含 申请/确认/撤回/生效',
      rebuiltSession.steps.filter((s) => s.action === 'transfer-apply').length >= 2 &&
      rebuiltSession.steps.some((s) => s.action === 'transfer-withdraw') &&
      rebuiltSession.steps.some((s) => s.action === 'transfer-effective'));

    // F11. 监管端按顺序回放:申请→确认→生效;拒绝有留痕;交接审计无异常
    const trOps = await get('/api/operations?pledgeId=' + TR_P);
    const seq = trOps.map((o) => o.seq);
    ok('转让相关留痕严格有序', seq.every((v, i) => !i || seq[i - 1] < v));
    const ix = (pred) => trOps.findIndex(pred);
    const applyIx = ix((o) => o.action === 'transfer-apply' && o.outcome === 'SUCCESS');
    const confirmIx = ix((o) => o.action === 'transfer-confirm' && o.outcome === 'SUCCESS');
    const effIx = ix((o) => o.action === 'transfer-effective');
    ok('监管回放顺序:申请 → 确认 → 生效', applyIx >= 0 && applyIx < confirmIx && confirmIx < effIx, `${applyIx}/${confirmIx}/${effIx}`);
    ok('监管回放包含各类拒绝(并发/重复确认/非参与方/生效前放行)',
      trOps.some((o) => o.reasonCode === 'TRANSFER_ALREADY_OPEN') &&
      trOps.some((o) => o.reasonCode === 'TRANSFER_ALREADY_CONFIRMED') &&
      trOps.some((o) => o.reasonCode === 'FORBIDDEN') &&
      trOps.some((o) => o.reasonCode === 'TRANSFER_PENDING') &&
      trOps.some((o) => o.reasonCode === 'STALE_PLEDGE_VERSION'));
    const tlTr = await get('/api/receipt?id=' + R_TR);
    ok('仓单时间线含两笔转让的完整回放(撤回+生效)',
      tlTr.transfers.length === 2 && tlTr.transfers.some((t) => t.status === 'WITHDRAWN') && tlTr.transfers.some((t) => t.status === 'EFFECTIVE'));
    const auditF = await get('/api/audit');
    ok('质权交接审计无异常(无双重权利人/半交接),链验签通过',
      auditF.handoffIssues.length === 0 &&
      auditF.counts.transfersEffective >= 1 && auditF.counts.transfersWithdrawn >= 1 &&
      auditF.chain.ok);

    console.log(`\n================ 端到端:${passed} 通过,${fails.length} 失败 ================`);
    if (fails.length) { console.log('失败项:', fails); process.exitCode = 1; }
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => srv.on('exit', r));
    rmSync(DB_FILE, { force: true });
  }
  if (fails.length) { console.log('失败项:', fails); process.exit(1); }
}
main().catch((e) => { console.error('端到端测试运行异常:', e); process.exit(1); });
