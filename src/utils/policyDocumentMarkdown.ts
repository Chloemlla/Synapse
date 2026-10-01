import type { PolicyDocument } from "../config/policyDocument";

/**
 * 条文 → Markdown 存档副本。
 *
 * 用户被告知「你同意的是哪份文本」时，最直接的证据是一份可离线保存的副本（见
 * docs/audit-2026-09-30-policy-system.md 第二阶段）。这里只做纯渲染：输入 POLICY_DOCUMENT，
 * 输出确定性字符串，因此可以直接被单测钉住，也不依赖任何请求上下文。
 *
 * 渲染范围与 `documentHash` 的哈希载荷一致（章节正文、勾选项文案与要点、重点提示），
 * 另附版本、生效日期、条文指纹与修订记录 —— 让存档既能逐字比对，也能指回哈希。
 */

export interface PolicyMarkdownOptions {
  /** 覆盖文件末尾的「生成时间」；默认取当前时间。测试里传固定值以保证输出确定。 */
  generatedAt?: Date;
}

const escapeCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const formatGeneratedAt = (value: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(
    value.getMinutes(),
  )}:${pad(value.getSeconds())} (UTC${-value.getTimezoneOffset() / 60 >= 0 ? "+" : ""}${
    -value.getTimezoneOffset() / 60
  })`;
};

const emphasisLabel = (emphasis: PolicyDocument["sections"][number]["emphasis"]): string => {
  if (emphasis === "critical") return "（重点条款）";
  if (emphasis === "notice") return "（请注意）";
  return "";
};

export function renderPolicyDocumentMarkdown(
  document: PolicyDocument,
  options: PolicyMarkdownOptions = {},
): string {
  const generatedAt = options.generatedAt ?? new Date();
  const lines: string[] = [];

  lines.push(`# ${document.title}`, "");
  lines.push(`> ${document.description}`, "");
  lines.push("| 项目 | 值 |", "| --- | --- |");
  lines.push(`| 版本 | v${escapeCell(document.version)} |`);
  lines.push(`| 条文指纹（sha256） | \`${document.documentHash}\` |`);
  lines.push(`| 生效日期 | ${document.effectiveDate} |`);
  lines.push(`| 最近修订 | ${document.lastUpdated} |`);
  lines.push(`| 同意有效期 | ${document.procedures.consentValidityDays} 天 |`);
  lines.push("");

  lines.push("## 阅读摘要", "");
  for (const highlight of document.highlights) {
    lines.push(`- **${highlight.title}**：${highlight.body}`);
  }
  lines.push("");

  lines.push("## 登录与注册须逐项同意的文件", "");
  document.agreements.forEach((agreement, index) => {
    lines.push(`### ${index + 1}. ${agreement.title}`, "");
    lines.push(`勾选项原文：**${agreement.label}**`, "");
    lines.push(agreement.summary, "");
    for (const point of agreement.points) {
      lines.push(`- ${point}`);
    }
    lines.push("");
    const sectionTitles = agreement.sectionIds
      .map((id) => document.sections.find((section) => section.id === id)?.title ?? id)
      .join("、");
    if (sectionTitles) lines.push(`相关章节：${sectionTitles}`, "");
  });

  lines.push("## 条文正文", "");
  document.sections.forEach((section, index) => {
    const number = String(index + 1).padStart(2, "0");
    lines.push(`### ${number}. ${section.title}${emphasisLabel(section.emphasis)}`, "");
    lines.push(`*${section.summary}*`, "");
    section.items.forEach((item, itemIndex) => {
      lines.push(`${number}.${itemIndex + 1} ${item}`, "");
    });
  });

  lines.push("## 重点风险提示", "");
  for (const warning of document.warnings) {
    lines.push(`- **${warning.title}**：${warning.body}`);
  }
  lines.push("");

  lines.push("## 历次修订", "");
  for (const revision of document.revisions) {
    lines.push(`### v${revision.version}（${revision.date}）`, "");
    for (const change of revision.changes) {
      lines.push(`- ${change}`);
    }
    lines.push("");
  }
  if (document.historyNote) lines.push(document.historyNote, "");

  lines.push("## 联系方式与程序化入口", "");
  for (const contact of document.contacts) {
    lines.push(`- **${contact.label}**：${contact.email} — ${contact.scope}`);
  }
  lines.push("");
  lines.push("| 用途 | 接口 |", "| --- | --- |");
  lines.push(`| 获取条文 | \`${document.procedures.documentEndpoint}\` |`);
  lines.push(`| 条文存档（本文件） | \`${document.procedures.documentArchiveEndpoint}\` |`);
  lines.push(`| 获取版本 | \`${document.procedures.versionEndpoint}\` |`);
  lines.push(`| 记录同意 | \`${document.procedures.recordConsentEndpoint}\` |`);
  lines.push(`| 查询状态 | \`${document.procedures.statusEndpoint}\` |`);
  lines.push(`| 同意轨迹 | \`${document.procedures.historyEndpoint}\` |`);
  lines.push(`| 查询同意 | \`${document.procedures.checkConsentEndpoint}\` |`);
  lines.push(`| 撤回同意 | \`${document.procedures.revokeConsentEndpoint}\` |`);
  lines.push("");

  lines.push("---", "");
  lines.push(`本存档由服务端按当前条文生成（生成时间：${formatGeneratedAt(generatedAt)}）。`);
  lines.push(
    `内容与 \`${document.procedures.documentEndpoint}\` 返回的 JSON 同源；条文指纹 \`${document.documentHash}\` 可与同意记录里的 documentHash 逐字核对。`,
  );
  lines.push("");

  return lines.join("\n");
}

/** 存档文件名：版本 + 指纹前 8 位，便于人工区分不同时期的副本。 */
export function policyArchiveFilename(document: PolicyDocument): string {
  return `synapse-policy-v${document.version}-${document.documentHash.slice(0, 8)}.md`;
}
