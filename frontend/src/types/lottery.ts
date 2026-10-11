// 区块链数据类型
export interface BlockchainData {
  height: number;
  hash: string;
  timestamp: number;
  /** 已废弃：后端不再返回编造的难度字段；保留可选仅为兼容旧响应。 */
  difficulty?: number;
}

// 奖品稀有度
export type LotteryPrizeCategory = 'common' | 'rare' | 'epic' | 'legendary';

// 奖品类型
export interface LotteryPrize {
  id: string;
  name: string;
  description: string;
  value: number;
  probability: number;
  quantity: number;
  remaining: number;
  image?: string;
  category: LotteryPrizeCategory;
}

/** 硬保底：本轮个人每抽到 everyDraws 的整数倍时，至少出 category 及以上稀有度。 */
export interface LotteryGuarantee {
  everyDraws: number;
  category: LotteryPrizeCategory;
}

// 抽奖轮次类型
export interface LotteryRound {
  id: string;
  name: string;
  description: string;
  startTime: number;
  endTime: number;
  isActive: boolean;
  prizes: LotteryPrize[];
  /**
   * 参与者。普通用户拿到的视图里是空数组（不回内部用户 id），
   * 请改用 hasParticipated / participantCount。管理员拿完整数据。
   */
  participants: string[];
  winners: LotteryWinner[];
  blockchainHeight: number;
  seed: string;
  /** 服务端按请求者算好的「本人是否已参与」（普通用户视图专用）。 */
  hasParticipated?: boolean;
  /** 参与人数（普通用户视图用，避免依赖 participants 数组）。 */
  participantCount?: number;
  /** 中奖人数（普通用户视图用）。 */
  winnerCount?: number;
  /** 每人本轮最大抽奖次数（默认 1）。 */
  maxDrawsPerUser?: number;
  /** 每次抽奖消耗的抽奖机会数（0 = 不消耗）。 */
  chanceCost?: number;
  /** 硬保底配置。 */
  guarantee?: LotteryGuarantee;
  /** 本人在本轮已抽次数（普通用户视图用）。 */
  drawsUsed?: number;
  /** 本人本轮剩余可抽次数（普通用户视图用）。 */
  remainingDraws?: number;
}

// 中奖者类型
export interface LotteryWinner {
  userId: string;
  username: string;
  prizeId: string;
  prizeName: string;
  drawTime: number;
  transactionHash?: string;
}

// 用户抽奖记录类型
export interface UserLotteryRecord {
  userId: string;
  username: string;
  participationCount: number;
  winCount: number;
  lastDrawTime: number;
  totalValue: number;
  /** 抽奖机会余额（自然日重置）。 */
  chanceBalance?: number;
  history: {
    roundId: string;
    prizeId: string;
    prizeName: string;
    drawTime: number;
    value: number;
  }[];
}

// 抽奖机会余额
export interface LotteryChances {
  balance: number;
  dailyFree: number;
}

// 统计信息类型
export interface LotteryStatistics {
  totalRounds: number;
  activeRounds: number;
  totalParticipants: number;
  totalWinners: number;
  totalValue: number;
}

// API响应类型
export interface LotteryApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  /** 后端对入参的自动修正说明（如概率归一化、时间顺序调整）。 */
  warning?: string;
} 