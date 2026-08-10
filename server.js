const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? path.join("/tmp", "heigen-data") : path.join(ROOT, "data"));
const STORE_PATH = path.join(DATA_DIR, "store.json");

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();
const PORT = Number(process.env.PORT || 4173);
const INTEL_MAX_ITEMS = Number(process.env.INTEL_MAX_ITEMS || 8);
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "";
const MODEL_PROVIDER_ORDER = (process.env.MODEL_PROVIDER_ORDER || "ollama,openai,anthropic")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const SOURCE_TIERS = [
  { tier: 1, type: "official", label: "官方/监管", weight: 0.95, reliability: "high" },
  { tier: 2, type: "database", label: "行业数据库", weight: 0.85, reliability: "high" },
  { tier: 3, type: "news", label: "新闻媒体", weight: 0.72, reliability: "medium" },
  { tier: 4, type: "social", label: "社交信号", weight: 0.45, reliability: "low" },
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const defaultStore = () => ({ sessions: [] });

let storeWriteQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

async function ensureStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    await fsp.writeFile(STORE_PATH, JSON.stringify(defaultStore(), null, 2), "utf8");
  }
}

async function readStore() {
  await ensureStore();
  const raw = (await fsp.readFile(STORE_PATH, "utf8")).replace(/^\uFEFF/, "");
  if (!raw.trim()) return defaultStore();
  try {
    return JSON.parse(raw);
  } catch {
    const backup = `${STORE_PATH}.corrupt.${Date.now()}`;
    await fsp.writeFile(backup, raw, "utf8");
    const fresh = defaultStore();
    await writeStore(fresh);
    return fresh;
  }
}

async function writeStore(store) {
  await ensureStore();
  await fsp.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

async function withStore(mutator) {
  const run = storeWriteQueue.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await writeStore(store);
    return result;
  });
  storeWriteQueue = run.catch(() => {});
  return run;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(sanitizePayload(JSON.parse(raw)));
      } catch (error) {
        reject(new Error("JSON 格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function sanitizePayload(value) {
  if (typeof value === "string") return value.replace(/\u0000/g, "").trim();
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = sanitizePayload(child);
    return result;
  }
  return value;
}

function decodeHtml(value = "") {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function pickTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeHtml(match ? match[1] : "");
}

function compact(text, size = 120) {
  if (!text) return "";
  return text.length <= size ? text : `${text.slice(0, size)}…`;
}

function toIsoDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function sourceTierByType(type) {
  return SOURCE_TIERS.find((item) => item.type === type) || SOURCE_TIERS[SOURCE_TIERS.length - 1];
}

function normalizeIntelEntry(entry, defaults = {}) {
  const sourceType = entry.sourceType || defaults.sourceType || "news";
  const tier = sourceTierByType(sourceType);
  const publishedAt = toIsoDate(entry.publishedAt || defaults.publishedAt || "");
  return {
    source: entry.source || defaults.source || "Unknown",
    sourceType,
    sourceTier: tier.tier,
    confidence: typeof entry.confidence === "number" ? entry.confidence : (defaults.confidence || tier.weight),
    title: compact(entry.title || defaults.title || "", 150),
    url: entry.url || defaults.url || "",
    publishedAt,
    snippet: compact(entry.snippet || defaults.snippet || "", 180),
  };
}

function inferDomain(text) {
  if (/求职|简历|岗位|面试|招聘|internship|resume|job matching|recruit|hiring/i.test(text)) return "求职与招聘服务";
  if (/签证|移民|出海|海外|visa|immigration|cross-border|go global|global expansion/i.test(text)) return "跨境与出海服务";
  if (/电商|商品|店铺|e-?commerce|marketplace|store/i.test(text)) return "电商与交易服务";
  if (/教育|课程|培训|学生|education|course|training|student/i.test(text)) return "教育服务";
  return "通用创业服务";
}

function inferTargetUser(text) {
  const patterns = [
    /(大学生|应届生|自由职业者|小微商家|中小企业|家长|教师|开发者|跨境卖家|创业者|students?|graduates?|freelancers?|small businesses?|smbs?|parents?|teachers?|developers?|sellers?)/i,
    /(?:为|给|帮助|面向|针对)([^，。,.]{2,18})(?:提供|解决|做|找|，|。|,)/,
    /(?:for|help|serve|target)\s+([a-z0-9\s-]{3,32})\s+(?:with|to|by|who|and|,|\.|$)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1] || match[0];
  }
  return "待进一步细分用户";
}

