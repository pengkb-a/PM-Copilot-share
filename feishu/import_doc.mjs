import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { loadEnvFile, getValidUserAccessToken, buildDocumentUrl, setPublicSharing } from "./feishu_doc.mjs";

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

// -------------------------------------------------------------------------
// Upload file to get a file_token for import
// -------------------------------------------------------------------------

async function uploadFileForImport(token, filePath, fileName) {
  const fileBuffer = await readFile(filePath);
  const fileStat = await stat(filePath);
  const name = fileName || basename(filePath);

  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);

  const fields = [
    { name: "file_name", value: name },
    { name: "parent_type", value: "explorer" },
    { name: "parent_node", value: "" },
    { name: "size", value: String(fileStat.size) },
  ];

  const parts = [];
  for (const field of fields) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`
    );
  }

  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;

  const headerBuf = Buffer.from(parts.join("") + fileHeader, "utf8");
  const footerBuf = Buffer.from(fileFooter, "utf8");
  const body = Buffer.concat([headerBuf, fileBuffer, footerBuf]);

  const response = await fetch(`${FEISHU_BASE_URL}/drive/v1/medias/upload_all`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) throw new Error(`Upload HTTP ${response.status}: ${text}`);
  if (data.code !== 0) throw new Error(`Upload error ${data.code}: ${data.msg ?? text}`);

  return data.data?.file_token;
}

// -------------------------------------------------------------------------
// Create import task
// -------------------------------------------------------------------------

async function createImportTask(token, fileToken, fileName, folderToken) {
  const body = {
    file_extension: "docx",
    file_token: fileToken,
    type: "docx",
    file_name: fileName.replace(/\.docx$/i, ""),
  };
  if (folderToken) body.point = { mount_type: 1, mount_key: folderToken };

  const response = await fetch(`${FEISHU_BASE_URL}/drive/v1/import_tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) throw new Error(`Import HTTP ${response.status}: ${text}`);
  if (data.code !== 0) throw new Error(`Import error ${data.code}: ${data.msg ?? text}`);

  return data.data?.ticket;
}

// -------------------------------------------------------------------------
// Poll import task result
// -------------------------------------------------------------------------

async function pollImportTask(token, ticket, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const response = await fetch(`${FEISHU_BASE_URL}/drive/v1/import_tasks/${ticket}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (!response.ok) throw new Error(`Poll HTTP ${response.status}: ${text}`);
    if (data.code !== 0) throw new Error(`Poll error ${data.code}: ${data.msg ?? text}`);

    const result = data.data?.result;
    if (result && result.token) {
      return result; // { token, url, type }
    }

    const job = data.data?.job_status;
    if (job === 1 || job === 2) {
      // 1=processing, 2=processing
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (job === 3) {
      // success
      return result;
    }
    if (job >= 100) {
      throw new Error(`Import task failed with job_status=${job}`);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Import task timed out");
}

// -------------------------------------------------------------------------
// Main CLI
// -------------------------------------------------------------------------

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node import_doc.mjs <path_to_docx_file>");
  console.error("  Converts a .docx file into a native Feishu cloud document.");
  console.error("  Requires: drive:drive scope (user identity).");
  process.exit(1);
}

const config = await loadEnvFile();
const token = await getValidUserAccessToken(config);
console.log("Token acquired.");

const fileName = basename(filePath);
console.log(`Uploading ${fileName}...`);
const fileToken = await uploadFileForImport(token, filePath, fileName);
console.log(`File uploaded. Token: ${fileToken}`);

console.log("Creating import task...");
const folderToken = config.FEISHU_FOLDER_TOKEN || "";
const ticket = await createImportTask(token, fileToken, fileName, folderToken);
console.log(`Import task created. Ticket: ${ticket}`);

console.log("Waiting for import to complete...");
const result = await pollImportTask(token, ticket);
const docToken = result.token || "";
const domain = config.FEISHU_TENANT_DOMAIN || "bytedance.feishu.cn";
const url = result.url || `https://${domain}/docx/${docToken}`;

console.log(`\nImport complete!`);
console.log(`Document token: ${docToken}`);
console.log(`URL: ${url}`);

// Set public sharing
if (docToken) {
  try {
    await setPublicSharing(docToken, token);
    console.log("Public sharing enabled: anyone with the link can read.");
  } catch (err) {
    console.log(`Note: Could not set public sharing (${err.message}).`);
  }
}
