import React, { useCallback, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLottery } from '../hooks/useLottery';
import { useAuth } from '../hooks/useAuth';
import { LotteryRound, LotteryWinner } from '../types/lottery';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useNotification } from './Notification';
import { isAdminRole } from '../utils/rbac';
import ManagedCaptcha, {
  type ManagedCaptchaChallenge,
  type ManagedCaptchaRef,
  type ManagedCaptchaStatus,
} from './ManagedCaptcha';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoPrimaryButton,
  InfoQueryHero,
  InfoQueryShell,
  InfoSectionTitle,
  studioPrimaryButtonClassName,
  studioSurfaceClassName,
  studioTileClassName,
} from './studioTheme';
import {
  FaChartBar,
  FaTrophy,
  FaUsers,
  FaCrosshairs,
  FaDice,
  FaGift,
  FaCrown,
  FaMedal,
} from 'react-icons/fa';

const lotteryPanelClass = studioSurfaceClassName;
const lotteryTileClass = studioTileClassName;

// 奖品展示组件
const PrizeDisplay: React.FC<{ prize: any }> = ({ prize }) => {
  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'legendary': return 'border-amber-200 bg-amber-50/80 text-amber-800';
      case 'epic': return 'border-violet-200 bg-violet-50/80 text-violet-800';
      case 'rare': return 'border-sky-200 bg-sky-50/80 text-sky-800';
      default: return 'border-slate-200 bg-slate-50/80 text-slate-800';
    }
  };

  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className={`rounded-2xl border p-3 shadow-sm ${getCategoryColor(prize.category)}`}
    >
      <div className="text-center">
        <h4 className="font-semibold text-sm">{prize.name}</h4>
        <p className="text-xs opacity-80 mt-1">{prize.description}</p>
        <div className="mt-2">
          <span className="text-lg font-bold">¥{prize.value}</span>
        </div>
        <div className="mt-1 text-xs opacity-70">
          概率: {(prize.probability * 100).toFixed(2)}% | 剩余: {prize.remaining}/{prize.quantity}
        </div>
      </div>
    </motion.div>
  );
};