function inferProblem(text) {
  const match = text.match(/(?:不知道|难以|很难|无法|痛点|问题是|struggle to|hard to|difficult to|can't|cannot|problem is)([^。！？!?]{3,80})/i);
  return match ? compact(match[0], 70) : compact(text, 70);
}

function inferMarketType(domain, text) {
  if (/求职|招聘|教育培训|外卖|电商|recruit|job|edtech|food delivery|e-?commerce/i.test(text)) return "国内偏红海：竞争密集，需强差异化切入。";
  if (/出海|非洲|中东|拉美|africa|middle east|latam|southeast asia|overseas/i.test(text)) return "区域错位机会：国内红海场景在新兴市场可能出现蓝海窗口。";
  if (domain === "跨境与出海服务") return "中性市场：合规与本地化能力决定壁垒。";
  return "中性偏红：先验证细分需求，避免大而全。";
}

function buildDifferentiation(domain, text) {
  if (/求职|简历|岗位|internship|resume|job matching|hiring/i.test(text)) {
    return [
      "从“写简历工具”升级为“拿到面试结果工具”：围绕面试邀约率优化，而不是只做文本润色。",
      "建立岗位匹配解释层：给出匹配分和不匹配原因（技能缺口、项目缺口、经历映射）。",
      "聚焦单一场景先做深：例如“应届生互联网产品岗”，用细分领域模型形成壁垒。",
    ];
  }
  if (/签证|出海|海外|visa|immigration|cross-border|go global/i.test(text)) {
    return [
      "以“任务完成率”而非“信息罗列”做产品：把申请流程拆成节点并自动检查缺失材料。",
      "绑定官方渠道链接和更新监控，突出“版本及时性”和“流程准确率”。",
      "针对单一国家+单一签证类型先打透，再横向复制。",
    ];
  }
  return [
    "选择一个细分用户群作为滩头市场，先拿到可复用的成交案例。",
    "围绕一个核心指标做产品（例如转化率、复购率、处理时长），避免功能堆砌。",
    "通过数据反馈闭环形成壁垒：每次服务结果反哺推荐策略与运营策略。",
  ];
}

function buildMonetization(domain, text) {
  if (/求职|招聘|简历|internship|resume|job matching|recruit/i.test(text)) {
    return [
      "B2C 订阅：按月会员（简历优化+岗位匹配+投递策略）。",
      "按结果付费：拿到面试邀约后收取成功服务费。",
      "B2B2C：与高校就业中心/培训机构合作，按席位授权。",
    ];
  }
  if (/签证|出海|海外|visa|immigration|cross-border|go global/i.test(text)) {
    return [
      "按申请流程收费：基础版（自助）+专业版（材料审查辅导）。",
      "企业套餐：为出海团队提供批量流程管理与合规提醒。",
      "生态分成：与翻译、保险、海外服务商合作分佣。",
    ];
  }
  return [
    "订阅制：稳定现金流，适合持续服务类产品。",
    "交易抽佣：适合撮合型平台，和业务规模联动。",
    "企业年费：适合 B2B 场景，便于长期续约。",
  ];
}

function buildGoGlobal(text) {
  if (/非洲|出海|海外|africa|overseas|cross-border|go global/i.test(text)) {
    return "可行，但必须先完成国家级落地验证：先选 1 个国家、1 个行业、1 个渠道伙伴，再做本地支付、语言和合规适配。";
  }
  return "若国内竞争过于激烈，可做“区域错位”：优先评估东南亚/非洲的同类需求成熟度、支付能力和合规门槛，再决定是否出海。";
}

function buildExecutionLinks(text) {
  const links = [];
  if (/新西兰|new zealand|\bnz\b/i.test(text) && /签证|visa/i.test(text)) {
    links.push({ label: "新西兰移民局官方签证入口", url: "https://www.immigration.govt.nz/new-zealand-visas" });
    links.push({ label: "新西兰签证在线申请（RealMe 登录）", url: "https://www.immigration.govt.nz/new-zealand-visas/apply-for-a-visa" });
  }
  if (/非洲|africa|出海|海外|overseas|go global|cross-border/i.test(text)) {
    links.push({ label: "ITC Trade Map（全球进出口数据）", url: "https://www.trademap.org/" });
    links.push({ label: "世界银行开放数据（市场与宏观指标）", url: "https://data.worldbank.org/" });
    links.push({ label: "UN Comtrade（国际贸易数据）", url: "https://comtradeplus.un.org/" });
  }
  if (/api|接口|对接|integration|sdk/i.test(text)) {
    links.push({ label: "RapidAPI Hub（可用第三方 API 市场）", url: "https://rapidapi.com/hub" });
    links.push({ label: "Public APIs Index（公共 API 列表）", url: "https://github.com/public-apis/public-apis" });
  }
  if (!links.length && /visa|签证/i.test(text)) {
    links.push({ label: "IATA Travel Centre（签证与入境要求）", url: "https://www.iatatravelcentre.com/" });
  }
  if (!links.length) {
    links.push({ label: "Google News 行业检索", url: "https://news.google.com/" });
  }
  return links.slice(0, 8);
}

function classifyLinkSource(url) {
  if (/\.gov|immigration\.govt\.nz|europa\.eu/i.test(url)) return "official";
  if (/worldbank|trademap|comtrade|statista|oecd|imf/i.test(url)) return "database";
  if (/news|reuters|bloomberg/i.test(url)) return "news";
  if (/rapidapi|public-apis|github/i.test(url)) return "database";
  return "news";
}

function buildIntelFromExecutionLinks(message) {
  const links = buildExecutionLinks(message);
  return links.map((item) => {
    const sourceType = classifyLinkSource(item.url);
    return normalizeIntelEntry({
      source: "Heigen curated source",
      sourceType,
      title: item.label,
      url: item.url,
      confidence: sourceTierByType(sourceType).weight,
      snippet: "基于你的场景推荐的高优先级数据源/官方入口。",
    });
  });
}

async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": "Heigen-Adviser/1.0" } });
  if (!response.ok) return [];
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 5);
  return items.map((match) => normalizeIntelEntry({
    source: "Google News",
    sourceType: "news",
    confidence: 0.72,
    title: pickTag(match[1], "title"),
    url: pickTag(match[1], "link"),
    publishedAt: pickTag(match[1], "pubDate"),
    snippet: compact(pickTag(match[1], "description"), 120),
  })).filter((entry) => entry.title && entry.url);
}

