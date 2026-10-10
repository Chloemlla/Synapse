import fs from "node:fs";
import path from "node:path";
import { SerialAtomicJsonWriter } from "../librechat/atomicJsonWriter";

const DATA_DIR = path.join(process.cwd(), "data", "lottery");
const ROUNDS_FILE = path.join(DATA_DIR, "rounds.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");

const writer = new SerialAtomicJsonWriter();

/**
 * G7-41: sanitize identifiers the same way mongo.ts does — reject characters
 * that are dangerous as object keys / Mongo query operators. Without this, an
 * id like "__proto__" silently replaces the object prototype and the round data
 * is lost.
 */
function sanitizeString(str: any): string {
  if (typeof str !== "string") return "";
  if (/[$.{}[\]]/.test(str)) return "";
  return str;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file: string) {
  if (!fs.existsSync(file)) return {};
  // G7-41: a corrupt JSON file must NOT be silently treated as `{}` — that makes
  // every lottery round "disappear" and the next write makes the loss permanent.
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

export async function getAllRounds() {
  ensureDir();
  const rounds = readJson(ROUNDS_FILE);
  return Object.values(rounds);
}

export async function addRound(round: any) {
  ensureDir();
  const safeId = sanitizeString(round.id);
  if (!safeId) throw new Error("轮次ID非法");
  const rounds = readJson(ROUNDS_FILE);
  if (rounds[safeId]) throw new Error("轮次已存在");
  rounds[safeId] = round;
  await writer.write(ROUNDS_FILE, rounds);
  return round;
}

export async function updateRound(id: string, data: any) {
  ensureDir();
  const safeId = sanitizeString(id);
  if (!safeId) throw new Error("轮次ID非法");
  const rounds = readJson(ROUNDS_FILE);
  if (!rounds[safeId]) throw new Error("未找到轮次");
  rounds[safeId] = { ...rounds[safeId], ...data };
  await writer.write(ROUNDS_FILE, rounds);
  return rounds[safeId];
}

export async function deleteAllRounds() {
  ensureDir();
  await writer.write(ROUNDS_FILE, {});
}

/** 清空用户记录：与 deleteAllRounds 配套，避免轮次删光后仍能查到旧的中奖历史。 */
export async function deleteAllUserRecords() {
  ensureDir();
  await writer.write(USERS_FILE, {});
}

/** 批量读取：一次读文件取代逐用户读文件。 */
export async function getUserRecordsByIds(userIds: string[]) {
  ensureDir();
  const users = readJson(USERS_FILE);
  return userIds.map((id) => users[sanitizeString(id)]).filter(Boolean);
}

export async function getUserRecord(userId: string) {
  ensureDir();
  const safeUserId = sanitizeString(userId);
  if (!safeUserId) return null;
  const users = readJson(USERS_FILE);
  return users[safeUserId] || null;
}

export async function updateUserRecord(userId: string, data: any) {
  ensureDir();
  const safeUserId = sanitizeString(userId);
  if (!safeUserId) throw new Error("用户ID非法");
  const users = readJson(USERS_FILE);
  users[safeUserId] = { ...(users[safeUserId] || {}), ...data };
  await writer.write(USERS_FILE, users);
  return users[safeUserId];
}
