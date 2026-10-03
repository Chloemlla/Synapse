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
  getUserByUsername(username: string): Promise<User | null>;
  getUserByToken(token: string): Promise<User | null>;
  getUserByLinuxDoId(linuxdoId: string): Promise<User | null>;
  getUsersByIds?(ids: string[]): Promise<User[]>;
  createUser(user: User): Promise<User>;
  updateUser(userId: string, updates: Partial<User>): Promise<User | null>;
  bulkUpdateUsers?(ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }>): Promise<void>;
  deleteUser(userId: string): Promise<boolean>;
}

export const getCurrentUserStorageMode = (): UserStorageMode => "mongo";

export const getUserStorageProvider = (): UserStorageProvider => mongoUserStorageProvider;
