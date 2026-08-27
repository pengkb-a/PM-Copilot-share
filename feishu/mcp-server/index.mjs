/**
 * Feishu (Lark) Document MCP Server
 *
 * Exposes the existing feishu document tooling as MCP tools:
 *   auth_status      - check whether the saved OAuth token is usable
 *   create_document  - create a document, optionally enabling public sharing
 *   write_markdown   - convert markdown to native blocks and append them
 *   list_blocks      - list blocks with text previews (to locate edit targets)
 *   update_block     - rewrite one block's text
 *   clear_document   - delete every content block (guarded by confirm)
 *   share_document   - change the public sharing level
 *
 * Auth state is shared with the CLI: both read feishu/.env and
 * feishu/.feishu_token.json, so `node feishu_doc.mjs login` authorises both.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadEnvFile,
  loadToken,
  getValidUserAccessToken,
  isAccessTokenValid,
  isRefreshTokenValid,
  createDocument,
  setPublicSharing,
  buildDocumentUrl,
  getScopes,
} from "../feishu_doc.mjs";

import {
  parseMarkdownToBlocks,
  parseInlineElements,
  appendBlocksToDocument,
} from "./lib/markdown.mjs";

import {
  FeishuError,
  listAllBlocks,
  listChildren,
  updateTextBlock,
  deleteAllChildren,
  blockText,
} from "./lib/api.mjs";

import { insertFlowchart, FlowSpecError } from "./lib/board.mjs";

const FEISHU_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = join(FEISHU_DIR, ".env");
const TOKEN_PATH = join(FEISHU_DIR, ".feishu_token.json");

const PREVIEW_LENGTH = 60;

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

const asContent = (payload, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const ok = (data) => asContent({ ok: true, ...data });

const fail = (code, message, extra = {}) =>
  asContent({ ok: false, error: { code, message, ...extra } }, true);

/** Map thrown errors onto a stable, machine-readable error code. */
function classify(err) {
  const msg = err?.message ?? String(err);

  if (err instanceof FlowSpecError) {
    return fail("INVALID_ARGUMENT", msg, err.details ? { details: err.details } : {});
  }
  if (/No saved user token/i.test(msg)) {
    return fail("AUTH_REQUIRED", "No saved Feishu token.", {
      remediation: "Run `node feishu_doc.mjs login` in the feishu directory.",
    });
  }
  if (/token expired/i.test(msg)) {
    return fail("AUTH_EXPIRED", "Feishu token expired and could not be refreshed.", {
      remediation: "Run `node feishu_doc.mjs login` in the feishu directory.",
    });
  }
  if (err instanceof FeishuError) {
    if (err.rateLimited) return fail("RATE_LIMITED", msg);
    if (err.code === 99991679 || err.status === 403) {
      return fail("PERMISSION_DENIED", msg, {
        feishu_code: err.code,
        remediation:
          "Re-authorise with `node feishu_doc.mjs login`; board edits need board:whiteboard:node:create.",
      });
    }
    if (err.status === 404) return fail("NOT_FOUND", msg, { feishu_code: err.code });
    return fail("UPSTREAM_ERROR", msg, { feishu_code: err.code, http_status: err.status });
  }
  if (err?.code === "ENOENT") {
    return fail("NOT_FOUND", msg);
  }
  return fail("INTERNAL_ERROR", msg);
}

/** Register a tool whose handler may throw; failures come back as JSON. */
function tool(server, name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return classify(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function loadConfig() {
  const config = await loadEnvFile(ENV_PATH);
  const missing = ["FEISHU_APP_ID", "FEISHU_APP_SECRET"].filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")} in feishu/.env`);
  }
  return config;
}

async function auth() {
  const config = await loadConfig();
  const token = await getValidUserAccessToken(config, { tokenPath: TOKEN_PATH });
  return { token, config };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "feishu-doc", version: "1.0.0" });

