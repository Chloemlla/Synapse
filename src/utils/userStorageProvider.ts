import { mongoUserStorageProvider } from "./providers/mongoUserStorageProvider";
import type { User } from "./userStorageTypes";
import type { AccountSecurityFacts, AdminUserListPageResult, AdminUserListQueryParams } from "../services/userService";
export type { AccountSecurityFacts } from "../services/userService";

export type UserStorageMode = "mongo";

export interface UserStorageProvider {
  getAllUsers(): Promise<User[]>;
  getAdminUserList?(opts?: { includeFingerprints?: boolean }): Promise<User[]>;
  getAdminUserListPage?(query: AdminUserListQueryParams, includeFingerprints?: boolean): Promise<AdminUserListPageResult>;
  getUserById(id: string): Promise<User | null>;
  getUserSecretsById?(id: string): Promise<User | null>;
  /**
   * 账号安全总览要用的窄事实（有没有密码材料 / 恢复码余量）。
   *
   * 为什么单独一个方法：公开投影（PUBLIC_USER_SELECT）不含这两项，
   * 任何“先取一个 User 再从上面读”的写法都会静默得到「没有密码 / 恢复码为 0」，
   * 从而误报安全告警。这里只回布尔与计数，不把密码材料/恢复码本体带出存储层。
   */
  getAccountSecurityFacts?(id: string): Promise<AccountSecurityFacts | null>;
  consumeTotpCounter?(id: string, counter: number): Promise<boolean>;
  consumePendingChallenge?(id: string, expectedChallenge: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserByEmailCaseInsensitive(email: string): Promise<User | null>;
  /** RC-05：按规范化邮箱查活跃账号（可选：旧替身未实现时视为“查不到”）。 */
  getUserByEmailCanonical?(canonical: string): Promise<User | null>;
  getUserByUsername(username: string): Promise<User | null>;
  getUserByToken(token: string): Promise<User | null>;
  getUserByLinuxDoId(linuxdoId: string): Promise<User | null>;
  getUsersByIds?(ids: string[]): Promise<User[]>;
  createUser(user: User): Promise<User>;
  updateUser(userId: string, updates: Partial<User>): Promise<User | null>;
  bulkUpdateUsers?(ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }>): Promise<void>;
  /**
   * 软删除用户（RC-01）。`options` 记录操作者与原因，供取证调取时解释留存依据。
   */
  deleteUser(userId: string, options?: { by?: string; reason?: string }): Promise<boolean>;
  /**
   * 物理删除用户。**仅限注册流程回滚**（邀请码消费失败等账号从未成立的场景）——
   * 那种情况软删除会留下占着邮箱的幽灵账号。用户/管理员删号一律走 deleteUser（软删除，RC-01）。
   */
  hardDeleteUser?(userId: string): Promise<boolean>;
}

export const getCurrentUserStorageMode = (): UserStorageMode => "mongo";

export const getUserStorageProvider = (): UserStorageProvider => mongoUserStorageProvider;
