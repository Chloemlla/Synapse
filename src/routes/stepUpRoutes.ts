import express from "express";
import { createLimiter } from "../middleware/rateLimiter";
import { authenticateToken } from "../middleware/authenticateToken";
import { createStepUpGrantHandler, discardStepUpGrantHandler } from "../controllers/stepUpController";

/**
 * 逐步验证（step-up）票据端点 —— RC-46。
 *
 * 为什么自己建限流器而不是进 `routeLimiters.ts`：那 64 个定义是全局共享的额度档位表，
 * 这两个端点需要的是**单用户**频次约束（一枚 grant 只该在一次弹窗后换一次），
 * 与 `analyticsRoutes` 的做法一致（在本文件内自建、避免与挂载级限流器重复计数）。
 * 注意：`rateLimited: true` 在模块声明里已如实标注。
 */
const router = express.Router();

// 兑换口子放得很紧：正常用户一次弹窗只调用一次；超过就是「无限弹窗」式可用性攻击面。
const grantLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: "验证请求过于频繁，请稍后再试",
});

const discardLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: "请求过于频繁，请稍后再试",
});

/**
 * @openapi
 * /step-up/grant:
 *   post:
 *     summary: 用一批服务端签名的挑战票据兑换一枚 step-up grant
 *     description: |
 *       被账户风险闸门拦截（403 STEP_UP_REQUIRED）后调用：先完成一次人机验证，
 *       再把队列里所有被拦请求的 challengeTicket 一起提交，换取一枚短时效 grant。
 *       grant 的可用次数严格等于服务端校验通过的票据数（上限 5），客户端声明的数量无效。
 *     tags:
 *       - StepUp
 *     responses:
 *       200:
 *         description: 已签发 grant
 *       400:
 *         description: 票据无效或已使用
 *       403:
 *         description: 人机验证失败或供应商不在白名单内
 */
router.post("/grant", grantLimiter, authenticateToken, createStepUpGrantHandler);

/**
 * @openapi
 * /step-up/discard:
 *   post:
 *     summary: 主动作废一枚 step-up grant（前端队列排空后调用）
 *     tags:
 *       - StepUp
 *     responses:
 *       200:
 *         description: 已作废（幂等）
 */
router.post("/discard", discardLimiter, authenticateToken, discardStepUpGrantHandler);

export default router;
