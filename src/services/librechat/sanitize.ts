/**
 * 上游正文清洗(X3-03 的前置)。
 *
 * 从 `libreChatService.ts` 里抽出来是为了**打破循环引用**:一次性调用层(`invoke.ts`)
 * 需要它,而服务层又要用 `invoke.ts` —— 函数留在服务文件里就得形成 service ↔ helper 环。
 * 行为与抽取前逐条一致,不新增规则。
 */
export function sanitizeAssistantText(text: string): string {
  if (!text) return text;
  try {
    return (
      text
        // 移除完整的 <think ...>...</think> 段落（允许属性，跨行）
        .replace(/<think\b[^>]*>[\s\S]*?<\/?think>/gi, "")
        // 兜底：去掉可能残留的起止标签（含空白）
        .replace(/<\/?\s*think\b[^>]*>/gi, "")
        // 去除常见的可视化标记行
        .replace(/^\s*(已深度思考|深度思考|Deep\s*Thinking)\b.*$/gim, "")
        // 折叠多余空行
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    );
  } catch {
    return text;
  }
}
