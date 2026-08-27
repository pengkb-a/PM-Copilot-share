/**
 * Markdown -> Feishu block conversion, plus the writer that pushes blocks
 * into a document.
 *
 * parseMarkdownToBlocks is a pure function (no network, no shared state) so it
 * can be unit tested directly. Heading counters live per call — a long-running
 * MCP server would otherwise keep incrementing them across requests.
 */

import {
  RATE,
  sleep,
  appendChildren,
  updateTextBlock,
  insertTableRow,
  listChildren,
} from "./api.mjs";

// Feishu rejects large row_size on table creation; create small, then grow.
const MAX_CREATE_ROWS = 8;
const TABLE_TOTAL_WIDTH = 800;
const TABLE_MIN_COL_WIDTH = 120;

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

/** Split a line into text runs, marking **bold** segments. */
export function parseInlineElements(text) {
  const elements = [];
  const bold = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;

  while ((match = bold.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push({
        text_run: { content: text.slice(lastIndex, match.index), text_element_style: {} },
      });
    }
    elements.push({
      text_run: { content: match[1], text_element_style: { bold: true } },
    });
    lastIndex = bold.lastIndex;
  }

  if (lastIndex < text.length) {
    elements.push({ text_run: { content: text.slice(lastIndex), text_element_style: {} } });
  }

  return elements.length ? elements : [{ text_run: { content: text, text_element_style: {} } }];
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

export function textBlock(text) {
  return { block_type: 2, text: { elements: parseInlineElements(text), style: {} } };
}

function bulletBlock(text) {
  return { block_type: 12, bullet: { elements: parseInlineElements(text), style: {} } };
}

function orderedBlock(text) {
  return { block_type: 13, ordered: { elements: parseInlineElements(text), style: {} } };
}

/** Tracks hierarchical heading numbers (1., 1.1., 1.1.1.) for one parse run. */
function createHeadingNumberer() {
  const counters = [0, 0, 0, 0, 0, 0];

  return (level) => {
    const idx = level - 1;
    counters[idx]++;
    for (let i = idx + 1; i < counters.length; i++) counters[i] = 0;
    return counters.slice(0, idx + 1).join(".");
  };
}

/**
 * Markdown h2 maps to Feishu heading1, h3 to heading2, and so on.
 * h1 is dropped upstream because the document title already carries it.
 */
function headingBlock(text, level, nextNumber) {
  const mapped = level - 1;
  const blockType = Math.min(mapped + 2, 11);
  const cleaned = text.replace(/^\d+(\.\d+)*\.?\s+/, "");
  const numbered = `${nextNumber(mapped)}. ${cleaned}`;

  return {
    block_type: blockType,
    [`heading${mapped}`]: { elements: parseInlineElements(numbered), style: {} },
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const isHeading = (l) => /^#{1,6}\s/.test(l);
const isTable = (l) => l.trim().startsWith("|");
const isBullet = (l) => /^\s*[-*]\s+/.test(l);
const isOrdered = (l) => /^\s*\d+\.\s+/.test(l);
const isQuote = (l) => l.trim().startsWith(">");
const isRule = (l) => /^-{3,}$/.test(l.trim());

function parseTableRows(lines) {
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue; // separator row
    rows.push(
      trimmed
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim())
    );
  }
  return rows;
}

/**
 * Convert markdown into an ordered list of block descriptors.
 * Tables come back as { type: "table", rows } because they need multi-request
 * construction rather than a single append.
 */
export function parseMarkdownToBlocks(content) {
  const lines = content.split(/\r?\n/);
  const nextNumber = createHeadingNumberer();
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "" || isRule(line)) {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      if (level > 1) blocks.push(headingBlock(heading[2].trim(), level, nextNumber));
      i++;
      continue;
    }

    if (isTable(line)) {
      const tableLines = [];
      while (i < lines.length && isTable(lines[i])) tableLines.push(lines[i++]);
      const rows = parseTableRows(tableLines);
      if (rows.length && rows[0].length) blocks.push({ type: "table", rows });
      continue;
    }

    if (isBullet(line)) {
      while (i < lines.length && isBullet(lines[i])) {
        blocks.push(bulletBlock(lines[i].replace(/^\s*[-*]\s+/, "").trim()));
        i++;
      }
      continue;
    }

    if (isOrdered(line)) {
      while (i < lines.length && isOrdered(lines[i])) {
        blocks.push(orderedBlock(lines[i].replace(/^\s*\d+\.\s+/, "").trim()));
        i++;
      }
      continue;
    }

    if (isQuote(line)) {
      const text = line.trim().replace(/^>\s*/, "");
      if (text) blocks.push(textBlock(text));
      i++;
      continue;
    }

    // Plain paragraph: absorb consecutive lines until a structural marker.
    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isHeading(lines[i]) &&
      !isTable(lines[i]) &&
      !isBullet(lines[i]) &&
      !isOrdered(lines[i]) &&
      !isQuote(lines[i]) &&
      !isRule(lines[i])
    ) {
      paragraph.push(lines[i].trim());
      i++;
    }
    if (paragraph.length) blocks.push(textBlock(paragraph.join("\n")));
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Build one native Feishu table and fill it.
 * Cells start with an empty text block, so filling updates that block in place
 * instead of appending (which would leave a blank first line in every cell).
 */
