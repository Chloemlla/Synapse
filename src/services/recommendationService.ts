/**
 * 推荐服务 - Recommendation Service
 * 提供个性化语音风格推荐、内容分析和建议功能
 *
 * Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import RecommendationHistoryModel from "../models/recommendationHistoryModel";
import RecommendationFeedbackModel, {
  RECOMMENDATION_FEEDBACK_KINDS,
  type RecommendationFeedbackKind,
} from "../models/recommendationFeedbackModel";
import UserPreferencesModel from "../models/userPreferencesModel";
import type {
  ChunkingStrategy,
  ContentSuggestion,
  GenerationRecord,
  Recommendation,
  RecommendationSettings,
  VoiceStyle,
} from "../types/recommendation";
import logger from "../utils/logger";
import { cacheService } from "./cacheService";

// 情感关键词映射表
const EMOTIONAL_KEYWORDS: Record<string, string[]> = {
  happy: ["开心", "快乐", "高兴", "欢乐", "喜悦", "happy", "joy", "cheerful", "delighted", "兴奋", "激动"],
  sad: ["悲伤", "难过", "伤心", "忧郁", "哀伤", "sad", "sorrow", "grief", "melancholy", "失落", "沮丧"],
  angry: ["愤怒", "生气", "恼火", "暴怒", "angry", "furious", "rage", "irritated", "气愤", "恼怒"],
  calm: ["平静", "安宁", "宁静", "祥和", "calm", "peaceful", "serene", "tranquil", "放松", "舒缓"],
  excited: ["兴奋", "激动", "热情", "澎湃", "excited", "thrilled", "enthusiastic", "振奋", "热烈"],
  serious: ["严肃", "正式", "庄重", "认真", "serious", "formal", "solemn", "grave", "郑重", "严谨"],
  romantic: ["浪漫", "温馨", "甜蜜", "柔情", "romantic", "tender", "sweet", "loving", "温柔", "深情"],
  mysterious: ["神秘", "悬疑", "诡异", "mysterious", "enigmatic", "suspenseful", "奇幻", "玄幻"],
};

// 默认热门语音风格（用于新用户或历史不足时的降级方案）
const DEFAULT_POPULAR_STYLES: VoiceStyle[] = [
  {
    id: "popular-1",
    name: "标准女声",
    voice: "zh-CN-XiaoxiaoNeural",
    model: "neural",
    speed: 1.0,
    emotionalTone: "neutral",
    language: "zh-CN",
  },
  {
    id: "popular-2",
    name: "标准男声",
    voice: "zh-CN-YunxiNeural",
    model: "neural",
    speed: 1.0,
    emotionalTone: "neutral",
    language: "zh-CN",
  },
  {
    id: "popular-3",
    name: "温柔女声",
    voice: "zh-CN-XiaoyiNeural",
    model: "neural",
    speed: 0.9,
    emotionalTone: "calm",
    language: "zh-CN",
  },
  {
    id: "popular-4",
    name: "活力女声",
    voice: "zh-CN-XiaochenNeural",
    model: "neural",
    speed: 1.1,
    emotionalTone: "happy",
    language: "zh-CN",
  },
  {
    id: "popular-5",
    name: "英文女声",
    voice: "en-US-JennyNeural",
    model: "neural",
    speed: 1.0,
    emotionalTone: "neutral",
    language: "en-US",
  },
];

// 历史记录阈值：少于此数量时使用热门推荐
const HISTORY_THRESHOLD = 10;

// 默认推荐数量限制
const DEFAULT_RECOMMENDATION_LIMIT = 5;

// RC-1：单个用户保留的生成记录上限。整段历史存在一条文档里，无界 $push 会撞 MongoDB
// 16MB 文档上限，也让每次读写放大。保留最近 N 条足够刻画偏好。
const MAX_GENERATIONS = 300;

// RC-3：热门风格是热点聚合，缓存 5 分钟；写路径只做前缀失效，不做同步重算。
const POPULAR_STYLES_CACHE_TTL_MS = 5 * 60 * 1000;
const USER_RECOMMENDATION_CACHE_TTL_MS = 60 * 1000;

// RC-6：风格 ID 白名单字符集，避免把任意字符串当风格 id 落库。
const STYLE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

// 长文本阈值（字符数）
const LONG_TEXT_THRESHOLD = 500;

// ContentSuggestion JSON Schema 用于验证
const _CONTENT_SUGGESTION_SCHEMA = {
  type: "object",
  required: ["voiceParameters", "emotionalMatch", "confidence"],
  properties: {
    voiceParameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        voice: { type: "string" },
        model: { type: "string" },
        speed: { type: "number" },
        emotionalTone: { type: "string" },
        language: { type: "string" },
      },
    },
    chunkingStrategy: {
      type: "object",
      properties: {
        chunkSize: { type: "number" },
        overlapSize: { type: "number" },
        breakPoints: { type: "array", items: { type: "string" } },
      },
    },
    emotionalMatch: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

/**
 * 推荐服务类
 */
