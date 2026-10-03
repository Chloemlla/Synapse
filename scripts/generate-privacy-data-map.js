#!/usr/bin/env node

// 隐私数据地图 → TypeScript 模块生成器。
//
// 为什么需要它：`docs/governance/privacy-data-map.json` 是隐私治理的**机器可读契约**
// （被 `check:privacy-contract` 校验），而隐私政策页面要「清楚地说明我们收集什么、为什么收集、
// 保存多久」。两边各自手写就会漂移 —— 契约里写着 60 天、页面上写着 90 天，正是这类文档最
// 常见的失效方式。这里把契约里的 `userFacing` 块生成为 TypeScript 常量，页面只渲染它：
//   数据地图改 → 重新生成 → 页面内容随之改变，**没有第二处可写**。
// 与 `generate-admin-spa-paths.js` 同样的套路：`--check` 模式供 CI 判漂移（漏重新生成就失败）。
//
// 生成物刻意只带「页面要用的字段」：不含 collection（内部集合名）与 evidence（仓库路径），
// 于是公开的政策接口天然不会泄漏内部实现细节。
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mapPath = path.join(root, "docs", "governance", "privacy-data-map.json");
const outputPath = path.join(root, "src", "generated", "privacyDataMap.ts");

// 展示分组顺序：页面按这个顺序分块渲染，新增类别必须同时改这里（否则构建失败而不是静默排到末尾）。
const CATEGORY_ORDER = [
  "账户与身份",
  "安全与风控",
  "服务与业务",
  "合规与审计",
  "通信与集成",
  "客户端本地",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function escapeTs(value) {
  return JSON.stringify(value);
}

function readMap() {
  if (!fs.existsSync(mapPath)) fail(`找不到隐私数据地图：${path.relative(root, mapPath)}`);
  try {
    return JSON.parse(fs.readFileSync(mapPath, "utf8"));
  } catch (error) {
    fail(`隐私数据地图不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeDataset(dataset) {
  const id = typeof dataset?.id === "string" ? dataset.id.trim() : "";
  if (!id) fail("存在缺少 id 的数据集");
  const uf = dataset?.userFacing;
  if (!uf || typeof uf !== "object") fail(`${id}: 缺少 userFacing（政策页面靠它渲染，不允许缺）`);
  for (const key of ["label", "category", "what", "why", "retention", "policySection"]) {
    if (typeof uf[key] !== "string" || !uf[key].trim()) fail(`${id}: userFacing.${key} 必须是非空字符串`);
  }
  if (!CATEGORY_ORDER.includes(uf.category)) {
    fail(`${id}: userFacing.category「${uf.category}」不在允许集合 ${CATEGORY_ORDER.join(" / ")} 内`);
  }
  const retentionType = typeof dataset?.retention?.type === "string" ? dataset.retention.type : "";
  const exportSupported = dataset?.export?.supported;
  return {
    id,
    label: uf.label.trim(),
    category: uf.category,
    what: uf.what.trim(),
    why: uf.why.trim(),
    retention: uf.retention.trim(),
    policySection: uf.policySection.trim(),
    retentionType,
    // partial 也要让页面能区分「可导出（部分）」，所以保留三态而不是布尔。
    exportable: exportSupported === true ? "full" : exportSupported === "partial" ? "partial" : "none",
    // 账户删除时的处置：delete.onUserDelete 是契约里的机器字段，页面据此提示「删除账户会不会一并删掉」。
    deleteOnUserDelete: typeof dataset?.delete?.onUserDelete === "string" ? dataset.delete.onUserDelete : "unknown",
  };
}

function renderGeneratedFile({ version, updatedAt, datasets }) {
  const byCategory = CATEGORY_ORDER.map((category) => ({
    category,
    ids: datasets.filter((dataset) => dataset.category === category).map((dataset) => dataset.id),
  })).filter((group) => group.ids.length > 0);

  const renderEntry = (dataset) =>
    [
      "  {",
      `    id: ${escapeTs(dataset.id)},`,
      `    label: ${escapeTs(dataset.label)},`,
      `    category: ${escapeTs(dataset.category)},`,
      `    what: ${escapeTs(dataset.what)},`,
      `    why: ${escapeTs(dataset.why)},`,
      `    retention: ${escapeTs(dataset.retention)},`,
      `    policySection: ${escapeTs(dataset.policySection)},`,
      `    retentionType: ${escapeTs(dataset.retentionType)},`,
      `    exportable: ${escapeTs(dataset.exportable)},`,
      `    deleteOnUserDelete: ${escapeTs(dataset.deleteOnUserDelete)},`,
      "  },",
    ].join("\n");

  return `/**
 * 本文件由 \`pnpm run generate:privacy-data-map\` 生成，请勿手工编辑。
 *
 * 数据源：docs/governance/privacy-data-map.json（隐私治理的机器可读契约，由 check:privacy-contract 校验）
 * 用途：隐私政策页面逐项说明「收集什么 / 为什么收集 / 保存多久 / 能否导出与删除」。
 * 页面只渲染本文件，因此条文与契约不可能各写一份：改契约 → 重新生成 → 页面内容随之变化。
 * 生成物刻意不含 collection 与 evidence，避免公开接口泄漏内部集合名与仓库路径。
 */

export interface PrivacyDataMapDataset {
  id: string;
  label: string;
  category: string;
  /** 具体收集到的信息类别（面向用户的措辞） */
  what: string;
  /** 为什么要这些信息（用途） */
  why: string;
  /** 保存期限（面向用户的一句话） */
  retention: string;
  /** 解释该数据集规则的条文章节 id（前端渲染为「详见第 N 章」） */
  policySection: string;
  retentionType: string;
  exportable: "full" | "partial" | "none";
  deleteOnUserDelete: string;
}

export const PRIVACY_DATA_MAP_VERSION = ${version};
export const PRIVACY_DATA_MAP_UPDATED_AT = ${escapeTs(updatedAt)};
export const PRIVACY_DATA_CATEGORY_ORDER = [
${CATEGORY_ORDER.map((category) => `  ${escapeTs(category)},`).join("\n")}
] as const;

export const PRIVACY_DATASETS: readonly PrivacyDataMapDataset[] = [
${datasets.map(renderEntry).join("\n")}
];

/** 类别 → 数据集 id，供页面分组渲染（顺序与 PRIVACY_DATA_CATEGORY_ORDER 一致）。 */
export const PRIVACY_DATASET_IDS_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = {
${byCategory.map((group) => `  ${escapeTs(group.category)}: [${group.ids.map(escapeTs).join(", ")}],`).join("\n")}
};
`;
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const map = readMap();
  if (!Array.isArray(map.datasets) || map.datasets.length === 0) fail("隐私数据地图必须定义非空 datasets");

  const datasets = map.datasets.map(normalizeDataset);
  const ids = new Set();
  for (const dataset of datasets) {
    if (ids.has(dataset.id)) fail(`重复的数据集 id：${dataset.id}`);
    ids.add(dataset.id);
  }
  // 章节 id 的健全性：政策文档必须存在对应章节，否则页面的「详见」链接会指空。
  for (const dataset of datasets) {
    if (!/^[a-z][a-z0-9-]*$/.test(dataset.policySection)) {
      fail(`${dataset.id}: policySection「${dataset.policySection}」不是合法的章节 id`);
    }
  }

  const expected = renderGeneratedFile({
    version: typeof map.version === "number" ? map.version : 1,
    updatedAt: typeof map.updatedAt === "string" ? map.updatedAt : "",
    datasets,
  });
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : null;
  const summary = `${datasets.length} 个数据集 / ${CATEGORY_ORDER.filter((c) => datasets.some((d) => d.category === c)).length} 个类别`;

  if (current === expected) {
    console.log(`隐私数据地图生成物已同步（${summary}）。`);
    return;
  }

  if (checkOnly) {
    console.error(
      [
        `${path.relative(root, outputPath).replace(/\\/g, "/")} 与 docs/governance/privacy-data-map.json 不一致。`,
        "请在本地运行：pnpm run generate:privacy-data-map",
        "（隐私政策页面直接渲染这份生成物，漂移会让页面说明与实际数据实践脱节）",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, expected, "utf8");
  console.log(`已生成 ${path.relative(root, outputPath).replace(/\\/g, "/")}（${summary}）。`);
}

main();
