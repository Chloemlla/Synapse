/**
 * 抽奖行为任务目录（PRD §3.3 资格来源）。
 *
 * 产品口径（每日可领次数、每次发几次机会）全部走 env，默认值可直接用；真实业务校验
 * （如下单是否满额、浏览是否达标）由对应子系统调用 `grantTaskChances` 授予，
 * 前端只能自助领取 `clientClaimable` 的任务（签到这类无外部依赖的）。
 */

export interface LotteryTaskDefinition {
  key: string;
  label: string;
  description: string;
  /** 每次领取发放的抽奖机会数。 */
  chances: number;
  /** 每日最多领取次数。 */
  dailyLimit: number;
  /** 是否允许前端自助领取（false 只能由服务端子系统授予）。 */
  clientClaimable: boolean;
}

function envInt(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export const LOTTERY_TASK_CATALOG: readonly LotteryTaskDefinition[] = Object.freeze([
  {
    key: "daily_checkin",
    label: "每日签到",
    description: "每天签到领取抽奖机会。",
    chances: envInt("LOTTERY_TASK_CHECKIN_CHANCES", 1, 100),
    dailyLimit: envInt("LOTTERY_TASK_CHECKIN_DAILY_LIMIT", 1, 100),
    clientClaimable: true,
  },
  {
    key: "browse_activity",
    label: "浏览活动页",
    description: "浏览活动页满指定时长领取抽奖机会。",
    chances: envInt("LOTTERY_TASK_BROWSE_CHANCES", 1, 100),
    dailyLimit: envInt("LOTTERY_TASK_BROWSE_DAILY_LIMIT", 1, 100),
    clientClaimable: true,
  },
  {
    key: "order_reward",
    label: "下单有礼",
    description: "完成订单后由业务子系统发放抽奖机会。",
    chances: envInt("LOTTERY_TASK_ORDER_CHANCES", 3, 100),
    dailyLimit: envInt("LOTTERY_TASK_ORDER_DAILY_LIMIT", 3, 100),
    // 下单是否满额由订单子系统校验，前端不能自助领取。
    clientClaimable: false,
  },
]);

export function getLotteryTask(key: string): LotteryTaskDefinition | undefined {
  return LOTTERY_TASK_CATALOG.find((task) => task.key === key);
}

/** 该任务在「当天已领 count 次」时是否还能再领。 */
export function canClaimTask(task: LotteryTaskDefinition, claimedToday: number): boolean {
  return Math.max(0, Math.floor(claimedToday)) < task.dailyLimit;
}
