import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { loadEnvFile, getValidUserAccessToken } from "./feishu_doc.mjs";

// =============================================================================
// svg_to_board.mjs — 把一张 SVG 流程图作为「可编辑的原生画板」插入飞书文档
//
// 用法:
//   node svg_to_board.mjs <document_id> <svg_file> [insertAfterText]
//
//   - document_id     : 目标飞书文档 ID
//   - svg_file        : SVG 文件路径（用 rect/circle/line/polyline+marker-end/text 绘制）
//   - insertAfterText : 可选，插入到包含该文字的段落之后；省略则追加到文末
//
// 依赖: @larksuite/whiteboard-cli（通过 npx 自动下载，无需安装）
//        飞书授权需包含 scope: board:whiteboard:node:create board:whiteboard:node:read
// =============================================================================

const FEISHU = "https://open.feishu.cn/open-apis";

const docId = process.argv[2];
const svgPath = process.argv[3];
const insertAfterText = process.argv[4] || "";

if (!docId || !svgPath) {
  console.error("Usage: node svg_to_board.mjs <document_id> <svg_file> [insertAfterText]");
  process.exit(1);
}

const config = await loadEnvFile();
const token = await getValidUserAccessToken(config);
const AUTH = { Authorization: `Bearer ${token}` };
const JSONH = { ...AUTH, "Content-Type": "application/json; charset=utf-8" };

// ---- 1. SVG -> Feishu openapi node JSON (via whiteboard-cli) ----
function svgToNodes(svgFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["-y", "@larksuite/whiteboard-cli@^0.2.11", "-i", svgFile, "--to", "openapi", "--format", "json"],
      { cwd: process.cwd(), shell: true }
    );
    let out = Buffer.alloc(0);
    child.stdout.on("data", (c) => { out = Buffer.concat([out, c]); });
    child.stderr.on("data", () => {});
    child.on("close", () => {
      try {
        const text = out.toString("utf8");
        const parsed = JSON.parse(text.slice(text.indexOf("{")));
        resolve(parsed.data.result.nodes);
      } catch (e) {
        reject(new Error("whiteboard-cli output parse failed: " + e.message));
      }
    });
  });
}

// ---- helpers ----
async function listChildren() {
  let items = [], pt = "";
  do {
    const url = `${FEISHU}/docx/v1/documents/${docId}/blocks/${docId}/children?page_size=500${pt ? "&page_token=" + encodeURIComponent(pt) : ""}`;
    const r = await fetch(url, { headers: AUTH });
    const d = await r.json();
    items = items.concat(d.data?.items || []);
    pt = d.data?.has_more ? d.data.page_token : "";
  } while (pt);
  return items;
}

console.log("Converting SVG to Feishu board nodes...");
const nodes = await svgToNodes(svgPath);
console.log(`  ${nodes.length} nodes generated`);

// find insertion index
let insertIndex = -1;
if (insertAfterText) {
  const children = await listChildren();
  for (let i = 0; i < children.length; i++) {
    const els = (children[i].text || {}).elements || [];
    const txt = els.map((e) => e.text_run?.content || "").join("");
    if (txt.includes(insertAfterText)) { insertIndex = i + 1; break; }
  }
}
console.log(`  Insert index: ${insertIndex === -1 ? "end" : insertIndex}`);

// ---- 2. create board block ----
const cr = await fetch(`${FEISHU}/docx/v1/documents/${docId}/blocks/${docId}/children`, {
  method: "POST", headers: JSONH,
  body: JSON.stringify({
    children: [{ block_type: 43, board: { align: 1, width: 700 } }],
    index: insertIndex,
  }),
});
const cd = await cr.json();
if (cd.code !== 0) { console.error("create board failed:", JSON.stringify(cd)); process.exit(1); }
const wbId = cd.data.children[0].board.token;
console.log("  Board created, whiteboard_id:", wbId);

// ---- 3. draw nodes ----
const nr = await fetch(`${FEISHU}/board/v1/whiteboards/${wbId}/nodes`, {
  method: "POST", headers: JSONH, body: JSON.stringify({ nodes }),
});
const nd = await nr.json();
if (nd.code === 0) {
  console.log(`✅ Editable flowchart inserted! (${nd.data.ids.length} nodes)`);
} else {
  console.error("nodes create failed:", JSON.stringify(nd).substring(0, 500));
  process.exit(1);
}
