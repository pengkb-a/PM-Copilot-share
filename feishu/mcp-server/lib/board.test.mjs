import assert from "node:assert/strict";
import test from "node:test";

import { FlowSpecError, _internals } from "./board.mjs";

const { validate, assignLevels, layout, buildConnectors, textUnits } = _internals;

const simpleFlow = {
  nodes: [
    { id: "a", text: "开始" },
    { id: "b", text: "判断" },
    { id: "yes", text: "同步" },
    { id: "no", text: "跳过" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "yes", label: "是" },
    { from: "b", to: "no", label: "否" },
  ],
};

test("textUnits counts CJK as double width", () => {
  assert.equal(textUnits("ab"), 2);
  assert.equal(textUnits("中文"), 4);
  assert.equal(textUnits("a中"), 3);
});

test("validate rejects an empty node list", () => {
  assert.throws(() => validate({ nodes: [] }), FlowSpecError);
});

test("validate rejects duplicate node ids", () => {
  assert.throws(
    () => validate({ nodes: [{ id: "a" }, { id: "a" }], edges: [] }),
    (err) => err instanceof FlowSpecError && err.details.duplicate_ids.includes("a")
  );
});

test("validate rejects edges pointing at unknown nodes", () => {
  assert.throws(
    () => validate({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "ghost" }] }),
    (err) => err instanceof FlowSpecError && err.details.invalid_references.length === 1
  );
});

test("validate defaults edges to an empty list", () => {
  assert.deepEqual(validate({ nodes: [{ id: "a" }] }).edges, []);
});

test("levels follow the longest path from the roots", () => {
  const levels = assignLevels(simpleFlow.nodes, simpleFlow.edges);
  assert.equal(levels.get("a"), 0);
  assert.equal(levels.get("b"), 1);
  assert.equal(levels.get("yes"), 2);
  assert.equal(levels.get("no"), 2);
});

test("a diamond node keeps its branches on the same level", () => {
  const levels = assignLevels(
    [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    [
      { from: "a", to: "b" },
      { from: "b", to: "d" },
      { from: "a", to: "c" },
      { from: "c", to: "d" },
    ]
  );
  // d sits below its deepest predecessor, not its first one.
  assert.equal(levels.get("d"), 2);
});

test("a cycle terminates instead of looping forever", () => {
  const levels = assignLevels(
    [{ id: "a" }, { id: "b" }],
    [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ]
  );
  assert.equal(typeof levels.get("a"), "number");
  assert.equal(typeof levels.get("b"), "number");
});

test("a node with two outgoing edges becomes a diamond", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  assert.equal(boxes.get("b").shape, "diamond");
  assert.equal(boxes.get("a").shape, "round_rect");
});

test("an explicit shape overrides the automatic choice", () => {
  const boxes = layout(
    [{ id: "a", shape: "ellipse" }, { id: "x" }, { id: "y" }],
    [
      { from: "a", to: "x" },
      { from: "a", to: "y" },
    ]
  );
  assert.equal(boxes.get("a").shape, "ellipse");
});

test("each level sits strictly below the previous one", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  const a = boxes.get("a");
  const b = boxes.get("b");
  assert.ok(a.y + a.height < b.y, "level 1 must start below the bottom of level 0");
});

test("siblings on one level do not overlap", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  const yes = boxes.get("yes");
  const no = boxes.get("no");
  const [left, right] = yes.x <= no.x ? [yes, no] : [no, yes];
  assert.ok(left.x + left.width <= right.x, "sibling boxes must not overlap");
  assert.equal(left.y, right.y, "siblings share a row");
});

test("a single node lays out without edges", () => {
  const boxes = layout([{ id: "only", text: "单节点" }], []);
  const box = boxes.get("only");
  assert.equal(box.y, 0);
  assert.ok(box.width > 0 && box.height > 0);
});

test("a vertically aligned pair gets a straight connector", () => {
  const boxes = layout([{ id: "a" }, { id: "b" }], [{ from: "a", to: "b" }]);
  const { connectors } = buildConnectors([{ from: "a", to: "b" }], boxes);
  assert.equal(connectors[0].connector.shape, "straight");
  assert.deepEqual(connectors[0].connector.turning_points, []);
});

test("a branching pair gets a polyline routed through a bus", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  const { connectors } = buildConnectors(simpleFlow.edges, boxes);
  const branch = connectors[1];
  assert.equal(branch.connector.shape, "polyline");
  assert.equal(branch.connector.turning_points.length, 2);
});

test("turning points are relative to the connector origin", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  const { connectors } = buildConnectors(simpleFlow.edges, boxes);

  for (const c of connectors) {
    for (const point of c.connector.turning_points) {
      assert.ok(point.x >= 0, "relative x must be non-negative");
      assert.ok(point.y >= 0, "relative y must be non-negative");
      assert.ok(point.x <= c.width, "relative x must sit inside the bounding box");
      assert.ok(point.y <= c.height, "relative y must sit inside the bounding box");
    }
  }
});

test("connector bounding boxes never have negative dimensions", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  const { connectors } = buildConnectors(simpleFlow.edges, boxes);
  for (const c of connectors) {
    assert.ok(c.width >= 0, "width must be non-negative");
    assert.ok(c.height >= 0, "height must be non-negative");
  }
});

test("connector endpoints land on the connection points of their shapes", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  const { connectors } = buildConnectors(simpleFlow.edges, boxes);

  simpleFlow.edges.forEach((edge, i) => {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    const { start, end } = connectors[i].connector;

    // y always sits exactly on the source bottom edge and target top edge.
    assert.equal(start.position.y, from.y + from.height);
    assert.equal(end.position.y, to.y);

    // x sits on the horizontal centre, within the snap tolerance applied to
    // vertically stacked pairs.
    assert.ok(Math.abs(start.position.x - (from.x + from.width / 2)) <= 4);
    assert.ok(Math.abs(end.position.x - (to.x + to.width / 2)) <= 4);
  });
});

test("a vertically stacked pair is snapped to a single x, so the line is exactly vertical", () => {
  const boxes = layout([{ id: "a" }, { id: "b" }], [{ from: "a", to: "b" }]);
  const [connector] = buildConnectors([{ from: "a", to: "b" }], boxes).connectors;
  const { start, end } = connector.connector;

  assert.equal(start.position.x, end.position.x);
  assert.equal(connector.width, 0);
  assert.equal(Number.isInteger(start.position.x), true);
});

test("snapping does not collapse a genuine horizontal offset", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  const { connectors } = buildConnectors(simpleFlow.edges, boxes);
  const branch = connectors[1].connector;
  assert.notEqual(branch.start.position.x, branch.end.position.x);
});

test("only the target end carries an arrow", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  const { connectors } = buildConnectors(simpleFlow.edges, boxes);
  assert.equal(connectors[0].connector.start.arrow_style, "none");
  assert.equal(connectors[0].connector.end.arrow_style, "line_arrow");
});

test("labels are emitted only for labelled edges", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  const { labels } = buildConnectors(simpleFlow.edges, boxes);
  assert.deepEqual(
    labels.map((l) => l.text.text),
    ["是", "否"]
  );
});

test("branch labels sit on the outside of their branch", () => {
  const boxes = layout(simpleFlow.nodes, simpleFlow.edges);
  const { labels } = buildConnectors(simpleFlow.edges, boxes);
  const yes = boxes.get("yes");
  const no = boxes.get("no");
  const [leftLabel, rightLabel] = yes.x < no.x ? [labels[0], labels[1]] : [labels[1], labels[0]];
  assert.ok(leftLabel.x < rightLabel.x, "the left branch label stays left of the right one");
});
