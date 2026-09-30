/**
 * server.js —— HTTP 服务(零依赖,Node 原生 http)
 * 静态托管 public/,并提供 /api/* JSON 接口。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { load, DomainError, getState } = require('./storage');
const domain = require('./domain');
const { seed } = require('./seed');

load();

/* ---------- 融资方操作守卫:业务事务回滚后,独立事务补登失败留痕 ----------
 * 成功/重放留痕已在业务事务内写入(原子);到达这里的只有被拒绝的请求。
 * 留痕与有效状态隔离:并发冲突、陈旧版本、非当前质权人请求全部可追溯,但不改变台账。
 */
const REQ_FIELDS = {
  lock: ['reqId', 'receiptId', 'financerId', 'pledgorId', 'valuationBatchId', 'loanAmount'],
  register: ['pledgeId', 'registrationNo', 'expectedVersion', 'valuationBatchId', 'registrar'],
  cancel: ['pledgeId', 'actorId'],
  supplement: ['pledgeId', 'amount', 'actorId'],
  repay: ['pledgeId', 'amount', 'actorId'],
  release: ['reqId', 'pledgeId', 'qty']
};

function guard(action, fn) {
  return async (body, query) => {
    try {
      return await fn(body, query);
    } catch (e) {
      if (e instanceof DomainError) {
        const input = body || {};
        let receiptId = input.receiptId || null;
        let pledgeId = input.pledgeId || null;
        if (!receiptId && pledgeId) {
          const p = getState().pledges.find((x) => x.id === pledgeId);
          if (p) receiptId = p.receiptId;
        }
        const idempotencyKey = domain.IDEMPOTENCY_KEY_OF[action]
          ? domain.IDEMPOTENCY_KEY_OF[action](input)
          : null;
        const request = {};
        for (const f of REQ_FIELDS[action] || []) if (input[f] !== undefined) request[f] = input[f];
        try {
          await domain.logRejection({
            action,
            actorId: input.actorId || null,
            sessionId: input.sessionId || null,
            receiptId,
            pledgeId,
            idempotencyKey,
            reasonCode: e.code,
            reason: e.message,
            request
          });
        } catch (logErr) {
          console.error('[audit log failure]', logErr); // 审计写入异常不得掩盖原始业务错误
        }
      }
      throw e;
    }
  };
}

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2e6) reject(new DomainError('BODY_TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new DomainError('BAD_JSON', 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------- API 路由 ------------------------------- */
const routes = {
  'GET /api/state': async () => domain.query(),
  'GET /api/audit': async () => domain.auditSnapshot(),
  'GET /api/session': async (body, query) => domain.sessionView(query.get('sessionId')),
  'GET /api/operations': async (body, query) =>
    domain.queryOperations({
      receiptId: query.get('receiptId') || undefined,
      pledgeId: query.get('pledgeId') || undefined,
      actorId: query.get('actorId') || undefined,
      sessionId: query.get('sessionId') || undefined,
      action: query.get('action') || undefined,
      outcome: query.get('outcome') || undefined
    }),
  'GET /api/receipt': async (body, query) => {
    const id = query.get('id');
    if (!id) throw new DomainError('ID_REQUIRED', '缺少 id');
    return domain.receiptTimeline(id);
  },
  'POST /api/valuation-batch': (b) => domain.createValuationBatch(b.actorId, b.note, b.prices),
  'POST /api/receipts/register': (b) => domain.registerReceipt(b),
  'POST /api/receipts/split': (b) => domain.splitReceipt(b),
  'POST /api/receipts/merge': (b) => domain.mergeReceipts(b),
  'POST /api/receipts/recheck': (b) => domain.recheck(b),
  'POST /api/receipts/deliver': (b) => domain.deliver(b),
  'POST /api/pledges/lock': guard('lock', (b) => domain.lockPledge(b)),
  'POST /api/pledges/cancel': guard('cancel', (b) => domain.cancelPledge(b)),
  'POST /api/pledges/register': guard('register', (b) => domain.registerPledge(b)),
  'POST /api/pledges/supplement': guard('supplement', (b) => domain.supplementCollateral(b)),
  'POST /api/pledges/repay': guard('repay', (b) => domain.repayPledge(b)),
  'POST /api/pledges/release': guard('release', (b) => domain.releasePledge(b)),
  'POST /api/admin/reset': async () => {
    seed();
    return { ok: true, message: '已重置为演示数据' };
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) throw new DomainError('NOT_FOUND', `无此接口:${key}`);
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await handler(body, url.searchParams);
      return sendJson(res, 200, { ok: true, data: result });
    }

    // 静态文件
    let filePath = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC, 'index.html');
    const ext = path.extname(filePath);
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    return res.end(buf);
  } catch (e) {
    if (e instanceof DomainError) {
      return sendJson(res, 400, { ok: false, error: { code: e.code, message: e.message, extra: e.extra } });
    }
    console.error('[server error]', e);
    return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: e.message } });
  }
});

server.listen(PORT, () => {
  console.log(`大宗商品电子仓单登记与质押协同平台已启动: http://localhost:${PORT}`);
  console.log('  仓库端   /warehouse.html   融资方端 /financier.html   监管端 /regulator.html');
});
