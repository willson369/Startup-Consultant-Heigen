const http = require("http");
const dns = require("dns");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

dns.setDefaultResultOrder("ipv4first");

const ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? path.join("/tmp", "heigen-data") : path.join(ROOT, "data"));
const STORE_PATH = path.join(DATA_DIR, "store.json");
const SKILL_DIR = path.join(ROOT, "skills", "heigen-advisor");

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

function isUsableSecret(value) {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 16) return false;
  if (/[【】]/.test(trimmed)) return false;
  if (/(必填|可选|your[-_ ]?api[-_ ]?key|placeholder|changeme|example|xxx+)/i.test(trimmed)) return false;
  return true;
}

function envFlag(name, fallback = false) {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw);
}

const PORT = Number(process.env.PORT || 4173);
const INTEL_MAX_ITEMS = Number(process.env.INTEL_MAX_ITEMS || 8);
const X_BEARER_TOKEN = isUsableSecret(process.env.X_BEARER_TOKEN) ? process.env.X_BEARER_TOKEN.trim() : "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || "").trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || "qwen-plus";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
const ENABLE_WEB_SEARCH = envFlag("ENABLE_WEB_SEARCH", true);
const DASHSCOPE_KEY = [process.env.DASHSCOPE_API_KEY, process.env.OPENAI_API_KEY].find(isUsableSecret) || "";
const ANTHROPIC_KEY = isUsableSecret(process.env.ANTHROPIC_API_KEY) ? process.env.ANTHROPIC_API_KEY.trim() : "";
const MODEL_PROVIDER_ORDER = (process.env.MODEL_PROVIDER_ORDER || "openai")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const SOURCE_TIERS = [
  { tier: 1, type: "official", label: "官方/监管", weight: 0.95, reliability: "high" },
  { tier: 2, type: "database", label: "行业数据库", weight: 0.85, reliability: "high" },
  { tier: 3, type: "news", label: "新闻媒体", weight: 0.72, reliability: "medium" },
  { tier: 4, type: "social", label: "社交信号", weight: 0.45, reliability: "low" },
  { tier: 5, type: "curated", label: "人工策展入口", weight: 0.35, reliability: "low" },
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const VERDICT_LABELS = {
  kill: "否决",
  pivot: "转向",
  narrow: "强制收窄",
  proceed: "有条件推进",
};

const defaultStore = () => ({ sessions: [] });
let storeWriteQueue = Promise.resolve();
const skillCache = { loaded: false, skill: "", validation: "", questions: "", bp: "", pitch: "" };

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function readSkillFile(relativePath) {
  try {
    return fs.readFileSync(path.join(SKILL_DIR, relativePath), "utf8");
  } catch {
    return "";
  }
}

function loadSkillCache() {
  if (skillCache.loaded) return skillCache;
  skillCache.skill = readSkillFile("SKILL.md");
  skillCache.validation = readSkillFile("references/idea-validation-frameworks.md");
  skillCache.questions = readSkillFile("references/judge-question-bank.md");
  skillCache.bp = readSkillFile("assets/business-plan-template.md");
  skillCache.pitch = readSkillFile("assets/pitch-script-template.md");
  skillCache.loaded = true;
  return skillCache;
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
      } catch {
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Heigen-Adviser/1.1 (startup research; +http://localhost)",
        Accept: "application/json, application/xml, text/xml, */*",
        ...(options.headers || {}),
      },
    });
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

function classifyLinkSource(url) {
  if (/\.gov|immigration\.govt\.nz|europa\.eu|pboc\.gov|cbirc|samr\.gov/i.test(url)) return "official";
  if (/worldbank|trademap|comtrade|oecd|imf|wikipedia|wikidata/i.test(url)) return "database";
  if (/news|reuters|bloomberg|36kr|caixin|ft\.com/i.test(url)) return "news";
  if (/rapidapi|github|hn\.algolia|ycombinator/i.test(url)) return "social";
  return "curated";
}