async function createTableWithContent(docId, token, rows) {
  const rowCount = rows.length;
  const colCount = rows[0].length;
  const colWidth = Math.max(TABLE_MIN_COL_WIDTH, Math.floor(TABLE_TOTAL_WIDTH / colCount));
  const initialRows = Math.min(rowCount, MAX_CREATE_ROWS);

  const created = await appendChildren(docId, docId, token, [
    {
      block_type: 31,
      table: {
        property: {
          row_size: initialRows,
          column_size: colCount,
          header_row: true,
          column_width: Array(colCount).fill(colWidth),
        },
        cells: Array(initialRows * colCount).fill(""),
      },
    },
  ]);

  const tableBlock = created.data?.children?.[0];
  const tableId = tableBlock?.block_id;
  let cellIds = tableBlock?.children ?? tableBlock?.table?.cells ?? [];

  for (let r = initialRows; r < rowCount; r++) {
    cellIds = await insertTableRow(docId, tableId, token);
    await sleep(RATE.betweenTableRows);
  }

  if (cellIds.length !== rowCount * colCount) {
    throw new Error(
      `table cell count mismatch: expected ${rowCount * colCount}, got ${cellIds.length}`
    );
  }

  for (let idx = 0; idx < cellIds.length; idx++) {
    const cellText = rows[Math.floor(idx / colCount)][idx % colCount] || "";
    if (!cellText) continue;

    let innerBlockId = null;
    try {
      const children = await listChildren(docId, cellIds[idx], token);
      innerBlockId = children[0]?.block_id ?? null;
    } catch {
      // Fall through to append.
    }

    if (innerBlockId) {
      await updateTextBlock(docId, innerBlockId, token, parseInlineElements(cellText));
    } else {
      await appendChildren(docId, cellIds[idx], token, [textBlock(cellText)]);
    }
    await sleep(RATE.betweenCells);
  }

  return tableId;
}

/**
 * Write block descriptors to a document.
 * A single failing block is recorded and skipped so one bad table does not
 * abort a long document.
 */
export async function appendBlocksToDocument(docId, token, blocks, onProgress) {
  const result = { total: blocks.length, written: 0, tables: 0, failed: 0, errors: [] };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    try {
      if (block.type === "table") {
        await createTableWithContent(docId, token, block.rows);
        result.tables++;
      } else {
        await appendChildren(docId, docId, token, [block]);
      }
      result.written++;
    } catch (err) {
      result.failed++;
      result.errors.push({
        index: i + 1,
        kind: block.type === "table" ? "table" : `block_type:${block.block_type}`,
        reason: err.message,
      });
    }

    await sleep(RATE.betweenBlocks);
    if (onProgress && (i + 1) % 10 === 0) onProgress(i + 1, blocks.length);
  }

  return result;
}
