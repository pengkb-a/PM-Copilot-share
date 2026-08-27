/**
 * Flowchart -> Feishu native board (whiteboard) construction.
 *
 * Takes a structured flow (nodes + edges), lays it out in layers, and draws it
 * with the board API so connectors land exactly on shape connection points.
 *
 * Two details are load-bearing and easy to get wrong:
 *   - connector turning_points are RELATIVE to the connector's own (x, y)
 *     origin (its bounding-box top-left). Absolute points render off-canvas.
 *   - connector width/height must be non-negative, so x/y take the minimum of
 *     start, end and all turning points.
 *
 * The board API rejects binding fields (attached_object / snap_to) on create,
 * so shapes and lines are positioned by coordinate only. Visually identical,
 * but dragging a shape in the UI will not drag its lines along.
 */

import { feishuFetch, appendChildren, listChildren, sleep, RATE, blockText } from "./api.mjs";

/** Layout constants, all in board units. */
const L = {
  boxMinWidth: 170,
  boxMaxWidth: 320,
  boxPadding: 26,
  unitWidth: 11,
  lineHeight: 24,
  boxMinHeight: 64,
  diamondScale: 1.35,
  levelGap: 116,
  siblingGap: 56,
  boardWidth: 680,
};

const CONNECTOR_STYLE = {
  border_opacity: 100,
  border_width: "narrow",
  border_color: "#1f2329",
  border_color_type: 1,
  border_style: "solid",
};

const NODE_BATCH = 50;

/** Horizontal drift below which two shapes count as vertically stacked. */
const ALIGN_TOLERANCE = 4;

/** Invalid flow input, as opposed to an upstream API failure. */
export class FlowSpecError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "FlowSpecError";
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Rough display width: CJK glyphs occupy about twice an ASCII character. */
function textUnits(text) {
  let units = 0;
  for (const ch of String(text ?? "")) units += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return units;
}

function boxSize(text, shape) {
  const units = textUnits(text);
  const ideal = L.boxPadding + units * L.unitWidth;
  const width = Math.min(L.boxMaxWidth, Math.max(L.boxMinWidth, ideal));
  const usable = Math.max(1, width - L.boxPadding);
  const lines = Math.max(1, Math.ceil((units * L.unitWidth) / usable));
  let height = Math.max(L.boxMinHeight, 30 + lines * L.lineHeight);
  if (shape === "diamond") height = Math.round(height * L.diamondScale);
  return { width, height };
}

// Connection points. For a diamond these are its four vertices; for a rect the
// four edge midpoints. Both reduce to the same formulas on the bounding box.
const topMid = (b) => ({ x: b.x + b.width / 2, y: b.y });
const botMid = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height });

// ---------------------------------------------------------------------------
// Flow validation and layering
// ---------------------------------------------------------------------------

function validate(flow) {
  const nodes = flow?.nodes;
  const edges = flow?.edges ?? [];

  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new FlowSpecError("flow.nodes must be a non-empty array");
  }

  const ids = new Set();
  const duplicates = [];
  for (const node of nodes) {
    if (!node?.id) throw new FlowSpecError("every node needs an id");
    if (ids.has(node.id)) duplicates.push(node.id);
    ids.add(node.id);
  }
  if (duplicates.length) {
    throw new FlowSpecError("duplicate node ids", { duplicate_ids: duplicates });
  }

  const unknown = [];
  for (const edge of edges) {
    if (!ids.has(edge?.from)) unknown.push({ edge, missing: edge?.from });
    if (!ids.has(edge?.to)) unknown.push({ edge, missing: edge?.to });
  }
  if (unknown.length) {
    throw new FlowSpecError("edges reference unknown node ids", {
      invalid_references: unknown,
      known_ids: [...ids],
    });
  }

  return { nodes, edges };
}

/**
 * Longest-path layering. Nodes with no incoming edge sit at level 0; every
 * other node sits one level below its deepest predecessor. Iteration is capped
 * so a cyclic graph degrades to a usable layout instead of looping forever.
 */
