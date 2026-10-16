import express from "express";
import { lotteryController } from "../controllers/lotteryController";
import { authenticateToken } from "../middleware/authenticateToken";
import { createLimiter } from "../middleware/routeLimiters";

const router = express.Router();

// 抽奖相关限流器
const lotteryLimiter = createLimiter({
  name: "lottery",
  profile: "relaxed",
  category: "public-api",
  max: 90,
  message: "抽奖请求过于频繁，请稍后再试",
});

const participationLimiter = createLimiter({
  name: "lotteryParticipation",
  profile: "sensitive",
  category: "public-api",
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: "参与抽奖过于频繁，请稍后再试",
});

// 公开接口 - 无需认证（已限流）
// 涉及数据库读取：区块链数据
router.get("/blockchain", lotteryLimiter, authenticateToken, lotteryController.getBlockchainData.bind(lotteryController));
// 涉及数据库读取：所有抽奖轮次
router.get("/rounds", lotteryLimiter, authenticateToken, lotteryController.getLotteryRounds.bind(lotteryController));
// 涉及数据库读取：活跃轮次
router.get(
  "/rounds/active",
  lotteryLimiter,
  authenticateToken,
  lotteryController.getActiveRounds.bind(lotteryController),
);
// 涉及数据库读取：单轮详情
router.get(
  "/rounds/:roundId",
  lotteryLimiter,
  authenticateToken,
  lotteryController.getRoundDetails.bind(lotteryController),
);
// 涉及数据库读取：排行榜
router.get("/leaderboard", lotteryLimiter, authenticateToken, lotteryController.getLeaderboard.bind(lotteryController));
// 涉及数据库读取：统计信息
router.get("/statistics", lotteryLimiter, authenticateToken, lotteryController.getStatistics.bind(lotteryController));

// 需要认证的接口（已限流）
// 限流器一律排在 authenticateToken 之前：未登录流量在进入 JWT 校验/会话查询前就被削峰，
// 且 CodeQL js/missing-rate-limiting 只认「限流先于鉴权」这一种形状（与 coinFlip / geogebra 同一约定）。
// keyGenerator 未指定即按 IP 分桶，故调序不改变配额归属，也不引入重复计数。
// 涉及数据库读取：用户抽奖记录
router.get("/user/record", lotteryLimiter, authenticateToken, lotteryController.getUserRecord.bind(lotteryController));
// 涉及数据库读取/写入：抽奖机会余额（懒发放当日免费额度）
router.get("/chances", lotteryLimiter, authenticateToken, lotteryController.getChances.bind(lotteryController));
// 发放抽奖机会（仅超管）
router.post("/chances/grant", lotteryLimiter, authenticateToken, lotteryController.grantChances.bind(lotteryController));
// 发放抽奖积分（仅超管）
router.post("/assets/grant", lotteryLimiter, authenticateToken, lotteryController.grantAssets.bind(lotteryController));
// 积分兑换抽奖机会
router.post("/chances/exchange", lotteryLimiter, authenticateToken, lotteryController.exchangeChances.bind(lotteryController));
// 行为任务列表与领取
router.get("/tasks", lotteryLimiter, authenticateToken, lotteryController.getTasks.bind(lotteryController));
router.post("/tasks/:taskKey/claim", lotteryLimiter, authenticateToken, lotteryController.claimTask.bind(lotteryController));
// 对账（仅超管）
router.get("/reconciliation/t0", lotteryLimiter, authenticateToken, lotteryController.getT0Reconciliation.bind(lotteryController));
router.get("/reconciliation/t1", lotteryLimiter, authenticateToken, lotteryController.getT1Reconciliation.bind(lotteryController));
// 履约（我的奖品 / 地址 / 转赠 / 折现）
router.get("/fulfillments/me", lotteryLimiter, authenticateToken, lotteryController.getMyFulfillments.bind(lotteryController));
router.post("/fulfillments/:id/address", lotteryLimiter, authenticateToken, lotteryController.submitFulfillmentAddress.bind(lotteryController));
router.post("/fulfillments/:id/transfer", lotteryLimiter, authenticateToken, lotteryController.transferFulfillment.bind(lotteryController));
router.post("/fulfillments/:id/redeem", lotteryLimiter, authenticateToken, lotteryController.redeemFulfillment.bind(lotteryController));
// 表现层 / AB / 风控大盘（仅超管）
router.put("/rounds/:roundId/presentation", lotteryLimiter, authenticateToken, lotteryController.updateRoundPresentation.bind(lotteryController));
router.get("/rounds/:roundId/ab-stats", lotteryLimiter, authenticateToken, lotteryController.getAbStats.bind(lotteryController));
router.get("/risk/dashboard", lotteryLimiter, authenticateToken, lotteryController.getRiskDashboard.bind(lotteryController));
// 涉及数据库写入：参与抽奖（更新用户、轮次等）
router.post(
  "/rounds/:roundId/participate",
  participationLimiter,
  authenticateToken,
  lotteryController.participateInLottery.bind(lotteryController),
);

// 管理员接口（已限流）
// 涉及数据库写入：创建新抽奖轮次
router.post("/rounds", lotteryLimiter, authenticateToken, lotteryController.createLotteryRound.bind(lotteryController));
// 涉及数据库写入：更新轮次状态
router.put(
  "/rounds/:roundId/status",
  lotteryLimiter,
  authenticateToken,
  lotteryController.updateRoundStatus.bind(lotteryController),
);
// 涉及数据库写入：重置轮次
router.post(
  "/rounds/:roundId/reset",
  lotteryLimiter,
  authenticateToken,
  lotteryController.resetRound.bind(lotteryController),
);
// 删除所有轮次（仅管理员）
router.delete("/rounds", lotteryLimiter, authenticateToken, lotteryController.deleteAllRounds.bind(lotteryController));

export default router;
