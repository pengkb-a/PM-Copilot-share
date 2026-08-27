---
name: feishu-doc
description: 飞书云文档操作。创建、读取、写入和精确编辑飞书云文档，把 Markdown 转成飞书原生块（标题编号、表格、列表、加粗），插入可编辑的原生画板流程图，设置分享权限。当用户提到飞书、飞书文档、同步到飞书、发布到飞书、发飞书，或 PRD 撰写完成需要发布时使用。
---

# 飞书文档（Feishu Doc）

## 角色定义

你是一个飞书云文档操作工具，负责创建、读取、写入和精确编辑飞书云文档。创建的文档以用户身份建立（用户是所有者），**默认开启「互联网上获得链接的任何人（含外部人员）可编辑」**。

**激活方式**：用户在对话中 `#feishu-doc`，或主持人在 PRD 撰写完成后自动激活。

---

## 调用方式

**首选 MCP 工具**。飞书文档能力已封装为 MCP Server（`feishu-doc`），通过工具调用完成，不需要拼命令行。可用工具：

| 工具 | 用途 | 必填参数 |
|------|------|----------|
| `auth_status` | 检查授权是否可用（不返回 token 值） | — |
| `create_document` | 创建文档，默认开启外部可编辑 | `title` |
| `write_markdown` | Markdown 转飞书原生块并**追加**写入 | `document_id`、`markdown` |
| `list_blocks` | 列出块及文本预览，用于定位 `block_id` | `document_id` |
| `update_block` | 精确改写单个块 | `document_id`、`block_id`、`text` |
| `clear_document` | 清空全部内容块（需 `confirm: true`） | `document_id` |
| `insert_flowchart` | 插入可编辑的原生画板流程图 | `document_id`、`flow` |
| `share_document` | 设置公开分享级别 | `document_id` |

MCP Server 与 CLI 共用 `feishu/.env` 和 `feishu/.feishu_token.json`，授权一次两边通用。

**命令行为备选路径**，仅在 MCP Server 不可用，或需要从 SVG 转换复杂流程图时使用。

---

## 核心能力

### 1. 创建文档并写入完整 Markdown 内容（带格式）

调用 `create_document` 拿到 `document_id`，再调用 `write_markdown` 写入内容。

备选命令行：

```powershell
node feishu_doc.mjs create "文档标题"
node batch_append.mjs <document_id> <markdown_file_path>
```

写入时自动转换为飞书原生格式：
- `##` → heading1（飞书一级标题），`###` → heading2，以此类推
- `# 文档标题` → 跳过（不写入内容，文档自身标题已代表）
- 标题自动加编号前缀（1.、1.1.、1.1.1.）
- Markdown 表格 → 飞书原生 table（带表头、均等列宽）
- `- 列表项` → 飞书原生无序列表
- `1. 列表项` → 飞书原生有序列表
- `**加粗**` → 加粗文字
- `> 引用` → 普通文本

### 2. 精确更新单个块（不影响其他内容）

先用 `list_blocks` 定位目标块（可传 `filter_text` 按文字筛选，返回的 `text_preview` 用于确认），再用 `update_block` 改写该块。`text` 支持 `**加粗**`。

适用场景：用户说「把 XX 改成 YY」时，只改对应的块，不重写全文。

### 3. 清空并重写（结构性修改时）

先 `clear_document`（必须带 `confirm: true`，否则返回将被删除的块数和前 5 条预览供确认），再 `write_markdown` 重新写入。

仅在标题层级、表格结构等整体性调整时使用。日常修改用「精确更新」。

### 4. 插入可编辑的原生画板流程图（SVG → 飞书画板）

把流程图作为**飞书原生画板**插入文档，用户可在文档内直接双击编辑（拖拽节点、改文字、加分支），而不是静态图片。

**首选 `insert_flowchart` 工具**。只给节点和连线，布局、直角折线、连接点对齐都自动算好：

```json
{
  "document_id": "<doc_id>",
  "anchor_text": "下面是同步流程",
  "flow": {
    "nodes": [
      { "id": "src",   "text": "飞书通讯录" },
      { "id": "check", "text": "单点系统是否存在该用户?" },
      { "id": "sync",  "text": "同步到人员数据清单" },
      { "id": "skip",  "text": "不同步不展示" }
    ],
    "edges": [
      { "from": "src",   "to": "check" },
      { "from": "check", "to": "sync", "label": "是" },
      { "from": "check", "to": "skip", "label": "否" }
    ]
  }
}
```

工具行为：