// 抽奖轮次卡片组件
export const LotteryRoundCard: React.FC<{
  round: LotteryRound;
  /** 返回 false 表示并发请求被拦下，当前令牌尚未发送。 */
  onParticipate: (roundId: string, challenge?: ManagedCaptchaChallenge | null) => Promise<boolean>;
  /** 是否正在参与抽奖（仅用于禁用按钮与按钮内进度，不再替换整份列表） */
  loading: boolean;
  /** 是否是「当前这一轮」正在参与（F5-37：只有被点击的轮次显示抽奖中） */
  isParticipatingRound?: boolean;
  isAdmin?: boolean;
}> = ({
  round,
  onParticipate,
  loading,
  isParticipatingRound = false,
  isAdmin = false,
}) => {
  const { user } = useAuth();
  // 每轮拥有独立的挑战，不能让另一张卡片的回调或 ref 消费本轮令牌。
  const captchaRef = useRef<ManagedCaptchaRef | null>(null);
  const submittingRef = useRef(false);
  const [captcha, setCaptcha] = useState<ManagedCaptchaChallenge | null>(null);
  const [captchaStatus, setCaptchaStatus] = useState<ManagedCaptchaStatus>({
    required: false, loading: true, error: null, provider: null, solved: false,
  });
  const onCaptchaSolved = useCallback((challenge: ManagedCaptchaChallenge) => setCaptcha(challenge), []);
  const onCaptchaCleared = useCallback(() => setCaptcha(null), []);
  const onCaptchaStatus = useCallback((status: ManagedCaptchaStatus) => setCaptchaStatus(status), []);
  // 服务端按请求者算好 hasParticipated（普通用户视图不回参与者 id）；
  // 兼容旧响应：没有该字段时才回退到 participants 数组。
  const hasParticipated = round.hasParticipated ?? (user?.id ? round.participants.includes(user.id) : false);
  const participantCount = round.participantCount ?? round.participants.length;
  const winnerCount = round.winnerCount ?? round.winners.length;
  // 有库存且有概率的奖品才真正参与抽取；概率和 < 100% 时剩余部分是未中奖概率。
  const totalWinProbability = Math.min(
    1,
    round.prizes
      .filter((item) => item.remaining > 0 && item.probability > 0)
      .reduce((sum, item) => sum + item.probability, 0),
  );
  const isActive = round.isActive && Date.now() >= round.startTime && Date.now() <= round.endTime;
  const captchaUnavailable = !isAdmin && (captchaStatus.loading || Boolean(captchaStatus.error) || (captchaStatus.required && !captcha?.token));
  const handleParticipate = async () => {
    if (submittingRef.current || loading || !isActive || hasParticipated) return;
    if (captchaUnavailable) return;
    submittingRef.current = true;
    let requestSent = true;
    try {
      requestSent = await onParticipate(round.id, isAdmin ? null : captcha);
    } finally {
      if (requestSent && captcha?.token) captchaRef.current?.reset(captcha.token);
      submittingRef.current = false;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className={`${lotteryPanelClass} p-5 sm:p-6`}
      whileHover={{ scale: 1.01, y: -2, boxShadow: '0 22px 60px rgba(15,23,42,0.10)' }}
      whileTap={{ scale: 0.98 }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-950">{round.name}</h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">{round.description}</p>
        </div>
        <div className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${
          isActive ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
        }`}>
          {isActive ? '进行中' : '已结束'}
        </div>
      </div>

      <div className="my-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className={`${lotteryTileClass} p-3 text-sm leading-6 text-slate-600`}>
          <div>开始时间: {new Date(round.startTime).toLocaleString()}</div>
          <div>结束时间: {new Date(round.endTime).toLocaleString()}</div>
        </div>
        <div className={`${lotteryTileClass} p-3 text-sm leading-6 text-slate-600`}>
          <div>参与人数: {participantCount}</div>
          <div>中奖人数: {winnerCount}</div>
        </div>
      </div>

      <div className="mb-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-700">奖品列表</h4>
          <span className="text-xs text-slate-500">
            本轮中奖概率：{(totalWinProbability * 100).toFixed(2)}%
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {round.prizes.slice(0, 6).map((prize) => (
            <PrizeDisplay key={prize.id} prize={prize} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="text-sm text-slate-500">
          抽奖编号: {round.id.slice(0, 8)}...
        </div>
        {user && (
          <div className="flex flex-col gap-2">
            <motion.button
              onClick={() => { void handleParticipate(); }}
              disabled={!isActive || hasParticipated || loading || captchaUnavailable}
              className={`${
                !isActive || hasParticipated || loading || captchaUnavailable
                  ? 'inline-flex cursor-not-allowed items-center justify-center gap-2 rounded-2xl bg-slate-200 px-5 py-3 text-sm font-semibold text-slate-500'
                  : studioPrimaryButtonClassName
              }`}
              whileTap={{ scale: 0.95 }}
            >
              {isParticipatingRound ? '抽奖中...' : hasParticipated ? '已参与' : '立即参与'}
            </motion.button>

            {/* 人机验证组件（非管理员用户）：三家供应商由 /admin/captcha-providers 统一调控 */}
            {!isAdmin && (
              <ManagedCaptcha
                ref={captchaRef}
                scenario="default"
                compact
                onSolved={onCaptchaSolved}
                onCleared={onCaptchaCleared}
                onStatusChange={onCaptchaStatus}
              />
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
};

// 用户记录组件
const UserRecordCard: React.FC<{ record: any }> = ({ record }) => {
  // 防御性处理，确保 record 存在且 history 为数组
  if (!record || typeof record !== 'object') {
    return (
      <motion.div 
        className={`${lotteryPanelClass} p-6 text-center`}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <h3 className="mb-4 text-lg font-semibold text-slate-950">我的抽奖记录</h3>
        <div className="text-slate-400">暂无抽奖记录</div>
      </motion.div>
    );
  }
  const safeHistory = Array.isArray(record.history) ? record.history : [];
  return (
    <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.6 }}
      className={`${lotteryPanelClass} p-5 sm:p-6`}
    >
      <InfoSectionTitle title="我的抽奖记录" icon={FaChartBar} tone="sky" />
      
      {/* 统计信息 */}
      <motion.div 
        className={`${lotteryTileClass} mb-4 p-4 text-left`}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <span className="text-xl font-semibold text-slate-950">{record.participationCount}</span>
        <span className="ml-2 text-sm text-slate-600">参与次数</span>
      </motion.div>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className={`${lotteryTileClass} p-3 text-left`}>
          <div className="text-2xl font-semibold text-emerald-700">{record.winCount}</div>
          <div className="text-sm text-slate-600">中奖次数</div>
        </div>
        <div className={`${lotteryTileClass} p-3 text-left`}>
          <div className="text-2xl font-semibold text-violet-700">¥{record.totalValue}</div>
          <div className="text-sm text-slate-600">总价值</div>
        </div>
        <div className={`${lotteryTileClass} p-3 text-left`}>
          <div className="text-2xl font-semibold text-amber-700">
            {record.participationCount > 0 ? ((record.winCount / record.participationCount) * 100).toFixed(1) : 0}%
          </div>
          <div className="text-sm text-slate-600">中奖率</div>
        </div>
      </div>
      
      {/* 历史记录 */}
      {safeHistory.length > 0 && (
        <div>
          <h4 className="text-md mb-3 font-semibold text-slate-800">最近中奖记录</h4>
          <div className="space-y-2">
            {safeHistory.slice(0, 5).map((item: any, index: number) => (
              <motion.div 
                key={index} 
                className="flex items-center gap-2 rounded-2xl p-2 text-sm hover:bg-white/70"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: 0.1 * index }}
                whileHover={{ scale: 1.02, x: 5 }}
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium text-slate-900">{item.prizeName}</div>
                  <div className="text-xs text-slate-500">
                    {formatDistanceToNow(item.drawTime, { addSuffix: true, locale: zhCN })}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-emerald-700">¥{item.value}</div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
};

// 排行榜组件
const LeaderboardCard: React.FC<{ leaderboard: any[] }> = ({ leaderboard }) => {
  // 修复：防御性处理，确保 leaderboard 一定为数组
  const safeLeaderboard = Array.isArray(leaderboard) ? leaderboard : [];
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className={`${lotteryPanelClass} p-5 sm:p-6`}
    >
      <InfoSectionTitle title="排行榜" icon={FaTrophy} tone="amber" />
      
      <div className="space-y-2">
        {safeLeaderboard.length === 0 ? (
          <motion.div
            className="py-8 text-center text-slate-400"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            暂无排行榜数据
          </motion.div>
        ) : (
          safeLeaderboard.map((user, index) => (
            <motion.div
              key={user.userId}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: 0.1 * index }}
              className="flex items-center gap-3 rounded-2xl p-2 text-sm hover:bg-white/70"
              whileHover={{ scale: 1.02, x: -5 }}
          >
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-white font-bold text-xs ${
              index === 0 ? 'bg-yellow-500' : 
              index === 1 ? 'bg-slate-400' :
              index === 2 ? 'bg-orange-500' : 'bg-slate-500'
            }`}>
              {index === 0 ? <FaCrown className="w-3 h-3" /> : 
               index === 1 ? <FaMedal className="w-3 h-3" /> : 
               index === 2 ? <FaMedal className="w-3 h-3" /> : 
               index + 1}
            </div>
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium text-slate-900">{user.username}</div>
                <div className="text-xs text-slate-500">
                参与 {user.participationCount} 次 | 中奖 {user.winCount} 次
              </div>
            </div>
            <div className="text-right">
              <div className="font-semibold text-emerald-700">¥{user.totalValue}</div>
            </div>
          </motion.div>
          ))
        )}
      </div>
    </motion.div>
  );
};

