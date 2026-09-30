/**
 * domain.js —— 大宗商品电子仓单领域逻辑
 *
 * 核心不变量(每个写事务内强制执行):
 *  I1 同一库位内,所有「有效」仓单的物理数量区间 [startQty,endQty) 两两不相交;
 *  I2 仓单版本单调递增,质押/登记必须锁定当时版本,旧版本晚到一律拒绝;
 *  I3 一份仓单任一时刻至多存在一个「未解除」质押(排他占有),从结构上杜绝重复融资;
 *  I4 登记成功(REGISTERED)之前质押仅为内部锁定,禁止对外宣称担保生效;
 *  I5 复检只重估受影响仓单,原质押不被抹除,覆盖不足时转 SUPPLEMENTING 并发起补充担保;
 *  I6 出库必须持有当前质权人放行单(或该仓单无有效质押)。
 */
'use strict';
const { transact, DomainError, getState, verifyChain } = require('./storage');

const LTV_POLICY = 0.7; // 质押率上限 70%

const ACTIVE_PLEDGE_STATUS = ['LOCKED', 'REGISTERED', 'SUPPLEMENTING'];
const CLOSED_PLEDGE_STATUS = ['RELEASED', 'CANCELLED', 'DELIVERED'];
const VALID_RECEIPT_STATUS = ['ACTIVE', 'DELIVERED_PARTIAL'];

/* ---------------- 融资方操作会话留痕 ----------------
 * 每一次锁仓/登记/撤回/补充/还款/放行请求都生成一条 operationRecords:
 *  outcome: SUCCESS(成功) / CONFLICT(并发或状态冲突,含幂等重放) / REJECTED(校验或权限拒绝)
 * 成功留痕与业务状态在同一事务提交;业务事务回滚后由独立事务补登失败留痕,
 * 因而「并发失败、陈旧版本、非当前质权人」全部可追溯,且失败不改变任何有效状态。
 */
const OUTCOME_SUCCESS = 'SUCCESS';
const OUTCOME_CONFLICT = 'CONFLICT';
const OUTCOME_REJECTED = 'REJECTED';
// 这些码语义为「状态/版本冲突」(请求合法但与当前有效状态不相容),其余按拒绝处理
const CONFLICT_CODES = new Set([
  'ALREADY_PLEDGED',
  'ALREADY_REGISTERED',
  'STALE_RECEIPT_VERSION',
  'PLEDGE_CLOSED',
  'NOT_CANCELLABLE',
  'PLEDGE_NOT_ACTIVE',
  'IDEMPOTENT_REPLAY'
]);
const ACTION_LABELS = {
  lock: '锁仓',
  register: '质押登记',
  cancel: '撤回锁定',
  supplement: '补充担保',
  repay: '还款',
  release: '质权人放行'
};
const outcomeOfCode = (code) => (CONFLICT_CODES.has(code) ? OUTCOME_CONFLICT : OUTCOME_REJECTED);
/** 幂等键的构造必须与各业务函数保持一致 */
const IDEMPOTENCY_KEY_OF = {
  lock: (b) => (b.reqId ? 'pledge-lock:' + b.reqId : null),
  register: (b) => (b.registrationNo ? 'register:' + b.registrationNo : null),
  release: (b) => (b.reqId ? 'release:' + b.reqId : null)
};

/* ----------------------------- 查询辅助 ----------------------------- */
const must = (arr, pred, code, msg) => {
  const x = arr.find(pred);
  if (!x) throw new DomainError(code, msg);
  return x;
};
const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const overlap = (a, b) => a.startQty < b.endQty && b.startQty < a.endQty;

function gradeOf(s, gradeId) {
  return must(s.grades, (g) => g.id === gradeId, 'GRADE_NOT_FOUND', `品级 ${gradeId} 不存在`);
}
function receiptOf(s, receiptId) {
  return must(s.receipts, (r) => r.id === receiptId, 'RECEIPT_NOT_FOUND', `仓单 ${receiptId} 不存在`);
}
function pledgeOf(s, pledgeId) {
  return must(s.pledges, (p) => p.id === pledgeId, 'PLEDGE_NOT_FOUND', `质押 ${pledgeId} 不存在`);
}
function activePledgeOf(s, receiptId) {
  return s.pledges.find((p) => p.receiptId === receiptId && ACTIVE_PLEDGE_STATUS.includes(p.status));
}

/** I1:校验同库位有效仓单区间互不相交(ignoreId 用于拆分/复检时排除自身) */
function assertNoOverlap(s, locationId, ignoreId = null) {
  const valid = s.receipts.filter(
    (r) => r.locationId === locationId && VALID_RECEIPT_STATUS.includes(r.status) && r.id !== ignoreId
  );
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      if (overlap(valid[i], valid[j])) {
        throw new DomainError(
          'INTERVAL_OVERLAP',
          `库位 ${locationId} 物理区间重叠:${valid[i].id}[${valid[i].startQty},${valid[i].endQty}) 与 ${valid[j].id}[${valid[j].startQty},${valid[j].endQty})`,
          { a: valid[i].id, b: valid[j].id }
        );
      }
    }
  }
}

function gradePrice(s, gradeId, valuationBatchId) {
  const grade = gradeOf(s, gradeId);
  if (!valuationBatchId) {
    const latest = s.valuationBatches
      .filter((b) => b.prices[gradeId] != null)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!latest) throw new DomainError('NO_PRICE', `品级 ${grade.name} 暂无估值`);
    return { batch: latest, price: latest.prices[gradeId] };
  }
  const batch = must(
    s.valuationBatches,
    (b) => b.id === valuationBatchId,
    'BATCH_NOT_FOUND',
    `估值批次 ${valuationBatchId} 不存在`
  );
  const price = batch.prices[gradeId];
  if (price == null) throw new DomainError('PRICE_NOT_IN_BATCH', `估值批次 ${batch.id} 未覆盖品级 ${grade.name}`);
  return { batch, price };
}

/** 按指定估值批次计算仓单价值 */
function valuationFor(s, receipt, batchId) {
  const { batch, price } = gradePrice(s, receipt.gradeId, batchId);
  const qty = round3(receipt.endQty - receipt.startQty);
  return { batchId: batch.id, price, qty, value: round3(price * qty) };
}

/** 质押当前敞口 = 融资额 - 已补充/已偿还金额 */
function exposureOf(pledge) {
  return round3(pledge.loanAmount - (pledge.coveredAmount || 0));
}

/**
 * 在业务事务内追加一条成功/冲突(重放)留痕 —— 与业务状态原子提交。
 * ref 为本次操作产物的可重建凭据(质押/登记回执/放行单要点)。
 */
