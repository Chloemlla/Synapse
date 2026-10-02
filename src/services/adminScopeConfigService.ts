import logger from "../utils/logger";
import {
  ADMIN_PAGES,
  DEFAULT_PLAIN_ADMIN_PAGES,
  normalizeGrantedPages,
} from "../config/adminPages";
import { getAdminScopeConfigModel, type AdminScopeConfigDoc } from "../models/adminScopeConfigModel";

const SCOPE_KEY = "plain-admin-pages";
/** 进程内缓存：授权判定在每个管理端请求上都会跑，不能每请求读一次库。 */
const CACHE_TTL_MS = 15_000;

export interface PlainAdminScopeConfig {
  defaultPages: string[];
  perUser: Record<string, string[]>;
  updatedAt: string | null;
  updatedBy: string;
  /** 文档不存在时为 true（说明当前用的是默认值）。 */
  isDefault: boolean;
}

export interface PlainAdminScopeView extends PlainAdminScopeConfig {
  /** 配置界面用：登记表里全部页面 key 与可读名。 */
  availablePages: Array<{ key: string; label: string; apiScopeCount: number }>;
}

let cache: { value: PlainAdminScopeConfig; expiresAt: number } | null = null;

function toRecord(perUser: AdminScopeConfigDoc["perUser"]): Record<string, string[]> {
  if (!perUser) return {};
  const entries = perUser instanceof Map ? [...perUser.entries()] : Object.entries(perUser);
  const record: Record<string, string[]> = {};
  for (const [userId, pages] of entries) {
    record[userId] = normalizeGrantedPages(Array.isArray(pages) ? pages : []);
  }
  return record;
}

function defaultConfig(): PlainAdminScopeConfig {
  return {
    defaultPages: normalizeGrantedPages(DEFAULT_PLAIN_ADMIN_PAGES),
    perUser: {},
    updatedAt: null,
    updatedBy: "",
    isDefault: true,
  };
}

async function loadFromStore(): Promise<PlainAdminScopeConfig> {
  try {
    const doc = (await getAdminScopeConfigModel()
      .findOne({ scopeKey: SCOPE_KEY })
      .lean()) as AdminScopeConfigDoc | null;

    if (!doc) return defaultConfig();

    return {
      defaultPages: normalizeGrantedPages(doc.defaultPages ?? DEFAULT_PLAIN_ADMIN_PAGES),
      perUser: toRecord(doc.perUser),
      updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
      updatedBy: doc.updatedBy || "",
      isDefault: false,
    };
  } catch (error) {
    // 读配置失败不能把管理端整个打死：退回默认值（与历史行为一致，且是收窄而不是放宽）。
    logger.warn("[AdminScope] 读取普通管理员页面配置失败，暂用默认值", {
      error: error instanceof Error ? error.message : String(error),
    });
    return defaultConfig();
  }
}

export async function getPlainAdminScopeConfig(options: { bypassCache?: boolean } = {}): Promise<PlainAdminScopeConfig> {
  if (!options.bypassCache && cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }
  const value = await loadFromStore();
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export function invalidatePlainAdminScopeCache(): void {
  cache = null;
}

/** 某个普通管理员最终可见的页面集合 = 默认集合 ∪ 该用户的覆盖。 */
export function resolvePagesForUser(config: PlainAdminScopeConfig, userId: string): string[] {
  return normalizeGrantedPages([...config.defaultPages, ...(config.perUser[userId] ?? [])]);
}

export async function getPagesForUser(userId: string): Promise<string[]> {
  const config = await getPlainAdminScopeConfig();
  return resolvePagesForUser(config, userId);
}

export async function getPlainAdminScopeView(): Promise<PlainAdminScopeView> {
  const config = await getPlainAdminScopeConfig({ bypassCache: true });
  return {
    ...config,
    availablePages: ADMIN_PAGES.map((page) => ({
      key: page.key,
      label: page.label,
      apiScopeCount: page.apiPrefixes.length,
    })),
  };
}

export interface UpdatePlainAdminScopeInput {
  defaultPages?: unknown;
  perUser?: unknown;
}

function sanitizePerUser(input: unknown): Record<string, string[]> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result: Record<string, string[]> = {};
  for (const [userId, pages] of Object.entries(input as Record<string, unknown>)) {
    const key = userId.trim();
    if (!key) continue;
    if (!Array.isArray(pages)) continue;
    result[key] = normalizeGrantedPages(pages);
  }
  return result;
}

/**
 * 覆盖式写入。`defaultPages` / `perUser` 允许只传其一（未传的保持原值），
 * 但两者都传空表示「收回全部授权」（此时普通管理员仍能看到总览）。
 */
export async function updatePlainAdminScopeConfig(
  input: UpdatePlainAdminScopeInput,
  actor: { userId: string },
): Promise<PlainAdminScopeView> {
  const model = getAdminScopeConfigModel();
  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: actor.userId,
  };

  if (input.defaultPages !== undefined) {
    if (!Array.isArray(input.defaultPages)) {
      throw new Error("defaultPages 必须是页面 key 数组");
    }
    updates.defaultPages = normalizeGrantedPages(input.defaultPages);
  }

  if (input.perUser !== undefined) {
    updates.perUser = sanitizePerUser(input.perUser);
  }

  await model.updateOne({ scopeKey: SCOPE_KEY }, { $set: updates }, { upsert: true });
  invalidatePlainAdminScopeCache();

  logger.info("[AdminScope] 普通管理员页面授权已更新", {
    actor: actor.userId,
    keys: Object.keys(updates).filter((key) => key !== "updatedAt" && key !== "updatedBy"),
  });

  return getPlainAdminScopeView();
}

export async function resetPlainAdminScopeConfig(actor: { userId: string }): Promise<PlainAdminScopeView> {
  await getAdminScopeConfigModel().deleteOne({ scopeKey: SCOPE_KEY });
  invalidatePlainAdminScopeCache();
  logger.info("[AdminScope] 普通管理员页面授权已恢复默认", { actor: actor.userId });
  return getPlainAdminScopeView();
}
