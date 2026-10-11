import crypto from "node:crypto";
import type { Request, Response } from "express";
import { isAdminRole, isSuperAdmin } from "../middleware/auth";
import { type LotteryPrize, type LotteryRound, lotteryService } from "../services/lotteryService";
import { boundedInt, firstString } from "../utils/httpParam";
import logger from "../utils/logger";

// 简单WAF校验函数
function wafCheck(str: string, maxLen = 128): boolean {
  if (typeof str !== "string") return false;
  if (!str.trim() || str.length > maxLen) return false;
  if (/[<>{}"'`;\\]/.test(str)) return false;
  if (/\b(select|update|delete|insert|drop|union|script|alert|onerror|onload)\b/i.test(str)) return false;
  return true;
}

// 500 统一用通用文案：raw error.message 会把 Mongo/驱动内部细节（集合名、索引冲突、
// provider 响应片段）漏给任意登录用户，而前端在错误分支上都会给出可读提示。
const SERVER_ERROR_MESSAGE = "服务器错误，请稍后重试";

/**
 * 参与抽奖的业务拒因：这些都是**说给用户听**的话，必须原样透出（前端直接展示）。
 * 其余看起来像内部异常的（数据库、驱动、IPFS 之类）一律回通用文案。
 */
const LOTTERY_USER_FACING_ERRORS = [
  "人机验证",
  "Turnstile",
  "已经参与过",
  "已结束",
  "时间未到",
  "没有可用的奖品",
  "不存在",
  "请稍后重试",
] as const;

function isUserFacingLotteryError(message: string): boolean {
  return LOTTERY_USER_FACING_ERRORS.some((fragment) => message.includes(fragment));
}

const PRIZE_CATEGORIES = new Set(["common", "rare", "epic", "legendary"]);
const MAX_PRIZES_PER_ROUND = 50;
const MAX_PRIZE_QUANTITY = 1_000_000;

/**
 * 普通用户看到的轮次：不回参与者的内部用户 id（隐私），改回「本人是否已参与」与计数，
 * 中奖记录也去掉 userId。管理员拿完整数据（管理面板要按 id 排查异常）。
 */
function sanitizeRoundForViewer<T extends LotteryRound>(round: T, userId: string | undefined, isAdmin: boolean): T {
  if (isAdmin) return round;
  const { participants, winners, drawCounts, ...rest } = round;
  const drawsUsed = userId ? Math.max(0, Math.floor(drawCounts?.[userId] ?? 0)) : 0;
  const maxDraws = Math.max(1, Math.floor(round.maxDrawsPerUser || 1));
  return {
    ...rest,
    participants: [],
    hasParticipated: Boolean(userId) && participants.includes(userId as string),
    participantCount: participants.length,
    winnerCount: winners.length,
    maxDrawsPerUser: maxDraws,
    chanceCost: Math.max(0, Math.floor(round.chanceCost || 0)),
    drawsUsed,
    remainingDraws: Math.max(0, maxDraws - drawsUsed),
    winners: winners.map(({ userId: _ignored, ...winner }) => winner),
  } as unknown as T;
}

function viewerIsAdmin(req: Request): boolean {
  return Boolean(req.user && isAdminRole(req.user.role));
}

export class LotteryController {
  // 获取区块链数据
  public async getBlockchainData(_req: Request, res: Response): Promise<void> {
    try {
      const blockchainData = await lotteryService.getBlockchainData();
      res.json({
        success: true,
        data: blockchainData,
      });
    } catch (error) {
      logger.error("获取区块链数据失败:", error);
      res.status(500).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 创建抽奖轮次
  public async createLotteryRound(req: Request, res: Response): Promise<void> {
    logger.info("收到创建轮次请求", req.body);
    try {
      if (!isSuperAdmin(req)) {
        res.status(403).json({ success: false, error: "权限不足" });
        return;
      }
      let { name, description, startTime, endTime, prizes } = req.body;
      // WAF校验
      if (!wafCheck(name, 64) || !wafCheck(description, 256)) {
        res.status(400).json({ success: false, error: "参数非法" });
        return;
      }
      // 时间必须是可解析的真实时刻：NaN 一旦落库，轮次永远不会出现在「活跃」里。
      const startsAt = new Date(startTime).getTime();
      const endsAt = new Date(endTime).getTime();
      if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
        res.status(400).json({ success: false, error: "开始/结束时间格式非法" });
        return;
      }
      if (!Array.isArray(prizes) || prizes.length === 0) {
        res.status(400).json({ success: false, error: "奖品列表不能为空" });
        return;
      }
      if (prizes.length > MAX_PRIZES_PER_ROUND) {
        res.status(400).json({ success: false, error: `奖品数量不能超过 ${MAX_PRIZES_PER_ROUND} 个` });
        return;
      }

      const warnings: string[] = [];
      const normalizedPrizes: LotteryPrize[] = [];
      const seenPrizeIds = new Set<string>();
      for (const p of prizes) {
        if (!wafCheck(p?.name, 64) || !wafCheck(p?.description, 128)) {
          res.status(400).json({ success: false, error: "奖品参数非法" });
          return;
        }
        const value = Number(p.value);
        const probability = Number(p.probability);
        const quantity = Number(p.quantity);
        if (!Number.isFinite(value) || value < 0) {
          res.status(400).json({ success: false, error: "奖品价值必须是非负数字" });
          return;
        }
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
          res.status(400).json({ success: false, error: "奖品概率必须在 0 到 1 之间" });
          return;
        }
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PRIZE_QUANTITY) {
          res.status(400).json({ success: false, error: `奖品数量必须是不小于 1 的整数（上限 ${MAX_PRIZE_QUANTITY}）` });
          return;
        }
        // 客户端传的 id/remaining 不采信：库存由服务端按数量初始化，id 缺失或重复就补一个。
        let prizeId = typeof p.id === "string" && p.id.trim() ? p.id.trim() : "";
        if (!prizeId || seenPrizeIds.has(prizeId)) prizeId = crypto.randomUUID();
        seenPrizeIds.add(prizeId);
        normalizedPrizes.push({
          id: prizeId,
          name: p.name,
          description: p.description,
          value,
          probability,
          quantity,
          remaining: quantity,
          category: typeof p.category === "string" && PRIZE_CATEGORIES.has(p.category) ? p.category : "common",
          ...(typeof p.image === "string" && p.image ? { image: p.image } : {}),
        });
      }

      // 强制修正：开始时间不能晚于结束时间
      if (startsAt > endsAt) {
        [startTime, endTime] = [endTime, startTime];
        warnings.push("开始时间和结束时间已自动调整。");
      }
      // 强制修正：奖品总概率不能大于 1（小于 1 的剩余部分是「未中奖」概率，不会被补贴给某个奖品）
      const totalProb = normalizedPrizes.reduce((sum, p) => sum + p.probability, 0);
      if (totalProb > 1) {
        for (const prize of normalizedPrizes) {
          prize.probability = Number((prize.probability / totalProb).toFixed(6));
        }
        warnings.push("奖品概率已自动归一化。");
      }
      // 抽奖机会与多次抽奖（可选，默认保持历史「每人免费抽一次」行为）
      const maxDrawsPerUser = boundedInt(req.body?.maxDrawsPerUser, { min: 1, max: 1000, fallback: 1 });
      const chanceCost = boundedInt(req.body?.chanceCost, { min: 0, max: 100000, fallback: 0 });
      // 硬保底（可选）：每 everyDraws 抽至少出 category 及以上稀有度
      let guarantee: { everyDraws: number; category: LotteryPrize["category"] } | undefined;
      const rawGuarantee = req.body?.guarantee;
      if (rawGuarantee && typeof rawGuarantee === "object") {
        const everyDraws = boundedInt((rawGuarantee as Record<string, unknown>).everyDraws, {
          min: 1,
          max: 100000,
          fallback: 0,
        });
        const category = (rawGuarantee as Record<string, unknown>).category;
        if (everyDraws < 1 || typeof category !== "string" || !PRIZE_CATEGORIES.has(category)) {
          res.status(400).json({ success: false, error: "保底配置非法（需要 everyDraws ≥ 1 与合法稀有度）" });
          return;
        }
        guarantee = { everyDraws, category: category as LotteryPrize["category"] };
      }
      const roundData = {
        name,
        description,
        startTime: new Date(startTime).getTime(),
        endTime: new Date(endTime).getTime(),
        isActive: true,
        prizes: normalizedPrizes,
        maxDrawsPerUser,
        chanceCost,
        ...(guarantee ? { guarantee } : {}),
      };
      const round = await lotteryService.createLotteryRound(roundData);
      res.json({
        success: true,
        data: round,
        ...(warnings.length ? { warning: warnings.join(" ") } : {}),
      });
    } catch (error) {
      logger.error("创建抽奖轮次失败:", error);
      res.status(500).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 获取所有抽奖轮次
  public async getLotteryRounds(req: Request, res: Response): Promise<void> {
    try {
      logger.debug("[Lottery] 开始处理抽奖轮次请求", {
        userId: req.user?.id,
        username: req.user?.username,
        role: req.user?.role,
        ip: req.ip,
      });

      const rounds = await lotteryService.getLotteryRounds();
      logger.debug("[Lottery] 获取到抽奖轮次数量", { count: rounds.length });

      // 内部 userId 只留给管理员：普通用户拿到的是「本人是否已参与 + 计数」的视图。
      const isAdmin = viewerIsAdmin(req);
      const data = rounds.map((round) => sanitizeRoundForViewer(round, req.user?.id, isAdmin));
      res.json({ success: true, data });
    } catch (error) {
      logger.error("获取抽奖轮次失败:", error);
      res.status(500).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 获取活跃的抽奖轮次
  public async getActiveRounds(req: Request, res: Response): Promise<void> {
    try {
      const rounds = await lotteryService.getActiveRounds();
      const isAdmin = viewerIsAdmin(req);
      res.json({
        success: true,
        data: rounds.map((round) => sanitizeRoundForViewer(round, req.user?.id, isAdmin)),
      });
    } catch (error) {
      logger.error("获取活跃抽奖轮次失败:", error);
      res.status(500).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 参与抽奖
  public async participateInLottery(req: Request, res: Response): Promise<void> {
    try {
      const roundId = firstString(req.params.roundId);
      const { cfToken } = req.body;
      // 三家供应商共用同一套下发链路：客户端带什么供应商就验哪家。
      const captchaProvider = req.body.captchaProvider ?? req.body.captchaType;
      // 全链路幂等（PRD §4）：客户端全局唯一请求 id，同一 id 的重放不再抽一次。
      const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.trim().slice(0, 64) : "";
      const userId = req.user?.id;

      if (!roundId) {
        res.status(400).json({ success: false, message: "无效的轮次ID" });
        return;
      }
      const username = req.user?.username;

      if (!userId || !username) {
        res.status(401).json({
          success: false,
          error: "用户未登录",
        });
        return;
      }
      // WAF校验
      if (!wafCheck(roundId, 64) || !wafCheck(username, 64)) {
        res.status(400).json({ success: false, error: "参数非法" });
        return;
      }

      const winner = await lotteryService.participateInLottery(
        roundId,
        userId,
        username,
        cfToken,
        req.user?.role,
        captchaProvider,
        { requestId: requestId || undefined, ip: req.ip, userAgent: req.headers["user-agent"] || "" },
      );

      res.json({
        success: true,
        data: winner,
      });
    } catch (error) {
      logger.error("参与抽奖失败:", error);
      // 参与抽奖的失败绝大多数是**业务拒因**（已参与过 / 奖品已领完 / 不在抽奖时间段 /
      // 人机验证未通过），前端会把文案直接展示给用户 —— 这类必须原样返回；
      // 只有看起来是内部异常时才退到通用文案。
      if (error instanceof Error) {
        if (isUserFacingLotteryError(error.message)) {
          res.status(400).json({
            success: false,
            error: error.message,
          });
          return;
        }
      }

      res.status(400).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 获取轮次详情
  public async getRoundDetails(req: Request, res: Response): Promise<void> {
    try {
      const roundId = firstString(req.params.roundId);
      if (!roundId) {
        res.status(400).json({ success: false, message: "无效的轮次ID" });
        return;
      }
      const round = await lotteryService.getRoundDetails(roundId);

      if (!round) {
        res.status(404).json({
          success: false,
          error: "抽奖轮次不存在",
        });
        return;
      }

      res.json({
        success: true,
        data: sanitizeRoundForViewer(round, req.user?.id, viewerIsAdmin(req)),
      });
    } catch (error) {
      logger.error("获取轮次详情失败:", error);
      res.status(500).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 获取用户抽奖记录
  public async getUserRecord(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: "用户未登录",
        });
        return;
      }

      const record = await lotteryService.getUserRecord(userId);
      res.json({
        success: true,
        data: record,
      });
    } catch (error) {
      logger.error("获取用户记录失败:", error);
      res.status(500).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 获取抽奖机会余额（懒发放当天免费机会）
  public async getChances(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ success: false, error: "用户未登录" });
        return;
      }
      const chances = await lotteryService.getChances(userId);
      res.json({ success: true, data: chances });
    } catch (error) {
      logger.error("获取抽奖机会失败:", error);
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // 发放抽奖机会（仅超管）
  public async grantChances(req: Request, res: Response): Promise<void> {
    try {
      if (!isSuperAdmin(req)) {
        res.status(403).json({ success: false, error: "权限不足" });
        return;
      }
      const targetUserId = firstString(req.body?.userId);
      const amount = boundedInt(req.body?.amount, { min: 1, max: 100000, fallback: 0 });
      if (!targetUserId || amount < 1) {
        res.status(400).json({ success: false, error: "参数非法（需要 userId 与正整数 amount）" });
        return;
      }
      const balance = await lotteryService.grantChances(targetUserId, amount, {
        userId: req.user?.id || "",
        username: req.user?.username || "",
        role: req.user?.role || "",
        ip: req.ip,
      });
      res.json({ success: true, data: { userId: targetUserId, balance }, message: "抽奖机会已发放" });
    } catch (error) {
      logger.error("发放抽奖机会失败:", error);
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // 获取排行榜
  public async getLeaderboard(req: Request, res: Response): Promise<void> {
    try {
      const limit = boundedInt(req.query.limit, { min: 1, max: 100, fallback: 10 });
      const leaderboard = await lotteryService.getLeaderboard(limit);

      res.json({
        success: true,
        data: leaderboard,
      });
    } catch (error) {
      logger.error("获取排行榜失败:", error);
      res.status(500).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 获取统计信息
  public async getStatistics(_req: Request, res: Response): Promise<void> {
    try {
      const stats = await lotteryService.getStatistics();
      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error("获取统计信息失败:", error);
      res.status(500).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 重置轮次（管理员功能）
  public async resetRound(req: Request, res: Response): Promise<void> {
    try {
      const roundId = firstString(req.params.roundId);
      if (!roundId) {
        res.status(400).json({ success: false, message: "无效的轮次ID" });
        return;
      }

      // 检查管理员权限
      if (!isSuperAdmin(req)) {
        res.status(403).json({
          success: false,
          error: "权限不足",
        });
        return;
      }

      await lotteryService.resetRound(roundId);
      res.json({
        success: true,
        message: "轮次重置成功",
      });
    } catch (error) {
      logger.error("重置轮次失败:", error);
      res.status(500).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 更新轮次状态
  public async updateRoundStatus(req: Request, res: Response): Promise<void> {
    try {
      const roundId = firstString(req.params.roundId);
      const { isActive } = req.body;

      if (!roundId) {
        res.status(400).json({ success: false, message: "无效的轮次ID" });
        return;
      }

      if (typeof isActive !== "boolean") {
        res.status(400).json({ success: false, message: "isActive 必须为布尔值" });
        return;
      }

      // 检查管理员权限
      if (!isSuperAdmin(req)) {
        res.status(403).json({
          success: false,
          error: "权限不足",
        });
        return;
      }

      // G4-22: 调用真实的状态更新实现，不再返回假成功
      const round = await lotteryService.updateRoundStatus(roundId, isActive);
      res.json({
        success: true,
        data: round,
        message: "轮次状态更新成功",
      });
    } catch (error) {
      logger.error("更新轮次状态失败:", error);
      res.status(500).json({
        success: false,
        error: SERVER_ERROR_MESSAGE,
      });
    }
  }

  // 删除所有抽奖轮次
  public async deleteAllRounds(req: Request, res: Response): Promise<void> {
    try {
      // 仅管理员可操作
      if (!isSuperAdmin(req)) {
        res.status(403).json({ success: false, error: "权限不足" });
        return;
      }
      await lotteryService.deleteAllRounds();
      res.json({ success: true, message: "所有轮次已删除" });
    } catch (error) {
      logger.error("删除所有轮次失败:", error);
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }
}

export const lotteryController = new LotteryController();