- 层级布局按最长路径分层，同层水平居中排布，不重叠
- 形状默认 `round_rect`；出度 ≥ 2 的节点自动用 `diamond`，也可用 `shape` 显式指定（`round_rect`/`rect`/`diamond`/`ellipse`）
- 竖直堆叠的两个节点连直线（自动吸附到同一 x，确保精确垂直）；分支走两层中间的水平总线，折成直角
- `label` 渲染成分支旁的文字节点，左分支标签在左、右分支在右
- `anchor_text` 匹配不到时追加到文末，并在 `warnings` 里说明
- `replace_existing: true` 会先删除文档中已有的画板块和图片块
- 连线引用了不存在的节点 id 时返回 `INVALID_ARGUMENT`，并列出无效引用，不创建任何内容

**备选：SVG 转换**（`node svg_to_board.mjs <doc_id> <svg> ["锚点文字"]`）适合已有复杂 SVG 的场景，但生成的连接线是游离坐标、不一定对齐连接点。

底层实现原理（`lib/board.mjs`，改动时需要了解）：
1. 用 `block_type: 43` + `board: {}` 在文档中创建原生画板块，返回 `whiteboard_id`（可指定 `index` 插入位置、`board.align`/`board.width`）
2. `POST /board/v1/whiteboards/{whiteboard_id}/nodes` 先建**形状节点**（`composite_shape`），拿回节点 id
3. 再建**连接线节点**（`connector`）和**文字节点**（`text_shape`）

**形状节点（composite_shape）：**
- `composite_shape.type`：`round_rect`（流程框/开始结束）、`diamond`（判断框）、`ellipse` 等
- `x/y/width/height` 绝对坐标；`text: { text }` 为框内文字
- **默认配色**：不要传 `style.fill_color`，省略 style 即用平台默认（白底黑框黑字），不要堆砌颜色

**连接线节点（connector）—— 关键格式（踩坑总结）：**
- `connector.shape` 枚举仅四种：`straight`（直线）、`polyline`（折线）、`curve`（曲线）、`right_angled_polyline`（自动直角，会忽略你给的折点自行路由，慎用）
- `start.position` / `end.position` 用**绝对坐标**
- ⚠️ **`turning_points` 折点必须是相对于连接线 `x,y` 原点（=包围盒左上角）的相对坐标**，传绝对坐标会导致线跑飞！（`build_flow.mjs` 的 `mkConnector` 已封装：传绝对折点，内部自动换算相对值）
- 连接线的 `x/y/width/height` = 起点、终点、所有折点的包围盒
- `end.arrow_style: "line_arrow"` 出箭头，`start.arrow_style: "none"`
- `width` 不能为负 —— `x` 取 min、`width` 取 abs

**连接点对齐**：菱形连接点是 4 个顶点（top/bottom/left/right 中点），矩形是 4 条边中点。让 connector 的坐标精确落在这些点上，视觉才"连上"。判断分支推荐"分支总线"布局：判断框底部往下一条竖线到中间高度，左右分叉成水平总线，再各自 90° 下折进目标框顶部。

**⚠️ 绑定限制**：GUI 手动连的线用 `attached_object`（带 `snap_to`）真正绑定形状，拖动时线会跟随；但**创建接口不接受绑定字段**（报 `2890002 invalid arg`），API 只能用坐标定位。视觉一致，但拖动框时线不跟随——这是 API 能力边界。

**前置条件：** 飞书授权 scope 需包含 `board:whiteboard:node:create board:whiteboard:node:read`（已配置在 DEFAULT_SCOPES；若报 `99991679` 权限错误，执行 `node feishu_doc.mjs login` 重新授权）。

**回读延迟**：刚创建完画板立即调 `GET /board/v1/whiteboards/{id}/nodes` 可能返回 `2890007`，等 1~2 秒重试即可，不是错误。

**实测默认配色**：省略 `style` 后平台默认给 `round_rect` 浅蓝底（`#f0f4fc`）、`diamond` 浅黄底（`#fef1ce`），不是纯白。

### 5. 备选命令行操作

| 命令 | 功能 |
|------|------|
| `node feishu_doc.mjs create "标题"` | 创建新文档（默认外部可编辑） |
| `node feishu_doc.mjs share <doc_id>` | 对已有文档开启公开分享（外部可编辑） |
| `build_flow.mjs`（参考实现） | 手写画板节点的示例，逻辑已封装进 `insert_flowchart` |
| `node svg_to_board.mjs <doc_id> <svg> [锚点文字]` | SVG 转画板（复杂图备选，连接线可能不对齐） |
| `node feishu_doc.mjs check` | 检查 .env 中的文档是否可读 |
| `node feishu_doc.mjs login` | 重新授权（token 过期或缺少画板权限时） |