async function fetchRedditRss(query) {
  const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new`;
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": "Heigen-Adviser/1.0" } });
  if (!response.ok) return [];
  const xml = await response.text();
  const items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].slice(0, 4);
  return items.map((match) => normalizeIntelEntry({
    source: "Reddit",
    sourceType: "social",
    confidence: 0.4,
    title: pickTag(match[1], "title"),
    url: pickTag(match[1], "id"),
    publishedAt: pickTag(match[1], "updated"),
    snippet: compact(pickTag(match[1], "content"), 140),
  })).filter((entry) => entry.title && entry.url);
}

async function fetchHackerNews(query) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5`;
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": "Heigen-Adviser/1.0" } });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.hits || []).map((item) => normalizeIntelEntry({
    source: "Hacker News",
    sourceType: "social",
    confidence: 0.45,
    title: item.title || item.story_title || "",
    url: item.url || `https://news.ycombinator.com/item?id=${item.objectID}`,
    publishedAt: item.created_at || "",
    snippet: compact(item._highlightResult?.title?.value || item.title || "", 140),
  })).filter((entry) => entry.title && entry.url);
}

async function fetchXRecent(query) {
  if (!X_BEARER_TOKEN) return [];
  const requestUrl = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=created_at&expansions=author_id&user.fields=username`;
  const response = await fetchWithTimeout(requestUrl, {
    headers: {
      Authorization: `Bearer ${X_BEARER_TOKEN}`,
      "User-Agent": "Heigen-Adviser/1.0",
    },
  }, 9000);
  if (!response.ok) return [];
  const data = await response.json();
  const users = new Map((data.includes?.users || []).map((user) => [user.id, user]));
  return (data.data || []).slice(0, 4).map((tweet) => {
    const user = users.get(tweet.author_id);
    return normalizeIntelEntry({
      source: "X",
      sourceType: "social",
      confidence: 0.42,
      title: compact(tweet.text || "", 90),
      url: user?.username ? `https://x.com/${user.username}/status/${tweet.id}` : `https://x.com/i/web/status/${tweet.id}`,
      publishedAt: tweet.created_at || "",
      snippet: compact(tweet.text || "", 150),
    });
  }).filter((entry) => entry.title && entry.url);
}