function logAttempt(tx, s, fields) {
  const rec = {
    id: tx.nextId('operation', 'OP'),
    seq: s.operationRecords.length + 1,
    at: Date.now(),
    action: fields.action,
    actionLabel: ACTION_LABELS[fields.action] || fields.action,
    actorId: fields.actorId || null,
    sessionId: fields.sessionId || null,
    receiptId: fields.receiptId || null,
    pledgeId: fields.pledgeId || null,
    idempotencyKey: fields.idempotencyKey || null,
    outcome: fields.outcome,
    reasonCode: fields.reasonCode || null,
    reason: fields.reason || null,
    request: fields.request || null,
    ref: fields.ref || null,
    eventSeq: null
  };
  const ev = tx.appendEvent('ATTEMPT_LOGGED', {
    receiptId: rec.receiptId,
    pledgeId: rec.pledgeId,
    actorId: rec.actorId,
    payload: {
      opId: rec.id,
      action: rec.action,
      sessionId: rec.sessionId,
      outcome: rec.outcome,
      reasonCode: rec.reasonCode,
      idempotencyKey: rec.idempotencyKey,
      ref: rec.ref
    }
  });
  rec.eventSeq = ev.seq;
  s.operationRecords.push(rec);
  return rec;
}

/**
 * 业务事务抛错回滚后,用独立事务补登一条失败留痕。
 * 与业务状态完全隔离:不读取、不修改任何质押/仓单,因此失败记录不会改变有效状态。
 */
function logRejection(fields) {
  return transact((s, tx) =>
    logAttempt(tx, s, {
      ...fields,
      outcome: fields.outcome || outcomeOfCode(fields.reasonCode),
      request: fields.request || null
    })
  );
}

function refOf(action, result) {
  if (!result) return null;
  if (action === 'lock' && result.pledge) {
    return {
      pledgeId: result.pledge.id,
      receiptId: result.pledge.receiptId,
      receiptVersion: result.pledge.receiptVersion,
      valuationBatchId: result.pledge.valuationBatchId,
      status: result.pledge.status
    };
  }
  if (action === 'register' && result.registration) {
    return {
      pledgeId: result.pledge.id,
      registrationNo: result.registration.registrationNo,
      registeredAt: result.registration.registeredAt,
      registrar: result.registration.registrar,
      receiptVersion: result.registration.receiptVersion
    };
  }
  if (action === 'release' && result.release) {
    return {
      releaseId: result.release.id,
      token: result.release.token,
      qty: result.release.qty,
      remaining: result.release.remaining,
      receiptId: result.release.receiptId
    };
  }
  if (result.id && /^PL/.test(result.id)) return { pledgeId: result.id, status: result.status, exposure: result.exposure };
  return null;
}

/* ===================== 基础数据 / 市场估值批次 ===================== */
function createValuationBatch(actorId, note, prices) {
  return transact((s, tx) => {
    const id = tx.nextId('valuation', 'VB');
    const batch = {
      id,
      note: note || '市场价格快照',
      prices: prices || {}, // gradeId -> 单价(元/吨)
      createdAt: Date.now(),
      createdBy: actorId
    };
    s.valuationBatches.push(batch);
    tx.appendEvent('VALUATION_BATCH_CREATED', { actorId, payload: { id, note: batch.note } });
    return batch;
  });
}

/* ===================== 仓单登记(按库位+检验批) ===================== */
function registerReceipt(input) {
  return transact((s, tx) => {
    const location = must(
      s.locations,
      (l) => l.id === input.locationId,
      'LOCATION_NOT_FOUND',
      `库位 ${input.locationId} 不存在`
    );
    const grade = gradeOf(s, input.gradeId);
    if (grade.commodityId !== location.commodityId)
      throw new DomainError('GRADE_MISMATCH', '品级与库位经营品类不一致');
    const qty = round3(Number(input.qty));
    if (!(qty > 0)) throw new DomainError('BAD_QTY', '数量必须为正数');

    // 检验批
    const ibId = tx.nextId('batch', 'IB');
    s.inspectionBatches.push({
      id: ibId,
      receiptId: null,
      locationId: location.id,
      gradeId: grade.id,
      qty,
      inspectedAt: Date.now(),
      kind: 'INITIAL'
    });

    // 未显式指定起点时,自动取库位内首个空闲区间
    let start = input.startQty != null ? round3(Number(input.startQty)) : null;
    if (start == null) {
      const occupied = s.receipts
        .filter((r) => r.locationId === location.id && VALID_RECEIPT_STATUS.includes(r.status))
        .sort((a, b) => a.startQty - b.startQty);
      let cursor = 0;
      for (const r of occupied) {
        if (round3(r.startQty - cursor) >= qty) break;
        cursor = Math.max(cursor, r.endQty);
      }
      start = cursor;
    }
    const end = round3(start + qty);
    if (start < 0 || end > location.capacity + 1e-6)
      throw new DomainError('OUT_OF_LOCATION', `超出库位容量 ${location.capacity}`);

    const id = tx.nextId('receipt', 'WR');
    const receipt = {
      id,
      warehouseId: location.warehouseId,
      locationId: location.id,
      commodityId: grade.commodityId,
      gradeId: grade.id,
      holderId: input.holderId,
      inspectionBatchId: ibId,
      startQty: start,
      endQty: end,
      version: 1,
      status: 'ACTIVE',
      parentIds: [],
      createdAt: Date.now(),
      deliveredQty: 0
    };
    s.inspectionBatches.find((b) => b.id === ibId).receiptId = id;
    s.receipts.push(receipt);

    assertNoOverlap(s, location.id); // I1

    tx.appendEvent('RECEIPT_REGISTERED', {
      receiptId: id,
      actorId: input.actorId || location.warehouseId,
      payload: {
        locationId: location.id,
        gradeId: grade.id,
        holderId: receipt.holderId,
        startQty: start,
        endQty: end,
        qty,
        version: 1,
        inspectionBatchId: ibId
      }
    });
    return receipt;
  });
}