tool(
  server,
  "auth_status",
  "Check whether the saved Feishu authorisation is usable. Call this first if other tools report auth errors. Never returns token values.",
  {},
  async () => {
    const config = await loadConfig();
    const record = await loadToken(TOKEN_PATH);

    let state = "login_required";
    if (isAccessTokenValid(record)) state = "valid";
    else if (isRefreshTokenValid(record)) state = "refreshable";

    return ok({
      data: {
        state,
        access_token_expires_at: record?.expires_at
          ? new Date(record.expires_at).toISOString()
          : null,
        refresh_token_expires_at: record?.refresh_expires_at
          ? new Date(record.refresh_expires_at).toISOString()
          : null,
        scopes: getScopes(config),
        tenant_domain: config.FEISHU_TENANT_DOMAIN ?? "bytedance.feishu.cn",
        ...(state === "login_required"
          ? { remediation: "Run `node feishu_doc.mjs login` in the feishu directory." }
          : {}),
      },
    });
  }
);

tool(
  server,
  "create_document",
  "Create a new Feishu cloud document and return its id and URL. By default anyone with the link (including external users) can edit it.",
  {
    title: z.string().min(1).describe("Document title"),
    public_sharing: z
      .boolean()
      .optional()
      .default(true)
      .describe("Enable link sharing with edit rights. Default: true"),
  },
  async ({ title, public_sharing }) => {
    if (!title.trim()) return fail("INVALID_ARGUMENT", "title must not be blank");

    const { token, config } = await auth();
    const result = await createDocument(token, title, config.FEISHU_FOLDER_TOKEN ?? "");
    const document = result.data?.document ?? result.data ?? {};
    const documentId = document.document_id ?? document.documentId ?? document.token ?? "";
    const url = document.url ?? (documentId ? buildDocumentUrl(config, documentId) : "");

    const data = { document_id: documentId, title, url, sharing: "disabled" };
    const warnings = [];

    if (public_sharing && documentId) {
      try {
        await setPublicSharing(documentId, token);
        data.sharing = "anyone_editable";
        data.notice =
          "Anyone on the internet with this link, including external users, can edit the document.";
      } catch (err) {
        data.sharing = "failed";
        warnings.push(`Sharing setup failed: ${err.message}`);
      }
    }

    return ok({ data, ...(warnings.length ? { warnings } : {}) });
  }
);

tool(
  server,
  "write_markdown",
  "Convert markdown to native Feishu blocks (numbered headings, tables, lists, bold) and APPEND them to a document. To replace content, call clear_document first.",
  {
    document_id: z.string().describe("Feishu document id"),
    markdown: z.string().describe("Markdown content to write"),
  },
  async ({ document_id, markdown }) => {
    const { token } = await auth();
    const blocks = parseMarkdownToBlocks(markdown);

    if (blocks.length === 0) {
      return fail("INVALID_ARGUMENT", "markdown produced no writable blocks");
    }

    const started = Date.now();
    const result = await appendBlocksToDocument(document_id, token, blocks);

    return ok({
      data: {
        blocks_total: result.total,
        blocks_written: result.written,
        tables_written: result.tables,
        blocks_failed: result.failed,
        elapsed_ms: Date.now() - started,
        failures: result.errors,
      },
    });
  }
);

tool(
  server,
  "list_blocks",
  "List the blocks of a Feishu document with text previews. Use this to find the block_id to pass to update_block.",
  {
    document_id: z.string().describe("Feishu document id"),
    filter_text: z
      .string()
      .optional()
      .describe("Only return blocks whose text contains this substring"),
    block_types: z
      .array(z.number())
      .optional()
      .describe("Only return blocks whose block_type is in this list"),
  },
  async ({ document_id, filter_text, block_types }) => {
    const { token } = await auth();
    const items = await listAllBlocks(document_id, token);

    const blocks = items
      .map((block) => {
        const text = blockText(block);
        return {
          block_id: block.block_id,
          block_type: block.block_type,
          parent_id: block.parent_id ?? "",
          text_preview:
            text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text,
        };
      })
      .filter((b) => !block_types?.length || block_types.includes(b.block_type))
      .filter((b) => !filter_text || b.text_preview.includes(filter_text));

    return ok({ data: { block_count: blocks.length, total_in_document: items.length, blocks } });
  }
);

