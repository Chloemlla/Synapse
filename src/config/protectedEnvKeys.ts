// G4-06 / G8-08: 密钥、密码、连接串与安全开关类的环境变量键，运行时不可改写。
// 写入侧（adminController 的 envs 接口）与重放侧（config/env.ts 读 data/env.admin.json）
// 必须共用这一份清单：只在写入侧拦、重放侧不拦，等于给一个可落盘的 JSON 文件留下
// 启动时改写生产 JWT_SECRET / MONGO_URI 的入口。
export const PROTECTED_ENV_KEYS: ReadonlySet<string> = new Set([
  "JWT_SECRET",
  "AES_KEY",
  "ADMIN_PASSWORD",
  "ADMIN_OPERATION_PASSWORD",
  "SERVER_PASSWORD",
  "PUBLIC_SHORT_URL_PASSWORD",
  "MONGO_URI",
  "MONGODB_URI",
  "REDIS_URL",
  "DATABASE_URL",
  "DB_URI",
  "NODE_ENV",
  "USER_STORAGE_MODE",
  "TURNSTILE_SECRET_KEY",
  "HCAPTCHA_SECRET_KEY",
  "CAP_SECRET_KEY",
  "RESEND_API_KEY",

  // R3-01（2026-10-03）：进程加载器 / 解释器 / shell 类环境变量。
  // 它们本身不是「密钥」，但会在**下一次启动**被 config/env.ts 的 applyAdminEnvOverlay
  // 重放回 process.env —— 等于把「改配置」变成「下次启动时执行代码」：
  // NODE_OPTIONS=--require /tmp/x.js、LD_PRELOAD=/abs/x.so、PYTHONSTARTUP、BASH_ENV 都是
  // 现成的注入面；PATH / NODE_EXTRA_CA_CERTS 则能分别改写子进程与 TLS 信任链。
  // 写侧已经拦了 NODE_ENV，却放行严格更强的 NODE_OPTIONS，属口径不一致；
  // 而这些键对本应用从来不是合法运行时配置，拦掉不损失任何能力。
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYLIB",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "PATH",
  "SHELL",
  "BASH_ENV",
  "ENV",
  "IFS",
  "HOME",
  "TMPDIR",
]);

// F-01（2026-09-27）：数据静态加密根密钥——它们直接解密已落库的密文。
// 不同于 webhook / 令牌类可轮换密钥（轮换是安全行为），一旦已有非空值又被静默改写，
// 存量密文就永久解不开（无重加密流程）= 静默数据损坏。
// 因此首次配置（当前为空）放行，但覆盖已有值必须携显式 confirmRotate（见 adminController.setEnv）。
export const DATA_AT_REST_ENCRYPTION_KEYS: ReadonlySet<string> = new Set([
  "PASSWORD_ENCRYPTION_KEY",
  "BILIBILI_COOKIE_ENCRYPTION_KEY",
  "DATA_COLLECTION_RAW_SECRET",
]);

/** 是否为「覆盖即可能静默损坏存量密文」的数据静态加密根密钥。 */
export function isDataAtRestEncryptionKey(key: string): boolean {
  return DATA_AT_REST_ENCRYPTION_KEYS.has(key.trim().toUpperCase());
}