/* ===================== 拆分(原子,中途故障整体回滚) ===================== */
function splitReceipt(input) {
  return transact((s, tx) => {
    const src = receiptOf(s, input.receiptId);
    if (!VALID_RECEIPT_STATUS.includes(src.status))
      throw new DomainError('RECEIPT_NOT_VALID', '仓单非有效状态,无法拆分');
    if (activePledgeOf(s, src.id))
      throw new DomainError('PLEDGE_EXISTS', '仓单已设质,不得直接拆分(需先解除或经质权人同意的变价程序)');

    const parts = (input.parts || []).map(Number).map(round3);
    if (parts.length < 2) throw new DomainError('BAD_SPLIT', '至少拆成两份');
    if (parts.some((p) => !(p > 0))) throw new DomainError('BAD_SPLIT', '拆分数量必须为正');
    const total = round3(parts.reduce((a, b) => a + b, 0));
    const srcQty = round3(src.endQty - src.startQty);
    if (Math.abs(total - srcQty) > 1e-6)
      throw new DomainError('BAD_SPLIT', `拆分数量之和 ${total} 与原数量 ${srcQty} 不符`);

    const base = src.startQty;
    const children = [];
    let cursor = base;
    for (let i = 0; i < parts.length; i++) {
      const id = tx.nextId('receipt', 'WR');
      const child = {
        ...src,
        id,
        inspectionBatchId: src.inspectionBatchId,
        startQty: round3(cursor),
        endQty: round3(cursor + parts[i]),
        version: 1,
        status: 'ACTIVE',
        parentIds: [src.id],
        createdAt: Date.now(),
        deliveredQty: 0
      };
      cursor = child.endQty;
      s.receipts.push(child);
      children.push(child);
    }

    // 模拟「拆分中途故障」:在子单已生成、源单尚未失效时抛出异常,
    // 事务整体回滚 —— 外界看不到任何半截状态。
    if (input.simulateCrash) {
      throw new DomainError('SIMULATED_CRASH', '模拟拆分中途故障:事务回滚,源仓单保持不变');
    }

    src.status = 'SPLIT';
    src.version += 1;

    assertNoOverlap(s, src.locationId); // I1(子单彼此/与邻居不得重叠)

    tx.appendEvent('RECEIPT_SPLIT', {
      receiptId: src.id,
      actorId: input.actorId || src.warehouseId,
      payload: {
        sourceId: src.id,
        childIds: children.map((c) => c.id),
        parts,
        sourceVersionAfter: src.version
      }
    });
    children.forEach((c) =>
      tx.appendEvent('RECEIPT_DERIVED', {
        receiptId: c.id,
        actorId: input.actorId || src.warehouseId,
        payload: { parentId: src.id, startQty: c.startQty, endQty: c.endQty, version: 1 }
      })
    );
    return { source: src, children };
  });
}

/* ===================== 合并(同库位、同品级、区间相邻) ===================== */
function mergeReceipts(input) {
  return transact((s, tx) => {
    const ids = input.receiptIds || [];
    if (ids.length < 2) throw new DomainError('BAD_MERGE', '至少两份仓单才能合并');
    const list = ids.map((id) => receiptOf(s, id));
    const first = list[0];
    for (const r of list) {
      if (!VALID_RECEIPT_STATUS.includes(r.status))
        throw new DomainError('RECEIPT_NOT_VALID', `仓单 ${r.id} 非有效状态`);
      if (activePledgeOf(s, r.id))
        throw new DomainError('PLEDGE_EXISTS', `仓单 ${r.id} 已设质,不得直接合并`);
      if (r.locationId !== first.locationId) throw new DomainError('MERGE_LOCATION', '必须同一库位');
      if (r.gradeId !== first.gradeId) throw new DomainError('MERGE_GRADE', '必须同一品级');
      if (r.holderId !== first.holderId) throw new DomainError('MERGE_HOLDER', '必须同一货主');
    }
    const sorted = [...list].sort((a, b) => a.startQty - b.startQty);
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].startQty - sorted[i - 1].endQty) > 1e-6)
        throw new DomainError('MERGE_ADJACENT', '仓单区间必须首尾相邻才能合并');
    }
    const start = sorted[0].startQty;
    const end = sorted[sorted.length - 1].endQty;

    const ibId = tx.nextId('batch', 'IB');
    s.inspectionBatches.push({
      id: ibId,
      receiptId: null,
      locationId: first.locationId,
      gradeId: first.gradeId,
      qty: round3(end - start),
      inspectedAt: Date.now(),
      kind: 'MERGE'
    });

    const id = tx.nextId('receipt', 'WR');
    const merged = {
      ...first,
      id,
      inspectionBatchId: ibId,
      startQty: start,
      endQty: end,
      version: 1,
      status: 'ACTIVE',
      parentIds: sorted.map((r) => r.id),
      createdAt: Date.now(),
      deliveredQty: 0
    };
    s.inspectionBatches.find((b) => b.id === ibId).receiptId = id;
    s.receipts.push(merged);
    sorted.forEach((r) => {
      r.status = 'MERGED';
      r.version += 1;
    });

    assertNoOverlap(s, first.locationId);

    tx.appendEvent('RECEIPT_MERGE', {
      receiptId: id,
      actorId: input.actorId || first.warehouseId,
      payload: { sourceIds: sorted.map((r) => r.id), mergedId: id, startQty: start, endQty: end }
    });
    return merged;
  });
}

