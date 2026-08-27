#!/usr/bin/env node
// 待改造项扫描：检查分享包是否还有未定制 / 未清理项
// 用法: node scripts/replace_check.mjs [目标目录]  （默认分享包根目录）

import { readdir, readFile } from "node:fs/promises";
import { join, resolve, relative, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = resolve(dirname(dirname(fileURLToPath(import.meta.url))));
const EXT = new Set([".md", ".mjs", ".js", ".json", ".py"]);

const SENSITIVE = /ffc6bb0d|NYW3spif|bot\/v2\/hook|Invoke-RestMethod/;
const BIZ_WORDS = /他趣|业财系统|业财中台|业财领域|业财对接|业财业务|新海豹|趣币|贝壳|金蝶|薪福通|Payermax|TIMO/;
const PLACEHOLDER = /\{\{[^}]+\}\}/;

// 以下文件中的占位符属于「模板/示例」正常状态，不算待改造
function isExempt(relPath) {
  const p = relPath.replace(/\\/g, "/");
  return (
    p.startsWith("examples/") ||
    p.startsWith("scripts/") ||
    p.startsWith("docs/") ||
    p.endsWith(".env.example") ||
    p.includes("-template.md") ||
    p.endsWith(".example.json")
  );
}

async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (EXT.has(extname(entry.name))) files.push(full);
  }
  return files;
}

export async function scan(root = DEFAULT_ROOT) {
  const files = await walk(root);
  const findings = [];
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, "/");
    const content = await readFile(file, "utf8");
    content.split(/\r?\n/).forEach((line, i) => {
      if (isExempt(rel)) return;
      if (SENSITIVE.test(line))
        findings.push({ file: rel, line: i + 1, type: "敏感值", text: line.trim() });
      if (BIZ_WORDS.test(line))
        findings.push({ file: rel, line: i + 1, type: "他趣业务词", text: line.trim() });
      if (!isExempt(rel) && PLACEHOLDER.test(line))
        findings.push({ file: rel, line: i + 1, type: "未填占位符", text: line.trim() });
    });
  }
  return findings;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const findings = await scan();
  if (findings.length === 0) {
    console.log("✅ 无待改造项");
  } else {
    console.log(`⚠️ 发现 ${findings.length} 处待改造项：`);
    for (const f of findings) {
      console.log(`  ${f.file}:${f.line}  [${f.type}]  ${f.text}`);
    }
    process.exitCode = 1;
  }
}