> ⚠️ **权限说明**：所有新建文档默认设为「获得链接的任何人（含外部人员）可编辑」。如需限制为仅可读或仅内部，需单独调整 `setPublicSharing` 的 `link_share_entity` 参数。

---

## 路径

- MCP Server：`feishu/mcp-server/index.mjs`，已注册在 `.mcp.json` 的 `feishu-doc` 条目
- 备选命令行：所有命令在 `feishu/` 目录下执行

---

## PRD 撰写后自动发布到飞书（与主持人联动）

### 触发时机

PRD 的输出形式（本地 MD / 飞书文档）已在 `prd-assistant` 阶段四确认。当用户确认「发布到飞书」，且 PRD 撰写完成（通过质量检查后），即可发布到飞书。

**本工作区策略**：输出形式不在本技能重复询问，由 `prd-assistant` 生成前统一确认。一旦确认走飞书，用户说“同步到飞书 / 发布到飞书 / 发飞书”即视为立即执行指令，必须在同一轮直接创建或更新原飞书文档，不再二次确认；仅当用户明确说“暂不发布 / 不发飞书 / 不同步”时跳过。

### 执行流程

1. PRD Markdown 文件已在 `PRD文档/` 目录下生成
2. 调用 `create_document`，`title` 为 `PRD-[功能名称]`（自动开启外部可编辑）
3. 调用 `write_markdown`，把 PRD Markdown 内容写入返回的 `document_id`
4. **如果 PRD 含流程图**：调用 `insert_flowchart`，把流程整理成节点加连线，用 `anchor_text` 定位插入位置（不要用 mermaid 代码块或静态图片）
5. 输出文档链接给用户

### 后续修改

如果用户对飞书文档提出修改意见：
- **小改**（改某段文字/某个字段说明）→ `list_blocks` 定位 `block_id` → `update_block`
- **大改**（调整章节结构/重排表格）→ `clear_document`（带 `confirm: true`）→ `write_markdown`

---

## 输出格式

创建并写入完成后输出：

```
📄 飞书文档已发布

标题：[文档标题]
链接：[文档 URL]
权限：获得链接的任何人（含外部人员）可编辑
内容：[N] 个内容块已写入（含 [X] 个表格、[Y] 个标题、[Z] 个可编辑画板流程图）

如需修改，告诉我具体要改哪里，我会精确更新对应内容。
```

---

## 飞书机器人通知（PRD 发布后按需推送）

PRD 文档创建并写入完成后，如需通知，在 `feishu/` 目录执行：

```bash
node notify.mjs "📄 PRD 已发布 | 文档名称：[PRD标题] | URL：[飞书文档链接] | 需求简介：[一句话概括需求目标]"
```

> 💡 未配置 `FEISHU_BOT_WEBHOOK` 时脚本静默跳过，不影响发布流程。

通知格式：
- 文档名称：PRD 标题
- URL：飞书文档链接
- 需求简介：一句话说明这个需求做什么

---

## 注意事项

- Token 有效期内自动续期。工具返回 `AUTH_REQUIRED` 或 `AUTH_EXPIRED` 时，提示用户在 `feishu/` 目录执行 `node feishu_doc.mjs login` 重新授权；可先用 `auth_status` 确认状态
- MCP 工具统一返回 `{ ok, data }` 或 `{ ok: false, error: { code, message } }`，`code` 取值：`AUTH_REQUIRED`、`AUTH_EXPIRED`、`PERMISSION_DENIED`、`RATE_LIMITED`、`INVALID_ARGUMENT`、`NOT_FOUND`、`CONFIRMATION_REQUIRED`、`UPSTREAM_ERROR`、`INTERNAL_ERROR`
- 表格列宽默认均等分配，总宽 800px
- 标题自动带数字编号前缀（1.、1.1.、1.1.1.），不依赖飞书的自动编号功能
- 第 62 块（某些复杂表格）创建可能失败，会被跳过并报告
- 建议用户创建后在飞书文档设置中开启「标题编号」以获得最佳效果
- **画板流程图**：`block_type 43` 可通过 API 创建画板并往里画节点（形状/连接线），但「创建空画板文件」的独立 API（`/board/v1/whiteboards`）在部分租户返回 404；必须走「文档内画板块」这条路。图片方式（mermaid 渲染成 PNG 插入）只作为无画板权限时的降级方案，且图片不可编辑
- **权限**：新建文档默认外部可编辑（`link_share_entity: anyone_editable`）；若只想公开可读，把该参数改回 `anyone_readable`
- **重复写入风险**：`write_markdown` 和 `batch_append.mjs` 都是追加模式；重写文档前必须先 `clear_document`，否则内容会重复累积
