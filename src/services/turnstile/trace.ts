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

  try {
    if (mongoose.connection.readyState !== 1) {
      await connectMongo();
    }
    const TraceModel = getTraceModel();

    const result = await TraceModel.updateOne(
      { traceId },
      {
        $set: {
          ...traceData,
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
        await TraceModel.updateOne(
          { traceId },
          {
            ...traceData,
            verificationMethod: traceData.verificationMethod || "turnstile",
            time: new Date(),
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
