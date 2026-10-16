/**
 * `@/lib/utils` 只是 `@/utils/cn` 的转发出口。
 *
 * 历史上这里有一份独立的 `cn`（clsx + tailwind-merge），与 `frontend/src/utils/cn.ts`
 * 并存：340+ 个文件用前者，`components/ui/*` 与 `layout/*` 用后者。
 * 两份实现一旦行为不同，同一套 studioTheme className 在 shell 内外表现就会不一致
 * （见 docs/audit/audit-2026-10-16-frontend-design-language.md FD-006）。
 * 现在只保留一份实现：新增代码请直接 `import { cn } from '../utils/cn'` 或 '../../utils/cn'。
 */
export { cn } from '../utils/cn';
export type { ClassValue } from 'clsx';
