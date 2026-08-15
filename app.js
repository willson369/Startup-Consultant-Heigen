const modes = {
  validation: {
    label: "创意与商业模式验证",
    title: "先问：这个项目值不值得把命押上去？",
    stage: "投资人审查",
    progress: 22,
    placeholder: "直接说项目、用户、竞争和你手上的证据。",
    welcome: "我是黑根。按投资人标准说话：证据不足就否决或收窄，不会先鼓励你。把项目丢过来。",
    prompts: ["我想做大学生求职 AI", "判断这个项目是不是伪需求", "国内红海，是否适合出海？"],
  },
  bp: {
    label: "商业计划书梳理",
    title: "把想法压成经得起追问的商业计划",
    stage: "BP 审查",
    progress: 16,
    placeholder: "输入项目信息，我会按七段 BP 指出哪些是假设、哪些能写进计划书。",
    welcome: "BP 模式：没有来源的 TAM、没有单位经济的财务、没有竞品的市场，都会被标红。",
    prompts: ["我的项目是校园 SaaS", "帮我重写执行摘要", "给我财务与渠道建议"],
  },
  pitch: {
    label: "五分钟路演准备",
    title: "路演只讲评委/投资人会追问的东西",
    stage: "路演审查",
    progress: 16,
    placeholder: "告诉我项目现状，我先拆哪些主张经不起追问。",
    welcome: "路演模式：开场不讲功能。没有验证证据的段落，我会让你删掉或改成假设。",
    prompts: ["帮我做 5 分钟路演", "优化我的开场和商业模式段", "给我评委可能最难问题"],
  },
  qa: {
    label: "模拟评委答辩",
    title: "高压答辩：直接暴露商业漏洞",
    stage: "答辩",
    progress: 10,
    placeholder: "输入你的项目，我先给投资人结论，再问最毒的一个问题。",
    welcome: "答辩模式：先给结论和硬伤，再逐题追问。不要准备演讲稿式的回答。",
    prompts: ["开始答辩", "先告诉我这项目最大风险", "给我评分并指出两处硬伤"],
  },
};

const state = {
  mode: "validation",
  sessionId: "",
  turns: 0,
  model: { connected: false, label: "通义未接通" },
};

const chat = document.querySelector("#chat");
const input = document.querySelector("#user-input");
const composer = document.querySelector("#composer");
const quickActions = document.querySelector("#quick-actions");
const template = document.querySelector("#message-template");

let liveMessages = [];
let ventureBoard = {
  user: "待确认",
  problem: "待确认",
  evidence: "待收集",
  next: "输入项目方向",
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/^### (.+)$/gm, "<strong>$1</strong>")
    .replace(/^## (.+)$/gm, "<strong>$1</strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^[-*] (.+)$/gm, "• $1")
    .replace(/\n/g, "<br>");
}

function formatMoneyRange(block) {
  if (!block) return "未给出";
  const low = Number(block.low);
  const high = Number(block.high);
  if (!low && !high && !block.value) return block.note || "未给出";
  if (block.value) return String(block.value);
  if (low || high) {
    const toWan = (n) => (n >= 10000 ? `${Math.round(n / 10000)} 万` : `${n}`);
    return `${toWan(low || 0)} – ${toWan(high || low || 0)} 人民币`;
  }
  return "未给出";
}

function fieldValue(field) {
  if (!field) return "未给出";
  if (typeof field === "string" || typeof field === "number") return String(field);
  const value = field.value || field.note || "";
  const basis = field.basis ? `（${field.basis}）` : "";
  return value ? `${value}${basis}` : "未给出";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({ error: "请求失败" }));
  if (!response.ok) {
    const extra = payload.details?.length ? `\n${payload.details.join("\n")}` : "";
    throw new Error((payload.error || `请求失败: ${response.status}`) + extra);
  }
  return payload;
}

