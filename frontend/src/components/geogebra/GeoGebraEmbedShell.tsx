import GeoGebraSharePage from "./GeoGebraSharePage";

// GeoGebra 只读嵌入壳（GEO-17）。
//
// 路由：/geogebra/share/:slug?embed=1（App.tsx 在该 query 存在时走独立分支，
// 不挂 DesktopShell / MobileNav / Footer）。壳本身只做两件事：
//   1) 用中性 slate 底色铺满 iframe 视口；
//   2) 复用完整的分享页渲染（只读模式），避免出现第二套画布实现。
// 分享链接已撤销 / 不存在时，分享页自己的错误态会在壳内呈现，不会泄漏到站点导航。
export default function GeoGebraEmbedShell() {
  return (
    <div className="min-h-screen w-full bg-white">
      <main className="mx-auto w-full max-w-none px-2 py-2 sm:px-4 sm:py-4">
        <GeoGebraSharePage embedded />
      </main>
    </div>
  );
}
