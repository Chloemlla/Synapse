import { useEffect, useRef } from 'react';

/**
 * `?focus=<userId>` 深链：从账户风险页 / 通知里跳进用户管理时，直接打开该用户的编辑表单。
 *
 * 为什么做成 hook 而不是页面内联：`UserManagement.tsx` 已顶到 1500 行的文件体积闸门，
 * 而这套逻辑是纯副作用（读 URL → 在列表里找人 → 打开表单或先按 ID 过滤），
 * 抽出来既不改变行为，也让页面本身少一段状态机。
 *
 * 行为约定：
 *   1. 同一个 focus 只处理一次（`handledRef`），避免每次列表刷新都重开表单；
 *   2. 用户不在当前页时不静默失败 —— 退化成「按 ID 关键词筛选」，
 *      并且只在筛选值尚未等于该 ID 时才写入（否则会和用户手动清筛选打架）。
 */
export function useUserFocusDeepLink<T extends { id: string }>(options: {
  focusId: string | null;
  users: T[];
  keyword: string;
  onOpenUser: (user: T) => void;
  onFilterById: (id: string) => void;
}): void {
  const { focusId, users, keyword, onOpenUser, onFilterById } = options;
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusId || handledRef.current === focusId) return;
    const target = users.find((item) => item.id === focusId);
    if (target) {
      handledRef.current = focusId;
      onOpenUser(target);
      return;
    }
    if (users.length > 0 && keyword !== focusId) {
      onFilterById(focusId);
    }
  }, [focusId, keyword, onFilterById, onOpenUser, users]);
}
