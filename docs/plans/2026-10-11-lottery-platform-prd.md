# 抽奖中台 PRD → 落地方案（分阶段）

> 状态：**Stage 1 已实现**（幂等 + 审计流水），其余为待排期。
> 日期：2026-10-11。来源：产品需求文档《抽奖系统产品需求文档 (PRD)》。
> 前置：`docs/plans/2026-10-10-librechat-quota-ban.md` 无关；本次针对抽奖（`lottery`）。

## 0. 现状盘点（与 PRD 的差距）

已具备（本轮之前 + 本轮前两次提交逐步补齐）：

| PRD 能力 | 现状 | 位置 |
| --- | --- | --- |
| 权重池抽奖 + CSPRNG | ✅ 已修（`pickPrize`，绝对概率语义、未中奖区间、不补贴第一个奖品） | `src/services/lotteryService.ts` |
| 奖品库存扣减 | ✅ 单机/共享锁下「读最新快照 → 扣减 → 写回」，非 Redis Lua | 同上 |
| 人机验证 / 管理员豁免 | ✅ 三家供应商共用下发链路 | 同上 + `ManagedCaptcha` |
| 概率/时间/数量入参硬化 | ✅ 概率 0-1、数量正整数、库存服务端初始化、概率和 > 1 归一化 | `src/controllers/lotteryController.ts` |
| 视图隐私 | ✅ 普通用户不回参与者 userId（`hasParticipated` / 计数） | 同上 |
| 排行榜 / 统计 | ✅ 批量读 + 单次读轮次 | `src/services/lotteryService.ts` |
| **请求幂等（Request ID）** | ✅ **本阶段** | 本文件 §1 |
| **抽奖审计流水（随机数/落点/结果）** | ✅ **本阶段** | 本文件 §1 |
| 抽奖机会/资格体系（每日免费、任务、资产消耗） | ❌ 目前「每人每轮 1 次」 | 待排期 Stage 2 |
| 保底（第 N 次必中指定等级） | ❌ | 待排期 Stage 2（依赖多抽） |
| 出奖速度控制 / 预算约束（Pacing） | ❌ | 待排期 Stage 3 |
| Redis Lua 原子预扣库存 | ❌ 现为共享锁 | 待排期 Stage 3 |
| 实时风控（设备指纹/行为/IP 频率）+ 静默降级空奖 | ⚠️ 仅限流 + 人机验证 | 待排期 Stage 4 |
| 履约中心（虚拟直充 / 卡密池 / 实物邮寄） | ❌ 只有中奖记录 | 待排期 Stage 5 |
| MQ 削峰 / 异步落库 | ❌ 当前同步写 | 待排期 Stage 5（需基础设施决策） |

## 1. Stage 1（本次已实现）：请求幂等 + 抽奖审计

### 1.1 幂等（PRD §4「客户端请求携带全局唯一 Request ID，全链路保证幂等」）

- `POST /api/lottery/rounds/:roundId/participate` 接受可选 `requestId`（≤64 字符）。
- 幂等键 `lottery:idem:<userId>:<requestId>` 走 `sharedStateStore`（Redis → Mongo → 内存三层）：
  - `claim(key, 10min, "pending")` 抢到 → 正常抽奖，结束后 `set(key, { roundId, winner })`；
  - 未抢到 → `get(key)`：已存结果则**直接重放**（不再抽、不再扣库存）；仍是 `pending` 则回「处理中，请稍后重试」；
  - 业务拒绝（已参与/验证失败/领完）会 `delete(key)`，同一 id 可安全重试。
- 幂等键带 `roundId`：同一个 requestId 换轮次复用会被拒，避免串轮。

### 1.2 审计（PRD §4「记录完整抽奖生命周期日志……不可变保存」）

- 每次抽奖写一条 `AuditLogService.log`：`module: "lottery"`、`action: "lottery.draw"`，
  `detail` 含 `roundId / outcome(win|no_win) / randomValue / prizeId / prizeName / remainingAfter / requestId`。
- 复用既有审计体系（`audit_logs`，60 天 TTL + 批量落盘兜底 + 管理端审计查看器按 `lottery` 模块筛选），
  不另造一套「抽奖流水」表——审计的不可变性/保留期/导出/脱敏已经在那一套里。
- 审计写入失败不回滚抽奖（fire-and-forget + try/catch）：履约事实以轮次/用户记录为准。

### 1.3 前端

- `api/lottery.ts` / `useLottery`：每次参与生成一个 `requestId`（`crypto.randomUUID()`，回落时间戳+随机），
  随请求体发送。同一次「用户动作」的重复投递（代理重发/手动重试）会被服务端幂等吸收。

## 2. Stage 2（待排期）：抽奖机会 + 保底

- 机会来源：每日免费次数（跨天清零/累加可配）、行为任务发放、积分/代币消耗（PRD §3.2）。
- 原子扣减：`sharedStateStore` 计数器（需新增 `incrBy` 原子指令）或落库计数 + 幂等键。
- 保底：轮次级 `guarantee: { everyDraws, category }`，按「本轮个人抽奖次数」计数，达阈值强制出该等级。
- 需要产品定：免费次数、任务种类、积分汇率、保底阈值与是否可跨轮累计。

## 3. Stage 3（待排期）：Pacing 与 Redis Lua 库存

- 预算/速度控制：按时间片配额（小时/分钟窗口）限制贵重奖出奖速率。
- Redis Lua 预扣库存 + 异步对账落库；无 Redis 时回落当前共享锁实现。
- 需要运维定：Redis 容量与降级策略。

## 4. Stage 4（待排期）：实时风控

- 设备指纹 / 行为画像 / IP 频率（可复用 `ipRiskService`、`fingerprint`、限流器）。
- 柔性对抗：命中高危 → 静默降级为「空奖/再接再厉」，不返回可被逆向的错误码。
- 需要安全定：风险分级口径、降级比例、申诉与误伤回滚。

## 5. Stage 5（待排期）：履约中心

- 虚拟资产直充（内部 RPC）、三方卡密池（加密提取、防碰撞）、实物（地址收集 + 时效 + 超时作废）。
- MQ 异步写入与发货通知（需引入消息队列或复用现有后台任务机制）。
- 需要产品/运维定：奖品类型与对接方、履约 SLA、超时策略。

## 6. 判据

- Stage 1：同 requestId 重放不产生第二次抽奖/扣库存；不同轮次复用同一 id 被拒；
  审计写入 `lottery.draw` 且含随机数与落点；不改变现有「每人每轮一次」与中奖语义。
