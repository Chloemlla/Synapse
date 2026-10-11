/**
 * 玩法表现层配置（PRD §3.1）：把「交互表现」与「底层发奖」解耦。
 *
 * 这里是**无代码区块编辑器**的数据模型：运营在管理端拼区块（文案/图片/按钮/倒计时/奖品格/
 * 间隔），前端按 `theme + blocks` 渲染；后端不感知具体皮肤，只做入库与校验。
 */

export type LotteryPresentationBlockType = "text" | "image" | "button" | "countdown" | "prizeGrid" | "spacer";

export interface LotteryPresentationBlock {
  id: string;
  type: LotteryPresentationBlockType;
  /** 区块属性（文案 / 图片地址 / 按钮动作 / 倒计时目标等）。 */
  props?: Record<string, unknown>;
}

export interface LotteryPresentation {
  theme?: string;
  blocks: LotteryPresentationBlock[];
  /** 规则说明文案（展示用）。 */
  rules?: string;
}

const BLOCK_TYPES = new Set<LotteryPresentationBlockType>(["text", "image", "button", "countdown", "prizeGrid", "spacer"]);
const MAX_BLOCKS = 30;
const MAX_STRING_LENGTH = 1000;

function sanitizeProps(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (/[$.{}[\]]/.test(key)) continue;
    if (typeof value === "string") {
      result[key] = value.slice(0, MAX_STRING_LENGTH);
    } else if (typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 校验并归一化表现层配置；非法返回 null（由调用方回 400，不静默丢弃）。 */
export function normalizePresentation(raw: unknown): LotteryPresentation | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const rawBlocks = record.blocks;
  if (!Array.isArray(rawBlocks) || rawBlocks.length > MAX_BLOCKS) return null;

  const blocks: LotteryPresentationBlock[] = [];
  for (const item of rawBlocks) {
    if (!item || typeof item !== "object") return null;
    const block = item as Record<string, unknown>;
    const type = block.type;
    if (typeof type !== "string" || !BLOCK_TYPES.has(type as LotteryPresentationBlockType)) return null;
    const id = typeof block.id === "string" && block.id.trim() ? block.id.trim().slice(0, 64) : `blk_${blocks.length + 1}`;
    blocks.push({
      id,
      type: type as LotteryPresentationBlockType,
      ...(sanitizeProps(block.props) ? { props: sanitizeProps(block.props) } : {}),
    });
  }

  const theme = typeof record.theme === "string" && record.theme.trim() ? record.theme.trim().slice(0, 64) : undefined;
  const rules = typeof record.rules === "string" ? record.rules.slice(0, MAX_STRING_LENGTH) : undefined;
  return {
    ...(theme ? { theme } : {}),
    ...(rules !== undefined ? { rules } : {}),
    blocks,
  };
}
