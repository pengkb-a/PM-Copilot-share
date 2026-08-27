import { readFile } from "node:fs/promises";
import { loadEnvFile, getValidUserAccessToken } from "./feishu_doc.mjs";

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

// -------------------------------------------------------------------------
// Inline text parsing (bold)
// -------------------------------------------------------------------------

function parseInlineElements(text) {
  const elements = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push({ text_run: { content: text.slice(lastIndex, match.index), text_element_style: {} } });
    }
    elements.push({ text_run: { content: match[1], text_element_style: { bold: true } } });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    elements.push({ text_run: { content: text.slice(lastIndex), text_element_style: {} } });
  }
  return elements.length ? elements : [{ text_run: { content: text, text_element_style: {} } }];
}

// -------------------------------------------------------------------------
// Block builders
// -------------------------------------------------------------------------

function textBlock(text) {
  return { block_type: 2, text: { elements: parseInlineElements(text), style: {} } };
}

// Heading numbering state
const headingCounters = [0, 0, 0, 0, 0, 0]; // h1 through h6

function getHeadingNumber(level) {
  // level is the mapped level (1-based): h2→1, h3→2, h4→3, etc.
  const idx = level - 1;
  headingCounters[idx]++;
  // Reset all sub-levels
  for (let i = idx + 1; i < headingCounters.length; i++) {
    headingCounters[i] = 0;
  }
  // Build the number string: e.g., "1", "1.1", "1.1.2"
  return headingCounters.slice(0, idx + 1).join(".");
}

function headingBlock(text, level) {
  // Skip h1 (will be filtered out at parse level), map h2→heading1, h3→heading2, etc.
  const mappedLevel = level - 1; // h2→1, h3→2, h4→3, h5→4, h6→5
  const blockType = Math.min(mappedLevel + 2, 11); // heading1=3, heading2=4, ...
  const fieldName = `heading${mappedLevel}`;
  // Strip leading numbering like "1. " or "1.2 " from source
  const cleaned = text.replace(/^[\d]+(\.\d+)*\.?\s+/, "");
  // Add auto-numbering prefix
  const number = getHeadingNumber(mappedLevel);
  const numbered = `${number}. ${cleaned}`;
  return { block_type: blockType, [fieldName]: { elements: parseInlineElements(numbered), style: {} } };
}

function bulletBlock(text) {
  return { block_type: 12, bullet: { elements: parseInlineElements(text), style: {} } };
}

function orderedBlock(text) {
  return { block_type: 13, ordered: { elements: parseInlineElements(text), style: {} } };
}

// Table is special: returns a descriptor, not a direct block
function tableDescriptor(rows) {
  return { type: "table", rows };
}

// -------------------------------------------------------------------------
// Markdown → block descriptors
// -------------------------------------------------------------------------

function parseTableRows(lines) {
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue; // separator
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    rows.push(cells);
  }
  return rows;
}

function parseMarkdown(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    // Heading
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      if (level === 1) { i++; continue; } // Skip h1 (document title is already set)
      blocks.push(headingBlock(hMatch[2].trim(), level));
      i++; continue;
    }

    // Table
    if (line.trim().startsWith("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { tableLines.push(lines[i]); i++; }
      const rows = parseTableRows(tableLines);
      if (rows.length > 0 && rows[0].length > 0) blocks.push(tableDescriptor(rows));
      continue;
    }

    // Unordered list (- item)
    if (/^\s*[-*]\s+/.test(line)) {
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        blocks.push(bulletBlock(lines[i].replace(/^\s*[-*]\s+/, "").trim()));
        i++;
      }
      continue;
    }

    // Ordered list (1. item)
    if (/^\s*\d+\.\s+/.test(line)) {
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        blocks.push(orderedBlock(lines[i].replace(/^\s*\d+\.\s+/, "").trim()));
        i++;
      }
      continue;
    }

    // Blockquote (> text) → render as text with 💡 prefix
    if (line.trim().startsWith(">")) {
      const text = line.trim().replace(/^>\s*/, "");
      if (text) blocks.push(textBlock(text));
      i++; continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim())) { i++; continue; }

    // Regular paragraph
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].trim().startsWith("|") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith(">") &&
      !/^-{3,}$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    if (paraLines.length) blocks.push(textBlock(paraLines.join("\n")));
  }

  return blocks;
}

// -------------------------------------------------------------------------
// Feishu API helpers
// -------------------------------------------------------------------------

async function appendChildren(docId, parentBlockId, token, children) {
  const r = await fetch(
    `${FEISHU_BASE_URL}/docx/v1/documents/${docId}/blocks/${parentBlockId}/children`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ children, index: -1 }),
    }
  );
  const text = await r.text();
  if (r.status === 429) throw new Error("RATE_LIMITED");
  const data = text ? JSON.parse(text) : {};
  if (!r.ok || (typeof data.code === "number" && data.code !== 0)) {
    throw new Error(`API ${r.status}: ${data.msg || text}`);
  }
  return data;
}

// Feishu docx caps the row_size that can be created in a single table-create
// request (empirically ~10). For larger tables we create a small table then
// append the remaining rows via insert_table_row, keeping it ONE table.
const MAX_CREATE_ROWS = 8;