export class RecommendationService {
  /**
   * 获取个性化推荐
   * Requirements: 1.1, 1.2
   *
   * @param userId 用户ID
   * @param limit 推荐数量限制（默认5）
   * @returns 推荐列表
   */
  async getPersonalizedRecommendations(
    userId: string,
    limit: number = DEFAULT_RECOMMENDATION_LIMIT,
  ): Promise<Recommendation[]> {
    const safeLimit = Number.isFinite(Number(limit))
      ? Math.min(Math.max(1, Math.floor(Number(limit))), 20)
      : DEFAULT_RECOMMENDATION_LIMIT;
    // RC-5 附带收益：推荐是只读热路径，缓存 60 秒可显著降低重复聚合；任何写路径前缀失效。
    const cacheKey = cacheService.buildKey("recommendation", "user", userId, safeLimit);
    return cacheService.getOrSet(cacheKey, USER_RECOMMENDATION_CACHE_TTL_MS, () =>
      this.computePersonalizedRecommendations(userId, safeLimit),
    );
  }

  private async computePersonalizedRecommendations(userId: string, limit: number): Promise<Recommendation[]> {
    try {
      const [history, preferences, feedbackDocs] = await Promise.all([
        RecommendationHistoryModel.findOne({ userId }).lean(),
        UserPreferencesModel.findOne({ userId }).lean(),
        RecommendationFeedbackModel.find({ userId }).select({ styleId: 1, feedback: 1 }).lean(),
      ]);

      // RC-2：显式负反馈（不喜欢/不感兴趣）直接排除；「喜欢」当作强先验加权。
      const excludedStyleIds = new Set<string>();
      const likedStyleIds = new Set<string>();
      for (const item of feedbackDocs) {
        if (item.feedback === "like") likedStyleIds.add(item.styleId);
        else excludedStyleIds.add(item.styleId);
      }
      const settings = preferences?.recommendationSettings;

      // 历史记录不足时返回热门推荐（Requirements 1.2）
      if (!history || (history.generations || []).length < HISTORY_THRESHOLD) {
        logger.info(`[RecommendationService] 用户 ${userId} 历史记录不足，返回热门推荐`);
        const popularStyles = await this.getPopularStyles(limit + excludedStyleIds.size);
        return this.buildPopularRecommendations(popularStyles, excludedStyleIds, likedStyleIds, settings, limit);
      }

      return this.analyzeHistoryForRecommendations(
        history.generations,
        settings,
        excludedStyleIds,
        likedStyleIds,
        limit,
      );
    } catch (error) {
      logger.error("[RecommendationService] 获取个性化推荐失败:", error);
      // 降级方案：返回热门推荐
      const popularStyles = await this.getPopularStyles(limit);
      return this.buildPopularRecommendations(popularStyles, new Set(), new Set(), null, limit);
    }
  }