tool(
  server,
  "update_block",
  "Replace the text of one block, leaving the rest of the document untouched. Supports **bold**. Find block_id via list_blocks.",
  {
    document_id: z.string().describe("Feishu document id"),
    block_id: z.string().describe("Target block id"),
    text: z.string().describe("New text content (supports **bold**)"),
  },
  async ({ document_id, block_id, text }) => {
    const { token } = await auth();
    await updateTextBlock(document_id, block_id, token, parseInlineElements(text));
    return ok({ data: { block_id, text } });
  }
);

tool(
  server,
  "clear_document",
  "Delete every content block from a document, keeping the document itself. This cannot be undone. Requires confirm=true; without it the tool reports what would be deleted.",
  {
    document_id: z.string().describe("Feishu document id"),
    confirm: z
      .boolean()
      .optional()
      .default(false)
      .describe("Must be true to actually delete. Default: false"),
  },
  async ({ document_id, confirm }) => {
    const { token } = await auth();

    if (!confirm) {
      const children = await listChildren(document_id, document_id, token);
      return fail("CONFIRMATION_REQUIRED", "Set confirm=true to delete all content blocks.", {
        details: {
          blocks_to_delete: children.length,
          preview: children.slice(0, 5).map((b) => blockText(b).slice(0, PREVIEW_LENGTH)),
        },
      });
    }

    const deleted = await deleteAllChildren(document_id, token);
    return ok({ data: { blocks_deleted: deleted } });
  }
);

tool(
  server,
  "insert_flowchart",
  "Insert a flowchart into a Feishu document as an editable native board (not a static image). Give nodes and edges; layout, right-angled connectors and connection-point alignment are computed automatically. Shape defaults to round_rect, or diamond for a node with 2+ outgoing edges.",
  {
    document_id: z.string().describe("Feishu document id"),
    flow: z
      .object({
        nodes: z
          .array(
            z.object({
              id: z.string().describe("Unique node id, referenced by edges"),
              text: z.string().optional().describe("Text shown inside the shape"),
              shape: z
                .enum(["round_rect", "rect", "diamond", "ellipse"])
                .optional()
                .describe("Override the auto-selected shape"),
            })
          )
          .min(1),
        edges: z
          .array(
            z.object({
              from: z.string().describe("Source node id"),
              to: z.string().describe("Target node id"),
              label: z.string().optional().describe("Label on the line, e.g. 是 / 否"),
            })
          )
          .optional()
          .default([]),
      })
      .describe("Flowchart definition"),
    anchor_text: z
      .string()
      .optional()
      .describe("Insert after the first block containing this text. Omitted means append at the end"),
    replace_existing: z
      .boolean()
      .optional()
      .default(false)
      .describe("Delete existing board and image blocks first. Default: false"),
  },
  async ({ document_id, flow, anchor_text, replace_existing }) => {
    const { token } = await auth();
    const result = await insertFlowchart(document_id, token, flow, {
      anchorText: anchor_text,
      replaceExisting: replace_existing,
    });

    const { warnings, ...data } = result;
    return ok({ data, ...(warnings.length ? { warnings } : {}) });
  }
);

tool(
  server,
  "share_document",
  "Set the public sharing level of a Feishu document.",
  {
    document_id: z.string().describe("Feishu document id"),
    permission: z
      .enum(["anyone_editable", "anyone_readable", "tenant_editable", "tenant_readable", "closed"])
      .optional()
      .default("anyone_editable")
      .describe("Sharing level. Default: anyone_editable"),
  },
  async ({ document_id, permission }) => {
    const { token } = await auth();
    await setPublicSharing(document_id, token, permission);

    return ok({
      data: {
        document_id,
        permission,
        ...(permission.startsWith("anyone")
          ? {
              notice:
                "Anyone on the internet with the link, including external users, now has this access level.",
            }
          : {}),
      },
    });
  }
);

// ---------------------------------------------------------------------------
// Start (stdout carries MCP protocol only; logs go to stderr)
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("feishu-doc MCP server ready on stdio");