/* ===================== 复检(品级/数量下降 → 仅重估受影响仓单) ===================== */
function recheck(input) {
  return transact((s, tx) => {
    const r = receiptOf(s, input.receiptId);
    if (!VALID_RECEIPT_STATUS.includes(r.status))
      throw new DomainError('RECEIPT_NOT_VALID', '仓单非有效状态,无法复检');

    const oldGrade = gradeOf(s, r.gradeId);
    const newGradeId = input.newGradeId || r.gradeId;
    gradeOf(s, newGradeId);
    const oldQty = round3(r.endQty - r.startQty);
    const newQty = input.newQty != null ? round3(Number(input.newQty)) : oldQty;
    if (!(newQty > 0)) throw new DomainError('BAD_QTY', '复检数量必须为正');
    if (newQty > oldQty + 1e-6)
      throw new DomainError('QTY_INCREASE_NOT_ALLOWED', '复检差异只允许数量下降;增量应走新仓单登记');

    const ibId = tx.nextId('batch', 'IB');
    s.inspectionBatches.push({
      id: ibId,
      receiptId: r.id,
      locationId: r.locationId,
      gradeId: newGradeId,
      qty: newQty,
      inspectedAt: Date.now(),
      kind: 'RECHECK'
    });

    // 数量下降:从区间尾部收缩,保证不侵入前序仓单
    const drop = round3(oldQty - newQty);
    r.endQty = round3(r.startQty + newQty);
    r.gradeId = newGradeId;
    r.version += 1;

    tx.appendEvent('RECEIPT_RECHECKED', {
      receiptId: r.id,
      actorId: input.actorId || r.warehouseId,
      payload: {
        oldGradeId: oldGrade.id,
        newGradeId,
        oldQty,
        newQty,
        droppedQty: drop,
        versionAfter: r.version,
        inspectionBatchId: ibId
      }
    });

    // I5:只重估「受影响仓单」上的有效质押 —— 原质押不删除、不解除
    const affectedPledges = s.pledges.filter(
      (p) => p.receiptId === r.id && ACTIVE_PLEDGE_STATUS.includes(p.status)
    );
    const revaluations = [];
    const supplements = [];
    for (const p of affectedPledges) {
      // 以登记时锁定的同一估值批次重算(量价齐看);另附最新批次参考值
      const locked = valuationFor(s, r, p.valuationBatchId);
      let latest = null;
      try {
        latest = valuationFor(s, r, null);
      } catch (_) {
        latest = null;
      }
      const before = p.currentValue;
      p.currentValue = locked.value;
      p.latestValue = latest ? latest.value : locked.value;
      p.revaluationCount = (p.revaluationCount || 0) + 1;
      const exposure = exposureOf(p);
      const wasShort = p.status === 'SUPPLEMENTING';
      const isShort = p.currentValue < exposure - 1e-6;
      if (isShort) p.status = 'SUPPLEMENTING'; // 覆盖不足:进入补充担保流程(质押仍在)

      tx.appendEvent('PLEDGE_REVALUED', {
        receiptId: r.id,
        pledgeId: p.id,
        actorId: input.actorId || r.warehouseId,
        payload: {
          valuationBatchId: locked.batchId,
          valueBefore: before,
          valueAfter: locked.value,
          latestValue: p.latestValue,
          exposure,
          shortfall: round3(Math.max(0, exposure - locked.value)),
          status: p.status
        }
      });

      if (isShort && !wasShort) {
        const supId = 'SU' + p.id.slice(2);
        const sup = {
          id: supId,
          pledgeId: p.id,
          receiptId: r.id,
          exposure,
          collateralValue: locked.value,
          shortfall: round3(Math.max(0, exposure - locked.value)),
          status: 'OPEN',
          createdAt: Date.now()
        };
        s.supplements.push(sup);
        supplements.push(sup);
        tx.appendEvent('SUPPLEMENT_REQUESTED', {
          receiptId: r.id,
          pledgeId: p.id,
          actorId: 'SYSTEM',
          payload: { shortfall: sup.shortfall, exposure, collateralValue: locked.value }
        });
      }
      revaluations.push({ pledgeId: p.id, value: locked.value, status: p.status });
    }

    return { receipt: r, droppedQty: drop, gradeChanged: oldGrade.id !== newGradeId, revaluations, supplements };
  });
}

/* ===================== 质押:锁定仓单版本 + 估值批次 + 权利人 ===================== */
function lockPledge(input) {
  return transact((s, tx) => {
    const key = IDEMPOTENCY_KEY_OF.lock(input);
    if (key && s.idempotency[key]) {
      const first = s.pledges.find((p) => p.id === s.idempotency[key].pledgeId);
      // 重放只服务于原请求方;他人拿到相同 reqId 也不得借重放窥得/操作他人质押
      if (input.actorId && first && input.actorId !== first.financerId)
        throw new DomainError('FORBIDDEN', `仅当前质权人 ${first.financerId} 可重放该锁仓请求`);
      const result = { duplicated: true, pledge: first };
      logAttempt(tx, s, {
        action: 'lock', actorId: input.actorId, sessionId: input.sessionId,
        receiptId: first ? first.receiptId : input.receiptId, pledgeId: first ? first.id : null,
        idempotencyKey: key, outcome: OUTCOME_CONFLICT, reasonCode: 'IDEMPOTENT_REPLAY',
        reason: `相同锁仓请求重放:返回既有质押 ${first ? first.id : ''},不产生第二笔质押`,
        request: reqView(input, ['reqId', 'receiptId', 'financerId', 'valuationBatchId', 'loanAmount']),
        ref: refOf('lock', result)
      });
      return result;
    }

    const r = receiptOf(s, input.receiptId);
    if (!VALID_RECEIPT_STATUS.includes(r.status))
      throw new DomainError('RECEIPT_NOT_VALID', '仓单非有效状态,不能质押');
    const existing = activePledgeOf(s, r.id);
    if (existing)
      // I3:并发质押的第二家在此被拒
      throw new DomainError(
        'ALREADY_PLEDGED',
        `仓单 ${r.id} 已存在 ${existing.status} 状态的质押 ${existing.id}(质权人 ${existing.financerId}),禁止重复融资`,
        { existingPledgeId: existing.id }
      );

    const { batch } = gradePrice(s, r.gradeId, input.valuationBatchId || null);
    const v = valuationFor(s, r, batch.id);
    const loan = round3(Number(input.loanAmount));
    if (!(loan > 0)) throw new DomainError('BAD_AMOUNT', '融资额必须为正');
    const cap = round3(v.value * LTV_POLICY);
    if (loan > cap + 1e-6)
      throw new DomainError('LTV_EXCEEDED', `融资额 ${loan} 超过质押率上限 ${cap}(估值 ${v.value} × ${LTV_POLICY})`);

    const id = tx.nextId('pledge', 'PL');
    const pledge = {
      id,
      receiptId: r.id,
      receiptVersion: r.version, // 锁定仓单版本(I2)
      valuationBatchId: batch.id, // 锁定估值批次
      financerId: input.financerId, // 权利人
      pledgorId: input.pledgorId || r.holderId,
      loanAmount: loan,
      ltvCap: cap,
      lockedValue: v.value,
      currentValue: v.value,
      latestValue: v.value,
      coveredAmount: 0,
      currency: 'CNY',
      status: 'LOCKED', // 登记前仅内部锁定(I4)
      publicClaimAllowed: false,
      registration: null,
      createdAt: Date.now(),
      revaluationCount: 0
    };
    s.pledges.push(pledge);
    if (key) s.idempotency[key] = { pledgeId: id, at: Date.now() };

    tx.appendEvent('PLEDGE_LOCKED', {
      receiptId: r.id,
      pledgeId: id,
      actorId: input.actorId || input.financerId,
      payload: {
        receiptVersion: r.version,
        valuationBatchId: batch.id,
        financerId: pledge.financerId,
        pledgorId: pledge.pledgorId,
        loanAmount: loan,
        lockedValue: v.value,
        notice: '仅内部锁定,登记成功前不得对外宣称担保生效'
      }
    });
    const result = { duplicated: false, pledge };
    logAttempt(tx, s, {
      action: 'lock', actorId: input.actorId || input.financerId, sessionId: input.sessionId,
      receiptId: r.id, pledgeId: id, idempotencyKey: key, outcome: OUTCOME_SUCCESS,
      request: reqView(input, ['reqId', 'receiptId', 'financerId', 'pledgorId', 'valuationBatchId', 'loanAmount']),
      ref: refOf('lock', result)
    });
    return result;
  });
}

