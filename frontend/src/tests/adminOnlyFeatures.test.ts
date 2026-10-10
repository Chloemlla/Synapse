// 「仅管理员可用」的一批功能：前端必须对普通用户隐藏（导航 + 直链两道）。
//
// 为什么单独钉一条：这类隐藏很容易只改一侧（导航藏了但直链还能进），
// 而「后端也拒」由 src/tests/requireAdminOrAnonymous.test.ts 与 doc-tool 的 admin 守卫覆盖。
// 这里直接读源码文本断言，是因为导航与路由都是声明式配置，跑起来渲染反而更脆（依赖 auth store 与 lazy 路由）。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ADMIN_ONLY = [
  '/public-shortlink',
  '/vt-ratios',
  '/markdown-export',
  '/doc-convert',
  '/github-billing',
  '/campus-emergency',
];

const readSource = (...segments: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');

describe('仅管理员功能的前端入口', () => {
  it('导航条目都标了 requiredRole: admin（普通用户看不到入口）', () => {
    const source = readSource('navigation', 'navConfig.ts');
    for (const url of ADMIN_ONLY) {
      const index = source.indexOf(`url: '${url}'`);
      expect(index, `${url} 应该在 navConfig 里`).toBeGreaterThan(-1);
      // 从该条目往后取一段（到下一个 url 条目为止）必须含 requiredRole: 'admin'
      const nextUrl = source.indexOf('url: ', index + 1);
      const block = source.slice(index, nextUrl === -1 ? index + 300 : nextUrl);
      expect(block, `${url} 的导航条目应带 requiredRole: 'admin'`).toContain("requiredRole: 'admin'");
    }
  });

  it('路由都用 renderAdminRoute（直链也进不去）', () => {
    const source = readSource('App.tsx');
    for (const route of ADMIN_ONLY) {
      const line = source.split('\n').find((item) => item.includes(`<Route path="${route}"`));
      expect(line, `${route} 应该在 App.tsx 里`).toBeTruthy();
      expect(line, `${route} 应该用 renderAdminRoute 而不是 renderAnimatedRoute/renderProtectedRoute`).toContain(
        'renderAdminRoute(',
      );
    }
  });
});
