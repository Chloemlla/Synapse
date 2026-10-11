import crypto from "node:crypto";
import type { Request, Response } from "express";
import { isAdminRole, isSuperAdmin } from "../middleware/auth";
import { type LotteryPrize, type LotteryRound, lotteryService } from "../services/lotteryService";
import { lotteryFulfillmentService } from "../services/lotteryFulfillmentService";
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
  "积分不足",
  "已领取完毕",
  "需由业务系统",
  "履约记录",
  "受赠人",
  "该奖品",
] as const;

function isUserFacingLotteryError(message: string): boolean {
  return LOTTERY_USER_FACING_ERRORS.some((fragment) => message.includes(fragment));
}

const PRIZE_CATEGORIES = new Set(["common", "rare", "epic", "legendary"]);
const MAX_PRIZES_PER_ROUND = 50;
const MAX_PRIZE_QUANTITY = 1_000_000;

function readInRange(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

interface SoftGuaranteeConfig {
  startsAfterDraws: number;
  category: LotteryPrize["category"];
  step: number;
  baseChance?: number;
}

interface PseudoRandomConfig {
  increment: number;
  maxBonus: number;
}

/** 解析软保底配置；字段缺失视为不启用，给非法值报错（不静默降级）。 */
function parseSoftGuarantee(raw: unknown): { value?: SoftGuaranteeConfig; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") return { error: "软保底配置非法" };
  const record = raw as Record<string, unknown>;
  const startsAfterDraws = readInRange(record.startsAfterDraws, 0, 100000);
  const step = readInRange(record.step, 0, 1);
  const baseChance = record.baseChance === undefined ? 0 : readInRange(record.baseChance, 0, 1);
  const category = record.category;
  if (startsAfterDraws === null || step === null || baseChance === null) return { error: "软保底数值非法" };
  if (typeof category !== "string" || !PRIZE_CATEGORIES.has(category)) return { error: "软保底稀有度非法" };
  return { value: { startsAfterDraws, step, baseChance, category: category as LotteryPrize["category"] } };
}

/** 解析伪随机平滑补偿配置。 */
function parsePseudoRandom(raw: unknown): { value?: PseudoRandomConfig; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") return { error: "平滑补偿配置非法" };
  const record = raw as Record<string, unknown>;
  const increment = readInRange(record.increment, 0, 1);
  const maxBonus = readInRange(record.maxBonus, 0, 1);
  if (increment === null || maxBonus === null) return { error: "平滑补偿数值非法" };
  return { value: { increment, maxBonus } };
}

/**
 * 普通用户看到的轮次：不回参与者的内部用户 id（隐私），改回「本人是否已参与」与计数，
 * 中奖记录也去掉 userId。管理员拿完整数据（管理面板要按 id 排查异常）。
 */
function sanitizeRoundForViewer<T extends LotteryRound>(round: T, userId: string | undefined, isAdmin: boolean): T {
  if (isAdmin) return round;
  const { participants, winners, drawCounts, pityCounters, ...rest } = round;
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
    // 不回内部计数器（pacingAwards 会泄露贵重奖的出奖节奏）。
    prizes: round.prizes.map(({ pacingAwards: _pacingAwards, ...prize }) => prize),
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
        // Pacing（可选）：按时间窗配额发放
        let pacing: { periodMs: number; quotaPerWindow: number } | undefined;
        if (p.pacing && typeof p.pacing === "object") {
          const periodMs = boundedInt((p.pacing as Record<string, unknown>).periodMs, {
            min: 60_000,
            max: 30 * 24 * 60 * 60 * 1000,
            fallback: 0,
          });
          const quotaPerWindow = boundedInt((p.pacing as Record<string, unknown>).quotaPerWindow, {
            min: 1,
            max: MAX_PRIZE_QUANTITY,
            fallback: 0,
          });
          if (periodMs < 60_000 || quotaPerWindow < 1) {
            res.status(400).json({ success: false, error: "奖品 Pacing 配置非法（periodMs ≥ 60000 且 quotaPerWindow ≥ 1）" });
            return;
          }
          pacing = { periodMs, quotaPerWindow };
        }
        // 履约配置（可选）：virtual=虚拟直充 / code=卡密 / physical=实物
        let fulfillment: LotteryPrize["fulfillment"] | undefined;
        if (p.fulfillment && typeof p.fulfillment === "object") {
          const rawFulfillment = p.fulfillment as Record<string, unknown>;
          const type = rawFulfillment.type;
          if (type !== "virtual" && type !== "code" && type !== "physical") {
            res.status(400).json({ success: false, error: "奖品履约类型非法（virtual / code / physical）" });
            return;
          }
          const provider =
            typeof rawFulfillment.provider === "string" && rawFulfillment.provider.trim()
              ? rawFulfillment.provider.trim().slice(0, 64)
              : undefined;
          const redeemValue =
            rawFulfillment.redeemValue === undefined ? undefined : readInRange(rawFulfillment.redeemValue, 0, 1_000_000_000);
          if (redeemValue === null) {
            res.status(400).json({ success: false, error: "奖品折现价值非法" });
            return;
          }
          const params =
            rawFulfillment.params && typeof rawFulfillment.params === "object"
              ? (rawFulfillment.params as Record<string, unknown>)
              : undefined;
          fulfillment = {
            type,
            ...(provider ? { provider } : {}),
            ...(params ? { params } : {}),
            ...(redeemValue !== undefined ? { redeemValue } : {}),
          };
        }
        normalizedPrizes.push({
          id: prizeId,
          name: p.name,
          description: p.description,
          value,
          probability,
          quantity,
          remaining: quantity,
          category: typeof p.category === "string" && PRIZE_CATEGORIES.has(p.category) ? p.category : "common",
          ...(pacing ? { pacing } : {}),
          ...(fulfillment ? { fulfillment } : {}),
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
      // 软保底 / 伪随机平滑补偿（可选）
      const softParsed = parseSoftGuarantee(req.body?.softGuarantee);
      if (softParsed.error) {
        res.status(400).json({ success: false, error: `保底配置非法：${softParsed.error}` });
        return;
      }
      const pseudoParsed = parsePseudoRandom(req.body?.pseudoRandom);
      if (pseudoParsed.error) {
        res.status(400).json({ success: false, error: `补偿配置非法：${pseudoParsed.error}` });
        return;
      }
      // 预算熔断（可选）
      let budget: { maxTotalValue: number; warningRatio: number } | undefined;
      const rawBudget = req.body?.budget;
      if (rawBudget && typeof rawBudget === "object") {
        const maxTotalValue = boundedInt((rawBudget as Record<string, unknown>).maxTotalValue, {
          min: 1,
          max: 1_000_000_000,
          fallback: 0,
        });
        const warningRatio =
          (rawBudget as Record<string, unknown>).warningRatio === undefined
            ? 0.8
            : readInRange((rawBudget as Record<string, unknown>).warningRatio, 0, 1);
        if (maxTotalValue < 1 || warningRatio === null) {
          res.status(400).json({ success: false, error: "预算配置非法（maxTotalValue ≥ 1 且 warningRatio ∈ [0,1]）" });
          return;
        }
        budget = { maxTotalValue, warningRatio };
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
        ...(softParsed.value ? { softGuarantee: softParsed.value } : {}),
        ...(pseudoParsed.value ? { pseudoRandom: pseudoParsed.value } : {}),
        ...(budget ? { budget } : {}),
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
        {
          requestId: requestId || undefined,
          ip: req.ip,
          userAgent: req.headers["user-agent"] || "",
          fingerprint: typeof req.body?.fingerprint === "string" ? req.body.fingerprint.slice(0, 128) : undefined,
          riskScore: readInRange(req.body?.riskScore, 0, 100) ?? undefined,
          distinctUsersPerFingerprint:
            boundedInt(req.body?.distinctUsersPerFingerprint, { min: 0, max: 10_000, fallback: 0 }) || undefined,
        },
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

  // 发放抽奖积分（仅超管）
  public async grantAssets(req: Request, res: Response): Promise<void> {
    try {
      if (!isSuperAdmin(req)) {
        res.status(403).json({ success: false, error: "权限不足" });
        return;
      }
      const targetUserId = firstString(req.body?.userId);
      const amount = boundedInt(req.body?.amount, { min: 1, max: 10_000_000, fallback: 0 });
      if (!targetUserId || amount < 1) {
        res.status(400).json({ success: false, error: "参数非法（需要 userId 与正整数 amount）" });
        return;
      }
      const balance = await lotteryService.grantAssets(targetUserId, amount, {
        userId: req.user?.id || "",
        username: req.user?.username || "",
        role: req.user?.role || "",
        ip: req.ip,
      });
      res.json({ success: true, data: { userId: targetUserId, balance }, message: "抽奖积分已发放" });
    } catch (error) {
      logger.error("发放抽奖积分失败:", error);
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // 行为任务列表与今日领取状态
  public async getTasks(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ success: false, error: "用户未登录" });
        return;
      }
      const tasks = await lotteryService.getTaskStatus(userId);
      res.json({ success: true, data: tasks });
    } catch (error) {
      logger.error("获取抽奖任务失败:", error);
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // 领取任务机会
  public async claimTask(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const taskKey = firstString(req.params.taskKey);
      if (!userId) {
        res.status(401).json({ success: false, error: "用户未登录" });
        return;
      }
      if (!taskKey) {
        res.status(400).json({ success: false, error: "无效的任务标识" });
        return;
      }
      const result = await lotteryService.claimTaskChances(userId, taskKey);
      res.json({ success: true, data: result, message: `已领取 ${result.chances} 次抽奖机会` });
    } catch (error) {
      logger.error("领取抽奖任务失败:", error);
      if (error instanceof Error && isUserFacingLotteryError(error.message)) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // 积分兑换抽奖机会
  public async exchangeChances(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ success: false, error: "用户未登录" });
        return;
      }
      const times = boundedInt(req.body?.times, { min: 1, max: 1000, fallback: 0 });
      if (times < 1) {
        res.status(400).json({ success: false, error: "参数非法（times 需为正整数）" });
        return;
      }
      const result = await lotteryService.exchangeChances(userId, times);
      res.json({ success: true, data: result, message: "兑换成功" });
    } catch (error) {
      logger.error("兑换抽奖机会失败:", error);
      if (error instanceof Error && isUserFacingLotteryError(error.message)) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // T+0 库存对账（仅超管）
  public async getT0Reconciliation(req: Request, res: Response): Promise<void> {
    try {
      if (!isSuperAdmin(req)) {
        res.status(403).json({ success: false, error: "权限不足" });
        return;
      }
      const reports = await lotteryService.runT0Reconciliation();
      res.json({ success: true, data: reports });
    } catch (error) {
      logger.error("T+0 对账失败:", error);
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // T+1 价值对账（仅超管）
  public async getT1Reconciliation(req: Request, res: Response): Promise<void> {
    try {
      if (!isSuperAdmin(req)) {
        res.status(403).json({ success: false, error: "权限不足" });
        return;
      }
      const report = await lotteryService.runT1Reconciliation(firstString(req.query.date));
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error("T+1 对账失败:", error);
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // 我的奖品（履约记录）
  public async getMyFulfillments(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ success: false, error: "用户未登录" });
        return;
      }
      const records = await lotteryFulfillmentService.listForUser(userId);
      res.json({ success: true, data: records });
    } catch (error) {
      logger.error("获取我的奖品失败:", error);
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // 实物奖品：提交收件地址
  public async submitFulfillmentAddress(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const fulfillmentId = firstString(req.params.id);
      if (!userId) {
        res.status(401).json({ success: false, error: "用户未登录" });
        return;
      }
      if (!fulfillmentId) {
        res.status(400).json({ success: false, error: "无效的履约记录ID" });
        return;
      }
      const name = (firstString(req.body?.name) || "").trim();
      const phone = (firstString(req.body?.phone) || "").trim();
      const detail = (firstString(req.body?.detail) || "").trim();
      if (!wafCheck(name, 64) || !/^[0-9+\- ]{5,20}$/.test(phone) || !detail || detail.length > 200 || /[<>]/.test(detail)) {
        res.status(400).json({ success: false, error: "地址参数非法" });
        return;
      }
      const record = await lotteryFulfillmentService.submitAddress(fulfillmentId, userId, { name, phone, detail });
      res.json({ success: true, data: record, message: "收件地址已提交" });
    } catch (error) {
      logger.error("提交收件地址失败:", error);
      if (error instanceof Error && isUserFacingLotteryError(error.message)) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // 转赠未核销的奖品
  public async transferFulfillment(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const fulfillmentId = firstString(req.params.id);
      const targetUserId = (firstString(req.body?.targetUserId) || "").trim();
      if (!userId) {
        res.status(401).json({ success: false, error: "用户未登录" });
        return;
      }
      if (!fulfillmentId || !targetUserId || targetUserId.length > 128) {
        res.status(400).json({ success: false, error: "参数非法（需要履约记录 ID 与受赠人 ID）" });
        return;
      }
      const record = await lotteryFulfillmentService.transfer(fulfillmentId, userId, targetUserId);
      res.json({ success: true, data: record, message: "已转赠" });
    } catch (error) {
      logger.error("转赠奖品失败:", error);
      if (error instanceof Error && isUserFacingLotteryError(error.message)) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      res.status(500).json({ success: false, error: SERVER_ERROR_MESSAGE });
    }
  }

  // 折现/折积分为抽奖积分
  public async redeemFulfillment(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      const fulfillmentId = firstString(req.params.id);
      if (!userId) {
        res.status(401).json({ success: false, error: "用户未登录" });
        return;
      }
      if (!fulfillmentId) {
        res.status(400).json({ success: false, error: "无效的履约记录ID" });
        return;
      }
      const result = await lotteryFulfillmentService.redeem(fulfillmentId, userId);
      res.json({ success: true, data: result, message: `已折现为 ${result.value} 抽奖积分` });
    } catch (error) {
      logger.error("折现奖品失败:", error);
      if (error instanceof Error && isUserFacingLotteryError(error.message)) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
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
