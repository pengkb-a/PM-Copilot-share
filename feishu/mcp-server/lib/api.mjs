/**
 * Low-level Feishu API layer.
 *
 * Owns HTTP concerns so the tool handlers stay declarative:
 * throttling, 429 retry, pagination, and error normalisation.
 */

export const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

// Throttle defaults mirror the values proven out by batch_append.mjs.
export const RATE = {
  betweenBlocks: 350,
  betweenTableRows: 250,
  betweenCells: 200,
  retryWait: 3000,
  maxRetries: 3,
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Error carrying the upstream Feishu code so callers can classify failures. */
export class FeishuError extends Error {
  constructor(message, { status, code, rateLimited = false } = {}) {
    super(message);
    this.name = "FeishuError";
    this.status = status;
    this.code = code;
    this.rateLimited = rateLimited;
  }
}

function jsonHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
  };
}

/**
 * Single Feishu request. Retries only on 429, which is the one failure mode
 * that reliably succeeds on a second attempt.
 */
export async function feishuFetch(path, { token, method = "GET", body } = {}) {
  let attempt = 0;

  while (true) {
    const response = await fetch(`${FEISHU_BASE_URL}${path}`, {
      method,
      headers: body ? jsonHeaders(token) : { Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });

    const raw = await response.text();

    if (response.status === 429) {
      attempt++;
      if (attempt > RATE.maxRetries) {
        throw new FeishuError("Feishu rate limit exceeded after retries", {
          status: 429,
          rateLimited: true,
        });
      }
      await sleep(RATE.retryWait);
      continue;
    }

    const data = raw ? JSON.parse(raw) : {};

    if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
      throw new FeishuError(data.msg || `HTTP ${response.status}: ${raw}`, {
        status: response.status,
        code: data.code,
      });
    }

    return data;
  }
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** All blocks in a document, following pagination to the end. */
export async function listAllBlocks(docId, token) {
  const items = [];
  let pageToken = "";

  do {
    const query = `?page_size=500${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`;
    const data = await feishuFetch(`/docx/v1/documents/${docId}/blocks${query}`, { token });
    items.push(...(data.data?.items ?? []));
    pageToken = data.data?.has_more ? data.data.page_token : "";
  } while (pageToken);

  return items;
}

/** Direct children of a block, following pagination to the end. */
export async function listChildren(docId, blockId, token) {
  const items = [];
  let pageToken = "";

  do {
    const query = `?page_size=500${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`;
    const data = await feishuFetch(
      `/docx/v1/documents/${docId}/blocks/${blockId}/children${query}`,
      { token }
    );
    items.push(...(data.data?.items ?? []));
    pageToken = data.data?.has_more ? data.data.page_token : "";
  } while (pageToken);

  return items;
}

/** Append (index -1) or insert (index >= 0) children under a parent block. */
export async function appendChildren(docId, parentBlockId, token, children, index = -1) {
  return feishuFetch(`/docx/v1/documents/${docId}/blocks/${parentBlockId}/children`, {
    token,
    method: "POST",
    body: { children, index },
  });
}

export async function updateTextBlock(docId, blockId, token, elements) {
  return feishuFetch(`/docx/v1/documents/${docId}/blocks/${blockId}`, {
    token,
    method: "PATCH",
    body: { update_text_elements: { elements } },
  });
}

/** Append one row to an existing table. Returns the full row-major cell id list. */
export async function insertTableRow(docId, tableId, token) {
  const data = await feishuFetch(`/docx/v1/documents/${docId}/blocks/${tableId}`, {
    token,
    method: "PATCH",
    body: { insert_table_row: { row_index: -1 } },
  });
  return data.data?.block?.table?.cells ?? [];
}

/**
 * Delete every child of the document root.
 * batch_delete takes an index range, so this walks back-to-front in chunks.
 */
export async function deleteAllChildren(docId, token, chunkSize = 50) {
  const children = await listChildren(docId, docId, token);
  const total = children.length;
  if (total === 0) return 0;

  let remaining = total;
  while (remaining > 0) {
    const start = Math.max(0, remaining - chunkSize);
    await feishuFetch(`/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`, {
      token,
      method: "DELETE",
      body: { start_index: start, end_index: remaining },
    });
    remaining = start;
    if (remaining > 0) await sleep(RATE.betweenTableRows);
  }

  return total;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

const TEXT_FIELDS = [
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "heading7",
  "heading8",
  "heading9",
  "bullet",
  "ordered",
  "code",
  "quote",
  "todo",
];

/** Plain text of a block, regardless of which typed field holds its elements. */
export function blockText(block) {
  for (const field of TEXT_FIELDS) {
    const elements = block?.[field]?.elements;
    if (Array.isArray(elements)) {
      return elements.map((e) => e.text_run?.content ?? "").join("");
    }
  }
  return "";
}
