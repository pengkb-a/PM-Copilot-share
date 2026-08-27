// 飞书机器人通知统一入口
// 用法: node notify.mjs "通知内容"
// 依赖 feishu/.env 中的 FEISHU_BOT_WEBHOOK；未配置时静默跳过，不影响主流程。

import { loadEnvFile, getDefaultEnvPath } from "./feishu_doc.mjs";

let config = {};
try {
  config = await loadEnvFile(getDefaultEnvPath());
} catch {
  // .env 不存在或不可读，视为未配置
}

const webhook = config.FEISHU_BOT_WEBHOOK;
const text = process.argv.slice(2).join(" ").trim();

if (!webhook) {
  console.log("📭 通知已跳过（未配置 FEISHU_BOT_WEBHOOK）");
  process.exit(0);
}

if (!text) {
  console.error('用法: node notify.mjs "通知内容"');
  process.exit(1);
}

try {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok || (typeof body.code === "number" && body.code !== 0)) {
    console.error("❌ 通知发送失败:", res.status, JSON.stringify(body));
    process.exit(1);
  }
  console.log("✅ 通知已发送");
} catch (err) {
  console.error("❌ 通知发送失败:", err.message);
  process.exit(1);
}