function flatRelatedTopics(topics) {
  if (!Array.isArray(topics)) return [];
  const result = [];
  for (const topic of topics) {
    if (topic.Topics) result.push(...flatRelatedTopics(topic.Topics));
    else result.push(topic);
  }
  return result;
}

async function fetchDuckDuckGo(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": "Heigen-Adviser/1.0" } });
  if (!response.ok) return [];
  const data = await response.json();
  const records = [];
  if (data.AbstractURL && data.AbstractText) {
    records.push(normalizeIntelEntry({
      source: "DuckDuckGo",
      sourceType: "database",
      confidence: 0.58,
      title: data.Heading || query,
      url: data.AbstractURL,
      publishedAt: "",
      snippet: compact(data.AbstractText, 120),
    }));
  }
  const related = flatRelatedTopics(data.RelatedTopics).slice(0, 3);
  for (const topic of related) {
    if (!topic.FirstURL || !topic.Text) continue;
    records.push(normalizeIntelEntry({
      source: "DuckDuckGo",
      sourceType: "database",
      confidence: 0.56,
      title: compact(topic.Text, 72),
      url: topic.FirstURL,
      publishedAt: "",
      snippet: compact(topic.Text, 120),
    }));
  }
  return records;
}

function extractQuery(message) {
  const clipped = message.replace(/\s+/g, " ").trim();
  if (!clipped) return "startup market trends";
  return compact(clipped, 80);
}

async function gatherMarketIntel(message) {
  const query = extractQuery(message);
  const tasks = [fetchGoogleNews(query), fetchDuckDuckGo(query), fetchHackerNews(query), fetchRedditRss(query), fetchXRecent(query)];
  const settled = await Promise.allSettled(tasks);
  const liveIntel = settled.flatMap((item) => (item.status === "fulfilled" ? item.value : []));
  const curatedIntel = buildIntelFromExecutionLinks(message);
  const merged = dedupeIntel([...liveIntel, ...curatedIntel]);
  const ranked = merged.sort((a, b) => scoreIntel(b) - scoreIntel(a));
  return ranked.slice(0, INTEL_MAX_ITEMS);
}

function dedupeIntel(entries) {
  const result = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry?.url) continue;
    const key = entry.url.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function scoreIntel(entry) {
  const tierBoost = Math.max(0, 1 - (entry.sourceTier - 1) * 0.08);
  const recencyBoost = entry.publishedAt
    ? Math.max(0, 1 - ((Date.now() - new Date(entry.publishedAt).getTime()) / (1000 * 60 * 60 * 24 * 30)))
    : 0.2;
  return (entry.confidence * 0.8) + (tierBoost * 0.12) + (recencyBoost * 0.08);
}

function rankedSourceOverview() {
  return SOURCE_TIERS.map((item) => ({
    tier: item.tier,
    type: item.type,
    label: item.label,
    reliability: item.reliability,
    weight: item.weight,
  }));
}

function availableSourceProviders() {
  return [
    { key: "google-news-rss", enabled: true, type: "news", authRequired: false },
    { key: "duckduckgo", enabled: true, type: "database", authRequired: false },
    { key: "hacker-news", enabled: true, type: "social", authRequired: false },
    { key: "reddit-rss", enabled: true, type: "social", authRequired: false },
    { key: "x-recent-search", enabled: Boolean(X_BEARER_TOKEN), type: "social", authRequired: true },
  ];
}

function availableModelProviders() {
  return [
    {
      key: "ollama",
      enabled: Boolean(OLLAMA_MODEL),
      requiresKey: false,
      model: OLLAMA_MODEL || "",
      baseUrl: OLLAMA_BASE_URL,
      note: "本地模型，零 API 成本（需本机运行 Ollama）",
    },
    {
      key: "openai-compatible",
      enabled: Boolean(process.env.OPENAI_API_KEY),
      requiresKey: true,
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      baseUrl: OPENAI_BASE_URL,
      note: "支持 OpenAI 兼容接口（可切换到国内兼容服务）",
    },
    {
      key: "anthropic",
      enabled: Boolean(process.env.ANTHROPIC_API_KEY),
      requiresKey: true,
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
      baseUrl: "https://api.anthropic.com/v1/messages",
      note: "高质量兜底模型",
    },
  ];
}

