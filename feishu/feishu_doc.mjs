import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";
const AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const DEFAULT_SCOPES = "docx:document drive:drive offline_access board:whiteboard:node:create board:whiteboard:node:read";
const DEFAULT_OAUTH_PORT = 3000;

export function getDefaultEnvPath(moduleUrl = import.meta.url) {
  return join(dirname(fileURLToPath(moduleUrl)), ".env");
}

export function getDefaultTokenPath(moduleUrl = import.meta.url) {
  return join(dirname(fileURLToPath(moduleUrl)), ".feishu_token.json");
}

export async function loadEnvFile(path = getDefaultEnvPath()) {
  const content = await readFile(path, "utf8");
  const config = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    config[key] = value;
  }

  return config;
}

export function isCliEntrypoint(moduleUrl, scriptPath) {
  if (!scriptPath) return false;
  return moduleUrl === pathToFileURL(scriptPath).href;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  if (typeof data.code === "number" && data.code !== 0) {
    throw new Error(`Feishu API error ${data.code}: ${data.msg ?? text}`);
  }

  if (data.error) {
    throw new Error(`OAuth error ${data.error}: ${data.error_description ?? text}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// OAuth config helpers
// ---------------------------------------------------------------------------

export function getOAuthPort(config) {
  const port = Number(config.FEISHU_OAUTH_PORT);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_OAUTH_PORT;
}

export function getRedirectUri(config) {
  return config.FEISHU_REDIRECT_URI || `http://localhost:${getOAuthPort(config)}/callback`;
}

export function getScopes(config) {
  return config.FEISHU_SCOPES || DEFAULT_SCOPES;
}

export function buildAuthorizeUrl(config, state, base = AUTHORIZE_URL) {
  const url = new URL(base);
  url.searchParams.set("client_id", config.FEISHU_APP_ID);
  url.searchParams.set("redirect_uri", getRedirectUri(config));
  url.searchParams.set("scope", getScopes(config));
  url.searchParams.set("state", state);
  return url.toString();
}

export function buildTokenRequestBody(config, code) {
  return {
    grant_type: "authorization_code",
    client_id: config.FEISHU_APP_ID,
    client_secret: config.FEISHU_APP_SECRET,
    code,
    redirect_uri: getRedirectUri(config),
  };
}

export function buildRefreshRequestBody(config, refreshToken) {
  return {
    grant_type: "refresh_token",
    client_id: config.FEISHU_APP_ID,
    client_secret: config.FEISHU_APP_SECRET,
    refresh_token: refreshToken,
  };
}

// ---------------------------------------------------------------------------
// Token record helpers
// ---------------------------------------------------------------------------

export function toTokenRecord(data, now = Date.now()) {
  const record = { access_token: data.access_token };
  if (data.refresh_token) record.refresh_token = data.refresh_token;
  if (typeof data.expires_in === "number") {
    record.expires_at = now + data.expires_in * 1000;
  }
  if (typeof data.refresh_token_expires_in === "number") {
    record.refresh_expires_at = now + data.refresh_token_expires_in * 1000;
  }
  return record;
}

export function isAccessTokenValid(record, now = Date.now(), skewMs = 60000) {
  return Boolean(record?.access_token && record.expires_at && now < record.expires_at - skewMs);
}

export function isRefreshTokenValid(record, now = Date.now(), skewMs = 60000) {
  if (!record?.refresh_token) return false;
  if (!record.refresh_expires_at) return true; // unknown expiry, assume usable
  return now < record.refresh_expires_at - skewMs;
}

export async function loadToken(path = getDefaultTokenPath()) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function saveToken(record, path = getDefaultTokenPath()) {
  await writeFile(path, JSON.stringify(record, null, 2), "utf8");
}

export async function requestUserToken(body) {
  return requestJson(`${FEISHU_BASE_URL}/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
}

export async function getValidUserAccessToken(config, options = {}) {
  const { tokenPath = getDefaultTokenPath(), now = Date.now() } = options;
  const record = await loadToken(tokenPath);

  if (!record) {
    throw new Error("No saved user token. Run: node feishu_doc.mjs login");
  }
  if (isAccessTokenValid(record, now)) {
    return record.access_token;
  }
  if (isRefreshTokenValid(record, now)) {
    const data = await requestUserToken(buildRefreshRequestBody(config, record.refresh_token));
    const updated = toTokenRecord(data, now);
    if (!updated.refresh_token && record.refresh_token) {
      updated.refresh_token = record.refresh_token;
      updated.refresh_expires_at = record.refresh_expires_at;
    }
    await saveToken(updated, tokenPath);
    return updated.access_token;
  }

  throw new Error("User token expired. Run: node feishu_doc.mjs login");
}

// ---------------------------------------------------------------------------
// Feishu docx API
// ---------------------------------------------------------------------------

export async function listDocumentBlocks(documentId, token) {
  return requestJson(`${FEISHU_BASE_URL}/docx/v1/documents/${documentId}/blocks`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function summarizeBlocks(blocksResponse) {
  return (blocksResponse.data?.items ?? []).map((block) => ({
    block_id: block.block_id,
    block_type: block.block_type,
    parent_id: block.parent_id ?? "",
  }));
}

export function buildCreateDocumentBody(title, folderToken = "") {
  const body = { title };
  if (folderToken) body.folder_token = folderToken;
  return body;
}

export function buildDocumentUrl(config, documentId) {
  const domain = config.FEISHU_TENANT_DOMAIN || "bytedance.feishu.cn";
  return `https://${domain}/docx/${documentId}`;
}

export async function createDocument(token, title, folderToken = "") {
  return requestJson(`${FEISHU_BASE_URL}/docx/v1/documents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(buildCreateDocumentBody(title, folderToken)),
  });
}

export async function setPublicSharing(documentId, token, linkShareEntity = "anyone_editable") {
  return requestJson(`${FEISHU_BASE_URL}/drive/v1/permissions/${documentId}/public?type=docx`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      external_access_entity: "open",
      security_entity: "anyone_can_view",
      comment_entity: "anyone_can_edit",
      share_entity: "anyone",
      link_share_entity: linkShareEntity,
    }),
  });
}

export async function appendTextBlock(documentId, token, text) {
  return requestJson(`${FEISHU_BASE_URL}/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      children: [
        {
          block_type: 2,
          text: {
            elements: [
              {
                text_run: {
                  content: text,
                  text_element_style: {},
                },
              },
            ],
            style: {},
          },
        },
      ],
      index: -1,
    }),
  });
}

