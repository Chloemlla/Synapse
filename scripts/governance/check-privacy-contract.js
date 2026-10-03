#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const mapPath = path.join(root, "docs", "governance", "privacy-data-map.json");
const requiredDatasetKeys = ["id", "collection", "fields", "purpose", "legalBasis", "retention", "delete", "export", "evidence"];
// 面向用户的那一面：隐私政策页面直接渲染这些字段（见 scripts/generate-privacy-data-map.js），
// 缺一个都会让页面上的说明出现窟窿，所以在这里也当硬要求。
const requiredUserFacingKeys = ["label", "category", "what", "why", "retention", "policySection"];
const knownCategories = new Set([
  "账户与身份",
  "安全与风控",
  "服务与业务",
  "合规与审计",
  "通信与集成",
  "客户端本地",
]);
const knownRetentionTypes = new Set([
  "account_lifetime",
  "ttl",
  "optional_ttl",
  "operational",
  "account_linked",
  "client_ttl",
]);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if (!fs.existsSync(mapPath)) {
  fail(`Missing privacy data map: ${path.relative(root, mapPath)}`);
  process.exit(1);
}

const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
if (!Array.isArray(map.datasets) || map.datasets.length === 0) {
  fail("privacy-data-map.json must define a non-empty datasets array");
}

const ids = new Set();
for (const dataset of map.datasets) {
  for (const key of requiredDatasetKeys) {
    if (!(key in dataset)) fail(`dataset ${dataset.id || "<unknown>"} is missing ${key}`);
  }

  if (ids.has(dataset.id)) fail(`duplicate dataset id: ${dataset.id}`);
  ids.add(dataset.id);

  if (!Array.isArray(dataset.fields) || dataset.fields.length === 0) {
    fail(`${dataset.id}: fields must be a non-empty array`);
  }
  if (!Array.isArray(dataset.evidence) || dataset.evidence.length === 0) {
    fail(`${dataset.id}: evidence must be a non-empty array`);
  }
  if (!dataset.retention || !knownRetentionTypes.has(dataset.retention.type)) {
    fail(`${dataset.id}: unsupported retention.type ${dataset.retention && dataset.retention.type}`);
  }
  if (dataset.retention.type === "ttl") {
    if (typeof dataset.retention.expireAfterSeconds !== "number") {
      fail(`${dataset.id}: ttl retention requires expireAfterSeconds`);
    }
    if (!dataset.retention.ttlField) fail(`${dataset.id}: ttl retention requires ttlField`);
  }

  for (const evidence of dataset.evidence) {
    const absolute = path.join(root, evidence);
    if (!fs.existsSync(absolute)) fail(`${dataset.id}: missing evidence file ${evidence}`);
  }

  const userFacing = dataset.userFacing;
  if (!userFacing || typeof userFacing !== "object") {
    fail(`${dataset.id}: missing userFacing block (the privacy policy page renders it)`);
  } else {
    for (const key of requiredUserFacingKeys) {
      if (typeof userFacing[key] !== "string" || !userFacing[key].trim()) {
        fail(`${dataset.id}: userFacing.${key} must be a non-empty string`);
      }
    }
    if (!knownCategories.has(userFacing.category)) {
      fail(`${dataset.id}: userFacing.category ${userFacing.category} is not in the known category set`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(String(userFacing.policySection))) {
      fail(`${dataset.id}: userFacing.policySection must look like a policy section id`);
    }
  }
}

const requiredIds = [
  "user-fingerprints",
  "temp-fingerprints",
  "access-tokens",
  "ip-verification-tokens",
  "ip-bans",
  "policy-consents",
  "tts-jobs",
  "audit-logs",
  "data-collections",
  "device-tracking",
  "ipqs-lookup-logs",
  "browser-local-fingerprint-cache",
];
for (const id of requiredIds) {
  if (!ids.has(id)) fail(`required privacy dataset missing: ${id}`);
}

const gapCount = map.datasets.filter((dataset) => {
  const values = [dataset.delete?.onUserDelete, dataset.delete?.current, dataset.delete?.gap, dataset.retention?.description]
    .filter(Boolean)
    .join(" ");
  return /gap/i.test(values);
}).length;

if (process.exitCode) {
  console.error("Privacy contract check failed.");
  process.exit(process.exitCode);
}

console.log(`Privacy contract check passed for ${map.datasets.length} datasets (${gapCount} acknowledged gap(s)).`);