async function callModelProvider(provider, prompt) {
  if (provider === "ollama") return callOllama(prompt);
  if (provider === "openai") return callOpenAI(prompt);
  if (provider === "anthropic") return callAnthropic(prompt);
  return null;
}

function safeJsonParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function callOpenAI(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const response = await fetchWithTimeout(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: payload,
    }),
  }, 15000);
  if (!response.ok) return null;
  const data = await response.json();
  return safeJsonParse(data?.choices?.[0]?.message?.content || "");
}

async function callOllama(payload) {
  if (!OLLAMA_MODEL) return null;
  const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: "json",
      options: { temperature: 0.2 },
      messages: payload,
    }),
  }, 20000);
  if (!response.ok) return null;
  const data = await response.json();
  const content = data?.message?.content || "";
  return safeJsonParse(content);
}

async function callAnthropic(payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  const system = payload.find((item) => item.role === "system")?.content || "";
  const messages = payload.filter((item) => item.role !== "system");
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0.2,
      system,
      messages,
    }),
  }, 15000);
  if (!response.ok) return null;
  const data = await response.json();
  const text = (data.content || []).map((item) => item.text || "").join("\n");
  return safeJsonParse(text);
}

function buildSystemPrompt() {
  return [
    "你是黑根（Heigen）创业商业顾问。",
    "目标：先给结论和方案，再最多问一个关键补充问题。",
    "禁止审判用户、禁止长篇问卷、禁止空泛鼓励。",
    "必须输出可执行建议：商业价值、红海蓝海判断、差异化、变现、出海策略、7/30/90天计划。",
    "引用联网信息时遵守来源权重：official > database > news > social；社交来源只能作为早期信号。",
    "如果用户提到签证/API/官方入口，必须给具体可点击链接。",
    "若信息不足，做合理假设并标注“假设前提”。",
    "输出严格 JSON，字段为：content、assessment、executionLinks、optionalQuestion。",
    "assessment 需要 targetUsers/coreProblem/evidenceState/nextAction 字段。",
  ].join("\n");
}

function buildUserPrompt({ mode, message, history, intel }) {
  const historyTail = history.slice(-6).map((item) => `${item.role}: ${item.content}`).join("\n");
  const intelText = intel.length
    ? intel.map((item, index) => `[${index + 1}] ${item.title} | ${item.source} | ${item.sourceType} | confidence=${item.confidence} | ${item.url}`).join("\n")
    : "暂无实时情报";
  return [
    `模式: ${mode}`,
    `用户输入: ${message}`,
    `历史上下文:\n${historyTail || "无"}`,
    `联网情报:\n${intelText}`,
    "请直接给出：",
    "1) 商业价值判断（明确结论）",
    "2) 市场判断（红海/蓝海+依据）",
    "3) 差异化打法（至少3条）",
    "4) 赚钱路径（至少3条）",
    "5) 出海可行性与国家切入建议",
    "6) 7/30/90天执行方案",
    "7) 最多一个补充问题（可选）",
    "8) 结论优先使用高权重来源（official > database > news > social）",
  ].join("\n\n");
}

