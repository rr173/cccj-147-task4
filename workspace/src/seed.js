/**
 * seed.js —— 演示基础数据:品类/品级/库位/参与方/初始仓单/估值批次
 */
'use strict';
const { freshState, reset } = require('./storage');

function buildSeed() {
  const s = freshState();
  const now = Date.now();

  s.commodities = [
    { id: 'CU', name: '阴极铜', unit: '吨' },
    { id: 'AL', name: '电解铝', unit: '吨' }
  ];

  // 品级基础价(元/吨)仅用于说明,真实价格以估值批次快照为准
  s.grades = [
    { id: 'CU-A', commodityId: 'CU', name: 'A级铜(99.95%)', basePrice: 72000 },
    { id: 'CU-B', commodityId: 'CU', name: 'B级铜(99.90%)', basePrice: 69000 },
    { id: 'AL-A', commodityId: 'AL', name: 'A级铝锭(99.70%)', basePrice: 19800 },
    { id: 'AL-B', commodityId: 'AL', name: 'B级铝锭(99.50%)', basePrice: 18600 }
  ];

  s.parties = [
    { id: 'WH-1', type: 'warehouse', name: '华东保税仓储有限公司' },
    { id: 'FIN-ICBC', type: 'financer', name: '鼎信银行供应链金融部' },
    { id: 'FIN-CMB', type: 'financer', name: '远航银行动产融资中心' },
    { id: 'ENT-HONGTAI', type: 'enterprise', name: '宏泰铜业有限公司' },
    { id: 'ENT-LVYE', type: 'enterprise', name: '绿野铝业有限公司' },
    { id: 'REG-1', type: 'regulator', name: '地方金融监督管理局' }
  ];

  s.locations = [
    { id: 'LOC-A1', warehouseId: 'WH-1', name: 'A区1号铜仓位', capacity: 5000, commodityId: 'CU' },
    { id: 'LOC-A2', warehouseId: 'WH-1', name: 'A区2号铜仓位', capacity: 5000, commodityId: 'CU' },
    { id: 'LOC-B1', warehouseId: 'WH-1', name: 'B区1号铝仓位', capacity: 8000, commodityId: 'AL' }
  ];

  // 最新市场估值批次(价格快照,质押登记时锁定具体批次)
  s.seq.valuation = 1;
  s.valuationBatches = [
    {
      id: 'VB0001',
      note: '2026年9月第4周市场价格',
      prices: { 'CU-A': 72500, 'CU-B': 69500, 'AL-A': 19900, 'AL-B': 18700 },
      createdAt: now - 86400000 * 2,
      createdBy: 'REG-1'
    }
  ];

  // 检验批 + 仓单(版本1,区间不重叠)
  s.seq.batch = 3;
  s.seq.receipt = 3;
  s.inspectionBatches = [
    { id: 'IB0001', receiptId: 'WR0001', locationId: 'LOC-A1', gradeId: 'CU-A', qty: 1000, inspectedAt: now - 86400000 * 3, kind: 'INITIAL' },
    { id: 'IB0002', receiptId: 'WR0002', locationId: 'LOC-A2', gradeId: 'CU-A', qty: 600, inspectedAt: now - 86400000 * 3, kind: 'INITIAL' },
    { id: 'IB0003', receiptId: 'WR0003', locationId: 'LOC-B1', gradeId: 'AL-A', qty: 2000, inspectedAt: now - 86400000 * 3, kind: 'INITIAL' }
  ];
  s.receipts = [
    {
      id: 'WR0001', warehouseId: 'WH-1', locationId: 'LOC-A1', commodityId: 'CU', gradeId: 'CU-A',
      holderId: 'ENT-HONGTAI', inspectionBatchId: 'IB0001',
      startQty: 0, endQty: 1000, version: 1, status: 'ACTIVE', parentIds: [],
      createdAt: now - 86400000 * 3, deliveredQty: 0
    },
    {
      id: 'WR0002', warehouseId: 'WH-1', locationId: 'LOC-A2', commodityId: 'CU', gradeId: 'CU-A',
      holderId: 'ENT-HONGTAI', inspectionBatchId: 'IB0002',
      startQty: 0, endQty: 600, version: 1, status: 'ACTIVE', parentIds: [],
      createdAt: now - 86400000 * 3, deliveredQty: 0
    },
    {
      id: 'WR0003', warehouseId: 'WH-1', locationId: 'LOC-B1', commodityId: 'AL', gradeId: 'AL-A',
      holderId: 'ENT-LVYE', inspectionBatchId: 'IB0003',
      startQty: 0, endQty: 2000, version: 1, status: 'ACTIVE', parentIds: [],
      createdAt: now - 86400000 * 3, deliveredQty: 0
    }
  ];

  return s;
}

function seed() {
  reset(buildSeed());
}

module.exports = { buildSeed, seed };
