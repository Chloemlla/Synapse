import { useState, useEffect, useCallback } from 'react';
import {
  LotteryRound,
  LotteryWinner,
  UserLotteryRecord,
  LotteryStatistics
} from '../types/lottery';
import * as lotteryApi from '../api/lottery';
import { useAuth } from './useAuth';


export function useLottery() {
  const { user } = useAuth();
  const [activeRounds, setActiveRounds] = useState<LotteryRound[]>([]);
  const [allRounds, setAllRounds] = useState<LotteryRound[]>([]);
  const [userRecord, setUserRecord] = useState<UserLotteryRecord | null>(null);
  const [leaderboard, setLeaderboard] = useState<UserLotteryRecord[]>([]);
  const [statistics, setStatistics] = useState<LotteryStatistics | null>(null);
  const [loading, setLoading] = useState(false);
  // F5-37：参与抽奖不应把整份轮次列表换成整页 spinner，单独用一个状态表示「正在参与」
  const [participating, setParticipating] = useState(false);
  const [participatingRoundId, setParticipatingRoundId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 获取活跃轮次
  const fetchActiveRounds = useCallback(async () => {
    try {
      setError(null);
      const rounds = await lotteryApi.getActiveRounds();
      setActiveRounds(rounds);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取活跃轮次失败');
    }
  }, []);

  // 获取所有轮次
  const fetchAllRounds = useCallback(async () => {
    try {
      setError(null);
      // 走统一 API 层（会带 credentials:'include'）：旧实现自己 fetch，跨域开发环境不带 cookie，
      // 而且与 api/lottery.ts 的错误/超时处理两套逻辑。
      const rounds = await lotteryApi.getLotteryRounds();
      setAllRounds(rounds);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取所有轮次失败');
    }
  }, []);

  // 获取用户记录
  const fetchUserRecord = useCallback(async () => {
    if (!user) {
      setUserRecord(null);
      return;
    }

    try {
      setError(null);
      const record = await lotteryApi.getUserRecord();
      setUserRecord(record);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取用户记录失败');
    }
  }, [user]);

  // 获取排行榜
  const fetchLeaderboard = useCallback(async (limit: number = 10) => {
    try {
      setError(null);
      const data = await lotteryApi.getLeaderboard(limit);
      setLeaderboard(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取排行榜失败');
    }
  }, []);

  // 获取统计信息
  const fetchStatistics = useCallback(async () => {
    try {
      setError(null);
      const stats = await lotteryApi.getStatistics();
      setStatistics(stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取统计信息失败');
    }
  }, []);

  // 参与抽奖。返回 null = 未中奖（概率和 < 1 的剩余区间），不是失败。
  const participateInLottery = useCallback(async (roundId: string, cfToken?: string, captchaProvider?: string): Promise<LotteryWinner | null> => {
    if (!user) {
      throw new Error('请先登录');
    }

    setParticipating(true);
    setParticipatingRoundId(roundId);

    try {
      // 幂等键：同一次用户动作的重复投递（代理重发 / 手动重试）由后端吸收，不会重复抽奖。
      const requestId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `draw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const winner = await lotteryApi.participateInLottery(roundId, cfToken, captchaProvider, requestId);

      // 更新相关数据
      await Promise.all([
        fetchActiveRounds(),
        fetchUserRecord(),
        fetchLeaderboard(),
        fetchStatistics()
      ]);

      return winner;
    } finally {
      setParticipating(false);
      setParticipatingRoundId(null);
    }
  }, [user, fetchActiveRounds, fetchUserRecord, fetchLeaderboard, fetchStatistics]);

  // 获取轮次详情
  const getRoundDetails = useCallback(async (roundId: string): Promise<LotteryRound> => {
    try {
      setError(null);
      return await lotteryApi.getRoundDetails(roundId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取轮次详情失败');
      throw err;
    }
  }, []);

  // 初始化数据
  useEffect(() => {
    const initializeData = async () => {
      setLoading(true);
      try {
        await Promise.all([
          fetchActiveRounds(),
          fetchAllRounds(),
          fetchLeaderboard(),
          fetchStatistics()
        ]);
      } catch (err) {
        console.error('初始化抽奖数据失败:', err);
      } finally {
        setLoading(false);
      }
    };

    initializeData();
  }, [fetchActiveRounds, fetchAllRounds, fetchLeaderboard, fetchStatistics]);

  // 当用户登录状态改变时，获取用户记录
  useEffect(() => {
    fetchUserRecord();
  }, [fetchUserRecord]);

  return {
    // 数据
    activeRounds,
    allRounds,
    userRecord,
    leaderboard,
    statistics,
    loading,
    participating,
    participatingRoundId,
    error,
    
    // 方法
    fetchActiveRounds,
    fetchAllRounds,
    fetchUserRecord,
    fetchLeaderboard,
    fetchStatistics,
    participateInLottery,
    getRoundDetails,
    
    // 工具方法
    clearError: () => setError(null),
  };
}