/** 登记成功前,出质企业可撤回锁定(给并发抢单失败方释放仓单) */
function cancelPledge(input) {
  return transact((s, tx) => {
    const p = pledgeOf(s, input.pledgeId);
    if (p.status !== 'LOCKED')
      throw new DomainError('NOT_CANCELLABLE', `质押处于 ${p.status},不可撤回(登记后须走解除/还款流程)`);
    if (input.actorId && input.actorId !== p.financerId && input.actorId !== p.pledgorId)
      throw new DomainError('FORBIDDEN', '仅质权人或出质人可撤回');
    p.status = 'CANCELLED';
    tx.appendEvent('PLEDGE_CANCELLED', {
      receiptId: p.receiptId,
      pledgeId: p.id,
      actorId: input.actorId,
      payload: {}
    });
    logAttempt(tx, s, {
      action: 'cancel', actorId: input.actorId, sessionId: input.sessionId,
      receiptId: p.receiptId, pledgeId: p.id, outcome: OUTCOME_SUCCESS,
      request: reqView(input, ['pledgeId', 'actorId']),
      ref: { pledgeId: p.id, status: p.status }
    });
    return p;
  });
}

/**
 * 登记 —— 幂等(相同登记回执重放返回同一结果,绝不产生第二笔担保)。
 * 旧版仓单晚到(expectedVersion 落后当前版本)直接拒绝。
 */
function registerPledge(input) {
  return transact((s, tx) => {
    const key = 'register:' + mustHave(input.registrationNo, 'REG_NO_REQUIRED', '登记回执号必填');
    const p = pledgeOf(s, input.pledgeId);
    if (s.idempotency[key]) {
      const first = s.idempotency[key];
      const pledge = pledgeOf(s, first.pledgeId);
      // 非当前质权人拿同一回执号重放:留拒绝痕迹,不返回任何登记细节
      if (input.actorId && input.actorId !== pledge.financerId)
        throw new DomainError('FORBIDDEN', `仅当前质权人 ${pledge.financerId} 可查询/重放该登记回执`);
      const result = { replayed: true, pledge, registration: pledge.registration };
      logAttempt(tx, s, {
        action: 'register', actorId: input.actorId, sessionId: input.sessionId,
        receiptId: pledge.receiptId, pledgeId: pledge.id, idempotencyKey: key,
        outcome: OUTCOME_CONFLICT, reasonCode: 'IDEMPOTENT_REPLAY',
        reason: `相同登记回执重放:返回首次登记结果 ${pledge.registration.registrationNo},第一次登记结果不变,不产生第二笔质押`,
        request: reqView(input, ['pledgeId', 'registrationNo', 'expectedVersion', 'valuationBatchId']),
        ref: refOf('register', result)
      });
      return result;
    }

    if (p.status === 'CANCELLED' || p.status === 'RELEASED' || p.status === 'DELIVERED')
      throw new DomainError('PLEDGE_CLOSED', `质押已终结(${p.status}),不能登记`);
    if (p.status === 'REGISTERED' || p.status === 'SUPPLEMENTING')
      throw new DomainError('ALREADY_REGISTERED', `质押 ${p.id} 已登记,回执 ${p.registration.registrationNo}`);
    // 登记是对担保权的处分,仅当前质权人本人可提交
    if (input.actorId && input.actorId !== p.financerId)
      throw new DomainError('FORBIDDEN', `仅当前质权人 ${p.financerId} 可登记,${input.actorId} 的请求拒绝`);

    const r = receiptOf(s, p.receiptId);
    const expectedVersion = Number(input.expectedVersion != null ? input.expectedVersion : p.receiptVersion);
    if (expectedVersion !== r.version) {
      // I2:旧版仓单晚到
      throw new DomainError(
        'STALE_RECEIPT_VERSION',
        `登记基于仓单版本 v${expectedVersion},但当前已为 v${r.version}(复检/拆分导致版本前进),旧版登记拒绝`,
        { expectedVersion, currentVersion: r.version }
      );
    }
    // 二次确认估值批次未被替换(质押锁定后始终沿用锁定批次)
    if (input.valuationBatchId && input.valuationBatchId !== p.valuationBatchId)
      throw new DomainError('BATCH_MISMATCH', '登记估值批次必须与锁定批次一致');

    const reg = {
      registrationNo: input.registrationNo,
      registeredAt: Date.now(),
      registrar: input.registrar || '登记中心',
      receiptVersion: r.version,
      valuationBatchId: p.valuationBatchId
    };
    p.status = 'REGISTERED';
    p.registration = reg;
    p.publicClaimAllowed = true; // 登记成功后方可对外宣称担保生效(I4)

    s.idempotency[key] = { pledgeId: p.id, at: reg.registeredAt };

    tx.appendEvent('PLEDGE_REGISTERED', {
      receiptId: r.id,
      pledgeId: p.id,
      actorId: input.actorId || p.financerId,
      payload: { registrationNo: reg.registrationNo, receiptVersion: r.version, valuationBatchId: p.valuationBatchId }
    });
    const result = { replayed: false, pledge: p, registration: reg };
    logAttempt(tx, s, {
      action: 'register', actorId: input.actorId || p.financerId, sessionId: input.sessionId,
      receiptId: r.id, pledgeId: p.id, idempotencyKey: key, outcome: OUTCOME_SUCCESS,
      request: reqView(input, ['pledgeId', 'registrationNo', 'expectedVersion', 'valuationBatchId', 'registrar']),
      ref: refOf('register', result)
    });
    return result;
  });
}

/* ===================== 补充担保 / 偿还(弥覆盖缺口) ===================== */
function supplementCollateral(input) {
  return transact((s, tx) => {
    const p = pledgeOf(s, input.pledgeId);
    const amount = round3(Number(input.amount));
    if (!(amount > 0)) throw new DomainError('BAD_AMOUNT', '补充金额必须为正');
    if (!ACTIVE_PLEDGE_STATUS.includes(p.status))
      throw new DomainError('PLEDGE_CLOSED', '质押已终结,不能补充担保');
    p.coveredAmount = round3((p.coveredAmount || 0) + amount);

    const open = s.supplements.find((x) => x.pledgeId === p.id && x.status === 'OPEN');
    const exposure = exposureOf(p);
    if (exposure <= p.currentValue + 1e-6) {
      p.status = 'REGISTERED'; // 覆盖恢复,回到正常存续
      if (open) open.status = 'SATISFIED';
    }
    tx.appendEvent('COLLATERAL_SUPPLEMENTED', {
      receiptId: p.receiptId,
      pledgeId: p.id,
      actorId: input.actorId || p.pledgorId,
      payload: { amount, coveredAmount: p.coveredAmount, exposure, collateralValue: p.currentValue, status: p.status }
    });
    const view = pledgeView(s, p);
    logAttempt(tx, s, {
      action: 'supplement', actorId: input.actorId || p.pledgorId, sessionId: input.sessionId,
      receiptId: p.receiptId, pledgeId: p.id, outcome: OUTCOME_SUCCESS,
      request: reqView(input, ['pledgeId', 'amount', 'actorId']),
      ref: refOf('supplement', view)
    });
    return view;
  });
}