function hardConstraints(message) {
  const hits = [];
  if (/和ChatGPT完全一样|没有差异化|clone (of )?chatgpt|generic chatbot/i.test(message)) hits.push("无差异化复制现有巨头产品");
  if (/没有技术|无技术背景|不会写代码|团队就我一个人/.test(message)) hits.push("交付与团队能力不足");
  if (/没有用户|零用户|也没有用户/.test(message)) hits.push("零用户零证据");
  if (/免费给所有人|靠广告赚钱/.test(message)) hits.push("免费+广告的单位经济通常不成立");
  if (/信用卡|放贷|支付牌照|持牌|Brex/i.test(message)) hits.push("强监管/持牌金融，资本与牌照门槛极高");
  if (/所有人|everybody|everyone/i.test(message) && /用户|target|customer/i.test(message)) hits.push("用户定义过宽");
  return hits;
}

function extractSearchQueries(message) {
  const queries = [];
  const push = (item) => {
    const value = compact(String(item || "").replace(/\s+/g, " ").trim(), 42);
    if (value && !queries.includes(value)) queries.push(value);
  };

  if (/brex|企业信用卡|费用管理/i.test(message)) {
    push("Brex funding valuation expense management");
    push("中国 企业信用卡 支付牌照 费用管理 融资");
  }
  if (/求职|招聘|简历|job matching/i.test(message)) {
    push("校园招聘 AI 求职 竞品 融资");
    if (/非洲|africa/i.test(message)) push("Africa job matching startup market");
  }
  if (/ChatGPT|通用聊天机器人/i.test(message)) {
    push("ChatGPT clone startup failure unit economics");
  }
  if (/签证|visa/i.test(message)) push("签证服务 创业 监管 市场");

  const tokens = [...message.matchAll(/[A-Za-z][A-Za-z0-9+\-]{2,24}|[\u4e00-\u9fff]{2,8}/g)]
    .map((match) => match[0])
    .filter((token) => !/^(我想|一个|没有|这个|我们|进行|如果|以及|或者|可以|需要|帮我|请给|方向|项目|创业)$/.test(token));
  if (tokens.length) push(tokens.slice(0, 6).join(" "));
  if (!queries.length) push(compact(message, 36));
  return queries.slice(0, 3);
}

function countryHints(message) {
  if (/中国|国内|china/i.test(message)) return ["CHN"];
  if (/肯尼亚|kenya/i.test(message)) return ["KEN"];
  if (/尼日利亚|nigeria/i.test(message)) return ["NGA"];
  if (/南非|south africa/i.test(message)) return ["ZAF"];
  if (/非洲|africa/i.test(message)) return ["NGA", "KEN", "ZAF"];
  if (/美国|united states|\busa\b/i.test(message)) return ["USA"];
  return ["CHN"];
}

async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const response = await fetchWithTimeout(url, {}, 10000);
  if (!response.ok) return [];
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 4);
  return items.map((match) => normalizeIntelEntry({
    source: "Google News",
    sourceType: "news",
    title: pickTag(match[1], "title"),
    url: pickTag(match[1], "link"),
    publishedAt: pickTag(match[1], "pubDate"),
    snippet: compact(pickTag(match[1], "description"), 120),
  })).filter((entry) => entry.title && entry.url);
}

async function fetchHackerNews(query) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];
  const data = await response.json();
  return (data.hits || []).map((item) => normalizeIntelEntry({
    source: "Hacker News",
    sourceType: "social",
    title: item.title || item.story_title || "",
    url: item.url || `https://news.ycombinator.com/item?id=${item.objectID}`,
    publishedAt: item.created_at || "",
    snippet: compact(item.title || "", 140),
  })).filter((entry) => entry.title && entry.url);
}

