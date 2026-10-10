export const MAX_COMMAND_QUEUE_LENGTH = 200;

export function assertQueueCapacity(size: number): void {
  if (size >= MAX_COMMAND_QUEUE_LENGTH) {
    throw new Error(`队列已满（上限 ${MAX_COMMAND_QUEUE_LENGTH} 条），请先清空或移除部分命令`);
  }
}
