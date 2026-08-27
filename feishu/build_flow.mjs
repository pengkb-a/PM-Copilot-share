import { loadEnvFile, getValidUserAccessToken } from "./feishu_doc.mjs";

const FEISHU = "https://open.feishu.cn/open-apis";
const docId = "TzbtdARJFoTGsBxmSpVcov6ynCe";
const config = await loadEnvFile();
const token = await getValidUserAccessToken(config);
const AUTH = { Authorization: `Bearer ${token}` };
const JSONH = { ...AUTH, "Content-Type": "application/json; charset=utf-8" };

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

// ---- 1. remove existing board/image blocks ----
let children = await listChildren();
const toDel = [];
children.forEach((b, idx) => { if (b.block_type === 43 || b.block_type === 27) toDel.push(idx); });
for (const idx of toDel.sort((a, b) => b - a)) {
  await fetch(`${FEISHU}/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`, {
    method: "DELETE", headers: JSONH, body: JSON.stringify({ start_index: idx, end_index: idx + 1 }),
  });
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`Removed ${toDel.length} old board/image blocks`);

// ---- 2. find insert index ----
children = await listChildren();
let insertIndex = children.length;
for (let i = 0; i < children.length; i++) {
  const els = (children[i].text || {}).elements || [];
  const txt = els.map((e) => e.text_run?.content || "").join("");
  if (txt.includes("变更后增加单点系统过滤条件")) { insertIndex = i + 1; break; }
}

// ---- 3. create board block ----
const cr = await fetch(`${FEISHU}/docx/v1/documents/${docId}/blocks/${docId}/children`, {
  method: "POST", headers: JSONH,
  body: JSON.stringify({ children: [{ block_type: 43, board: { align: 1, width: 680 } }], index: insertIndex }),
});
const cd = await cr.json();
const wbId = cd.data.children[0].board.token;
console.log("Board created:", wbId);

// ---- 4. layout (default colors: omit style so platform defaults apply) ----
// boxes
const boxes = {
  start:  { x: 260, y: 0,   w: 220, h: 64 },
  check:  { x: 230, y: 180, w: 280, h: 100 },
  yes:    { x: 60,  y: 420, w: 240, h: 80 },
  no:     { x: 440, y: 420, w: 240, h: 80 },
};
const cx = (b) => b.x + b.w / 2;         // center x
const topMid = (b) => ({ x: b.x + b.w / 2, y: b.y });
const botMid = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h });
// diamond connection points = 4 vertices
const dia = boxes.check;
const diaTop = { x: dia.x + dia.w / 2, y: dia.y };
const diaBot = { x: dia.x + dia.w / 2, y: dia.y + dia.h };
const diaLeft = { x: dia.x, y: dia.y + dia.h / 2 };
const diaRight = { x: dia.x + dia.w, y: dia.y + dia.h / 2 };

const shapeNodes = [
  { id: "start", type: "composite_shape", composite_shape: { type: "round_rect" }, x: boxes.start.x, y: boxes.start.y, width: boxes.start.w, height: boxes.start.h, text: { text: "飞书通讯录" } },
  { id: "check", type: "composite_shape", composite_shape: { type: "diamond" }, x: boxes.check.x, y: boxes.check.y, width: boxes.check.w, height: boxes.check.h, text: { text: "单点系统是否存在该用户?" } },
  { id: "yes", type: "composite_shape", composite_shape: { type: "round_rect" }, x: boxes.yes.x, y: boxes.yes.y, width: boxes.yes.w, height: boxes.yes.h, text: { text: "同步到海豹工作台人员数据清单" } },
  { id: "no", type: "composite_shape", composite_shape: { type: "round_rect" }, x: boxes.no.x, y: boxes.no.y, width: boxes.no.w, height: boxes.no.h, text: { text: "不同步不展示" } },
];

const connStyle = { border_opacity: 100, border_width: "narrow", border_color: "#1f2329", border_color_type: 1, border_style: "solid" };
// position-based connector. start/end positions are ABSOLUTE; turning_points are RELATIVE to the connector's (x,y) origin (= bounding-box min corner). This relative-turning-point detail is critical — absolute turning points render off-canvas.
function mkConnector(id, s, e, shape = "straight", turningAbs = []) {
  const xs = [s.x, e.x, ...turningAbs.map((t) => t.x)];
  const ys = [s.y, e.y, ...turningAbs.map((t) => t.y)];
  const ox = Math.min(...xs), oy = Math.min(...ys);
  return {
    id, type: "connector",
    x: ox, y: oy, width: Math.max(...xs) - ox, height: Math.max(...ys) - oy,
    style: connStyle,
    connector: {
      start: { position: { x: s.x, y: s.y }, arrow_style: "none" },
      end: { position: { x: e.x, y: e.y }, arrow_style: "line_arrow" },
      shape,
      turning_points: turningAbs.map((t) => ({ x: t.x - ox, y: t.y - oy })),
      caption_auto_direction: false,
      specified_coordinate: true,
    },
  };
}

async function createNodes(nodes) {
  const r = await fetch(`${FEISHU}/board/v1/whiteboards/${wbId}/nodes`, {
    method: "POST", headers: JSONH, body: JSON.stringify({ nodes }),
  });
  return r.json();
}

// 1) create shapes
const r1 = await createNodes(shapeNodes);
if (r1.code !== 0) { console.error("shapes FAIL:", JSON.stringify(r1)); process.exit(1); }
console.log("shapes OK:", JSON.stringify(r1.data.ids));

// 2) position-based orthogonal connectors (split-bus layout)
const yesTop = topMid(boxes.yes);
const noTop = topMid(boxes.no);
const busY = Math.round((diaBot.y + boxes.yes.y) / 2); // horizontal split-bus height
const connNodes = [
  // 通讯录底部 -> 判断顶点（竖直）
  mkConnector("c1", botMid(boxes.start), diaTop),
  // 判断底部 -> 下到总线 -> 左 -> 下折进"是"框顶（直角）
  mkConnector("c2", diaBot, yesTop, "polyline", [{ x: diaBot.x, y: busY }, { x: yesTop.x, y: busY }]),
  // 判断底部 -> 下到总线 -> 右 -> 下折进"否"框顶（直角）
  mkConnector("c3", diaBot, noTop, "polyline", [{ x: diaBot.x, y: busY }, { x: noTop.x, y: busY }]),
];
const r2 = await createNodes(connNodes);
console.log("connectors:", r2.code === 0 ? "OK " + JSON.stringify(r2.data.ids) : "FAIL " + JSON.stringify(r2.error?.field_violations || r2));

// 3) yes/no labels on the vertical drop of each branch
const labelNodes = [
  { id: "lyes", type: "text_shape", x: yesTop.x - 44, y: (busY + boxes.yes.y) / 2 - 14, width: 32, height: 28, text: { text: "是" } },
  { id: "lno", type: "text_shape", x: noTop.x + 12, y: (busY + boxes.no.y) / 2 - 14, width: 32, height: 28, text: { text: "否" } },
];
const r3 = await createNodes(labelNodes);
console.log("labels:", r3.code === 0 ? "OK " + JSON.stringify(r3.data.ids) : JSON.stringify(r3).substring(0, 300));
