import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdownToBlocks, parseInlineElements } from "./markdown.mjs";

/** Text of a non-table block, regardless of which typed field holds it. */
function textOf(block) {
  const field = Object.keys(block).find((k) => k !== "block_type");
  return block[field].elements.map((e) => e.text_run.content).join("");
}

test("parseInlineElements marks bold segments and keeps order", () => {
  const elements = parseInlineElements("plain **bold** tail");
  assert.deepEqual(
    elements.map((e) => [e.text_run.content, Boolean(e.text_run.text_element_style.bold)]),
    [
      ["plain ", false],
      ["bold", true],
      [" tail", false],
    ]
  );
});

test("parseInlineElements returns a single run when there is no markup", () => {
  const elements = parseInlineElements("no markup");
  assert.equal(elements.length, 1);
  assert.equal(elements[0].text_run.content, "no markup");
});

test("h1 is dropped because the document title already carries it", () => {
  const blocks = parseMarkdownToBlocks("# Title\n## Section\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].block_type, 3);
});

test("heading levels shift up one and gain hierarchical numbers", () => {
  const blocks = parseMarkdownToBlocks("## A\n### A1\n### A2\n#### A2a\n## B\n");
  assert.deepEqual(
    blocks.map((b) => [b.block_type, textOf(b)]),
    [
      [3, "1. A"],
      [4, "1.1. A1"],
      [4, "1.2. A2"],
      [5, "1.2.1. A2a"],
      [3, "2. B"],
    ]
  );
});

test("existing numeric prefixes in the source are replaced, not doubled", () => {
  const blocks = parseMarkdownToBlocks("## 3. Already numbered\n");
  assert.equal(textOf(blocks[0]), "1. Already numbered");
});

test("heading counters are per call, so a second parse restarts at 1", () => {
  parseMarkdownToBlocks("## A\n## B\n## C\n");
  const blocks = parseMarkdownToBlocks("## Fresh\n");
  assert.equal(textOf(blocks[0]), "1. Fresh");
});

test("consecutive plain lines merge into one text block", () => {
  const blocks = parseMarkdownToBlocks("line one\nline two\n\nline three\n");
  assert.deepEqual(blocks.map(textOf), ["line one\nline two", "line three"]);
});

test("a structural marker ends paragraph absorption", () => {
  const blocks = parseMarkdownToBlocks("para\n## Heading\n");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].block_type, 2);
  assert.equal(blocks[1].block_type, 3);
});

test("bullets and ordered items map to their native block types", () => {
  const blocks = parseMarkdownToBlocks("- a\n* b\n1. one\n2. two\n");
  assert.deepEqual(
    blocks.map((b) => [b.block_type, textOf(b)]),
    [
      [12, "a"],
      [12, "b"],
      [13, "one"],
      [13, "two"],
    ]
  );
});

test("blockquotes become plain text without the marker", () => {
  const blocks = parseMarkdownToBlocks("> quoted\n");
  assert.equal(blocks[0].block_type, 2);
  assert.equal(textOf(blocks[0]), "quoted");
});

test("horizontal rules produce no blocks", () => {
  assert.deepEqual(parseMarkdownToBlocks("---\n-----\n"), []);
});

test("tables keep the header row and drop the separator row", () => {
  const blocks = parseMarkdownToBlocks("| h1 | h2 |\n|----|----|\n| a | b |\n| c | d |\n");
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    type: "table",
    rows: [
      ["h1", "h2"],
      ["a", "b"],
      ["c", "d"],
    ],
  });
});

test("a table directly after a heading is still parsed as a table", () => {
  const blocks = parseMarkdownToBlocks("## T\n| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.equal(blocks[0].block_type, 3);
  assert.equal(blocks[1].type, "table");
});

test("empty input yields no blocks", () => {
  assert.deepEqual(parseMarkdownToBlocks(""), []);
});

test("CRLF line endings parse the same as LF", () => {
  const lf = parseMarkdownToBlocks("## A\ntext\n");
  const crlf = parseMarkdownToBlocks("## A\r\ntext\r\n");
  assert.deepEqual(crlf, lf);
});