/** 还款:敞口归零,自动具备解除条件 */
function repayPledge(input) {
  return transact((s, tx) => {
    const p = pledgeOf(s, input.pledgeId);
    const amount = round3(Number(input.amount));
    if (!(amount > 0)) throw new DomainError('BAD_AMOUNT', '还款金额必须为正');
    p.coveredAmount = round3(Math.min(p.loanAmount, (p.coveredAmount || 0) + amount));
    if (exposureOf(p) <= 0) {
      const open = s.supplements.find((x) => x.pledgeId === p.id && x.status === 'OPEN');
      if (open) open.status = 'SATISFIED';
    }
    tx.appendEvent('LOAN_REPAID', {
      receiptId: p.receiptId,
      pledgeId: p.id,
      actorId: input.actorId || p.pledgorId,
      payload: { amount, coveredAmount: p.coveredAmount, exposure: exposureOf(p) }
    });
    const view = pledgeView(s, p);
    logAttempt(tx, s, {
      action: 'repay', actorId: input.actorId || p.pledgorId, sessionId: input.sessionId,
      receiptId: p.receiptId, pledgeId: p.id, outcome: OUTCOME_SUCCESS,
      request: reqView(input, ['pledgeId', 'amount', 'actorId']),
      ref: refOf('repay', view)
    });
    return view;
  });
}

/* ===================== 质权人放行(幂等) ===================== */
function releasePledge(input) {
  return transact((s, tx) => {
    const key = 'release:' + mustHave(input.reqId, 'REQ_ID_REQUIRED', '放行请求号必填(幂等键)');
    if (s.idempotency[key]) {
      const rel = s.releases.find((x) => x.id === s.idempotency[key].releaseId);
      // 非当前质权人持相同 reqId 重放:拒绝并不改变令牌核销状态
      if (input.actorId && rel && input.actorId !== rel.financerId)
        throw new DomainError('FORBIDDEN', `仅当前质权人 ${rel.financerId} 可重放该放行请求`);
      const result = { replayed: true, release: rel };
      logAttempt(tx, s, {
        action: 'release', actorId: input.actorId, sessionId: input.sessionId,
        receiptId: rel ? rel.receiptId : null, pledgeId: rel ? rel.pledgeId : input.pledgeId,
        idempotencyKey: key, outcome: OUTCOME_CONFLICT, reasonCode: 'IDEMPOTENT_REPLAY',
        reason: `相同放行请求重放:返回原放行令牌 ${rel ? rel.token : ''},令牌不重复签发`,
        request: reqView(input, ['reqId', 'pledgeId', 'qty']),
        ref: refOf('release', result)
      });
      return result;
    }
    const p = pledgeOf(s, input.pledgeId);
    if (!ACTIVE_PLEDGE_STATUS.includes(p.status))
      throw new DomainError('PLEDGE_NOT_ACTIVE', `质押状态 ${p.status},无法放行`);
    if (input.actorId !== p.financerId)
      throw new DomainError('FORBIDDEN', `仅当前质权人 ${p.financerId} 可放行货物,${input.actorId || '未知主体'} 的请求拒绝`);
    const exposure = exposureOf(p);
    const releaseAll = exposure <= 1e-6; // 全额还款才允许全量放行
    const asked = input.qty != null ? round3(Number(input.qty)) : null;
    const r = receiptOf(s, p.receiptId);
    const qty = round3(r.endQty - r.startQty);
    if (!releaseAll) {
      if (asked == null)
        throw new DomainError('LOAN_OUTSTANDING', `尚有敞口 ${exposure} 未清偿,只能部分放行,须指定放行数量`);
      if (!(asked > 0) || asked > qty + 1e-6) throw new DomainError('BAD_QTY', '放行数量超出仓单数量');
    }
    const releaseQty = releaseAll ? qty : asked;

    const id = tx.nextId('release', 'RL');
    const rel = {
      id,
      pledgeId: p.id,
      receiptId: r.id,
      financerId: p.financerId,
      qty: releaseQty,
      remaining: round3(qty - releaseQty),
      token: 'TKN-' + id + '-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
      consumed: false,
      createdAt: Date.now()
    };
    s.releases.push(rel);
    s.idempotency[key] = { releaseId: id, at: rel.createdAt };

    tx.appendEvent('RELEASE_GRANTED', {
      receiptId: r.id,
      pledgeId: p.id,
      actorId: p.financerId,
      payload: { releaseId: id, qty: releaseQty, remaining: rel.remaining, allReleased: releaseAll }
    });
    const result = { replayed: false, release: rel };
    logAttempt(tx, s, {
      action: 'release', actorId: p.financerId, sessionId: input.sessionId,
      receiptId: r.id, pledgeId: p.id, idempotencyKey: key, outcome: OUTCOME_SUCCESS,
      request: reqView(input, ['reqId', 'pledgeId', 'qty']),
      ref: refOf('release', result)
    });
    return result;
  });
}

