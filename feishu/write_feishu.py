"""
Write a Markdown file to a Feishu document with full formatting (headings, tables, bold, lists).
Uses the feishu-docx library which handles the complex block structure.

Usage:
  python write_feishu.py <markdown_file> [--title "Document Title"]
  python write_feishu.py <markdown_file> --doc-id <existing_doc_id>

Requires .feishu_token.json (from `node feishu_doc.mjs login`) and .env for config.
"""

import sys
import os
import json
import argparse
from pathlib import Path

# Add the feishu directory to find .env and token
SCRIPT_DIR = Path(__file__).parent

def load_env():
    env_path = SCRIPT_DIR / ".env"
    config = {}
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            config[key.strip()] = value.strip()
    return config

def load_token():
    token_path = SCRIPT_DIR / ".feishu_token.json"
    with open(token_path, "r", encoding="utf-8") as f:
        return json.load(f)

def main():
    parser = argparse.ArgumentParser(description="Write Markdown to Feishu document")
    parser.add_argument("markdown_file", help="Path to the markdown file")
    parser.add_argument("--title", help="Document title (for new documents)")
    parser.add_argument("--doc-id", help="Existing document ID to write into")
    args = parser.parse_args()

    config = load_env()
    token_data = load_token()
    access_token = token_data["access_token"]
    domain = config.get("FEISHU_TENANT_DOMAIN", "bytedance.feishu.cn")

    # Read markdown content
    md_path = Path(args.markdown_file)
    if not md_path.exists():
        print(f"Error: File not found: {md_path}")
        sys.exit(1)

    md_content = md_path.read_text(encoding="utf-8")
    title = args.title or md_path.stem

    from feishu_docx import FeishuDocxWriter

    writer = FeishuDocxWriter(
        user_access_token=access_token,
        feishu_domain=f"https://{domain}",
    )

    if args.doc_id:
        # Write to existing document
        doc_id = args.doc_id
        print(f"Writing to existing document: {doc_id}")
    else:
        # Create new document
        doc_id = writer.create_document(title=title)
        print(f"Document created: {doc_id}")
        url = f"https://{domain}/docx/{doc_id}"
        print(f"URL: {url}")

    # Write markdown content
    writer.write_markdown(doc_id, md_content)
    print("Markdown content written with formatting.")

    url = f"https://{domain}/docx/{doc_id}"
    print(f"\nDone! URL: {url}")

if __name__ == "__main__":
    main()
