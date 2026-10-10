import { BlockedIdentityModel } from "../models/blockedIdentityModel";
import { mongoose } from "./mongoService";
import logger from "../utils/logger";

/**
 * 已退役身份（墓碑）服务 —— RC-47。
 *
 * 语义：一旦某个身份被退役，**未经人工释放不得再次用于注册**。
 * 这堵的是“注销 → 用同一邮箱重注 → 风险档归零”的洗白路径。
 *
 * 为什么键是 `emailCanonical` 而不是原邮箱：攻击者换一个写法（Gmail 点号、
 * `+tag` 别名）就能绕过基于原值的比对。规范化把这类变体折叠成同一个键。
 *
 * 失败语义（刻意不同，别统一）：
 * - **查（注册侧）**：抛错。注册本来就必须能读 Mongo，读不到时不能“当作没墓碑”放行
 *   —— 那正好是攻击者等的窗口（fail-closed）。
 * - **写（退役侧）**：由调用方放在事务里；写失败即让整个删号事务回滚。
 *   还有唯一索引作硬兜底，所以这里宁可报错也不要静默降级。
 */

/**
 * 规范化邮箱，用于“同一身份”的判定。
 *
 * 规则（只有两条，避免过度规范化把不同人的邮箱折叠到一起）：
 *  1. 小写 + 去首尾空白；
 *  2. 去掉 `+tag` 后缀；Gmail/Googlemail 额外去掉本地部分的点号。
 *
 * 刻意**不**做的：不为 outlook/hotmail 去点号（那些域名的点号可能是有意义的）、
 * 不做名字折叠。过度规范化会导致 A 的墓碑挡住 B 的注册 —— 那是比洗白更糟的误伤。
 */
export function normalizeEmailCanonical(email: string): string {
  const trimmed = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!trimmed) return "";
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;

  const domain = trimmed.slice(at + 1);
  let local = trimmed.slice(0, at);

  // 去 +tag（几乎所有主流服务商都忽略它）
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);

  // Gmail 系忽略本地部分的点号
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    // googlemail.com 与 gmail.com 是同一个邮箱（同一账号的两种写法）
    return `${local}@gmail.com`;
  }

  return `${local}@${domain}`;
}

export interface RetiredIdentityHit {
  retired: boolean;
  username?: string;
  reason?: string;
  blockedAt?: Date;
}

/**
 * 该邮箱是否处于“已退役、未释放”状态。
 * 读失败时**抛错**（fail-closed）—— 调用方（注册/绑定）必须让请求失败，不能放行。
 */
export async function findRetiredIdentity(email: string): Promise<RetiredIdentityHit> {
  const canonical = normalizeEmailCanonical(email);
  if (!canonical) return { retired: false };
  if (mongoose.connection.readyState !== 1) {
    throw new Error("数据库连接不可用");
  }

  const doc = await BlockedIdentityModel.findOne({ emailCanonical: canonical, releasedAt: null })
    .select("username reason blockedAt")
    .lean()
    .exec();

  if (!doc) return { retired: false };
  return { retired: true, username: doc.username, reason: doc.reason, blockedAt: doc.blockedAt };
}

/** 便捷布尔版；异常向上抛，不吞。 */
export async function isIdentityRetired(email: string): Promise<boolean> {
  return (await findRetiredIdentity(email)).retired;
}

export interface RetireIdentityInput {
  userId: string;
  username: string;
  email: string;
  reason?: string;
}

/**
 * 写入（或更新）墓碑。
 *
 * 用 upsert 而不是 create：同一个身份可能“退役 → 人工释放 → 再次退役”，
 * `emailCanonical` 是唯一索引，第二次退役必须更新既有墓碑并清掉 `releasedAt`，
 * 否则会撞 E11000 而让删号事务整体失败。
 */
export async function retireIdentity(
  input: RetireIdentityInput,
  session?: mongoose.ClientSession,
): Promise<void> {
  const canonical = normalizeEmailCanonical(input.email);
  if (!canonical) {
    logger.warn("[BlockedIdentity] 邮箱无法规范化，跳过墓碑写入", { userId: input.userId });
    return;
  }

  await BlockedIdentityModel.findOneAndUpdate(
    { emailCanonical: canonical },
    {
      $set: {
        emailCanonical: canonical,
        email: input.email,
        username: input.username,
        userId: input.userId,
        reason: input.reason ?? "account_deleted",
        blockedAt: new Date(),
        // 重新退役时必须清掉旧的释放标记，否则墓碑形同虚设
        releasedBy: null,
        releasedAt: null,
      },
    },
    { upsert: true, returnDocument: "after", session },
  ).exec();

  logger.info("[BlockedIdentity] 身份已退役（禁止直接重注）", {
    userId: input.userId,
    reason: input.reason ?? "account_deleted",
  });
}

/**
 * 人工释放：仅用于“确实误删、已人工核验”的恢复路径。
 * 调用方必须已过安全会话（RC-32）并写审计（RC-35）—— 本函数只负责状态迁移。
 */
export async function releaseIdentity(
  email: string,
  options: { by: string },
): Promise<{ released: boolean }> {
  const canonical = normalizeEmailCanonical(email);
  if (!canonical) return { released: false };
  if (mongoose.connection.readyState !== 1) {
    throw new Error("数据库连接不可用");
  }

  const result = await BlockedIdentityModel.updateOne(
    { emailCanonical: canonical, releasedAt: null },
    { $set: { releasedBy: options.by, releasedAt: new Date() } },
  ).exec();

  if (result.modifiedCount > 0) {
    logger.warn("[BlockedIdentity] 身份已被人工释放，该邮箱可再次注册", {
      by: options.by,
    });
  }
  return { released: result.modifiedCount > 0 };
}
