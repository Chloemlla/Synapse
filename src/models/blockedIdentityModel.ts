import { mongoose } from "../services/mongoService";

/**
 * 已退役身份墓碑（RC-47）。
 *
 * 存在的唯一理由：**阻止“注销再注册”洗白风险档**。
 *
 * 背景（这是一个真实被引入过的漏洞）：软删除账号时如果把 `email`/`username`
 * 改名释放唯一索引，攻击者立刻用原邮箱重新注册 —— 注册查重只看 `user_datas` 里
 * 未删除的账号，查不到即注册成功，`riskTier`/`riskFlags` 全部归零。
 * 被风控标记的账号因此获得一条零成本的洗白路径，直接推翻 RC-01 的初衷。
 *
 * 两条防线同时存在，互不替代：
 *   1. **唯一索引不释放**：软删除后 `user_datas` 上的 `email`/`username` 保持原值，
 *      唯一索引本身就是硬兜底（即使墓碑写失败也拦得住）。
 *   2. **墓碑表**（本文件）：把“这个身份被退役过”显式记下来，使得拒绝**可解释**、
 *      可审计、可人工释放；并且键用 `emailCanonical`，因此 Gmail 的点号与 `+tag`
 *      变体也一并挡住 —— 否则攻击者改用 `u.s.e.r@gmail.com` 就绕过了。
 *
 * 合规：墓碑表会长期保存邮箱，属“安全与风控”类数据，必须登记进
 * `docs/governance/privacy-data-map.json`，并在隐私政策里说明保留依据（不得做成隐形的永久邮箱名单）。
 */

export interface BlockedIdentityDoc {
  /** 规范化邮箱（小写、去 Gmail 点号、去 +tag），唯一索引。 */
  emailCanonical: string;
  /** 原始邮箱，仅供人工核验与审计展示。 */
  email: string;
  /** 退役时的用户名（用户名不参与规范化，按原值记录）。 */
  username: string;
  /** 触发退役的账号 id。 */
  userId: string;
  /** 可读原因（如 account_deleted）。 */
  reason: string;
  blockedAt: Date;
  /** 人工释放者；非空表示该身份已放行，可再次注册。 */
  releasedBy?: string | null;
  releasedAt?: Date | null;
}

const BlockedIdentitySchema = new mongoose.Schema<BlockedIdentityDoc>(
  {
    // unique 本身即建索引；再写 index: true 是冗余的（且容易与下方复合索引混成重复声明）。
    emailCanonical: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    username: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    reason: { type: String, required: true, default: "account_deleted" },
    blockedAt: { type: Date, required: true, default: Date.now },
    releasedBy: { type: String, default: null },
    releasedAt: { type: Date, default: null },
  },
  { collection: "blocked_identities", timestamps: true },
);

// 注册查重按“未释放 + 规范化邮箱”命中；带上 releasedAt 让该查询能吃到索引。
BlockedIdentitySchema.index({ emailCanonical: 1, releasedAt: 1 });

export const BlockedIdentityModel =
  (mongoose.models.BlockedIdentity as mongoose.Model<BlockedIdentityDoc>) ||
  mongoose.model<BlockedIdentityDoc>("BlockedIdentity", BlockedIdentitySchema);
