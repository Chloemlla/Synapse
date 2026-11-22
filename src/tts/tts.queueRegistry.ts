import type { TtsQueue } from "./tts.queue";

/**
 * TTS 队列的进程内注册表（RC-30 管理端只读视图）。
 *
 * 为什么需要它：队列实例是 `TtsController` 的私有静态成员，管理端拿不到句柄；
 * 而占用信息（全局并发 / 每用户上限 / 正在处理 / 占用 Top N）又只能从实例上读。
 * 直接给队列加导出会鼓励别处也去取实例，所以这里只暴露**一个 getter**：
 * 谁注册谁负责，读取方只能拿它做只读展示。
 *
 * 约束：这里不改变队列行为。注册发生在控制器初始化时，未注册时读方得到 `null`
 * 并自己降级成「当前进程没有队列实例」，而不是抛错。
 */
let registered: TtsQueue | null = null;

/** 由 `TtsController` 在创建队列后调用（幂等：后到的实例覆盖先到的）。 */
export function registerTtsQueue(queue: TtsQueue): void {
  registered = queue;
}

/** 管理端只读视图用；未注册（例如只跑 HTTP 层测试）返回 null。 */
export function getRegisteredTtsQueue(): TtsQueue | null {
  return registered;
}

/** 仅供用例清理全局状态。 */
export function resetRegisteredTtsQueueForTests(): void {
  registered = null;
}
