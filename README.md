# 黑根 AI 创业计划指导顾问

“黑根”是面向早期创业者的企业化顾问 Web 应用：支持会话持久化、联网行业检索、可选大模型推理，并先给建议再最小化追问，帮助用户判断项目是否有商业价值。

项目同时保留 `pbathuri/entrepreneur-persona-llm` 的 `SKILL.md + references + assets` 设计模式，用于提示词工程。

## 运行网页

1. `node server.js`
2. 打开 `http://localhost:4173`
3. 如需启用真实模型推理，复制 `.env.example` 并配置 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`

### 中国 + 尽量免费配置建议

优先顺序建议：

1. **本地 Ollama + Qwen（免费）**  
   - 安装 Ollama 后拉取模型：`ollama pull qwen2.5:7b-instruct`
   - `.env` 设置：`OLLAMA_MODEL=qwen2.5:7b-instruct`
2. **OpenAI-compatible 国内接口（低成本）**  
   - 例如通义千问兼容接口或 DeepSeek 兼容接口
   - 通过 `OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL` 接入
3. **Anthropic 兜底（可选）**

可用诊断接口：

- `GET /api/model/providers`：查看模型通道是否启用、调用顺序
- `GET /api/intel/sources`：查看联网信息源权重和启用状态

## 联网信息策略（防过时）

后端会分层抓取并排序来源，避免只靠单一社媒：

1. 官方/监管（最高权重）
2. 行业数据库
3. 新闻媒体
4. 社交信号（含 X/Twitter，可选）

可用接口：

- `GET /api/intel/sources`：查看当前来源分层与启用状态
- `POST /api/advice`：返回建议 + 联网情报（含 sourceType、confidence、publishedAt）

## 项目结构

```text
server.js                     # Node 后端：API、联网检索、会话存储、静态站点
index.html / styles.css / app.js
data/store.json               # 会话历史（运行时生成，不提交）
docs/
skills/heigen-advisor/        # SKILL、模板与参考资料
```

## 边界

黑根提供教育与准备用途的商业辅导，不提供具体法律意见、合同审查、融资承销、税务建议、会计记账、财务代账或投资建议。
