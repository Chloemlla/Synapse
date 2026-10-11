import logger from "../../utils/logger";

/**
 * 外部财务流水适配（PRD §3 T+1 全链路核对）。
 *
 * 形态：`GET ${LOTTERY_FINANCE_SOURCE_URL}?date=YYYY-MM-DD`
 * 期望响应 `{ totalValue: number, count?: number }`（或包在 `data` 里）。
 * 未配置外部源时返回 null —— 对账退化为「内部一致性核对」，并在报表里明确标注
 * `external: null`，不把「没有基线」伪装成「对上了」。
 */

export interface LotteryFinanceEntry {
  date: string;
  totalValue: number;
  count: number | null;
  source: string;
}

export interface LotteryFinanceSource {
  name: string;
  fetchDaily(date: string): Promise<LotteryFinanceEntry | null>;
}

const FINANCE_TIMEOUT_MS = 8000;

function readFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createHttpFinanceSource(url: string, name = "http"): LotteryFinanceSource {
  return {
    name,
    async fetchDaily(date: string): Promise<LotteryFinanceEntry | null> {
      const target = new URL(url);
      target.searchParams.set("date", date);
      try {
        const response = await fetch(target.toString(), { signal: AbortSignal.timeout(FINANCE_TIMEOUT_MS) });
        if (!response.ok) {
          logger.warn("[LotteryFinance] 财务源返回非 2xx", { date, status: response.status });
          return null;
        }
        const payload = (await response.json()) as Record<string, unknown>;
        const inner = (payload?.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
        const totalValue = readFiniteNumber(inner.totalValue);
        if (totalValue === null) {
          logger.warn("[LotteryFinance] 财务源响应缺少 totalValue", { date });
          return null;
        }
        return { date, totalValue, count: readFiniteNumber(inner.count), source: name };
      } catch (error) {
        logger.warn("[LotteryFinance] 拉取外部财务流水失败", {
          date,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}

/** 解析已配置的财务源；未配置返回 null。 */
export function resolveLotteryFinanceSource(): LotteryFinanceSource | null {
  const url = process.env.LOTTERY_FINANCE_SOURCE_URL?.trim();
  if (!url) return null;
  return createHttpFinanceSource(url, process.env.LOTTERY_FINANCE_SOURCE_NAME?.trim() || "http");
}

/** 上海自然日的 YYYY-MM-DD（对账日期口径与归日一致）。 */
export function shanghaiDateKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
}