function assignLevels(nodes, edges) {
  const level = new Map(nodes.map((n) => [n.id, 0]));
  const hasIncoming = new Set(edges.map((e) => e.to));

  for (const node of nodes) {
    if (!hasIncoming.has(node.id)) level.set(node.id, 0);
  }

  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      const candidate = level.get(edge.from) + 1;
      if (candidate > level.get(edge.to)) {
        level.set(edge.to, candidate);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return level;
}

/** Place every node on a grid: one row per level, centred horizontally. */
function layout(nodes, edges) {
  const level = assignLevels(nodes, edges);
  const outDegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const edge of edges) outDegree.set(edge.from, outDegree.get(edge.from) + 1);

  const rows = new Map();
  for (const node of nodes) {
    const lv = level.get(node.id);
    if (!rows.has(lv)) rows.set(lv, []);
    rows.get(lv).push(node);
  }

  const boxes = new Map();
  const rowWidths = [];
  const sortedLevels = [...rows.keys()].sort((a, b) => a - b);

  for (const lv of sortedLevels) {
    const row = rows.get(lv);
    let total = 0;
    for (const node of row) {
      const shape = node.shape ?? (outDegree.get(node.id) >= 2 ? "diamond" : "round_rect");
      const size = boxSize(node.text ?? node.id, shape);
      boxes.set(node.id, { ...size, shape, text: node.text ?? node.id });
      total += size.width;
    }
    rowWidths.push(total + L.siblingGap * (row.length - 1));
  }

  const canvasWidth = Math.max(...rowWidths);
  let y = 0;

  for (const lv of sortedLevels) {
    const row = rows.get(lv);
    const rowWidth = rowWidths[sortedLevels.indexOf(lv)];
    let x = Math.round((canvasWidth - rowWidth) / 2);
    let rowHeight = 0;

    for (const node of row) {
      const box = boxes.get(node.id);
      box.x = x;
      box.y = y;
      x += box.width + L.siblingGap;
      rowHeight = Math.max(rowHeight, box.height);
    }

    y += rowHeight + L.levelGap;
  }

  return boxes;
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

function shapeNode(id, box) {
  return {
    id,
    type: "composite_shape",
    composite_shape: { type: box.shape },
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    text: { text: box.text },
  };
}

/**
 * Connector positioned by coordinate. `turningAbs` takes absolute points and is
 * converted to the relative form the API expects.
 */
function connectorNode(id, start, end, shape, turningAbs = []) {
  const xs = [start.x, end.x, ...turningAbs.map((t) => t.x)];
  const ys = [start.y, end.y, ...turningAbs.map((t) => t.y)];
  const ox = Math.min(...xs);
  const oy = Math.min(...ys);

  return {
    id,
    type: "connector",
    x: ox,
    y: oy,
    width: Math.max(...xs) - ox,
    height: Math.max(...ys) - oy,
    style: CONNECTOR_STYLE,
    connector: {
      start: { position: { x: start.x, y: start.y }, arrow_style: "none" },
      end: { position: { x: end.x, y: end.y }, arrow_style: "line_arrow" },
      shape,
      turning_points: turningAbs.map((t) => ({ x: t.x - ox, y: t.y - oy })),
      caption_auto_direction: false,
      specified_coordinate: true,
    },
  };
}

/**
 * Build connectors and their labels.
 * Vertically aligned pairs get a straight line; everything else routes through
 * a horizontal bus halfway between the two rows, giving right-angled bends.
 */
function buildConnectors(edges, boxes) {
  const connectors = [];
  const labels = [];

  edges.forEach((edge, i) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    const start = botMid(from);
    const end = topMid(to);
    const aligned = Math.abs(start.x - end.x) < ALIGN_TOLERANCE;
    const busY = Math.round((start.y + end.y) / 2);

    // Odd box widths put the two centres a fraction apart, which renders as a
    // barely slanted line. Snap both ends to one x so the line is truly vertical.
    if (aligned) {
      const snapped = Math.round((start.x + end.x) / 2);
      start.x = snapped;
      end.x = snapped;
    }

    connectors.push(
      aligned
        ? connectorNode(`c${i}`, start, end, "straight")
        : connectorNode(`c${i}`, start, end, "polyline", [
            { x: start.x, y: busY },
            { x: end.x, y: busY },
          ])
    );

    if (edge.label) {
      const onLeft = end.x <= start.x;
      const width = Math.max(32, textUnits(edge.label) * 12);
      labels.push({
        id: `l${i}`,
        type: "text_shape",
        x: aligned ? end.x + 10 : onLeft ? end.x - width - 8 : end.x + 8,
        y: Math.round((busY + end.y) / 2) - 14,
        width,
        height: 28,
        text: { text: edge.label },
      });
    }
  });

  return { connectors, labels };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

async function createNodes(whiteboardId, token, nodes) {
  const ids = [];
  for (let i = 0; i < nodes.length; i += NODE_BATCH) {
    const data = await feishuFetch(`/board/v1/whiteboards/${whiteboardId}/nodes`, {
      token,
      method: "POST",
      body: { nodes: nodes.slice(i, i + NODE_BATCH) },
    });
    ids.push(...(data.data?.ids ?? []));
    if (i + NODE_BATCH < nodes.length) await sleep(RATE.betweenCells);
  }
  return ids;
}

/** Delete existing board (43) and image (27) blocks, back to front. */
async function removeExistingVisuals(docId, token) {
  const children = await listChildren(docId, docId, token);
  const indices = children
    .map((b, idx) => (b.block_type === 43 || b.block_type === 27 ? idx : -1))
    .filter((idx) => idx >= 0)
    .sort((a, b) => b - a);

  for (const idx of indices) {
    await feishuFetch(`/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`, {
      token,
      method: "DELETE",
      body: { start_index: idx, end_index: idx + 1 },
    });
    await sleep(RATE.betweenTableRows);
  }

  return indices.length;
}

/**
 * Insert a flowchart as an editable native board.
 * Returns counts plus any warnings (e.g. an anchor that did not match).
 */
export async function insertFlowchart(docId, token, flow, options = {}) {
  const { anchorText = "", replaceExisting = false } = options;

  const { nodes, edges } = validate(flow);
  const boxes = layout(nodes, edges);
  const warnings = [];

  const removed = replaceExisting ? await removeExistingVisuals(docId, token) : 0;

  let insertIndex = -1;
  if (anchorText) {
    const children = await listChildren(docId, docId, token);
    const hit = children.findIndex((b) => blockText(b).includes(anchorText));
    if (hit >= 0) insertIndex = hit + 1;
    else warnings.push(`anchor_text "${anchorText}" not found; board appended at the end`);
  }

  const created = await appendChildren(
    docId,
    docId,
    token,
    [{ block_type: 43, board: { align: 1, width: L.boardWidth } }],
    insertIndex
  );

  const boardBlock = created.data?.children?.[0];
  const whiteboardId = boardBlock?.board?.token;
  if (!whiteboardId) {
    throw new Error("board block created but no whiteboard token was returned");
  }

  // Shapes first: connectors reference their coordinates, so ordering matters
  // for the visual result even though the API does not bind them.
  const shapeIds = await createNodes(
    whiteboardId,
    token,
    nodes.map((n) => shapeNode(n.id, boxes.get(n.id)))
  );
  await sleep(RATE.betweenCells);

  const { connectors, labels } = buildConnectors(edges, boxes);

  let connectorIds = [];
  if (connectors.length) {
    connectorIds = await createNodes(whiteboardId, token, connectors);
    await sleep(RATE.betweenCells);
  }

  let labelIds = [];
  if (labels.length) {
    labelIds = await createNodes(whiteboardId, token, labels);
  }

  return {
    whiteboard_id: whiteboardId,
    block_id: boardBlock.block_id,
    insert_index: insertIndex === -1 ? "end" : insertIndex,
    shapes_created: shapeIds.length,
    connectors_created: connectorIds.length,
    labels_created: labelIds.length,
    blocks_removed: removed,
    warnings,
  };
}

// Exported for unit tests.
export const _internals = { validate, assignLevels, layout, buildConnectors, boxSize, textUnits };
