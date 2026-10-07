import { createHash, randomUUID } from "node:crypto";
import { AuthEmailCooldownModel } from "../models/authEmailCooldownModel";
import logger from "../utils/logger";

export interface AuthEmailReservation {
  key: string;
  id: string;
  cooldownMs: number;
}

export type AuthEmailReservationResult =
  | { success: true; reservation: AuthEmailReservation }
  | { success: false; retryAfterSeconds: number };

export async function reserveAuthEmail(
  email: string,
  purpose: string,
  cooldownMs = 60_000,
): Promise<AuthEmailReservationResult> {
  const key = createHash("sha256").update(`${purpose}:${email.trim().toLowerCase()}`).digest("hex");
  const id = randomUUID();
  const now = new Date();
  try {
    // 正在投递时持有较长租约；完成后从完成时刻开始短冷却。不同进程共享同一原子条件。
    const acquired = await AuthEmailCooldownModel.findOneAndUpdate(
      { _id: key, expiresAt: { $lte: now } },
      { $set: { reservationId: id, expiresAt: new Date(now.getTime() + 5 * 60_000) } },
      { upsert: true, returnDocument: "after" },
    ).lean().exec();
    if (acquired?.reservationId === id) {
      return { success: true, reservation: { key, id, cooldownMs } };
    }
  } catch (error) {
    // 未过期条目的唯一 _id 与 upsert 冲突即表示另一个请求已经占位；数据库故障由调用方处理。
    if ((error as { code?: number })?.code !== 11000) throw error;
  }
  const existing = await AuthEmailCooldownModel.findById(key).lean().exec();
  const retryAfterSeconds = Math.max(1, Math.ceil(((existing?.expiresAt?.getTime() ?? Date.now() + 60_000) - Date.now()) / 1000));
  return { success: false, retryAfterSeconds };
}

export async function completeAuthEmail(reservation: AuthEmailReservation): Promise<void> {
  try {
    await AuthEmailCooldownModel.updateOne(
      { _id: reservation.key, reservationId: reservation.id },
      { $set: { expiresAt: new Date(Date.now() + reservation.cooldownMs) } },
    ).exec();
  } catch (error) {
    // 邮件已投递；保留租约，不能将记账故障变成“发送失败”诱导用户重复发送。
    logger.warn("[AuthEmail] 完成冷却记录失败，保留发送租约", { error });
  }
}

export async function releaseAuthEmail(reservation: AuthEmailReservation): Promise<void> {
  try {
    await AuthEmailCooldownModel.deleteOne({ _id: reservation.key, reservationId: reservation.id }).exec();
  } catch (error) {
    logger.warn("[AuthEmail] 释放失败发送的冷却记录失败", { error });
  }
}
