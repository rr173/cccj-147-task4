# 大宗商品电子仓单登记与质押协同平台

零外部依赖(Node.js ≥18 原生 http + 文件持久化 + SHA-256 哈希链)的电子仓单协同平台,
覆盖**仓库端、融资方端、监管查询**三类工作台。

## 运行

```bash
npm start                 # 启动: http://localhost:3000
# 或指定端口 PORT=4000 node src/server.js

npm test                  # 端到端不变量测试(112 项,需先启动服务)
npm run test:restart      # 服务进程 SIGKILL→重启恢复回归(28 项,自起停服务与临时库)
npm run test:e2e          # 三页串联端到端(88 项,自起停服务;真实执行页面脚本)
npm run test:all          # 以上三套依次运行
```

> 重启恢复测试通过环境变量 `EWR_DB_FILE` 使用独立临时数据文件(默认 `/tmp/ewr-restart-db.json`),
> 不污染 `data/db.json`;端口可用 `RESTART_PORT` 覆盖。

首次启动自动载入 `src/seed.js` 演示数据;数据落盘于 `data/db.json`,任一工作台可点「重置演示数据」。

| 页面 | 地址 | 角色 |
|---|---|---|
| 仓库端 | `/warehouse.html` | 按库位+检验批登记、拆分/合并、复检、凭放行出库 |
| 融资方端 | `/financier.html` | 质押锁定/登记、补充担保、还款、放行、**质权转让与交接(双方确认)**;**可恢复会话、操作步骤回放**;并发/晚到/重放演练 |
| 监管查询 | `/regulator.html` | 区间重叠/重复融资/提前宣称/**质权转让交接**审计、哈希链验签、权属穿透、**融资方操作审计回放** |

## 五条强制业务不变量

- **I1 实物区间不重叠** — 同一库位内有效仓单的 `[startQty,endQty)` 两两相交检测,登记/拆分/合并/复检/出库每个事务提交前强制执行。
- **I2 版本锁定** — 质押锁定仓单 `version`、估值批次 `valuationBatchId`、权利人 `financerId`;旧版本晚到登记返回 `STALE_RECEIPT_VERSION` 拒绝。
- **I3 排他占有** — 一份仓单任一时刻至多一笔存续质押(`LOCKED/REGISTERED/SUPPLEMENTING`),第二家机构(含并发)得到 `ALREADY_PLEDGED`。
- **I4 登记生效** — 登记回执到达前恒为「已锁定·未登记」,`canPubliclyClaimEffective=false`,页面明确标注不得宣称担保生效。
- **I5 复检不抹押** — 复检生成新检验批、版本+1,只重估受影响仓单的质押;覆盖不足转 `SUPPLEMENTING` 并生成补充担保要求,原质押不删除。
- **I6 放行前置出库** — 有有效质押时出库必须携带**当前质权人**签发的放行令牌;未清偿只能按放行数量部分出库,令牌核销。
- **I8 质权转让双方确认** — 存续中已登记质押可发起转让;同一质押同时至多一笔待确认转让,申请锁定当时质权版本(`rightsVersion`)。原质权人与受让机构**必须分别确认同一申请**:任一方撤回、同一方重复确认、非参与方确认、基于旧质权版本的申请/确认晚到,均不改变当前权利人。第二方确认时过**生效闸口**(质押仍存续 + 敞口未清偿 + 无生效放行单)才在同一事务切换 `financerId`(权利版本 +1、原登记凭证不动、旧放行单作废);闸口不过则申请记 `REJECTED` 并给出明确原因。切换后旧质权人的登记/还款/补充/放行一律 `FORBIDDEN`,新质权人沿用原质押继续处理。

## 对抗场景的实现位置

| 风险 | 机制 |
|---|---|
| 多家机构并发质押 | `storage.js` 写操作 FIFO 串行队列 + `domain.js activePledgeOf` 排他校验,失败方留 `CONFLICT/ALREADY_PLEDGED` 操作痕迹 |
| 旧版仓单晚到 | `registerPledge()` 比对 `expectedVersion` 与仓单当前版本,拒绝留 `CONFLICT/STALE_RECEIPT_VERSION` 痕迹,质押不被抹除 |
| 非当前质权人请求 | 登记/放行(含幂等重放)校验 `actorId === pledge.financerId`,拒绝留 `REJECTED/FORBIDDEN` 痕迹 |
| 并发发起两笔转让 | 写事务 FIFO + 每质押至多一笔 PENDING 转让,第二笔 `TRANSFER_ALREADY_PENDING` 留痕,无双重权利人 |
| 重复确认 / 非参与方确认 | 同一方二次确认 `ALREADY_CONFIRMED`;非转让双方 `FORBIDDEN`;相同确认 `reqId` 重放返回首次结论 |
| 旧质权版本晚到 | 申请/确认携带 `expectedRightsVersion`,与当前 `rightsVersion` 不符一律 `STALE_PLEDGE_VERSION`,权利人不变 |
| 双方确认时已清偿/已有放行单 | 第二方确认的生效闸口在同一事务判定:`PLEDGE_SETTLED` / `RELEASE_EXISTS` → 申请落 `REJECTED`,不切换、不重复生效 |
| 转让进行中刷新/宕机 | 申请与双方确认进度、幂等表、操作留痕全部随盘持久化;重启后凭同一申请号恢复 PENDING 进度并可继续交接 |
| 拆分中途故障 | `transact()` 写时复制深拷贝,`simulateCrash` 抛错整体回滚,无半截子单 |
| 相同登记回执重放 | 登记回执号 / 锁仓 reqId / 放行 reqId 均走 `idempotency` 表,重放返回 `replayed:true` 同一结果(同一登记回执号、同一放行令牌) |
| 浏览器刷新 / 服务重启 | 每个写请求带 `sessionId`,成功/冲突/拒绝均落 `operationRecords` 并随盘持久化;`GET /api/session` 重建台账、操作步骤与原始回执 |
| 重复提交 / 断网重试 | 前端发送前把幂等键持久化为 PENDING 草稿;重建时按幂等键核对,核对不到只能「同键重发」,无幂等键步骤只按台账核对、绝不自动补发 |
| 权利链篡改 | append-only 事件,每条 `hash = sha256(prevHash + 稳定序列化载荷)`,`verifyChain()` 重算全链;操作留痕亦为链上 `ATTEMPT_LOGGED` 事件,监管页一键验签 |

## 可恢复融资方会话(I7)与操作审计

- **I7a 会话由服务端权威重建** — `sessionId` 存浏览器 localStorage;`GET /api/session?sessionId=` 返回
  当前台账(质押/仓单/放行单/补充要求)、按序操作步骤(SUCCESS / CONFLICT / REJECTED + 实际原因)、
  原始回执(锁仓版本与估值批次、**登记回执号**、**放行令牌**)。刷新页面或进程重启后工作台不依赖浏览器内存。
- **I7b 失败必留痕且不改变有效状态** — 成功/冲突(重放)留痕与业务事务原子提交;业务事务回滚后由
  独立事务补登拒绝记录,留痕不读写任何业务状态。并发冲突、陈旧版本、非当前质权人请求全部可按
  仓单/质押/主体/会话/结果在监管页回放。
- **I7c 重试不产生第二笔** — 锁仓 `reqId`、登记回执号、放行 `reqId` 在发送前生成并持久化;
  任何刷新/重启后的重试都携带同一幂等键,服务端返回首次产物(同一质押、同一登记结果、同一令牌)。
  非原请求方持相同键重放按 `FORBIDDEN` 拒绝。

## 目录

```
src/storage.js  持久化 + 串行事务 + 哈希链(EWR_DB_FILE 可指定数据文件)
src/domain.js   仓单/质押/复检/出库领域逻辑、操作留痕、会话重建与审计查询
src/seed.js     演示数据
src/server.js   HTTP API、失败留痕守卫与静态托管
public/         三端工作台(原生 HTML/JS;common.js 以 IIFE 隔离,只暴露 window.EWR,
                避免与各页顶层 `const { api, … } = EWR` 重名导致整脚本 SyntaxError)
test/smoke.mjs              69 项端到端不变量测试
test/restart-recovery.mjs   18 项进程重启恢复测试(自起停临时服务)
test/e2e-flow.mjs           63 项三页串联端到端(仓库建单→锁定/登记/清偿/授权→出库→监管)
test/mini-dom.mjs           e2e 使用的零依赖极简 DOM 垫片(在 Node 中真实加载 common.js+页面脚本)
```

## 主要 API

`POST /api/receipts/register|split|merge|recheck|deliver`
`POST /api/pledges/lock|cancel|register|supplement|repay|release`
`POST /api/pledges/transfers/apply|confirm|withdraw` · `GET /api/transfers`
`POST /api/valuation-batch` · `GET /api/state` · `GET /api/audit` · `GET /api/receipt?id=` · `POST /api/admin/reset`

会话与审计:
- `GET /api/session?sessionId=` — 重建融资方会话:台账(含**转让单**)+ 按序步骤(成功/冲突/拒绝原因)+ 原始回执;
- `GET /api/operations?receiptId=&pledgeId=&actorId=&sessionId=&outcome=&action=` — 操作留痕多条件查询,按发生顺序返回(支持 `transferApply/transferConfirm/transferWithdraw`);
- 六个 `/api/pledges/*` 与三个 `/api/pledges/transfers/*` 写接口均可携带 `sessionId`;锁仓/登记/放行/转让申请/确认/撤回的幂等键(`reqId`/`registrationNo`)在服务端去重,重放返回首次结果。

质权转让接口:
- `POST /api/pledges/transfers/apply` — 当前质权人发起:`{pledgeId,toFinancerId,expectedRightsVersion,reqId,actorId}`,返回 PENDING 申请(锁定质权版本);
- `POST /api/pledges/transfers/confirm` — 一方确认:`{transferId,actorId,side,expectedRightsVersion,reqId}`;第二方确认时同事务过闸口,返回 `effective:true` 或 `{effective:false,rejectCode}`(申请落 REJECTED);
- `POST /api/pledges/transfers/withdraw` — 任一方撤回:`{transferId,actorId,reqId}`,撤回后权利人不变,可重新发起。

`GET /api/receipt?id=` 的时间线另含 `operations[]`(按仓单的操作顺序、登记回执号、放行令牌与失败原因)。