async function fetchWikipedia(query) {
  const endpoints = [
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=1&format=json&srlimit=1`,
    `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=1&format=json&srlimit=1`,
  ];
  for (const searchUrl of endpoints) {
    try {
      const searchResp = await fetchWithTimeout(searchUrl);
      if (!searchResp.ok) continue;
      const searchData = await searchResp.json();
      const hit = searchData?.query?.search?.[0];
      if (!hit?.title) continue;
      const origin = searchUrl.startsWith("https://zh.") ? "https://zh.wikipedia.org" : "https://en.wikipedia.org";
      const summaryUrl = `${origin}/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}`;
      const summaryResp = await fetchWithTimeout(summaryUrl);
      if (!summaryResp.ok) continue;
      const summary = await summaryResp.json();
      if (!summary?.extract || !summary?.content_urls?.desktop?.page) continue;
      return [normalizeIntelEntry({
        source: "Wikipedia",
        sourceType: "database",
        title: summary.title || hit.title,
        url: summary.content_urls.desktop.page,
        snippet: compact(summary.extract, 180),
      })];
    } catch {
      continue;
    }
  }
  return [];
}

async function fetchWorldBank(message) {
  const countries = countryHints(message);
  const results = [];
  for (const code of countries.slice(0, 2)) {
    const url = `https://api.worldbank.org/v2/country/${code}/indicator/NY.GDP.MKTP.CD?format=json&mrnev=1`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) continue;
    const data = await response.json();
    const row = Array.isArray(data) ? data[1]?.[0] : null;
    if (!row?.value || !row?.country?.value) continue;
    const trillionUsd = (Number(row.value) / 1e12).toFixed(2);
    results.push(normalizeIntelEntry({
      source: "World Bank",
      sourceType: "database",
      title: `${row.country.value} GDP ${row.date}：约 ${trillionUsd} 万亿美元`,
      url: `https://data.worldbank.org/indicator/NY.GDP.MKTP.CD?locations=${code}`,
      publishedAt: `${row.date}-12-31`,
      snippet: `世界银行最新可获得 GDP（现价美元）为 ${Number(row.value).toLocaleString("en-US")}。这是宏观规模，不是你的 TAM。`,
      confidence: 0.9,
    }));
  }
  return results;
}