async function insertTableRow(docId, tableId, token) {
  const r = await fetch(
    `${FEISHU_BASE_URL}/docx/v1/documents/${docId}/blocks/${tableId}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ insert_table_row: { row_index: -1 } }),
    }
  );
  const body = await r.text();
  if (r.status === 429) throw new Error("RATE_LIMITED");
  const data = body ? JSON.parse(body) : {};
  if (!r.ok || (typeof data.code === "number" && data.code !== 0)) {
    throw new Error(`API ${r.status}: ${data.msg || body}`);
  }
  // Return the updated full cell id list (row-major)
  return data.data?.block?.table?.cells || [];
}

async function createTableWithContent(docId, parentBlockId, token, rows) {
  const rowCount = rows.length;
  const colCount = rows[0].length;

  // Calculate even column widths (wider: total ~800px distributed evenly, min 120 per col)
  const totalWidth = 800;
  const colWidth = Math.max(120, Math.floor(totalWidth / colCount));
  const columnWidth = Array(colCount).fill(colWidth);

  // Step 1: create the table with an initial (safe) number of rows
  const initialRows = Math.min(rowCount, MAX_CREATE_ROWS);
  const createData = await appendChildren(docId, parentBlockId, token, [{
    block_type: 31,
    table: {
      property: { row_size: initialRows, column_size: colCount, header_row: true, column_width: columnWidth },
      cells: Array(initialRows * colCount).fill(""),
    },
  }]);

  const tableBlock = createData.data?.children?.[0];
  const tableId = tableBlock?.block_id;
  let cellIds = tableBlock?.children || tableBlock?.table?.cells || [];

  // Step 1b: append remaining rows one by one (single logical table)
  for (let r = initialRows; r < rowCount; r++) {
    cellIds = await insertTableRow(docId, tableId, token);
    await new Promise((res) => setTimeout(res, 250));
  }

  if (cellIds.length !== rowCount * colCount) {
    console.log(`  Warning: expected ${rowCount * colCount} cells, got ${cellIds.length}`);
    return;
  }

  // Step 2: fill each cell by UPDATING its default (empty) text block.
  // A freshly created table cell already contains one empty text block;
  // appending a new block would leave that empty block as a blank first line.
  for (let idx = 0; idx < cellIds.length; idx++) {
    const row = Math.floor(idx / colCount);
    const col = idx % colCount;
    const cellText = rows[row][col] || "";
    if (!cellText) continue;

    // Fetch the cell's existing (empty) child text block id
    let innerBlockId = null;
    try {
      const childRes = await fetch(
        `${FEISHU_BASE_URL}/docx/v1/documents/${docId}/blocks/${cellIds[idx]}/children`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const childData = JSON.parse((await childRes.text()) || "{}");
      innerBlockId = childData.data?.items?.[0]?.block_id || null;
    } catch { /* fall through to append */ }

    if (innerBlockId) {
      // Update the existing empty text block in place (no blank first line)
      await updateTextBlock(docId, innerBlockId, token, cellText);
    } else {
      // Fallback: append (older behavior)
      await appendChildren(docId, cellIds[idx], token, [textBlock(cellText)]);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function updateTextBlock(docId, blockId, token, text) {
  const r = await fetch(
    `${FEISHU_BASE_URL}/docx/v1/documents/${docId}/blocks/${blockId}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ update_text_elements: { elements: parseInlineElements(text) } }),
    }
  );
  const body = await r.text();
  if (r.status === 429) throw new Error("RATE_LIMITED");
  const data = body ? JSON.parse(body) : {};
  if (!r.ok || (typeof data.code === "number" && data.code !== 0)) {
    throw new Error(`API ${r.status}: ${data.msg || body}`);
  }
  return data;
}

// -------------------------------------------------------------------------
// Main execution
// -------------------------------------------------------------------------

const docId = process.argv[2];
const filePath = process.argv[3];

if (!docId || !filePath) {
  console.error("Usage: node batch_append.mjs <document_id> <markdown_file_path>");
  process.exit(1);
}

const config = await loadEnvFile();
const token = await getValidUserAccessToken(config);
console.log("Token acquired.");

const content = await readFile(filePath, "utf8");
const blocks = parseMarkdown(content);

const tableCount = blocks.filter((b) => b.type === "table").length;
const otherCount = blocks.length - tableCount;
console.log(`Parsed ${blocks.length} blocks (${otherCount} text/heading/list + ${tableCount} tables).`);

for (let i = 0; i < blocks.length; i++) {
  const block = blocks[i];

  let retries = 3;
  while (retries > 0) {
    try {
      if (block.type === "table") {
        await createTableWithContent(docId, docId, token, block.rows);
      } else {
        await appendChildren(docId, docId, token, [block]);
      }
      break;
    } catch (err) {
      if (err.message === "RATE_LIMITED" && retries > 1) {
        retries--;
        console.log(`  Rate limited at block ${i + 1}, waiting 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        console.error(`  Error at block ${i + 1}: ${err.message}`);
        // Skip this block and continue
        break;
      }
    }
  }

  await new Promise((r) => setTimeout(r, 350));
  if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${blocks.length} done`);
}

console.log(`\nDone! All ${blocks.length} blocks processed.`);
