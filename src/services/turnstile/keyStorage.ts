import { createHash } from "node:crypto";
import logger from "../../utils/logger";
import { isConnected, mongoose } from "../mongoService";

function keyId(key: string) {
  return new mongoose.Types.ObjectId(createHash("sha256").update(`captcha-key:${key}`).digest("hex").slice(0, 24));
}

/** The built-in _id index serializes new writes without a risky unique-index migration. */
export async function writeCaptchaKey(model: mongoose.Model<any>, key: string, value: string): Promise<void> {
  const filter = { _id: keyId(key) };
  const patch = { $set: { key, value, updatedAt: new Date() } };
  try {
    await model.updateOne(filter, patch, { upsert: true }).exec();
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    await model.updateOne(filter, patch).exec();
  }
}

const lastSources = new Map<string, string>();

export async function readCaptchaKey(model: mongoose.Model<any>, key: string): Promise<string | null> {
  let value: string | null = null;
  let databaseState = isConnected() ? "available" : "unavailable";
  if (databaseState === "available") {
    try {
      // Preserve existing installations: until a key is saved, use the newest legacy row.
      const canonical = await model.findOne({ _id: keyId(key) }).lean().exec();
      const doc = canonical ?? await model.findOne({ key }).sort({ updatedAt: -1, _id: -1 }).lean().exec();
      if (typeof doc?.value === "string" && doc.value.trim()) value = doc.value.trim();
      else databaseState = doc ? "empty" : "missing";
    } catch {
      databaseState = "error";
    }
  }
  const source = value ? "mongo" : process.env[key]?.trim() ? "env" : "missing";
  value ??= process.env[key]?.trim() || null;
  const state = `${source}:${databaseState}`;
  if (lastSources.get(key) !== state) {
    lastSources.set(key, state);
    // Key names and source states are diagnostic; credential values never enter logs.
    logger.info("[Captcha] Configuration source changed", { keyName: key, source, databaseState });
  }
  return value;
}