function heuristicAdvice({ mode, message, intel }) {
  const domain = inferDomain(message);
  const targetUsers = inferTargetUser(message);
  const coreProblem = inferProblem(message);
  const marketType = inferMarketType(domain, message);
  const differentiation = buildDifferentiation(domain, message);
  const monetization = buildMonetization(domain, message);
  const goGlobal = buildGoGlobal(message);
  const executionLinks = buildExecutionLinks(message);

  const modeBlock = mode === "bp"
    ? [
      "**BP落地建议（先做这三件）**：",
      "1. 先写执行摘要一句话：用户是谁、问题是什么、你如何解决、为什么你赢。",
      "2. 先定财务假设最小集合：单价、单位成本、首月获客量、毛利。",
      "3. 市场部分先用“可验证小市场”而不是大而空的 TAM。",
    ]
    : mode === "pitch"
      ? [
        "**路演落地建议（优先改）**：",
        "1. 开场15秒只讲痛点场景，不讲功能。",
        "2. 第3分钟前必须给出至少一个验证证据。",
        "3. 结尾给清晰诉求：要资源、资金还是渠道。",
      ]
      : mode === "qa"
        ? [
          "**答辩策略（评委视角）**：",
          "1. 每个回答先给结论，再给证据，不要先解释背景。",
          "2. 对未知问题直接承认，并给验证计划和时间点。",
          "3. 防守重点：付费意愿、获客成本、可复制增长。",
        ]
        : [];

  const content = [
    "先给你结论：这个方向有商业机会，但前提是你必须把“大而泛”的功能改成“结果导向”的细分场景产品。",
    "",
    `**商业价值判断**：${domain}存在真实需求，尤其当你能直接提升用户可感知结果（如求职邀约率、申请通过率、成交效率）时，具备付费基础。`,
    `**市场判断（红海/蓝海）**：${marketType}`,
    "**差异化打法**：",
    ...differentiation.map((item, index) => `${index + 1}. ${item}`),
    "",
    "**赚钱模型**：",
    ...monetization.map((item, index) => `${index + 1}. ${item}`),
    "",
    `**出海建议**：${goGlobal}`,
    "**7/30/90 天执行方案**：",
    "1. 7天：锁定一个细分用户群，做10-15次访谈，验证最高频痛点和现有替代方案。",
    "2. 30天：上线最小可用版本，只保留一个核心结果指标，跑首批真实用户。",
    "3. 90天：根据数据决定加价、扩渠道或转向，并形成可复用的增长模型。",
    "",
    ...modeBlock,
    ...(modeBlock.length ? [""] : []),
    intel.length ? `**最新行业线索**：已同步 ${intel.length} 条联网信息，优先跟进与你赛道最相关的2-3条。` : "**最新行业线索**：当前未抓到稳定外部信息，建议稍后重试联网检索。",
    "",
    "假设前提：以上建议基于你当前描述，未包含你尚未披露的成本结构与实际转化数据。",
  ].join("\n");

  const optionalQuestion = mode === "qa"
    ? "如果只能证明一个指标来打动评委，你准备证明“用户愿意付费”还是“用户持续留存”？"
    : "你希望我先帮你落地哪一段：差异化方案、变现方案，还是出海落地计划？";

  return {
    content,
    optionalQuestion,
    assessment: {
      targetUsers,
      coreProblem,
      evidenceState: /访谈|试点|收入|订单|客户|数据/.test(message) ? "已有初步证据，建议补强样本质量" : "证据不足，需先做小规模验证",
      nextAction: "优先定义单一细分用户 + 单一核心结果指标，再开展 7 天验证",
    },
    executionLinks,
  };
}

function mergeExecutionLinks(primary, fallback) {
  const merged = [];
  const seen = new Set();
  for (const item of [...(primary || []), ...(fallback || [])]) {
    if (!item || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    merged.push(item);
    if (merged.length >= 8) break;
  }
  return merged;
}

function ensureStructuredContent(content, fallbackContent) {
  const required = ["商业价值判断", "市场判断（红海/蓝海）", "差异化打法", "赚钱模型", "7/30/90"];
  if (content && required.every((token) => content.includes(token))) return content;
  if (!content) return fallbackContent;
  return `${fallbackContent}\n\n**模型补充判断**：${compact(content, 520)}`;
}

async function generateAdvice({ mode, message, history, intel }) {
  const fallback = heuristicAdvice({ mode, message, intel });
  const prompt = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt({ mode, message, history, intel }) },
  ];

  let llm = null;
  for (const provider of MODEL_PROVIDER_ORDER) {
    if (llm) break;
    try {
      llm = await callModelProvider(provider, prompt);
    } catch {
      llm = null;
    }
  }

  if (llm && llm.content && llm.assessment) {
    const structuredContent = ensureStructuredContent(llm.content, fallback.content);
    return {
      content: structuredContent,
      optionalQuestion: llm.optionalQuestion || fallback.optionalQuestion,
      assessment: {
        targetUsers: llm.assessment.targetUsers || fallback.assessment.targetUsers,
        coreProblem: llm.assessment.coreProblem || fallback.assessment.coreProblem,
        evidenceState: llm.assessment.evidenceState || fallback.assessment.evidenceState,
        nextAction: llm.assessment.nextAction || fallback.assessment.nextAction,
      },
      executionLinks: mergeExecutionLinks(Array.isArray(llm.executionLinks) ? llm.executionLinks.slice(0, 8) : [], fallback.executionLinks),
    };
  }

  return fallback;
}