async function fetchGdelt(query) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=4&format=json&timespan=6m`;
  const response = await fetchWithTimeout(url, {}, 10000);
  if (!response.ok) return [];
  const data = await response.json();
  return (data.articles || []).map((item) => normalizeIntelEntry({
    source: item.domain || "GDELT",
    sourceType: "news",
    title: item.title || "",
    url: item.url || "",
    publishedAt: item.seendate || "",
    snippet: compact(item.title || "", 140),
  })).filter((entry) => entry.title && entry.url);
}

function buildExecutionLinks(message) {
  const links = [];
  if (/新西兰|new zealand|\bnz\b/i.test(message) && /签证|visa/i.test(message)) {
    links.push({ label: "新西兰移民局官方签证入口", url: "https://www.immigration.govt.nz/new-zealand-visas" });
  }
  if (/信用卡|支付|Brex|清结算/i.test(message)) {
    links.push({ label: "中国人民银行 支付业务许可公示", url: "https://www.pbc.gov.cn/" });
    links.push({ label: "国家金融监督管理总局", url: "https://www.nfra.gov.cn/" });
  }
  if (/非洲|africa|出海/i.test(message)) {
    links.push({ label: "世界银行开放数据", url: "https://data.worldbank.org/" });
  }
  if (/融资|估值|轮次/.test(message)) {
    links.push({ label: "SEC EDGAR 公开披露检索", url: "https://www.sec.gov/edgar/search/" });
  }
  return links.slice(0, 6);
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
    ? Math.max(0, 1 - ((Date.now() - new Date(entry.publishedAt).getTime()) / (1000 * 60 * 60 * 24 * 90)))
    : 0.2;
  return (entry.confidence * 0.8) + (tierBoost * 0.12) + (recencyBoost * 0.08);
}

async function gatherMarketIntel(message) {
  const queries = extractSearchQueries(message);
  const primary = queries[0];
  const tasks = [
    fetchHackerNews(primary),
    fetchWikipedia(primary),
    fetchWorldBank(message),
    fetchGdelt(primary),
    fetchGoogleNews(primary),
  ];
  if (queries[1]) tasks.push(fetchHackerNews(queries[1]), fetchWikipedia(queries[1]));
  const settled = await Promise.allSettled(tasks);
  const liveIntel = settled.flatMap((item) => (item.status === "fulfilled" ? item.value : []));
  const curated = buildExecutionLinks(message).map((item) => normalizeIntelEntry({
    source: "Heigen curated source",
    sourceType: classifyLinkSource(item.url),
    title: item.label,
    url: item.url,
    snippet: "场景相关入口，不是市场规模或融资事实。",
  }));
  return dedupeIntel([...liveIntel, ...curated]).sort((a, b) => scoreIntel(b) - scoreIntel(a)).slice(0, INTEL_MAX_ITEMS);
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
    { key: "world-bank", enabled: true, type: "database", authRequired: false },
    { key: "wikipedia", enabled: true, type: "database", authRequired: false },
    { key: "gdelt", enabled: true, type: "news", authRequired: false },
    { key: "hacker-news", enabled: true, type: "social", authRequired: false },
    { key: "google-news-rss", enabled: true, type: "news", authRequired: false },
    { key: "qwen-enable-search", enabled: Boolean(DASHSCOPE_KEY) && ENABLE_WEB_SEARCH, type: "news", authRequired: true },
    { key: "x-recent-search", enabled: Boolean(X_BEARER_TOKEN), type: "social", authRequired: true },
  ];
}

function availableModelProviders() {
  return [
    {
      key: "tongyi-dashscope",
      enabled: Boolean(DASHSCOPE_KEY),
      requiresKey: true,
      model: OPENAI_MODEL,
      baseUrl: OPENAI_BASE_URL,
      search: ENABLE_WEB_SEARCH,
      note: "通义千问（DashScope 兼容模式）。未配置真实 DASHSCOPE_API_KEY 时禁用。",
    },
    {
      key: "ollama",
      enabled: Boolean(OLLAMA_MODEL),
      requiresKey: false,
      model: OLLAMA_MODEL || "",
      baseUrl: OLLAMA_BASE_URL,
      note: "仅当本机确有模型名且可连通时才应启用",
    },
    {
      key: "anthropic",
      enabled: Boolean(ANTHROPIC_KEY),
      requiresKey: true,
      model: ANTHROPIC_MODEL,
      note: "未配置真实密钥时禁用",
    },
  ];
}

function safeJsonParse(raw) {
  if (!raw) return null;
  const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
  try {
    const direct = asObject(JSON.parse(raw));
    if (direct) return direct;
  } catch {
    // continue to brace extraction
  }
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return asObject(JSON.parse(match[0]));
  } catch {
    return null;
  }
}

function collectSearchCitations(payload) {
  const buckets = [
    payload?.search_info?.search_results,
    payload?.choices?.[0]?.message?.search_info?.search_results,
  ].filter(Boolean);
  const results = [];
  for (const list of buckets) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      results.push(normalizeIntelEntry({
        source: item.site_name || item.source || "Qwen Search",
        sourceType: classifyLinkSource(item.url || ""),
        title: item.title || "",
        url: item.url || "",
        snippet: compact(item.snippet || item.title || "通义联网检索结果", 160),
      }));
    }
  }
  return results.filter((item) => item.title && item.url);
}

async function callTongyi(messages, { jsonMode = true } = {}) {
  if (!DASHSCOPE_KEY) return { error: "未配置 DASHSCOPE_API_KEY，通义未接通。" };
  const body = {
    model: OPENAI_MODEL,
    temperature: 0.3,
    max_tokens: 4096,
    messages,
    enable_search: ENABLE_WEB_SEARCH,
  };
  if (ENABLE_WEB_SEARCH) {
    body.search_options = {
      forced_search: true,
      enable_source: true,
      enable_citation: true,
    };
  }
  if (jsonMode) body.response_format = { type: "json_object" };

  const response = await fetchWithTimeout(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DASHSCOPE_KEY}`,
    },
    body: JSON.stringify(body),
  }, 60000);

  const rawText = await response.text();
  if (!response.ok) {
    return { error: `通义接口 ${response.status}：${compact(rawText, 240)}` };
  }
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return { error: "通义返回不是合法 JSON。" };
  }
  const content = payload?.choices?.[0]?.message?.content || "";
  const parsed = jsonMode ? safeJsonParse(content) : { content };
  if (!parsed) return { error: "通义未返回可解析的顾问 JSON。", raw: compact(content, 400) };
  return {
    data: parsed,
    citations: collectSearchCitations(payload),
    provider: "tongyi",
    model: payload?.model || OPENAI_MODEL,
  };
}

