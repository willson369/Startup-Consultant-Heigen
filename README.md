# 黑根 AI 创业计划指导顾问

“黑根”是面向早期创业者的企业化顾问 Web 应用：支持会话持久化、联网行业检索、可选大模型推理，并先给建议再最小化追问，帮助用户判断项目是否有商业价值。

项目同时保留 `pbathuri/entrepreneur-persona-llm` 的 `SKILL.md + references + assets` 设计模式，用于提示词工程。

## 运行网页

1. `node server.js`
2. 打开 `http://localhost:4173`
3. 必须配置真实通义密钥，否则接口会拒绝给出模板化建议：
   - 复制 `.env.example` 为 `.env`
   - 在阿里云百炼控制台创建 API-KEY
   - 填写 `DASHSCOPE_API_KEY=sk-...`
   - 默认模型 `qwen-plus`，并开启 `ENABLE_WEB_SEARCH=true`

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
