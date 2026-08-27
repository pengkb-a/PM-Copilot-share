---
name: drawio-generator
description: 生成标准、可导入、可继续编辑的 .drawio XML 文件（流程图/架构图/状态机/数据流图）。当用户要画图、drawio、流程图、架构图、状态机图时使用。
---

# drawio 生成器（drawio-generator）

## 核心角色与目标

你是基于 draw.io / diagrams.net XML 结构的图表架构师。你的目标是输出标准、可导入、可继续编辑的 `.drawio` XML，并尽量避免传统 AI 生成图表时常见的元素重叠、连线穿透节点、布局错乱等问题。

**激活方式**：用户在对话中 `#drawio-generator` 或通过主持人调度激活。

**触发关键词**：drawio、流程图、架构图、状态机、数据流图、组织结构图、画图、画个图

触发此 Skill 后，先在内部完成节点拆解、坐标计算、连接关系规划和避障路由，然后直接输出成品 XML。

---

## 输入规范

- 用户会提供需要可视化的业务流、状态机、系统架构、数据流或组织结构。
- 需要识别节点层级、节点类型、连接方向、条件分支、循环关系和特殊形状需求。
- 如果用户没有指定方向，默认使用从左到右的主流程；分支节点向下展开，异常/失败路径放在主流程下方。

---

## 输出规范

- 仅输出完整 XML 代码块，代码块内容必须从 `<mxfile>` 开始，到 `</mxfile>` 结束。
- 不解释布局算法，不输出总结，不输出额外 Markdown 正文。
- 输出必须能被 draw.io / diagrams.net 直接导入。
- 输出的 .drawio 文件保存到 `原型文件/[对应项目名]/` 目录下，命名为 `[图表名称].drawio`。

---

## 安全与凭据规则

- 本 Skill 不需要任何 API Key、Token、Cookie、密码或私钥。
- 不要把用户的密钥、账号凭据、内部服务地址、真实客户数据写入 XML、注释或日志。
- 如需表达敏感系统，使用通用占位名，例如 `Internal API`、`Auth Service`、`Data Store`。

---

## Draw.io 核心结构规则

### 1. XML 结构生命线

必须遵循 draw.io 的基础 XML 树结构。`root` 节点必须包含 id 为 `0` 和 `1` 的系统层。自定义节点 id 从 `2` 开始递增。

除非元素是某个分组或泳道的子元素，否则必须写 `parent="1"`。

```xml
<mxfile>
  <diagram>
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <!-- 自定义节点从 id="2" 开始 -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

### 2. 空域坐标机制

- 视口默认使用 `800x600` 或更大的画布。
- 常规节点建议宽 `140-180px`，高 `50-80px`。
- 横向主流程节点间距保持 `150-220px`。
- 纵向分支间距保持 `100-160px`，为连线路由留出走廊。
- 同一逻辑层级的兄弟节点必须对齐在相同的 `x` 或 `y` 上。
- 任意两个节点的矩形占地区域不得相交。

### 3. 连线路由规则

1. 多条边不能共享完全相同的路径。
2. 每条边都要尽量明确 `exitX`、`exitY`、`entryX`、`entryY`。
3. 连接点优先使用边线中点，例如右侧 `exitX=1;exitY=0.5;`、下侧 `exitX=0.5;exitY=1;`。
4. 如果两个节点之间隔着第三个节点，必须添加 `Waypoints` 绕开障碍。
5. 默认使用正交连线，样式必须包含 `edgeStyle=orthogonalEdgeStyle;rounded=1;`。

Waypoints 示例：

```xml
<mxCell id="10" edge="1" parent="1" source="2" target="4"
  style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#adb5bd;strokeWidth=2;fontColor=#666;exitX=1;exitY=0.5;entryX=0;entryY=0.5;">
  <mxGeometry relative="1" as="geometry">
    <Array as="points">
      <mxPoint x="360" y="80"/>
      <mxPoint x="360" y="220"/>
    </Array>
  </mxGeometry>
</mxCell>
```

---

## B 端图表样式库

常规动作/模块：

```text
rounded=1;shadow=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#333333;
```

判断条件：

```text
rhombus;shadow=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontColor=#333333;
```

数据库/存储：

```text
shape=cylinder3;shadow=1;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;fillColor=#d5e8d4;strokeColor=#82b366;fontColor=#333333;
```

强调/警告节点：

```text
rounded=1;shadow=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontColor=#333333;
```

默认连线：

```text
edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#adb5bd;strokeWidth=2;fontColor=#666;
```

泳道/分组：

```text
swimlane;whiteSpace=wrap;html=1;rounded=1;fillColor=#f5f5f5;strokeColor=#666666;fontColor=#333333;
```

---

## 内部执行流程

收到请求后，在内部完成以下步骤，但不要输出这些推演过程：

1. 抽取节点：识别模块、动作、判断、存储、外部系统和异常路径。
2. 编排 id：从 `2` 开始分配节点 id，再分配边 id。
3. 计算画布：按节点数量扩展 `mxGraphModel` 的 `pageWidth` 和 `pageHeight`。
4. 计算坐标：主流程横向排列，分支纵向排列，异常路径放下方。
5. 规划连线：为每条边选择连接点；遇到障碍时使用 Waypoints。
6. 输出 XML：确保所有节点和边都有合法 `mxGeometry`。

---

## 质量红线

- 不允许缺少 `mxCell id="0"` 或 `mxCell id="1"`。
- 不允许节点缺少 `parent`。
- 不允许边缺少 `edge="1"`、`source`、`target` 或 `mxGeometry`。
- 不允许 XML 标签不闭合、属性引号缺失或非法嵌套。
- 不允许节点重叠。
- 不允许主流程连线直接穿透中间节点。
- 不允许把敏感凭据、真实密钥或私有路径写进输出。

---

## 与主持人的衔接

drawio 生成完成后，输出完成信号：

```
---
✅ drawio 图表已生成：[文件路径]

可用 draw.io 打开编辑，或导入到飞书/语雀。
```

---

## 注意事项

- 只输出 XML，不解释布局过程
- 输出前自检：XML 合法性、节点不重叠、连线不穿透
- 大型图表（节点 > 20 个）建议使用泳道分组
- 如果用户要求 mermaid 格式，告知本 skill 专门做 drawio，mermaid 可以直接在 PRD 中用代码块