async function callOllama(messages) {
  if (!OLLAMA_MODEL) return { error: "未配置 OLLAMA_MODEL" };
  const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: "json",
      options: { temperature: 0.3 },
      messages,
    }),
  }, 25000);
  if (!response.ok) return { error: `Ollama ${response.status}` };
  const data = await response.json();
  const parsed = safeJsonParse(data?.message?.content || "");
  if (!parsed) return { error: "Ollama 未返回可解析 JSON" };
  return { data: parsed, citations: [], provider: "ollama", model: OLLAMA_MODEL };
}

async function callAnthropic(messages) {
  if (!ANTHROPIC_KEY) return { error: "未配置 ANTHROPIC_API_KEY" };
  const system = messages.find((item) => item.role === "system")?.content || "";
  const rest = messages.filter((item) => item.role !== "system");
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      temperature: 0.3,
      system,
      messages: rest,
    }),
  }, 45000);
  if (!response.ok) return { error: `Anthropic ${response.status}` };
  const data = await response.json();
  const text = (data.content || []).map((item) => item.text || "").join("\n");
  const parsed = safeJsonParse(text);
  if (!parsed) return { error: "Anthropic 未返回可解析 JSON" };
  return { data: parsed, citations: [], provider: "anthropic", model: ANTHROPIC_MODEL };
}

async function callModelProvider(provider, messages) {
  if (provider === "openai" || provider === "tongyi") {
    const first = await callTongyi(messages, { jsonMode: true });
    if (extractAdvicePayload(first.data)) return first;
    const retry = await callTongyi(messages, { jsonMode: false });
    if (retry.data) {
      const parsed = extractAdvicePayload(safeJsonParse(retry.data.content || "")) || extractAdvicePayload(retry.data);
      if (parsed) return { ...retry, data: parsed };
      if (typeof retry.data.content === "string" && retry.data.content.trim()) {
        return {
          ...retry,
          data: {
            verdict: "narrow",
            verdictReason: "模型未输出结构化 JSON，以下为原文，按投资人标准暂作强制收窄。",
            content: retry.data.content,
          },
        };
      }
    }
    return {
      error: [first.error, retry.error, first.raw ? `raw:${first.raw}` : "", retry.raw ? `retry:${retry.raw}` : ""]
        .filter(Boolean)
        .join(" | ") || "通义未返回顾问结论",
    };
  }
  if (provider === "ollama") return callOllama(messages);
  if (provider === "anthropic") return callAnthropic(messages);
  return { error: `未知模型通道 ${provider}` };
}