// ---------------------------------------------------------------------------
// Interactive login (OAuth authorization code flow)
// ---------------------------------------------------------------------------

async function openBrowser(url) {
  try {
    const { spawn } = await import("node:child_process");
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Ignore: the URL is also printed so the user can open it manually.
  }
}

async function waitForAuthorizationCode(config, state) {
  const { createServer } = await import("node:http");
  const port = getOAuthPort(config);
  const redirectUri = getRedirectUri(config);
  const callbackPath = new URL(redirectUri).pathname;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${port}`);
      if (reqUrl.pathname !== callbackPath) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const returnedCode = reqUrl.searchParams.get("code");
      const returnedState = reqUrl.searchParams.get("state");
      res.setHeader("Content-Type", "text/html; charset=utf-8");

      if (!returnedCode || returnedState !== state) {
        res.statusCode = 400;
        res.end("<h2>授权失败，请返回终端重试。</h2>");
        server.close();
        reject(new Error("Authorization failed or state mismatch."));
        return;
      }

      res.end("<h2>授权成功，可以关闭本页面并返回终端。</h2>");
      server.close();
      resolve(returnedCode);
    });

    server.on("error", reject);
    server.listen(port, () => {
      const authUrl = buildAuthorizeUrl(config, state);
      console.log(`Local callback server listening on ${redirectUri}`);
      console.log("If the browser does not open automatically, open this URL:");
      console.log(authUrl);
      openBrowser(authUrl);
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 300 seconds."));
    }, 300000).unref?.();
  });
}

async function runLogin(config) {
  const state = Math.random().toString(36).slice(2);
  const code = await waitForAuthorizationCode(config, state);
  const data = await requestUserToken(buildTokenRequestBody(config, code));
  const record = toTokenRecord(data);
  await saveToken(record);
  console.log("User access token saved to .feishu_token.json");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const command = process.argv[2] ?? "check";
  const config = await loadEnvFile();

  if (!config.FEISHU_APP_ID || !config.FEISHU_APP_SECRET) {
    throw new Error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET in .env");
  }

  if (command === "login") {
    await runLogin(config);
    return;
  }

  const token = await getValidUserAccessToken(config);
  console.log("User access token acquired.");

  if (command === "create") {
    const args = process.argv.slice(3);
    const noPublic = args.includes("--no-public");
    const titleParts = args.filter((a) => a !== "--public" && a !== "--no-public");
    const title = titleParts.join(" ").trim() || `Kiro Created Doc ${new Date().toISOString()}`;
    const result = await createDocument(token, title, config.FEISHU_FOLDER_TOKEN ?? "");
    const document = result.data?.document ?? result.data ?? {};
    const newDocumentId = document.document_id ?? document.documentId ?? document.token ?? "";
    const url = document.url ?? (newDocumentId ? buildDocumentUrl(config, newDocumentId) : "");

    console.log(`Document created. Title: ${title}`);
    if (newDocumentId) console.log(`Document ID: ${newDocumentId}`);
    if (url) console.log(`URL: ${url}`);

    if (!noPublic && newDocumentId) {
      await setPublicSharing(newDocumentId, token);
      console.log("Public sharing enabled: anyone with the link (incl. external) can edit.");
    }

    console.log(JSON.stringify(result.data, null, 2));
    return;
  }

  if (command === "share") {
    const targetId = process.argv[3] || config.FEISHU_DOCUMENT_ID;
    if (!targetId) throw new Error("Usage: node feishu_doc.mjs share <document_id>");
    await setPublicSharing(targetId, token);
    console.log(`Public sharing enabled for ${targetId}: anyone with the link (incl. external) can edit.`);
    return;
  }

  const documentId = config.FEISHU_DOCUMENT_ID;
  if (!documentId) {
    throw new Error("Missing FEISHU_DOCUMENT_ID in .env");
  }

  if (command === "check") {
    const blocks = await listDocumentBlocks(documentId, token);
    const count = blocks.data?.items?.length ?? 0;
    console.log(`Document is readable. Block count: ${count}`);
    return;
  }

  if (command === "blocks") {
    const blocks = await listDocumentBlocks(documentId, token);
    console.log(JSON.stringify(summarizeBlocks(blocks), null, 2));
    return;
  }

  if (command === "append") {
    const text = process.argv.slice(3).join(" ").trim();
    if (!text) throw new Error("Usage: node feishu_doc.mjs append <text>");

    await appendTextBlock(documentId, token, text);
    console.log("Text appended to document.");
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