  /**
   * 获取热门语音风格（降级方案）
   * Requirements: 1.2
   *
   * @param limit 数量限制
   * @returns 热门语音风格列表
   */
  async getPopularStyles(limit: number = DEFAULT_RECOMMENDATION_LIMIT): Promise<VoiceStyle[]> {
    const safeLimit = Number.isFinite(Number(limit))
      ? Math.min(Math.max(1, Math.floor(Number(limit))), 50)
      : DEFAULT_RECOMMENDATION_LIMIT;
    const cacheKey = cacheService.buildKey("recommendation", "popular", safeLimit);
    return cacheService.getOrSet(cacheKey, POPULAR_STYLES_CACHE_TTL_MS, async () => {
      try {
        // 从数据库聚合最常用的语音风格
        const aggregation = await RecommendationHistoryModel.aggregate([
          { $unwind: "$generations" },
          {
            $group: {
              _id: "$generations.voiceStyle.id",
              voiceStyle: { $first: "$generations.voiceStyle" },
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
          { $limit: safeLimit },
        ]);

        if (aggregation.length > 0) {
          return aggregation.map((item) => item.voiceStyle as VoiceStyle);
        }
      } catch (error) {
        logger.error("[RecommendationService] 获取热门风格失败:", error);
      }
      // 没有数据或聚合失败：返回默认热门风格（不进缓存失败分支，getOrSet 会缓存该结果）
      return DEFAULT_POPULAR_STYLES.slice(0, safeLimit);
    });
  }

  /**
   * 记录用户选择
   * Requirements: 1.3
   *
   * @param userId 用户ID
   * @param styleId 选择的语音风格ID
   * @param textContent 文本内容
   * @param voiceStyle 完整的语音风格配置
   */
  async recordSelection(
    userId: string,
    styleId: string,
    textContent: string = "",
    voiceStyle?: VoiceStyle,
  ): Promise<void> {
    // RC-6：拒绝任意字符串当风格 id 落库。
    const safeStyleId = this.normalizeStyleId(styleId);
    if (!safeStyleId) {
      throw new Error("无效的语音风格 ID");
    }
    try {
      const now = new Date();
      const record: GenerationRecord = {
        id: `gen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: now,
        textContent: textContent.substring(0, 1000), // 限制存储长度
        textLength: textContent.length,
        contentType: this.detectContentType(textContent),
        language: this.detectLanguage(textContent),
        voiceStyle: voiceStyle || this.findStyleById(safeStyleId),
        duration: 0, // 实际生成后更新
      };

      // 更新或创建用户历史记录。$slice 从尾部保留最近 MAX_GENERATIONS 条（RC-1）。
      await RecommendationHistoryModel.findOneAndUpdate(
        { userId },
        {
          $push: { generations: { $each: [record], $slice: -MAX_GENERATIONS } },
          $inc: { totalCount: 1 },
          $set: { lastUpdated: now },
        },
        { upsert: true, returnDocument: "after" },
      );

      await this.invalidateUserCache(userId);
      logger.info(`[RecommendationService] 记录用户 ${userId} 的选择: ${safeStyleId}`);
    } catch (error) {
      logger.error("[RecommendationService] 记录选择失败:", error);
      throw error;
    }
  }

  /** RC-2：记录显式反馈（喜欢/不喜欢/不感兴趣），同一风格重复提交覆盖为最新态度。 */
  async recordFeedback(
    userId: string,
    styleId: string,
    feedback: string,
    comment?: string,
  ): Promise<{ styleId: string; feedback: RecommendationFeedbackKind }> {
    const safeStyleId = this.normalizeStyleId(styleId);
    if (!safeStyleId) throw new Error("无效的语音风格 ID");
    if (!RECOMMENDATION_FEEDBACK_KINDS.includes(feedback as RecommendationFeedbackKind)) {
      throw new Error("无效的反馈类型");
    }
    const kind = feedback as RecommendationFeedbackKind;
    await RecommendationFeedbackModel.findOneAndUpdate(
      { userId, styleId: safeStyleId },
      {
        $set: { feedback: kind, comment: typeof comment === "string" ? comment.slice(0, 500) : "" },
      },
      { upsert: true, returnDocument: "after" },
    ).exec();
    await this.invalidateUserCache(userId);
    return { styleId: safeStyleId, feedback: kind };
  }

  /** RC-2：读取用户自己的反馈，供「我的偏好」页面回显。 */
  async listFeedback(userId: string): Promise<
    Array<{ styleId: string; feedback: RecommendationFeedbackKind; comment: string; updatedAt: string | null }>
  > {
    const docs = await RecommendationFeedbackModel.find({ userId }).sort({ updatedAt: -1 }).limit(500).lean();
    return docs.map((doc: any) => ({
      styleId: doc.styleId,
      feedback: doc.feedback as RecommendationFeedbackKind,
      comment: doc.comment || "",
      updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    }));
  }

  /** RC-7：管理端只读分析（含个人标识的原始历史不外泄，只回聚合）。 */
  async getAdminAnalytics(): Promise<{
    totalUsers: number;
    totalGenerations: number;
    feedback: { like: number; dislike: number; notInterested: number; total: number };
    topStyles: Array<{ styleId: string; total: number }>;
    topLanguages: Array<{ language: string; total: number }>;
  }> {
    // as any：mongoose 的 aggregate pipeline 类型极窄，$group/$facet 组合会误报；
    // 聚合结果的形状由下方取值处兜底，不在类型层做体操。
    const [historyStats, feedbackByKind, topStyles, topLanguages] = await Promise.all([
      RecommendationHistoryModel.aggregate([
        {
          $group: {
            _id: null,
            totalUsers: { $sum: 1 },
            totalGenerations: { $sum: { $ifNull: ["$totalCount", 0] } },
          },
        },
      ] as any),
      RecommendationFeedbackModel.aggregate([{ $group: { _id: "$feedback", total: { $sum: 1 } } }] as any),
      RecommendationHistoryModel.aggregate([
        { $unwind: "$generations" },
        { $group: { _id: "$generations.voiceStyle.id", total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
      ] as any),
      RecommendationHistoryModel.aggregate([
        { $unwind: "$generations" },
        { $group: { _id: "$generations.language", total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 10 },
      ] as any),
    ]);

    const kindCount = (kind: string) =>
      feedbackByKind.find((row: any) => row._id === kind)?.total ?? 0;
    return {
      totalUsers: historyStats[0]?.totalUsers ?? 0,
      totalGenerations: historyStats[0]?.totalGenerations ?? 0,
      feedback: {
        like: kindCount("like"),
        dislike: kindCount("dislike"),
        notInterested: kindCount("not_interested"),
        total: feedbackByKind.reduce((sum: number, row: any) => sum + (row.total ?? 0), 0),
      },
      topStyles: topStyles.map((row: any) => ({ styleId: row._id ?? "unknown", total: row.total })),
      topLanguages: topLanguages.map((row: any) => ({ language: row._id ?? "unknown", total: row.total })),
    };
  }

  /**
   * 分析文本内容并提供建议
   * Requirements: 2.1, 2.2, 2.3, 2.4
   *
   * @param text 文本内容
   * @returns 内容建议
   */
  async analyzeContent(text: string): Promise<ContentSuggestion> {
    const startTime = Date.now();

    try {
      // 检测情感关键词（Requirements 2.2）
      const emotionalMatch = this.detectEmotionalTone(text);

      // 检测语言
      const language = this.detectLanguage(text);

      // 根据情感匹配推荐语音参数
      const voiceParameters = this.getVoiceParametersForEmotion(emotionalMatch, language);

      // 检查是否需要分块策略（Requirements 2.3）
      let chunkingStrategy: ChunkingStrategy | undefined;
      if (text.length > LONG_TEXT_THRESHOLD) {
        chunkingStrategy = this.generateChunkingStrategy(text);
      }

      // 计算置信度
      const confidence = this.calculateConfidence(text, emotionalMatch);

      const suggestion: ContentSuggestion = {
        voiceParameters,
        chunkingStrategy,
        emotionalMatch,
        confidence,
      };

      const elapsed = Date.now() - startTime;
      logger.info(`[RecommendationService] 内容分析完成，耗时 ${elapsed}ms`);

      // 确保在2秒内完成（Requirements 2.1）
      if (elapsed > 2000) {
        logger.warn(`[RecommendationService] 内容分析超时: ${elapsed}ms`);
      }

      return suggestion;
    } catch (error) {
      logger.error("[RecommendationService] 内容分析失败:", error);
      // 返回默认建议
      return {
        voiceParameters: {
          speed: 1.0,
          emotionalTone: "neutral",
        },
        emotionalMatch: "neutral",
        confidence: 0.3,
      };
    }
  }

  /**
   * 序列化内容建议为JSON
   * Requirements: 2.5
   *
   * @param suggestion 内容建议对象
   * @returns JSON字符串
   */
  serializeContentSuggestion(suggestion: ContentSuggestion): string {
    return JSON.stringify(suggestion);
  }

  /**
   * 解析JSON为内容建议对象
   * Requirements: 2.6
   *
   * @param json JSON字符串
   * @returns 内容建议对象
   * @throws 如果JSON格式无效
   */
  parseContentSuggestion(json: string): ContentSuggestion {
    try {
      const parsed = JSON.parse(json);

      // 验证必需字段
      if (!this.validateContentSuggestion(parsed)) {
        throw new Error("Invalid ContentSuggestion format");
      }

      return parsed as ContentSuggestion;
    } catch (error) {
      logger.error("[RecommendationService] 解析ContentSuggestion失败:", error);
      throw new Error(`Failed to parse ContentSuggestion: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 分析历史记录生成推荐
   */
  private analyzeHistoryForRecommendations(
    generations: GenerationRecord[],
    settings: RecommendationSettings | null | undefined,
    excludedStyleIds: Set<string>,
    likedStyleIds: Set<string>,
    limit: number,
  ): Recommendation[] {
    // 统计语音风格使用频率
    const styleFrequency = new Map<string, { style: VoiceStyle; count: number }>();

    for (const gen of generations) {
      const style = gen?.voiceStyle;
      if (!style?.id) continue;
      const existing = styleFrequency.get(style.id);
      if (existing) {
        existing.count++;
      } else {
        styleFrequency.set(style.id, { style, count: 1 });
      }
    }

    // 排序：显式「喜欢」优先，其次按使用频次；同时排除负反馈与不符合偏好的风格。
    const rankedStyles = Array.from(styleFrequency.values())
      .filter((item) => !excludedStyleIds.has(item.style.id) && this.isStyleAllowed(item.style, settings))
      .sort((a, b) => {
        const likeDelta = Number(likedStyleIds.has(b.style.id)) - Number(likedStyleIds.has(a.style.id));
        if (likeDelta !== 0) return likeDelta;
        return b.count - a.count;
      });

    const recommendations: Recommendation[] = rankedStyles.slice(0, limit).map((item, index) => ({
      voiceStyle: item.style,
      similarityScore: Math.max(0.5, 1 - index * 0.1),
      reason: likedStyleIds.has(item.style.id) ? "您标记过喜欢" : `基于您的使用历史（使用${item.count}次）`,
      sampleAudioUrl: `/samples/${item.style.id}.mp3`,
    }));

    // 如果推荐不足，补充热门风格
    if (recommendations.length < limit) {
      const existingIds = new Set(recommendations.map((r) => r.voiceStyle.id));
      const excluded = new Set<string>([...excludedStyleIds, ...existingIds]);
      recommendations.push(
        ...this.buildPopularRecommendations(
          DEFAULT_POPULAR_STYLES,
          excluded,
          likedStyleIds,
          settings,
          limit - recommendations.length,
        ),
      );
    }

    return recommendations;
  }

  /** 热门候选池 → 推荐列表：去重、排除负反馈、套用偏好白名单。 */
  private buildPopularRecommendations(
    styles: VoiceStyle[],
    excludedStyleIds: Set<string>,
    likedStyleIds: Set<string>,
    settings: RecommendationSettings | null | undefined,
    limit: number,
  ): Recommendation[] {
    const result: Recommendation[] = [];
    const seen = new Set<string>();
    const candidates = [...styles, ...DEFAULT_POPULAR_STYLES];
    for (const style of candidates) {
      if (result.length >= limit) break;
      if (!style?.id || excludedStyleIds.has(style.id) || seen.has(style.id)) continue;
      if (!this.isStyleAllowed(style, settings)) continue;
      seen.add(style.id);
      const liked = likedStyleIds.has(style.id);
      result.push({
        voiceStyle: style,
        similarityScore: liked ? 0.9 : 0.5,
        reason: liked ? "您标记过喜欢" : "社区热门推荐",
        sampleAudioUrl: `/samples/${style.id}.mp3`,
      });
    }
    return result;
  }

  /** RC-5：让 recommendationSettings 的四项真正生效（白名单优先于黑名单）。 */
  private isStyleAllowed(style: VoiceStyle, settings: RecommendationSettings | null | undefined): boolean {
    if (!settings) return true;
    const disabled = settings.disabledCategories || [];
    const enabled = settings.enabledCategories || [];
    const languages = settings.preferredLanguages || [];
    const voices = settings.preferredVoices || [];
    if (disabled.includes(style.emotionalTone)) return false;
    if (enabled.length > 0 && !enabled.includes(style.emotionalTone)) return false;
    if (languages.length > 0 && !languages.includes(style.language)) return false;
    if (voices.length > 0 && !voices.includes(style.voice)) return false;
    return true;
  }

  private normalizeStyleId(styleId: unknown): string | null {
    if (typeof styleId !== "string") return null;
    const trimmed = styleId.trim();
    if (!STYLE_ID_PATTERN.test(trimmed)) return null;
    return trimmed;
  }

  private async invalidateUserCache(userId: string): Promise<void> {
    await cacheService.delByPrefix(cacheService.buildKey("recommendation", "user", userId));
  }

  /**
   * 检测文本的情感基调
   */
  private detectEmotionalTone(text: string): string {
    const lowerText = text.toLowerCase();
    let maxScore = 0;
    let detectedEmotion = "neutral";

    for (const [emotion, keywords] of Object.entries(EMOTIONAL_KEYWORDS)) {
      let score = 0;
      for (const keyword of keywords) {
        if (lowerText.includes(keyword.toLowerCase())) {
          score++;
        }
      }
      if (score > maxScore) {
        maxScore = score;
        detectedEmotion = emotion;
      }
    }

    return detectedEmotion;
  }

  /**
   * 检测文本语言
   */
  private detectLanguage(text: string): string {
    // RC-4：空文本时 text.length 为 0，比值会变成 NaN 并静默落到 en-US。
    if (!text || text.length === 0) return "zh-CN";
    // 简单的语言检测：检查中文字符比例
    const chineseChars = text.match(/[\u4e00-\u9fa5]/g) || [];
    const chineseRatio = chineseChars.length / text.length;

    if (chineseRatio > 0.3) {
      return "zh-CN";
    }
    return "en-US";
  }

  /**
   * 检测内容类型
   */
  private detectContentType(text: string): string {
    if (text.length < 50) return "short";
    if (text.length < 200) return "medium";
    if (text.length < 500) return "long";
    return "article";
  }

  /**
   * 根据情感获取推荐的语音参数
   */
  private getVoiceParametersForEmotion(emotion: string, language: string): Partial<VoiceStyle> {
    const emotionToParams: Record<string, Partial<VoiceStyle>> = {
      happy: { speed: 1.1, emotionalTone: "happy" },
      sad: { speed: 0.85, emotionalTone: "sad" },
      angry: { speed: 1.15, emotionalTone: "angry" },
      calm: { speed: 0.9, emotionalTone: "calm" },
      excited: { speed: 1.2, emotionalTone: "excited" },
      serious: { speed: 0.95, emotionalTone: "serious" },
      romantic: { speed: 0.85, emotionalTone: "romantic" },
      mysterious: { speed: 0.9, emotionalTone: "mysterious" },
      neutral: { speed: 1.0, emotionalTone: "neutral" },
    };

    const params = emotionToParams[emotion] || emotionToParams.neutral;
    return {
      ...params,
      language,
    };
  }

  /**
   * 生成分块策略
   */
  private generateChunkingStrategy(text: string): ChunkingStrategy {
    const textLength = text.length;

    // 根据文本长度确定分块大小
    let chunkSize: number;
    if (textLength < 1000) {
      chunkSize = 300;
    } else if (textLength < 3000) {
      chunkSize = 500;
    } else {
      chunkSize = 800;
    }

    // 重叠大小为分块大小的10%
    const overlapSize = Math.floor(chunkSize * 0.1);

    // 识别自然断点
    const breakPoints = this.findNaturalBreakPoints(text);

    return {
      chunkSize,
      overlapSize,
      breakPoints,
    };
  }

  /**
   * 查找文本的自然断点
   */
  private findNaturalBreakPoints(text: string): string[] {
    const breakPoints: string[] = [];

    // 段落分隔符
    if (text.includes("\n\n")) {
      breakPoints.push("paragraph");
    }

    // 句号分隔
    if (text.includes("。") || text.includes(".")) {
      breakPoints.push("sentence");
    }

    // 逗号分隔
    if (text.includes("，") || text.includes(",")) {
      breakPoints.push("clause");
    }

    return breakPoints.length > 0 ? breakPoints : ["sentence"];
  }

  /**
   * 计算建议的置信度
   */
  private calculateConfidence(text: string, emotion: string): number {
    let confidence = 0.5;

    // 文本长度影响置信度
    if (text.length > 100) confidence += 0.1;
    if (text.length > 300) confidence += 0.1;

    // 情感检测结果影响置信度
    if (emotion !== "neutral") confidence += 0.2;

    return Math.min(confidence, 1.0);
  }

  /**
   * 根据ID查找语音风格
   */
  private findStyleById(styleId: string): VoiceStyle {
    const found = DEFAULT_POPULAR_STYLES.find((s) => s.id === styleId);
    if (found) return found;

    // 返回默认风格
    return {
      id: styleId,
      name: "自定义风格",
      voice: "zh-CN-XiaoxiaoNeural",
      model: "neural",
      speed: 1.0,
      emotionalTone: "neutral",
      language: "zh-CN",
    };
  }

  /**
   * 验证ContentSuggestion对象格式
   */
  private validateContentSuggestion(obj: any): boolean {
    if (!obj || typeof obj !== "object") return false;
    if (typeof obj.emotionalMatch !== "string") return false;
    if (typeof obj.confidence !== "number") return false;
    if (obj.confidence < 0 || obj.confidence > 1) return false;
    if (!obj.voiceParameters || typeof obj.voiceParameters !== "object") return false;

    // 验证可选的chunkingStrategy
    if (obj.chunkingStrategy !== undefined) {
      if (typeof obj.chunkingStrategy !== "object") return false;
      if (typeof obj.chunkingStrategy.chunkSize !== "number") return false;
      if (typeof obj.chunkingStrategy.overlapSize !== "number") return false;
      if (!Array.isArray(obj.chunkingStrategy.breakPoints)) return false;
    }

    return true;
  }
}

// 导出单例实例
export const recommendationService = new RecommendationService();
