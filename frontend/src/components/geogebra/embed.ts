// GeoGebra 分享链接与 embed 链接（GEO-17）。
//
// 服务端 shareView 也会返回一个相对 embedUrl；这里做两件事：
//   1) 给「复制」按钮一个绝对地址（分享者通常要直接粘给别人）；
//   2) 在旧响应没有 embedUrl 时按同一口径本地推导，避免前端依赖某个后端版本的字段。
// `?embed=1` 由 App 的嵌入分支识别，隐藏站点导航与页脚（只读壳）。

export function geoGebraShareUrl(slug: string, origin: string = window.location.origin): string {
  return `${origin}/geogebra/share/${encodeURIComponent(slug)}`;
}

export function geoGebraShareEmbedUrl(slug: string, origin: string = window.location.origin): string {
  return `${geoGebraShareUrl(slug, origin)}?embed=1`;
}

export function resolveGeoGebraEmbedUrl(
  share: { slug: string; embedUrl?: string | null },
  origin: string = window.location.origin,
): string {
  const provided = typeof share.embedUrl === "string" ? share.embedUrl.trim() : "";
  if (provided) {
    try {
      return new URL(provided, origin).toString();
    } catch {
      // 后端给了不可解析的值时退回本地推导，不把坏链接复制给用户。
    }
  }
  return geoGebraShareEmbedUrl(share.slug, origin);
}
