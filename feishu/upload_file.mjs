import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { loadEnvFile, getValidUserAccessToken, buildDocumentUrl } from "./feishu_doc.mjs";

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

async function uploadFile(token, filePath, folderToken, fileName) {
  const fileBuffer = await readFile(filePath);
  const fileStat = await stat(filePath);
  const name = fileName || basename(filePath);

  // Use multipart/form-data via the drive upload API
  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);

  const fields = [
    { name: "file_name", value: name },
    { name: "parent_type", value: "explorer" },
    { name: "parent_node", value: folderToken },
    { name: "size", value: String(fileStat.size) },
  ];

  // Build multipart body manually
  const parts = [];
  for (const field of fields) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`
    );
  }

  // File part
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;

  const headerBuf = Buffer.from(parts.join("") + fileHeader, "utf8");
  const footerBuf = Buffer.from(fileFooter, "utf8");
  const body = Buffer.concat([headerBuf, fileBuffer, footerBuf]);

  const response = await fetch(`${FEISHU_BASE_URL}/drive/v1/files/upload_all`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  if (typeof data.code === "number" && data.code !== 0) {
    throw new Error(`Feishu API error ${data.code}: ${data.msg ?? text}`);
  }

  return data;
}

async function setFilePublicSharing(fileToken, token, fileType = "file") {
  const response = await fetch(
    `${FEISHU_BASE_URL}/drive/v1/permissions/${fileToken}/public?type=${fileType}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        external_access_entity: "open",
        security_entity: "anyone_can_view",
        link_share_entity: "anyone_readable",
      }),
    }
  );

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  if (typeof data.code === "number" && data.code !== 0) {
    throw new Error(`Feishu API error ${data.code}: ${data.msg ?? text}`);
  }
  return data;
}

// CLI
const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node upload_file.mjs <file_path> [folder_token]");
  process.exit(1);
}

const config = await loadEnvFile();
const token = await getValidUserAccessToken(config);
console.log("Token acquired.");

const folderToken = process.argv[3] || config.FEISHU_FOLDER_TOKEN;
if (!folderToken) {
  console.error("Error: No folder_token provided. Set FEISHU_FOLDER_TOKEN in .env or pass as argument.");
  process.exit(1);
}

const result = await uploadFile(token, filePath, folderToken, basename(filePath));
const fileToken = result.data?.file_token ?? "";
console.log(`File uploaded successfully.`);
console.log(`File token: ${fileToken}`);

if (fileToken) {
  const domain = config.FEISHU_TENANT_DOMAIN || "bytedance.feishu.cn";
  const url = `https://${domain}/file/${fileToken}`;
  console.log(`URL: ${url}`);

  // Try to set public sharing
  try {
    await setFilePublicSharing(fileToken, token);
    console.log("Public sharing enabled: anyone with the link can read.");
  } catch (err) {
    console.log(`Note: Could not set public sharing (${err.message}). You may need to share manually.`);
  }
}
