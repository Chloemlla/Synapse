// GeoGebra 公开分享的 iframe 嵌入策略（GEO-17）。
//
// 背景：全站 helmet 的 frameguard 固定发 `X-Frame-Options: DENY`，CSP 固定
// `frame-ancestors 'none'`。这对普通页面是对的，但会让「复制嵌入」得到的
// `/geogebra/share/<slug>?embed=1` 一进 iframe 就被浏览器拦下——功能看起来有了，
// 实际不可用。
//
// 取舍：只为「分享嵌入壳」这一条路径放宽，且放宽的是**只读、无登录动作**的页面
// （嵌入模式隐藏复制/登录/fork，只保留画布与导出）。普通分享页与站点其它页面
// 仍然保持 DENY。默认值是 `*`，因为公开分享本身就是「持有链接即可看」；
// 需要收紧时用 GEOGEBRA_EMBED_FRAME_ANCESTORS 配成逗号分隔的来源白名单，
// 或设为空字符串彻底关闭嵌入（回到 DENY）。
const EMBED_PATH = /^\/geogebra\/share\/[A-Za-z0-9_-]{10,100}\/?$/;

function isValidFrameAncestorSource(value: string): boolean {
  if (value === "*") return true;
  if (value === "'self'") return true;
  try {
    const url = new URL(value);
    // 只接受裸来源（scheme://host[:port]），不接受路径/查询/凭据：
    // frame-ancestors 里带路径的写法各浏览器行为不一致，容易产生「配了却不生效」的错觉。
    return (url.protocol === "https:" || url.protocol === "http:")
      && url.pathname === "/"
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

/**
 * 解析当前请求是否命中「分享嵌入壳」。
 * 只看 pathname 与 query，不信任 Host；slug 形状与前端 embed helper 保持同一口径。
 */
export function isGeoGebraEmbedRequest(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url, "http://embed.invalid");
    if (!EMBED_PATH.test(parsed.pathname)) return false;
    return parsed.searchParams.get("embed") === "1";
  } catch {
    return false;
  }
}

/**
 * 读取配置的 frame-ancestors 来源；返回 `null` 表示「保持全站默认的 DENY」。
 * 未设置 → `*`；空字符串 → 关闭嵌入；全部非法 → 关闭嵌入（fail-closed）。
 */
export function resolveGeoGebraEmbedFrameAncestors(
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  const raw = env.GEOGEBRA_EMBED_FRAME_ANCESTORS;
  const value = raw === undefined ? "*" : raw.trim();
  if (!value) return null;
  const sources = [...new Set(
    value.split(",").map((item) => item.trim()).filter(Boolean).filter(isValidFrameAncestorSource),
  )];
  return sources.length > 0 ? sources : null;
}

/** 命中嵌入壳且策略允许时，返回应写入 CSP 的来源；否则返回 null（调用方维持 DENY）。 */
export function geoGebraEmbedFrameAncestorsForUrl(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  if (!isGeoGebraEmbedRequest(url)) return null;
  return resolveGeoGebraEmbedFrameAncestors(env);
}
