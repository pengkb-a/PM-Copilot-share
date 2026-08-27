#!/usr/bin/env node
// 交付校验：检查分享包是否干净、可分享
// 用法: node scripts/build_share.mjs

import { scan } from "./replace_check.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const findings = await scan(ROOT);

if (findings.length > 0) {
  console.error(`❌ 校验未通过，共 ${findings.length} 处待改：`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.type}]  ${f.text}`);
  }
  process.exit(1);
}

console.log("✅ 分享包校验通过：无敏感值、无业务词残留、无未填占位符");
console.log("   打包发送：将 PM-Copilot-share 目录压缩为 zip 即可。");