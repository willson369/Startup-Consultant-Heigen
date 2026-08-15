# 黑根方案设计

## 设计原则

严格复用 `pbathuri/entrepreneur-persona-llm` 的设计模式：以模型无关的 `SKILL.md` 作为核心逻辑，以 `references/` 提供按需上下文，以 `assets/` 提供可复制模板。该参考项目本身不是 Web 应用，因此黑根不引入额外的前端框架、后端服务、数据库或复杂业务逻辑。

## 模块划分

| 模块 | 文件/职责 | 说明 |
| --- | --- | --- |
| 核心指导层 | `skills/heigen-advisor/SKILL.md` | 定义人格、边界、分步工作流、BP 结构、评分规则和输出要求 |
| 参考知识层 | `references/` | 提供创意验证框架、创业大赛评审量表、评委问题库 |
| 输出模板层 | `assets/` | 提供 BP 与路演脚本的固定 Markdown 结构 |
| 宿主会话层 | 用户选用的 LLM 产品 | 负责消息展示、历史会话持久化和文档下载；不属于本提示词包实现 |

## 数据流向图（文字描述）

```text
用户输入创业信息或选择工作模式
  -> 宿主 LLM 产品将当前会话、SKILL.md 与相关参考资料交给模型
  -> SKILL.md 判断模式：问题发现 / BP 梳理 / 路演 / 模拟答辩
  -> 模型按当前阶段只提出必要的结构化问题
  -> 用户补充信息
  -> 模型将信息归入 BP 字段，并标记“假设”或“证据”
  -> 模型引用对应模板生成阶段性 Markdown 输出
  -> 宿主 LLM 产品保存用户与助手消息作为历史记录
  -> 用户请求导出时，宿主将生成的 Markdown 下载为 BP 或路演文档
```

## 结构化对话流

1. **开始与模式识别**：确认用户是要梳理 BP、验证创意、生成路演，还是模拟答辩。
2. **问题发现**：收集具体用户、痛点频率、严重度、当前替代方案；未达到清晰标准不进入方案设计。
3. **方案与商业模式**：明确产品机制、差异化、最小版本、前十名客户路径、收费机制与创始人契合度。
4. **证据审查**：将每个主张分类为事实、证据支持的结论或待验证假设，并指定验证方法。
5. **BP 逐段补全**：按照七段结构，每次补全一个字段并反馈当前草稿。
6. **路演或答辩**：仅在核心商业逻辑足够清晰时生成脚本或开始高压问答；输出评分和可执行改进动作。

## 关键接口定义

接口定义为宿主 LLM 产品与提示词包之间的逻辑契约，不要求新增服务端接口。

### `startSession`

```ts
type SessionMode = "bp" | "validation" | "pitch" | "qa";

interface StartSessionInput {
  mode: SessionMode;
  ventureName?: string;
  initialContext: string;
}

interface StartSessionOutput {
  stage: string;
  assistantMessage: string;
  nextQuestion: string;
}
```

### `continueSession`

```ts
interface ContinueSessionInput {
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  ventureState: Record<string, unknown>;
}

interface ContinueSessionOutput {
  assistantMessage: string;
  ventureState: Record<string, unknown>;
  evidenceGaps: string[];
  nextQuestion: string;
}
```

### `exportDocument`

```ts
type ExportType = "business-plan" | "pitch-script";

interface ExportDocumentInput {
  type: ExportType;
  ventureState: Record<string, unknown>;
}

interface ExportDocumentOutput {
  filename: string;
  mimeType: "text/markdown";
  content: string;
}
```

### `runJudgeGauntlet`

```ts
interface JudgeGauntletInput {
  ventureState: Record<string, unknown>;
  priorAnswers?: Array<{ question: string; answer: string }>;
}

interface JudgeGauntletOutput {
  questions: string[];
  scores: Array<{ dimension: string; score: 1 | 2 | 3 | 4 | 5; rationale: string }>;
  twoPriorityActions: string[];
}
```

## 历史与导出

历史对话由承载该提示词包的 LLM 产品原生会话功能保存；每轮会话保留 `ventureState` 的结构化摘要以恢复步骤。导出通过将当前生成内容或模板填充结果保存为 Markdown 完成。

