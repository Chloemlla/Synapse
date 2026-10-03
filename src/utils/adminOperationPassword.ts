import { config } from "../config/config";
import { RuntimeConfigService } from "../services/runtimeConfigService";
import { timingSafeStringEqual } from "./timingSafeCompare";

/**
 * 管理员操作口令校验。
 *
 * R3-06 之后有两处可能的存放位置，都要认：
 *  1. `config.adminOperationPassword` —— 环境变量 / 启动默认值（未在后台改过口令时）；
 *  2. 运行时配置里的 bcrypt 哈希（后台改过）或旧版遗留明文行。
 *
 * 顺序是「先默认值、后后台值」：默认值在环境里已是明文比对，成本最低；两边都不命中才判否。
 * 函数变成 async 是因为后台那份是 bcrypt（比对必须异步），调用方都已是 async 上下文。
 */
export async function isAdminOperationPasswordValid(candidate: unknown): Promise<boolean> {
  if (typeof candidate !== "string" || !candidate) {
    return false;
  }

  if (config.adminOperationPassword && timingSafeStringEqual(candidate, config.adminOperationPassword)) {
    return true;
  }

  // SYN-01: 移除 `NODE_ENV==="test"` 万能口令后门（同 commandService G7-39）。此前该分支在
  // TEST_ADMIN_PASSWORD 未设时接受硬编码 "admin"，一旦生产被误配 NODE_ENV=test 即形成万能口令。
  // 测试改为通过 config.adminOperationPassword（由 setup.ts 的 ADMIN_PASSWORD / TEST_ADMIN_PASSWORD
  // 提供）走上面这条真校验分支，不再需要单独的 test 兜底。
  return RuntimeConfigService.verifyAdminSecurityPassword("operationPassword", candidate);
}
