import { isMeaningfulLocation } from "./ipTelemetryService";

/**
 * 地域与出口风险的**唯一判据源**（RC-14 / RC-15 / RC-26 / RC-56）。
 *
 * 为什么要单独收一层：`isGeoJump` 原先长在 `mobileTokenRiskService` 里，只服务 `sml_` 令牌轮换；
 * web 登录、安全会话、账户风险聚合三处要么各自复刻、要么只能反向依赖「移动端令牌」这个语义上
 * 完全不相干的模块。判据一旦有了第二份实现，登录侧与移动端迟早会对同一个 IP 台账给出相反结论
 *（`accountRiskScoring` 的注释里已经记过同类事故风险）。
 *
 * 本文件保持**纯函数**：不读运行时配置、不碰 Mongo、不发网络请求。调用方把 scope /
 * 建议阈值作为参数传进来，阈值改配置不改公式（与 `accountRiskScoring` 同范式）。
 */

export type GeoJumpScope = "country" | "region";

export interface GeoLocationSegments {
  /** 国家/地区（属地字符串第一段）。 */
  country: string;
  /** 省/州（第二段）；取不到时为空串。 */
  region: string;
}

/**
 * 拆属地字符串（形如 `"中国, 北京, 北京 运营商: 中国联通"`）。
 *
 * 失败哨兵（"未知" / "未找到位置" / "获取位置时出错"）一律返回空段：
 * 宁可漏报，也不要拿「查不到」当「换了个国家」。
 */
export function parseGeoLocation(location: string | null | undefined): GeoLocationSegments {
  const raw = typeof location === "string" ? location.trim() : "";
  if (!raw || !isMeaningfulLocation(raw)) return { country: "", region: "" };
  const parts = raw.split(",").map((part) => part.trim());
  return { country: parts[0] || "", region: parts[1] || "" };
}

/**
 * 纯函数：两份属地字符串是否算「突变」。
 *
 * - `country`：国家/地区不同即算，省份缺失不影响判定；
 * - `region`：国家相同但省份可判且不同才算 —— 同一国家里 provider 少给一段不该算突变。
 *
 * 任一侧不是有意义的值就不判。
 */
export function isGeoJump(
  previous: string | null | undefined,
  current: string | null | undefined,
  scope: GeoJumpScope = "country",
): boolean {
  const before = parseGeoLocation(previous);
  const after = parseGeoLocation(current);
  if (!before.country || !after.country) return false;
  if (before.country !== after.country) return true;
  if (scope !== "region") return false;
  if (!before.region || !after.region) return false;
  return before.region !== after.region;
}

/** 判定机房/IDC 出口所需的最小事实集合（proxycheck 与 Scamalytics 两种来源都能映射进来）。 */
export interface DatacenterEgressFacts {
  /** proxycheck `detections.hosting`。 */
  hosting?: boolean;
  /** 归一化后的 flags（Scamalytics 的 `datacenter` 也会落在这里）。 */
  flags?: readonly string[] | null;
  /** proxycheck `networkType`（如 `hosting` / `business`）。 */
  networkType?: string | null;
}

const DATACENTER_NETWORK_PATTERN = /datacenter|data center|hosting|\bidc\b/i;

/**
 * 纯函数：这个出口是不是机房/IDC。
 *
 * 三路来源取并集，因为历史上已经存在两份实现：
 * `registrationRiskService.isDatacenterIp`（flags + networkType）与
 * `accountRiskService.isDatacenterResult`（额外看 `detections.hosting`）。
 * 两份各写一份的结果是「注册侧拒绝、登录侧却没看见」，所以在这里统一。
 *
 * **注意**：命中它本身不触发全站挑战（`ipRiskService.CHALLENGE_FLAGS` 刻意不含 hosting，
 * 避免误伤企业专线 / 云桌面）。强制力只放在 RC-14 的两个窄口子：注册无邀请码、
 * 已登录/API Key 路径的升档。
 */
export function isDatacenterEgress(facts: DatacenterEgressFacts | null | undefined): boolean {
  if (!facts) return false;
  if (facts.hosting === true) return true;
  if (Array.isArray(facts.flags) && facts.flags.some((flag) => flag === "datacenter")) return true;
  return DATACENTER_NETWORK_PATTERN.test(String(facts.networkType || ""));
}
