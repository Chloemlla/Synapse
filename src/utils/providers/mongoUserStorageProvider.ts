import * as userService from "../../services/userService";
import logger from "../logger";
import type { User } from "../userStorageTypes";
import type { UserStorageProvider } from "../userStorageProvider";

const removeAvatarBase64 = <T>(value: T): T => {
  if (value && typeof value === "object" && "avatarBase64" in (value as Record<string, unknown>)) {
    delete (value as Record<string, unknown>).avatarBase64;
  }
  return value;
};

export const mongoUserStorageProvider: UserStorageProvider = {
  async getAllUsers() {
    return (await userService.getAllUsers()).map((user) => removeAvatarBase64(user));
  },

  async getAdminUserList(opts?: { includeFingerprints?: boolean }) {
    return (await userService.getAdminUserList(opts)).map((user) => removeAvatarBase64(user));
  },

  async getAdminUserListPage(query, includeFingerprints) {
    return userService.getAdminUserListPage(query, includeFingerprints === true);
  },

  async getAccountSecurityFacts(id: string) {
    return userService.getAccountSecurityFacts(id);
  },

  async getUserById(id: string) {
    return removeAvatarBase64(await userService.getUserById(id));
  },

  async getUserSecretsById(id: string) {
    return removeAvatarBase64(await userService.getUserSecretsById(id));
  },

  async consumeTotpCounter(id: string, counter: number) {
    return userService.consumeTotpCounter(id, counter);
  },

  async consumePendingChallenge(id: string, expectedChallenge: string) {
    return removeAvatarBase64(await userService.consumePendingChallenge(id, expectedChallenge));
  },

  async getUserByEmail(email: string) {
    return removeAvatarBase64(await userService.getUserByEmail(email));
  },

  async getUserByEmailCaseInsensitive(email: string) {
    return removeAvatarBase64(await userService.getUserByEmailCaseInsensitive(email));
  },

  async getUserByUsername(username: string) {
    return removeAvatarBase64(await userService.getUserByUsername(username));
  },

  async getUserByToken(token: string) {
    return removeAvatarBase64(await userService.getUserByToken(token));
  },

  async getUsersByIds(ids: string[]) {
    return (await userService.getUsersByIds(ids)).map((user) => removeAvatarBase64(user));
  },

  async bulkUpdateUsers(ops) {
    await userService.bulkUpdateUsers(ops);
  },

  async getUserByLinuxDoId(linuxdoId: string) {
    return removeAvatarBase64(await userService.getUserByLinuxDoId(linuxdoId));
  },

  async createUser(user: User) {
    return removeAvatarBase64(await userService.createUser(user));
  },

  async updateUser(userId: string, updates: Partial<User>) {
    return removeAvatarBase64(await userService.updateUser(userId, updates));
  },

  async deleteUser(userId: string, options: { by?: string; reason?: string } = {}) {
    try {
      // RC-01: 语义已改为软删除（打 deletedAt 标记 + 凭据失效），不再物理删除。
      await userService.softDeleteUser(userId, options);
      return true;
    } catch (error) {
      logger.error("[UserStorage] MongoDB deleteUser 失败", { error, userId });
      return false;
    }
  },

  /**
   * 物理删除：**仅限注册流程回滚**（账号从未真正存在过）。
   * 用户/管理员删号必须走 deleteUser（软删除）。
   */
  async hardDeleteUser(userId: string) {
    try {
      await userService.hardDeleteUser(userId);
      return true;
    } catch (error) {
      logger.error("[UserStorage] MongoDB hardDeleteUser 失败", { error, userId });
      return false;
    }
  },
};