function buildSystemPrompt(mode) {
  const cache = loadSkillCache();
  const modeExtra = mode === "qa"
    ? cache.questions
    : mode === "bp"
      ? cache.bp
      : mode === "pitch"
        ? cache.pitch
        : cache.validation;

  return [
    "你是黑根（Heigen），按早期投资人和创业大赛评委标准做顾问，不是人生导师。",
    "必须加载并遵守以下 SKILL 与参考资料。",
    cache.skill,
    modeExtra ? `\n## 当前模式参考\n${modeExtra}` : "",
    "—— 投资人硬规则 ——",
    "1. 允许且必须否决：无差异化复制、无交付能力、零证据、强监管却无牌照/无资本、单位经济算不平。",
    "2. 禁止默认说“这个方向有商业机会”。没有证据时优先 kill / pivot / narrow。",
    "3. 数字必须标注 cited 或 assumption。禁止编造融资轮次、估值、用户数、牌照状态。",
    "4. 单位经济必须给：单价、单位成本、毛利率、CAC、回本月数、启动资金人民币区间、18个月烧钱、死亡线指标。",
    "5. 引用联网信息时 official > database > news > social；社交只作早期信号。",
    "6. 先给投资人结论，再给理由、数字、下一步实验；最多一个补充问题。",
    "7. 禁止编造法规条文号、通报编号、判例名称、融资轮次或精确估值。不确定就写待核验，并给出应去哪个官网核对。",
    "8. 只输出严格 JSON，字段：verdict, verdictReason, content, assessment, unitEconomics, market, executionLinks, optionalQuestion。",
    "verdict 只能是 kill | pivot | narrow | proceed。",
    "assessment 含 targetUsers, coreProblem, evidenceState, nextAction。",
    "unitEconomics 含 price, cogs, grossMargin, cac, paybackMonths, ltv, startingCapitalCny{low,high,basis,includes}, burn18mCny, killMetrics。",
    "market 含 type(red|blue|neutral), tamSamSom{tam,sam,som,source,status}, competitors[], fundingSignals[]。",
    "content 为给创业者看的中文 Markdown，必须包含：投资人结论、否决/收窄理由、单位经济、资金、竞品、证据缺口、7/30/90天（若已否决则改成退出或转向动作）。",
  ].filter(Boolean).join("\n");
}

function buildUserPrompt({ mode, message, history, intel, constraints }) {
  const historyTail = history.slice(-6).map((item) => `${item.role}: ${item.content}`).join("\n");
  const intelText = intel.length
    ? intel.map((item, index) => `[${index + 1}] ${item.title} | ${item.source} | ${item.sourceType} | ${item.url} | ${item.snippet}`).join("\n")
    : "本地检索未拿到可用条目；不要假装有数据，标为待核验。";
  return [
    `模式: ${mode}`,
    `用户输入: ${message}`,
    constraints.length ? `硬约束信号（必须在 verdict 中显式处理）: ${constraints.join("；")}` : "硬约束信号: 无自动标记，仍按投资人标准独立判断。",
    `历史上下文:\n${historyTail || "无"}`,
    `已检索情报:\n${intelText}`,
    "请直接给出投资人级判断，而不是鼓励性套话。",
  ].join("\n\n");
}

function emptyEconomics() {
  return {
    price: { value: "", basis: "assumption", note: "" },
    cogs: { value: "", basis: "assumption", note: "" },
    grossMargin: { value: "", basis: "assumption", note: "" },
    cac: { value: "", basis: "assumption", note: "" },
    paybackMonths: { value: "", basis: "assumption", note: "" },
    ltv: { value: "", basis: "assumption", note: "" },
    startingCapitalCny: { low: 0, high: 0, basis: "assumption", includes: [] },
    burn18mCny: { value: "", basis: "assumption", note: "" },
    killMetrics: [],
  };
}

function normalizeEconomics(raw) {
  const base = emptyEconomics();
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    ...raw,
    startingCapitalCny: {
      ...base.startingCapitalCny,
      ...(raw.startingCapitalCny || {}),
    },
  };
}

function extractAdvicePayload(data) {
  if (!data || typeof data !== "object") return null;
  if (data.verdict || data.content) return data;
  if (data.output && typeof data.output === "object") return extractAdvicePayload(data.output);
  if (data.result && typeof data.result === "object") return extractAdvicePayload(data.result);
  return null;
}