// 统计信息组件
const StatisticsCard: React.FC<{ stats: any }> = ({ stats }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.6 }}
    className="space-y-4"
  >
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <InfoMetricCard label="总轮次" value={stats.totalRounds} icon={FaDice} tone="sky" />
      <InfoMetricCard label="活跃轮次" value={stats.activeRounds} icon={FaCrosshairs} tone="emerald" />
      <InfoMetricCard label="总参与人数" value={stats.totalParticipants} icon={FaUsers} tone="violet" />
      <InfoMetricCard label="总中奖人数" value={stats.totalWinners} icon={FaTrophy} tone="amber" />
      <InfoMetricCard label="总价值" value={`¥${stats.totalValue}`} icon={FaGift} tone="rose" />
    </div>
  </motion.div>
);

// 中奖弹窗组件
const WinnerModal: React.FC<{ 
  winner: LotteryWinner | null; 
  onClose: () => void; 
}> = ({ winner, onClose }) => {
  if (!winner) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.8, opacity: 0 }}
          className="w-full max-w-md rounded-2xl border border-slate-200 bg-white/90 p-8 text-center shadow-sm backdrop-blur-xl max-h-[90vh] overflow-y-auto overscroll-contain"
          onClick={(e) => e.stopPropagation()}
        >
          <FaGift className="text-6xl mb-4 text-yellow-500" />
          <h2 className="mb-2 text-2xl font-semibold text-slate-950">恭喜中奖！</h2>
          <p className="mb-4 text-lg text-slate-600">{winner.prizeName}</p>
          <InfoPrimaryButton onClick={onClose} tone="sky">确定</InfoPrimaryButton>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

