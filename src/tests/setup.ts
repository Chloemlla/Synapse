import fs from "node:fs";
import path from "node:path";
import { stopRegisteredBackgroundTasks } from "../utils/backgroundTaskRegistry";

process.env.NODE_ENV = "test";

const setDefaultEnv = (name: string, value: string): void => {
  if (!process.env[name]) {
    process.env[name] = value;
  }
};

setDefaultEnv("MONGO_URI", "mongodb://127.0.0.1:27017/tts-test");
setDefaultEnv("USER_STORAGE_MODE", "mongo");
setDefaultEnv("SERVER_PASSWORD", "test-password");
setDefaultEnv("OPENAI_API_KEY", "test-openai-key");
setDefaultEnv("OPENAI_KEY", "test-openai-key");
setDefaultEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
setDefaultEnv("JWT_SECRET", "test-jwt-secret");
setDefaultEnv("SIGN_SECRET_KEY", "test-sign-secret-key");
// 单一主密钥：keyDerivation 以 AES_KEY 为 IKM 源；测试固定一个默认值保证派生确定。
setDefaultEnv("AES_KEY", "test-aes-master-key-0123456789abcdef0123456789abcdef");
setDefaultEnv("ADMIN_USERNAME", "admin");
setDefaultEnv("ADMIN_PASSWORD", "admin123");
// SYN-01: adminOperationPassword 的 test 后门已移除。测试用例读 TEST_ADMIN_PASSWORD 作为管理
// 操作口令，这里将其对齐到 config.adminOperationPassword 的实际取值（= ADMIN_OPERATION_PASSWORD
// || ADMIN_PASSWORD = "admin123"），使其走 isAdminOperationPasswordValid 的真校验分支。
setDefaultEnv("TEST_ADMIN_PASSWORD", "admin123");
setDefaultEnv("SMART_HUMAN_CHECK_SECRET", "test-smart-human-check-secret");

const testDirectories = [
  "test-data",
  "test-data/logs",
  "test-data/sharelogs",
  "test-data/audio",
  "logs",
  "finish",
  "data",
  "data/logs",
  "data/sharelogs",
  "data/archives",
];

for (const directory of testDirectories) {
  fs.mkdirSync(path.join(process.cwd(), directory), { recursive: true });
}

const usersFile = path.join(process.cwd(), "data", "users.json");
if (!fs.existsSync(usersFile)) {
  const now = new Date().toISOString();
  fs.writeFileSync(
    usersFile,
    JSON.stringify(
      [
        {
          id: "1",
          username: "admin",
          email: "admin@example.com",
          password: "admin123",
          role: "admin",
          dailyUsage: 0,
          lastUsageDate: now,
          createdAt: now,
        },
        {
          id: "2",
          username: "testuser",
          email: "test@example.com",
          password: "TestPass123!",
          role: "user",
          dailyUsage: 0,
          lastUsageDate: now,
          createdAt: now,
        },
      ],
      null,
      2,
    ),
    "utf8",
  );
}

jest.setTimeout(30_000);

export const testConfig = {
  port: 3001,
  environment: "test",
  openaiApiKey: "test-api-key",
  openaiModel: "tts-1",
  openaiVoice: "alloy",
  openaiResponseFormat: "mp3",
  openaiSpeed: "1.0",
  audioDir: path.join(process.cwd(), "test-data/audio"),
  adminUsername: "admin",
  adminPassword: "admin123",
  jwtSecret: "test-jwt-secret",
  rateLimits: {
    tts: { windowMs: 60_000, max: 10 },
    auth: { windowMs: 300_000, max: 30 },
    api: { windowMs: 60_000, max: 100 },
  },
};

const cleanupTasks: Array<() => void | Promise<void>> = [];

export function addCleanupTask(task: () => void | Promise<void>): void {
  cleanupTasks.push(task);
}

afterAll(async () => {
  // 先停后台定时任务，再跑各套件的清理：定时器活过本测试文件的拆卸点时，
  // 它们回调里的 mongoose 惰性 require 会把 process.exitCode 悄悄置 1
  // （断言全绿但步骤 exit 1），必须在拆卸之前切断。
  stopRegisteredBackgroundTasks();
  for (const task of cleanupTasks.splice(0)) {
    await task();
  }
});