function addMessage(role, text, extras = {}) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector(".avatar").textContent = role === "user" ? "你" : "H";
  node.querySelector(".message-name").textContent = role === "user" ? "你" : "黑根 · 投资人标准";
  node.querySelector(".message-text").innerHTML = role === "assistant" ? renderMarkdown(text) : escapeHtml(text).replace(/\n/g, "<br>");

  if (extras.verdict) {
    const badge = document.createElement("div");
    badge.className = `verdict-chip ${extras.verdict.verdict || ""}`;
    badge.textContent = extras.verdict.label || extras.verdict.verdict || "";
    node.querySelector(".message-content").prepend(badge);
  }

  if (extras.links && extras.links.length) {
    const links = document.createElement("div");
    links.className = "message-links";
    links.innerHTML = extras.links.map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label || item.title || item.url)}</a>`).join("");
    node.querySelector(".message-content").append(links);
  }

  if (extras.intel && extras.intel.length) {
    const intel = document.createElement("div");
    intel.className = "intel-list";
    intel.innerHTML = extras.intel
      .map((entry) => {
        const confidence = typeof entry.confidence === "number" ? `${Math.round(entry.confidence * 100)}%` : "n/a";
        const type = entry.sourceType || "news";
        const published = entry.publishedAt ? entry.publishedAt.slice(0, 10) : "待核验";
        return `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.source)} · ${escapeHtml(type)} · 置信度${escapeHtml(confidence)} · ${escapeHtml(published)}</span></a>`;
      })
      .join("");
    node.querySelector(".message-content").append(intel);
  }

  chat.append(node);
  chat.scrollTop = chat.scrollHeight;
}

function renderQuickActions() {
  quickActions.innerHTML = modes[state.mode].prompts.map((prompt) => `<button class="quick-action" type="button">${prompt}</button>`).join("");
  quickActions.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.textContent;
      input.focus();
    });
  });
}

function updateBoard(board = {}) {
  ventureBoard = { ...ventureBoard, ...board };
  const labels = ["目标用户", "核心问题", "当前证据", "下一动作"];
  const values = [ventureBoard.user, ventureBoard.problem, ventureBoard.evidence, ventureBoard.next];
  document.querySelector("#venture-board").innerHTML = labels.map((label, index) =>
    `<div><dt>${label}</dt><dd>${escapeHtml(values[index] || "待确认")}</dd></div>`).join("");
}

function updateVerdict(verdict) {
  const card = document.querySelector("#verdict-card");
  if (!verdict) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  card.className = `verdict-card ${verdict.verdict || ""}`;
  document.querySelector("#verdict-label").textContent = verdict.label || verdict.verdict || "待判断";
  document.querySelector("#verdict-reason").textContent = verdict.reason || verdict.verdictReason || "";
}

function updateEconomics(econ) {
  const board = document.querySelector("#econ-board");
  if (!econ) {
    board.innerHTML = "<div><dt>启动资金</dt><dd>待模型计算</dd></div>";
    return;
  }
  const kill = Array.isArray(econ.killMetrics) ? econ.killMetrics.filter(Boolean).slice(0, 2).join("；") : "";
  const rows = [
    ["启动资金", formatMoneyRange(econ.startingCapitalCny)],
    ["单价 / 成本 / 毛利", `${fieldValue(econ.price)} / ${fieldValue(econ.cogs)} / ${fieldValue(econ.grossMargin)}`],
    ["CAC / 回本 / LTV", `${fieldValue(econ.cac)} / ${fieldValue(econ.paybackMonths)} / ${fieldValue(econ.ltv)}`],
    ["18 个月烧钱", fieldValue(econ.burn18mCny)],
    ["死亡线", kill || "未给出"],
  ];
  board.innerHTML = rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}

function updateModelStatus(payload) {
  const node = document.querySelector("#model-status");
  if (!payload) return;
  if (payload.connected && payload.active) {
    state.model = { connected: true, label: `通义已接通 · ${payload.active.model}` };
    node.className = "model-status on";
    node.textContent = `${state.model.label}${payload.active.search ? " · 联网搜索开" : ""}`;
  } else {
    state.model = { connected: false, label: "通义未接通" };
    node.className = "model-status off";
    node.textContent = "通义未接通：请在 .env 填写 DASHSCOPE_API_KEY 后重启服务";
  }
}

function updateMeta() {
  const mode = modes[state.mode];
  document.querySelector("#mode-label").textContent = mode.label;
  document.querySelector("#page-title").textContent = mode.title;
  document.querySelector("#stage-label").textContent = mode.stage;
  document.querySelector("#progress-text").textContent = state.turns
    ? "已给出投资人判断，继续用证据迭代。"
    : "先给否决/收窄/推进结论，再最小化追问。";
  document.querySelector("#progress-bar").style.width = `${Math.min(mode.progress + state.turns * 10, 92)}%`;
  document.querySelector("#board-mode").textContent = mode.label;
  document.querySelector("#rubric-tip").textContent = "没有来源的数字都是假设。没有证据的故事，默认不值得出价。";
  input.placeholder = mode.placeholder;
  document.querySelectorAll(".mode-card").forEach((button) => button.classList.toggle("active", button.dataset.mode === state.mode));
  renderQuickActions();
}

function clearChat() {
  liveMessages = [];
  chat.innerHTML = "";
}

function normalizeBoard(assessment) {
  if (!assessment) return {};
  return {
    user: assessment.targetUsers || ventureBoard.user,
    problem: assessment.coreProblem || ventureBoard.problem,
    evidence: assessment.evidenceState || ventureBoard.evidence,
    next: assessment.nextAction || ventureBoard.next,
  };
}

function renderHistory(messages) {
  clearChat();
  messages.forEach((entry) => {
    if (entry.role === "assistant") {
      addMessage("assistant", entry.content, {
        links: entry.metadata?.executionLinks || [],
        intel: entry.metadata?.intel || [],
        verdict: entry.metadata?.verdict || null,
      });
    } else {
      addMessage("user", entry.content);
    }
  });
  liveMessages = messages;
}

async function createSession(mode, title = "") {
  const payload = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ mode, title }),
  });
  state.sessionId = payload.session.id;
  return payload.session;
}

async function loadLatestSession(mode) {
  const payload = await api("/api/sessions");
  const found = payload.sessions.find((item) => item.mode === mode);
  if (found) {
    state.sessionId = found.id;
    const detail = await api(`/api/sessions/${found.id}`);
    renderHistory(detail.session.messages || []);
    updateBoard(normalizeBoard(detail.session.lastAssessment));
    updateVerdict(detail.session.lastVerdict);
    updateEconomics(detail.session.lastEconomics);
    state.turns = Math.max(0, (detail.session.messages || []).filter((message) => message.role === "user").length);
    if (!detail.session.messages.length) addMessage("assistant", modes[mode].welcome);
    return;
  }
  await createSession(mode);
  addMessage("assistant", modes[mode].welcome);
}

async function switchMode(mode, forceNew = false) {
  state.mode = mode;
  state.turns = 0;
  updateMeta();
  clearChat();
  updateBoard({
    user: "待确认",
    problem: "待确认",
    evidence: "待收集",
    next: "输入项目方向",
  });
  updateVerdict(null);
  updateEconomics(null);
  if (forceNew) {
    await createSession(mode);
    addMessage("assistant", modes[mode].welcome);
    return;
  }
  await loadLatestSession(mode);
}

async function requestAdvice(message) {
  return api("/api/advice", {
    method: "POST",
    body: JSON.stringify({
      sessionId: state.sessionId,
      mode: state.mode,
      message,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });
}

function assistantLoading() {
  addMessage("assistant", "正在调用通义并检索行业/宏观数据，请稍候…");
}

function removeLoading() {
  const messages = chat.querySelectorAll(".message.assistant");
  const last = messages[messages.length - 1];
  if (last && last.textContent.includes("正在调用通义")) last.remove();
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  addMessage("user", text);
  input.value = "";
  assistantLoading();
  try {
    const payload = await requestAdvice(text);
    removeLoading();
    state.turns += 1;
    updateBoard(normalizeBoard(payload.assistant.assessment));
    updateVerdict({
      verdict: payload.assistant.verdict,
      label: payload.assistant.verdictLabel,
      reason: payload.assistant.verdictReason,
    });
    updateEconomics(payload.assistant.unitEconomics);
    addMessage("assistant", payload.assistant.content, {
      links: payload.assistant.executionLinks || [],
      intel: payload.intel || payload.assistant.intel || [],
      verdict: { verdict: payload.assistant.verdict, label: payload.assistant.verdictLabel },
    });
    updateMeta();
  } catch (error) {
    removeLoading();
    addMessage("assistant", `请求失败：${error.message}`);
  }
});

document.querySelectorAll(".mode-card").forEach((button) => {
  button.addEventListener("click", async () => {
    await switchMode(button.dataset.mode, false);
  });
});

document.querySelector("#new-session").addEventListener("click", async () => {
  await switchMode(state.mode, true);
});

document.querySelector("#clear-history").addEventListener("click", async () => {
  await api("/api/reset", { method: "POST", body: "{}" });
  await switchMode(state.mode, true);
});

document.querySelector("#export-session").addEventListener("click", async () => {
  try {
    const payload = await api(`/api/sessions/${state.sessionId}`);
    const report = payload.session.messages
      .map((entry) => `### ${entry.role === "user" ? "创业者" : "黑根"}\n\n${entry.content}\n`)
      .join("\n");
    const board = `# 黑根咨询记录\n\n模式：${modes[state.mode].label}\n结论：${payload.session.lastVerdict?.label || "未判定"}\n\n## 当前判断\n\n- 目标用户：${ventureBoard.user}\n- 核心问题：${ventureBoard.problem}\n- 当前证据：${ventureBoard.evidence}\n- 下一动作：${ventureBoard.next}\n\n## 对话\n\n`;
    const blob = new Blob([board + report], { type: "text/markdown;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `heigen-session-${state.sessionId}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    addMessage("assistant", `导出失败：${error.message}`);
  }
});

(async () => {
  updateMeta();
  try {
    updateModelStatus(await api("/api/model/providers"));
  } catch {
    updateModelStatus({ connected: false });
  }
  await switchMode(state.mode, false);
})();