function normalizeAdvice(llm, { message, intel }) {
  const verdict = ["kill", "pivot", "narrow", "proceed"].includes(llm?.verdict) ? llm.verdict : "narrow";
  const assessment = llm?.assessment || {};
  return {
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    verdictReason: llm?.verdictReason || "模型未给出明确否决/推进理由，按投资人标准视为强制收窄。",
    content: llm?.content || "模型没有返回可读结论。",
    optionalQuestion: llm?.optionalQuestion || "",
    assessment: {
      targetUsers: assessment.targetUsers || "未定义滩头用户",
      coreProblem: assessment.coreProblem || compact(message, 80),
      evidenceState: assessment.evidenceState || "证据不足",
      nextAction: assessment.nextAction || "先补证据，再谈方案",
    },
    unitEconomics: normalizeEconomics(llm?.unitEconomics),
    market: {
      type: ["red", "blue", "neutral"].includes(llm?.market?.type) ? llm.market.type : "neutral",
      tamSamSom: llm?.market?.tamSamSom || { tam: "", sam: "", som: "", source: "", status: "assumption" },
      competitors: Array.isArray(llm?.market?.competitors) ? llm.market.competitors.slice(0, 6) : [],
      fundingSignals: Array.isArray(llm?.market?.fundingSignals) ? llm.market.fundingSignals.slice(0, 6) : [],
    },
    executionLinks: Array.isArray(llm?.executionLinks) ? llm.executionLinks.filter((item) => item?.url).slice(0, 8) : [],
    intel,
  };
}