/* ===================== 出库(必须持有当前质权人放行) ===================== */
function deliver(input) {
  return transact((s, tx) => {
    const r = receiptOf(s, input.receiptId);
    if (!VALID_RECEIPT_STATUS.includes(r.status))
      throw new DomainError('RECEIPT_NOT_VALID', '仓单非有效状态,不能出库');
    const qty = round3(Number(input.qty));
    if (!(qty > 0)) throw new DomainError('BAD_QTY', '出库数量必须为正');
    const available = round3(r.endQty - r.startQty);
    if (qty > available + 1e-6) throw new DomainError('QTY_EXCEEDED', `出库 ${qty} 超过在库 ${available}`);

    const pledge = activePledgeOf(s, r.id);
    let usedRelease = null;
    if (pledge) {
      // I6:必须取得「当前质权人」放行
      const rel = s.releases.find(
        (x) => x.token === input.releaseToken && x.receiptId === r.id && !x.consumed
      );
      if (!rel)
        throw new DomainError(
          'NO_RELEASE',
          `仓单 ${r.id} 存在有效质押 ${pledge.id},须先取得当前质权人 ${pledge.financerId} 的放行单`,
          { pledgeId: pledge.id, financerId: pledge.financerId }
        );
      if (rel.financerId !== pledge.financerId)
        throw new DomainError('RELEASE_FROM_WRONG_HOLDER', '放行单签发人与当前质权人不一致');
      if (qty > rel.qty - (rel.usedQty || 0) + 1e-6)
        throw new DomainError('RELEASE_QTY_EXCEEDED', '超出放行单允许数量');
      rel.usedQty = round3((rel.usedQty || 0) + qty);
      usedRelease = rel.id;
      if (rel.remaining <= 1e-6 || rel.usedQty >= rel.qty - 1e-6) rel.consumed = true;
    }

    // 从区间尾部出货
    r.endQty = round3(r.endQty - qty);
    r.deliveredQty = round3((r.deliveredQty || 0) + qty);
    r.version += 1;
    const fullyDelivered = r.endQty - r.startQty <= 1e-6;
    if (fullyDelivered) r.status = 'DELIVERED';
    else r.status = 'DELIVERED_PARTIAL';

    const delivery = {
      id: tx.nextId('delivery', 'DL'),
      receiptId: r.id,
      qty,
      releaseId: usedRelease,
      pledgeId: pledge ? pledge.id : null,
      at: Date.now(),
      actorId: input.actorId || r.warehouseId
    };
    s.deliveries.push(delivery);

    tx.appendEvent('GOODS_DELIVERED', {
      receiptId: r.id,
      pledgeId: pledge ? pledge.id : null,
      actorId: delivery.actorId,
      payload: { qty, remainingQty: round3(r.endQty - r.startQty), releaseId: usedRelease, fullyDelivered }
    });

    if (fullyDelivered && pledge) {
      pledge.status = 'DELIVERED';
      tx.appendEvent('PLEDGE_CLOSED', {
        receiptId: r.id,
        pledgeId: pledge.id,
        actorId: 'SYSTEM',
        payload: { reason: '货物全部出库,担保关系结清归档' }
      });
    }
    return { delivery, receipt: r, usedRelease };
  });
}

/* ===================== 视图装配 ===================== */
function pledgeView(s, p) {
  const r = s.receipts.find((x) => x.id === p.receiptId);
  const exposure = exposureOf(p);
  return {
    ...p,
    exposure,
    collateralRatio: exposure > 0 ? round3(p.currentValue / exposure) : null,
    canPubliclyClaimEffective: p.status === 'REGISTERED' || p.status === 'SUPPLEMENTING',
    receiptCurrentVersion: r ? r.version : null,
    versionStale: r ? r.version !== p.receiptVersion : null
  };
}

function receiptView(s, r) {
  const grade = s.grades.find((g) => g.id === r.gradeId);
  const loc = s.locations.find((l) => l.id === r.locationId);
  const holder = s.parties.find((x) => x.id === r.holderId);
  const pledge = activePledgeOf(s, r.id);
  const qty = round3(r.endQty - r.startQty);
  let latest = null;
  try {
    latest = valuationFor(s, r, null);
  } catch (_) {
    latest = null;
  }
  return {
    ...r,
    qty,
    gradeName: grade ? grade.name : r.gradeId,
    locationName: loc ? loc.name : r.locationId,
    holderName: holder ? holder.name : r.holderId,
    marketValue: latest ? latest.value : null,
    activePledge: pledge
      ? {
          id: pledge.id,
          status: pledge.status,
          financerId: pledge.financerId,
          registrationNo: pledge.registration ? pledge.registration.registrationNo : null,
          canPubliclyClaimEffective: pledgeView(s, pledge).canPubliclyClaimEffective
        }
      : null
  };
}

function lineageOf(receiptId) {
  const s = getState();
  const nodes = new Map();
  const walk = (id, depth) => {
    if (nodes.has(id)) return;
    const r = s.receipts.find((x) => x.id === id);
    if (!r) return;
    nodes.set(id, { id: r.id, status: r.status, version: r.version, qty: round3(r.endQty - r.startQty), depth });
    r.parentIds.forEach((pid) => {
      walk(pid, depth + 1);
    });
  };
  walk(receiptId, 0);
  // 反向:找到祖先派生的全部后代
  const target = s.receipts.find((x) => x.id === receiptId);
  const rootAncestors = [...nodes.keys()];
  s.receipts.forEach((r) => {
    if (r.parentIds.some((p) => rootAncestors.includes(p))) walk(r.id, 0);
  });
  const edges = [];
  s.receipts.forEach((r) =>
    r.parentIds.forEach((p) => {
      if (nodes.has(r.id) && nodes.has(p)) edges.push({ from: p, to: r.id });
    })
  );
  return { target, nodes: [...nodes.values()], edges };
}

/* ===================== 监管审计快照 ===================== */
function auditSnapshot() {
  const s = getState();
  // I1 全局区间重叠审计
  const overlaps = [];
  const byLoc = {};
  s.receipts
    .filter((r) => VALID_RECEIPT_STATUS.includes(r.status))
    .forEach((r) => ((byLoc[r.locationId] ||= []).push(r)));
  Object.entries(byLoc).forEach(([loc, list]) => {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if (overlap(list[i], list[j])) overlaps.push({ locationId: loc, a: list[i].id, b: list[j].id });
  });

  // I3 重复融资审计:同一仓单是否存在多个有效质押
  const doubleFinancing = [];
  const g = {};
  s.pledges.filter((p) => ACTIVE_PLEDGE_STATUS.includes(p.status)).forEach((p) => ((g[p.receiptId] ||= []).push(p)));
  Object.entries(g).forEach(([rid, list]) => {
    if (list.length > 1) doubleFinancing.push({ receiptId: rid, pledges: list.map((p) => p.id) });
  });

  // I4 提前宣称审计:未登记却被标记可对外宣称
  const prematureClaims = s.pledges
    .filter((p) => p.publicClaimAllowed && p.status === 'LOCKED')
    .map((p) => ({ pledgeId: p.id, receiptId: p.receiptId }));

  const chain = verifyChain(s);
  return {
    chain,
    overlaps,
    doubleFinancing,
    prematureClaims,
    operations: {
      total: s.operationRecords.length,
      success: s.operationRecords.filter((o) => o.outcome === 'SUCCESS').length,
      conflict: s.operationRecords.filter((o) => o.outcome === 'CONFLICT').length,
      rejected: s.operationRecords.filter((o) => o.outcome === 'REJECTED').length
    },
    counts: {
      receipts: s.receipts.length,
      validReceipts: s.receipts.filter((r) => VALID_RECEIPT_STATUS.includes(r.status)).length,
      pledges: s.pledges.length,
      activePledges: s.pledges.filter((p) => ACTIVE_PLEDGE_STATUS.includes(p.status)).length,
      supplements: s.supplements.filter((x) => x.status === 'OPEN').length,
      releases: s.releases.length,
      deliveries: s.deliveries.length,
      operations: s.operationRecords.length,
      events: s.events.length
    }
  };
}

