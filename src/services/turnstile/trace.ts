import crypto from "node:crypto";
import logger from "../../utils/logger";
import { connectMongo, mongoose } from "../mongoService";
import { getTraceModel } from "./models";

export function generateUniqueTraceId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = crypto.randomBytes(8).toString("hex");
  return `${timestamp}-${randomPart}`;
}

export async function persistTurnstileTrace(traceData: any): Promise<void> {
  // traceData 由多条验证路径拼装，可能夹带客户端可控字段。traceId 只接受字符串，
  // 否则对象（如 {"$gt": ""}）会被当成 Mongoose 过滤条件注入（NoSQL）。
  const traceId = traceData?.traceId;
  if (typeof traceId !== "string" || traceId.length === 0 || traceId.length > 128) {
    logger.warn("[Turnstile] 溯源信息缺少合法 traceId，已跳过持久化");
    return;
  }

  /**
   * 字段名净化（防更新注入）：
   *  - 以 `$` 开头的键在写入文档里会被当成**更新操作符**（如 traceData 里带一个 `$rename`
   *    就会真的去重命名字段）；
   *  - 含 `.` 的键会被当成**嵌套路径**（如写进 `a.b.c`），可以把数据写到预期之外的层级。
   * traceData 可能夹带客户端可控字段，因此两个写入分支都用净化后的结果，不直接展开原对象。
   * 值本身不改（仍由调用方拼装），这里只挡“键”。
   */
  const safeTraceFields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(traceData ?? {})) {
    if (field.startsWith("$") || field.includes(".")) continue;
    safeTraceFields[field] = value;
  }

  try {
    if (mongoose.connection.readyState !== 1) {
      await connectMongo();
    }
    const TraceModel = getTraceModel();

    const result = await TraceModel.updateOne(
      { traceId },
      {
        $set: {
          ...safeTraceFields,
          verificationMethod: traceData.verificationMethod || "turnstile",
          time: traceData.time || new Date(),
        },
      },
      { upsert: true },
    );
    if (result?.upsertedCount) {
      logger.info("[Turnstile] 创建新溯源信息", { traceId });
    } else {
      logger.info("[Turnstile] 更新现有溯源信息", { traceId });
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as any).code === 11000) {
      try {
        const TraceModel = getTraceModel();
        // codeql[js/sql-injection] 过滤值 traceId 已在函数入口收窄为 ≤128 的字符串；
        // 更新文档只由 safeTraceFields（已剔除 `$` 前缀与 `.` 路径）与两个字面量字段构成。
        await TraceModel.updateOne(
          { traceId },
          {
            $set: {
              ...safeTraceFields,
              verificationMethod: traceData.verificationMethod || "turnstile",
              time: new Date(),
            },
          },
        );
        logger.info("[Turnstile] 处理重复键，更新溯源信息", { traceId });
      } catch (updateError) {
        logger.warn("[Turnstile] 更新溯源信息失败", updateError);
      }
    } else {
      logger.warn("[Turnstile] 持久化溯源信息失败", error);
    }
  }
}