async function generateAdvice({ mode, message, history, intel }) {
  const constraints = hardConstraints(message);
  const prompt = [
    { role: "system", content: buildSystemPrompt(mode) },
    { role: "user", content: buildUserPrompt({ mode, message, history, intel, constraints }) },
  ];

  const errors = [];
  for (const provider of MODEL_PROVIDER_ORDER) {
    try {
      const result = await callModelProvider(provider, prompt);
      const advicePayload = extractAdvicePayload(result?.data);
      if (advicePayload) {
        const advice = normalizeAdvice(advicePayload, { message, intel });
        const mergedIntel = dedupeIntel([...(result.citations || []), ...intel]).slice(0, INTEL_MAX_ITEMS);
        advice.intel = mergedIntel;
        advice.executionLinks = mergeExecutionLinks(advice.executionLinks, buildExecutionLinks(message));
        return {
          ok: true,
          advice,
          model: {
            connected: true,
            provider: result.provider,
            model: result.model,
            search: ENABLE_WEB_SEARCH,
          },
        };
      }
      if (result?.error) errors.push(`${provider}: ${result.error}`);
      else if (result?.data) errors.push(`${provider}: 返回 JSON 缺少 verdict/content：${compact(JSON.stringify(result.data), 220)}`);
      else errors.push(`${provider}: 空响应`);
    } catch (error) {
      errors.push(`${provider}: ${error.message || "调用失败"}`);
    }
  }

  return {
    ok: false,
    error: "真实模型未接通，已拒绝返回模板化安慰剂建议。",
    details: errors,
    model: {
      connected: false,
      provider: "",
      model: OPENAI_MODEL,
      search: ENABLE_WEB_SEARCH,
    },
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

function createSessionRecord({ mode = "validation", title = "" }) {
  const timestamp = nowIso();
  return {
    id: makeId("sess"),
    mode,
    title: title || `黑根咨询-${mode}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastAssessment: null,
    lastVerdict: null,
    lastEconomics: null,
    messages: [],
  };
}

function getSession(store, sessionId) {
  return store.sessions.find((session) => session.id === sessionId);
}

function modelStatusPayload() {
  const providers = availableModelProviders();
  const active = providers.find((item) => item.enabled);
  return {
    connected: Boolean(active),
    active: active ? { key: active.key, model: active.model, search: ENABLE_WEB_SEARCH } : null,
    order: MODEL_PROVIDER_ORDER,
    providers,
    note: active
      ? "已接通真实模型。失败时不会回退到“永远有机会”的模板。"
      : "未接通真实模型。请在 .env 填写 DASHSCOPE_API_KEY 后重启。",
  };
}

async function apiHandler(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, now: nowIso(), model: modelStatusPayload() });
    return;
  }

  if (req.method === "GET" && pathname === "/api/intel/sources") {
    sendJson(res, 200, {
      ranking: rankedSourceOverview(),
      providers: availableSourceProviders(),
      note: "官方与数据库优先；通义 enable_search 负责补充行业与融资公开信息。社交来源只作早期信号。",
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/model/providers") {
    sendJson(res, 200, modelStatusPayload());
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
        verdict: session.lastVerdict?.verdict || "",
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

    const status = modelStatusPayload();
    if (!status.connected) {
      sendJson(res, 503, {
        error: "真实模型未接通。请在项目 .env 填写 DASHSCOPE_API_KEY（阿里云百炼通义密钥）后重启 node server.js。",
        model: status,
      });
      return;
    }

    const intel = await gatherMarketIntel(text).catch(() => []);
    const preview = await readStore();
    const existing = getSession(preview, body.sessionId);
    let generated;
    try {
      generated = await generateAdvice({
        mode: body.mode || existing?.mode || "validation",
        message: text,
        history: existing?.messages || [],
        intel,
      });
    } catch (error) {
      sendJson(res, 502, { error: error.message || "模型调用失败", model: status });
      return;
    }

    if (!generated.ok) {
      sendJson(res, 502, {
        error: generated.error,
        details: generated.details,
        model: generated.model,
      });
      return;
    }

    const result = await withStore(async (store) => {
      let session = getSession(store, body.sessionId);
      if (!session) {
        session = createSessionRecord({ mode: body.mode || "validation", title: `黑根咨询-${body.mode || "validation"}` });
        store.sessions.push(session);
      }

      const advice = generated.advice;
      const userEntry = {
        id: makeId("msg"),
        role: "user",
        content: text,
        createdAt: nowIso(),
        metadata: { mode: body.mode || session.mode, timezone: body.timezone || "" },
      };
      session.messages.push(userEntry);

      const assistantContent = advice.optionalQuestion
        ? `${advice.content}\n\n关键补充问题：${advice.optionalQuestion}`
        : advice.content;

      const assistantEntry = {
        id: makeId("msg"),
        role: "assistant",
        content: assistantContent,
        createdAt: nowIso(),
        metadata: {
          verdict: { verdict: advice.verdict, label: advice.verdictLabel, reason: advice.verdictReason },
          assessment: advice.assessment,
          unitEconomics: advice.unitEconomics,
          market: advice.market,
          executionLinks: advice.executionLinks,
          intel: advice.intel,
          model: generated.model,
        },
      };
      session.messages.push(assistantEntry);
      session.lastAssessment = advice.assessment;
      session.lastVerdict = { verdict: advice.verdict, label: advice.verdictLabel, reason: advice.verdictReason };
      session.lastEconomics = advice.unitEconomics;
      session.updatedAt = nowIso();
      return { session, advice, model: generated.model };
    });

    sendJson(res, 200, {
      session: {
        id: result.session.id,
        mode: result.session.mode,
        title: result.session.title,
      },
      assistant: result.advice,
      intel: result.advice.intel,
      model: result.model,
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
  loadSkillCache();
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    const status = modelStatusPayload();
    console.log(`Heigen server running at http://localhost:${PORT}`);
    console.log(`Model connected: ${status.connected} ${status.active ? `${status.active.key}/${status.active.model}` : "(missing DASHSCOPE_API_KEY)"}`);
  });
}

module.exports = handleRequest;
module.exports.handleRequest = handleRequest;
module.exports.modelStatusPayload = modelStatusPayload;