/* ===================== 全量查询 ===================== */
function query() {
  const s = getState();
  return {
    commodities: s.commodities,
    grades: s.grades,
    locations: s.locations,
    parties: s.parties,
    valuationBatches: [...s.valuationBatches].sort((a, b) => b.createdAt - a.createdAt),
    receipts: s.receipts.map((r) => receiptView(s, r)),
    pledges: s.pledges.map((p) => pledgeView(s, p)),
    supplements: s.supplements,
    releases: s.releases,
    deliveries: s.deliveries,
    events: s.events,
    operations: s.operationRecords.map((o) => operationView(s, o)),
    policy: { ltv: LTV_POLICY },
    audit: auditSnapshot()
  };
}

function receiptTimeline(receiptId) {
  const s = getState();
  receiptOf(s, receiptId);
  const evs = s.events.filter((e) => e.receiptId === receiptId || (e.payload && e.payload.sourceId === receiptId) || (e.payload && e.payload.parentId === receiptId));
  // 质押相关事件
  const pledgeIds = s.pledges.filter((p) => p.receiptId === receiptId).map((p) => p.id);
  const more = s.events.filter((e) => pledgeIds.includes(e.pledgeId));
  const all = [...new Map([...evs, ...more].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
  // 按仓单的操作留痕顺序(含登记回执号、放行令牌、失败原因),即「审计回放」
  const operations = s.operationRecords
    .filter((o) => o.receiptId === receiptId || (o.pledgeId && pledgeIds.includes(o.pledgeId)))
    .sort((a, b) => a.seq - b.seq)
    .map((o) => operationView(s, o));
  return { lineage: lineageOf(receiptId), events: all, operations };
}

function mustHave(v, code, msg) {
  if (v == null || v === '') throw new DomainError(code, msg);
  return v;
}

/** 仅保留留痕允许落盘的请求字段(避免把无关/内部字段写进审计记录) */
function reqView(input, fields) {
  const out = {};
  for (const f of fields) if (input[f] !== undefined) out[f] = input[f];
  return out;
}

/* ===================== 操作会话重建 / 审计查询 ===================== */
function operationView(s, op) {
  const receipt = op.receiptId ? s.receipts.find((r) => r.id === op.receiptId) : null;
  const pledge = op.pledgeId ? s.pledges.find((p) => p.id === op.pledgeId) : null;
  const actor = s.parties.find((x) => x.id === op.actorId);
  return {
    ...op,
    actorName: actor ? actor.name : op.actorId,
    receiptLocation: receipt ? receipt.locationId : null,
    pledgeStatusNow: pledge ? pledge.status : null
  };
}

/**
 * 融资方工作台会话重建:从服务端返回当前台账 + 该会话操作步骤 + 原始回执。
 * 浏览器刷新 / 服务进程重启后,工作台凭 sessionId 调此接口恢复,不依赖浏览器内存。
 */
function sessionView(sessionId) {
  const s = getState();
  if (!sessionId) throw new DomainError('SESSION_ID_REQUIRED', '缺少 sessionId');
  const ops = s.operationRecords
    .filter((o) => o.sessionId === sessionId)
    .map((o) => operationView(s, o));
  const pledgeIds = new Set(ops.map((o) => o.pledgeId).filter(Boolean));
  const receiptIds = new Set(ops.map((o) => o.receiptId).filter(Boolean));
  const pledges = s.pledges
    .filter((p) => pledgeIds.has(p.id) || (p.financerId && ops.some((o) => o.actorId === p.financerId)))
    .map((p) => pledgeView(s, p));
  pledges.forEach((p) => receiptIds.add(p.receiptId));
  const receipts = s.receipts.filter((r) => receiptIds.has(r.id)).map((r) => receiptView(s, r));
  const releases = s.releases.filter((x) => pledgeIds.has(x.pledgeId));
  const supplements = s.supplements.filter((x) => pledgeIds.has(x.pledgeId));

  // 会话内每一步的处置结论汇总(成功/冲突/拒绝)
  const steps = ops.map((o) => ({
    seq: o.seq,
    id: o.id,
    at: o.at,
    action: o.action,
    actionLabel: o.actionLabel,
    outcome: o.outcome,
    reasonCode: o.reasonCode,
    reason: o.reason,
    receiptId: o.receiptId,
    pledgeId: o.pledgeId,
    idempotencyKey: o.idempotencyKey,
    ref: o.ref
  }));
  const counts = {
    total: ops.length,
    success: ops.filter((o) => o.outcome === 'SUCCESS').length,
    conflict: ops.filter((o) => o.outcome === 'CONFLICT').length,
    rejected: ops.filter((o) => o.outcome === 'REJECTED').length
  };
  return {
    sessionId,
    rebuiltAt: Date.now(),
    counts,
    steps,
    ledger: { pledges, receipts, releases, supplements },
    chainHead: s.events.length ? s.events[s.events.length - 1].hash : 'GENESIS'
  };
}

/** 审计页操作查询:按仓单/质押/主体/结果/会话过滤,严格按发生顺序返回 */
function queryOperations(filter = {}) {
  const s = getState();
  let ops = [...s.operationRecords];
  if (filter.receiptId) {
    const pledgeIds = new Set(s.pledges.filter((p) => p.receiptId === filter.receiptId).map((p) => p.id));
    ops = ops.filter((o) => o.receiptId === filter.receiptId || (o.pledgeId && pledgeIds.has(o.pledgeId)));
  }
  if (filter.pledgeId) ops = ops.filter((o) => o.pledgeId === filter.pledgeId);
  if (filter.actorId) ops = ops.filter((o) => o.actorId === filter.actorId);
  if (filter.sessionId) ops = ops.filter((o) => o.sessionId === filter.sessionId);
  if (filter.action) ops = ops.filter((o) => o.action === filter.action);
  if (filter.outcome) ops = ops.filter((o) => o.outcome === filter.outcome);
  return ops.sort((a, b) => a.seq - b.seq).map((o) => operationView(s, o));
}

module.exports = {
  LTV_POLICY,
  ACTIVE_PLEDGE_STATUS,
  OUTCOME_SUCCESS,
  OUTCOME_CONFLICT,
  OUTCOME_REJECTED,
  CONFLICT_CODES,
  ACTION_LABELS,
  IDEMPOTENCY_KEY_OF,
  outcomeOfCode,
  logRejection,
  createValuationBatch,
  registerReceipt,
  splitReceipt,
  mergeReceipts,
  recheck,
  lockPledge,
  cancelPledge,
  registerPledge,
  supplementCollateral,
  repayPledge,
  releasePledge,
  deliver,
  query,
  auditSnapshot,
  receiptTimeline,
  sessionView,
  queryOperations,
  valuationFor,
  exposureOf
};