function createSessionRecord({ mode = "validation", title = "" }) {
  const timestamp = nowIso();
  return {
    id: makeId("sess"),
    mode,
    title: title || `黑根咨询-${mode}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastAssessment: null,
    messages: [],
  };
}

function getSession(store, sessionId) {
  return store.sessions.find((session) => session.id === sessionId);
}

async function apiHandler(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, now: nowIso() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/intel/sources") {
    sendJson(res, 200, {
      ranking: rankedSourceOverview(),
      providers: availableSourceProviders(),
      note: "建议优先采用官方与数据库来源，社交来源仅用于发现早期信号。",
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/model/providers") {
    sendJson(res, 200, {
      order: MODEL_PROVIDER_ORDER,
      providers: availableModelProviders(),
      note: "推荐国内低成本方案：ollama(qwen) 为主，openai-compatible(通义/DeepSeek) 为辅，anthropic 兜底。",
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/sessions") {
    const store = await readStore();
    const sessions = [...store.sessions]
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .map((session) => ({
        id: session.id,
        mode: session.mode,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
      }));
    sendJson(res, 200, { sessions });
    return;
  }

  if (req.method === "POST" && pathname === "/api/sessions") {
    const body = await parseBody(req);
    const session = await withStore((store) => {
      const record = createSessionRecord({ mode: body.mode, title: body.title });
      store.sessions.push(record);
      return record;
    });
    sendJson(res, 201, { session });
    return;
  }

  if (req.method === "POST" && pathname === "/api/reset") {
    await withStore((store) => {
      store.sessions = [];
      return true;
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  const detailMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    const sessionId = detailMatch[1];
    const store = await readStore();
    const session = getSession(store, sessionId);
    if (!session) {
      sendJson(res, 404, { error: "会话不存在" });
      return;
    }
    sendJson(res, 200, { session });
    return;
  }

  if (req.method === "POST" && pathname === "/api/advice") {
    const body = await parseBody(req);
    const text = String(body.message || "").trim();
    if (!text) {
      sendJson(res, 400, { error: "message 不能为空" });
      return;
    }

    const intel = await gatherMarketIntel(text).catch(() => []);
    const result = await withStore(async (store) => {
      let session = getSession(store, body.sessionId);
      if (!session) {
        session = createSessionRecord({ mode: body.mode || "validation", title: `黑根咨询-${body.mode || "validation"}` });
        store.sessions.push(session);
      }
      const userEntry = {
        id: makeId("msg"),
        role: "user",
        content: text,
        createdAt: nowIso(),
        metadata: { mode: body.mode || session.mode, timezone: body.timezone || "" },
      };
      session.messages.push(userEntry);

      const advice = await generateAdvice({
        mode: body.mode || session.mode,
        message: text,
        history: session.messages,
        intel,
      });

      const assistantContent = advice.optionalQuestion
        ? `${advice.content}\n\n关键补充问题：${advice.optionalQuestion}`
        : advice.content;

      const assistantEntry = {
        id: makeId("msg"),
        role: "assistant",
        content: assistantContent,
        createdAt: nowIso(),
        metadata: {
          assessment: advice.assessment,
          executionLinks: advice.executionLinks,
          intel,
        },
      };
      session.messages.push(assistantEntry);
      session.lastAssessment = advice.assessment;
      session.updatedAt = nowIso();
      return { session, assistant: advice, intel };
    });

    sendJson(res, 200, {
      session: {
        id: result.session.id,
        mode: result.session.mode,
        title: result.session.title,
      },
      assistant: result.assistant,
      intel: result.intel,
    });
    return;
  }

  sendJson(res, 404, { error: "未知 API 路径" });
}

async function serveStatic(req, res, pathname) {
  let relativePath = pathname === "/" ? "/index.html" : pathname;
  relativePath = decodeURIComponent(relativePath);
  const filePath = path.resolve(ROOT, `.${relativePath}`);
  if (!filePath.startsWith(ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Not Found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME_TYPES[ext] || "application/octet-stream";
  const content = await fsp.readFile(filePath);
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(content);
}

async function handleRequest(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = requestUrl;
    if (pathname.startsWith("/api/")) {
      await apiHandler(req, res, pathname);
      return;
    }
    if (req.method !== "GET") {
      sendText(res, 405, "Method Not Allowed");
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "内部错误" });
  }
}

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Heigen server running at http://localhost:${PORT}`);
  });
}

module.exports = handleRequest;
module.exports.handleRequest = handleRequest;