// 主抽奖页面组件
const LotteryPage: React.FC = () => {
  const { user } = useAuth();
  const { setNotification } = useNotification();
  const {
    activeRounds,
    userRecord,
    leaderboard,
    statistics,
    loading,
    participating,
    participatingRoundId,
    error,
    fetchActiveRounds,
    fetchLeaderboard,
    fetchStatistics,
    participateInLottery,
    clearError
  } = useLottery();

  const [winner, setWinner] = useState<LotteryWinner | null>(null);
  
  const submittingRef = useRef(false);

  // 检查是否为管理员（superadmin 同样视为管理员）
  const isAdmin = useMemo(() => isAdminRole(user?.role), [user]);

  const handleParticipate = async (roundId: string, challenge?: ManagedCaptchaChallenge | null) => {
    if (submittingRef.current) return false;
    submittingRef.current = true;
    try {
      const result = await participateInLottery(roundId, challenge?.token, challenge?.provider);
      if (result) {
        setWinner(result);
        setNotification({ message: `恭喜获得 ${result.prizeName}！`, type: 'success' });
      } else {
        // 概率和 < 1 时会有「未中奖」：这是正常结果，不是失败。
        setNotification({ message: '本轮未中奖，谢谢参与！', type: 'info' });
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : '参与抽奖失败';
      setNotification({ message: msg, type: 'error' });
    } finally {
      submittingRef.current = false;
    }
    return true;
  };

  // F5-11：错误面板的「重试」必须真的重新拉数据，而不是只把错误清掉
  const handleRetry = useCallback(() => {
    clearError();
    void Promise.all([fetchActiveRounds(), fetchLeaderboard(), fetchStatistics()]);
  }, [clearError, fetchActiveRounds, fetchLeaderboard, fetchStatistics]);

  if (error) {
    return (
      <InfoQueryShell>
        <InfoPanel className="border-rose-200 bg-rose-50/80">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-rose-700">
              抽奖数据暂时加载不出来，请检查网络后重试。
            </div>
            <InfoPrimaryButton onClick={handleRetry} tone="rose">重试</InfoPrimaryButton>
          </div>
          <details className="mt-3 text-xs text-rose-700/80">
            <summary className="cursor-pointer">技术详情</summary>
            <div className="mt-1 break-all font-mono">{error}</div>
          </details>
        </InfoPanel>
      </InfoQueryShell>
    );
  }

  return (
    <InfoQueryShell>
        <motion.div
          className="space-y-6"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <InfoQueryHero
            eyebrow="Entertainment"
            title="幸运抽奖"
            description="参与抽奖轮次、查看奖品与中奖记录。抽奖结果公平公正，全程可查。"
            icon={FaDice}
            tone="violet"
            meta={
              <>
                <InfoBadge tone="sky">公平公正</InfoBadge>
                <InfoBadge tone="emerald">实时轮次</InfoBadge>
                <InfoBadge tone="amber">透明记录</InfoBadge>
              </>
            }
          />

        {/* 统计信息 */}
        {statistics && <StatisticsCard stats={statistics} />}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 用户记录 */}
          <div className="lg:col-span-1">
            {user ? (
              <UserRecordCard record={userRecord} />
            ) : (
            <motion.div 
              className={`${lotteryPanelClass} p-6 text-center`}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
            >
                <p className="text-slate-600">请登录查看个人记录</p>
            </motion.div>
            )}
          </div>

          {/* 排行榜 */}
          <div className="lg:col-span-1">
            <LeaderboardCard leaderboard={leaderboard} />
          </div>
        </div>

        {/* 活跃轮次 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className={`${lotteryPanelClass} p-5 sm:p-6`}
        >
          <InfoSectionTitle
            title="活跃抽奖轮次"
            description="选择可参与的抽奖轮次并完成必要验证。"
            icon={FaCrosshairs}
            tone="rose"
          />
          {loading ? (
            <div className="text-center py-8">
              <div className="mx-auto h-12 w-12 animate-spin rounded-full border-2 border-sky-200 border-b-sky-600"></div>
              <p className="mt-4 text-slate-600">加载中...</p>
            </div>
          ) : activeRounds.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {activeRounds.map((round) => (
                <LotteryRoundCard
                  key={round.id}
                  round={round}
                  onParticipate={handleParticipate}
                  loading={participating}
                  isParticipatingRound={participatingRoundId === round.id}
                  isAdmin={isAdmin}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-slate-600">暂无活跃的抽奖轮次</p>
            </div>
          )}
        </motion.div>
        </motion.div>

      {/* 中奖弹窗 */}
      <WinnerModal winner={winner} onClose={() => setWinner(null)} />
    </InfoQueryShell>
  );
};

export default LotteryPage; 
