const modes = {
  validation: {
    label: "创意与商业模式验证",
    title: "判断你的项目是否有真实商业价值",
    stage: "价值验证模式",
    progress: 22,
    placeholder: "描述你的创业方向，我会先给判断和建议，再补充最少量追问。",
    welcome: "我是黑根。你先说项目方向，我会先给出商业价值判断、红海/蓝海判断、差异化和赚钱方案，再只问一个关键补充问题。",
    prompts: ["我想做大学生求职 AI", "判断这个项目是不是伪需求", "国内红海，是否适合出海？"],
  },
  bp: {
    label: "商业计划书梳理",
    title: "把想法变成可执行商业计划",
    stage: "BP构建模式",
    progress: 16,
    placeholder: "输入现有项目信息，我会先输出可落地的 BP 建议。",
    welcome: "我会先给你可执行建议，再把内容归入 BP 七段框架。你不用先把一切想清楚。",
    prompts: ["我的项目是校园 SaaS", "帮我重写执行摘要", "给我财务与渠道建议"],
  },
  pitch: {
    label: "五分钟路演准备",
    title: "把项目讲成评委听得懂的价值故事",
    stage: "路演模式",
    progress: 16,
    placeholder: "告诉我项目现状，我先给路演重点和改法。",
    welcome: "我会先给路演结构和关键改法，不会让你一直填问卷。",
    prompts: ["帮我做 5 分钟路演", "优化我的开场和商业模式段", "给我评委可能最难问题"],
  },
  qa: {
    label: "模拟评委答辩",
    title: "高压答辩：直接暴露商业漏洞",
    stage: "答辩模式",
    progress: 10,
    placeholder: "输入你的项目，我先给风险判断，再开始提问。",
    welcome: "我会先给评委视角结论，再进行逐题问答，不会先审问你基础信息。",
    prompts: ["开始答辩", "先告诉我这项目最大风险", "给我评分并指出两处硬伤"],
  },
};

const state = {
  mode: "validation",
  sessionId: "",
  turns: 0,
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
  next: "输入项目方向，获得商业价值建议",
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "请求失败" }));
    throw new Error(payload.error || `请求失败: ${response.status}`);
  }
  return response.json();
}

function addMessage(role, text, extras = {}) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector(".avatar").textContent = role === "user" ? "你" : "H";
  node.querySelector(".message-name").textContent = role === "user" ? "你" : "黑根 · 商业顾问";
  node.querySelector(".message-text").innerHTML = escapeHtml(text).replace(/\n/g, "<br>");

  if (extras.links && extras.links.length) {
    const links = document.createElement("div");
    links.className = "message-links";
    links.innerHTML = extras.links.map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>`).join("");
    node.querySelector(".message-content").append(links);
  }

  if (extras.intel && extras.intel.length) {
    const intel = document.createElement("div");
    intel.className = "intel-list";
    intel.innerHTML = extras.intel
      .map((entry) => {
        const confidence = typeof entry.confidence === "number" ? `${Math.round(entry.confidence * 100)}%` : "n/a";
        const type = entry.sourceType || "news";
        const published = entry.publishedAt ? entry.publishedAt.slice(0, 10) : "最新";
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

function updateMeta() {
  const mode = modes[state.mode];
  document.querySelector("#mode-label").textContent = mode.label;
  document.querySelector("#page-title").textContent = mode.title;
  document.querySelector("#stage-label").textContent = mode.stage;
  document.querySelector("#progress-text").textContent = state.turns
    ? "已给出建议，继续迭代你的商业打法。"
    : "先给建议，再最小化追问。";
  document.querySelector("#progress-bar").style.width = `${Math.min(mode.progress + state.turns * 10, 92)}%`;
  document.querySelector("#board-mode").textContent = mode.label;
  document.querySelector("#rubric-tip").textContent = "联网信息按权重使用：官方/数据库 > 新闻 > 社交信号（X 等）。";
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
    next: "输入项目方向，获得商业价值建议",
  });
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
  addMessage("assistant", "正在联网检索最新行业信息并生成建议，请稍候…");
}

function removeLoading() {
  const messages = chat.querySelectorAll(".message.assistant");
  const last = messages[messages.length - 1];
  if (last && last.textContent.includes("正在联网检索最新行业信息")) last.remove();
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
    addMessage("assistant", payload.assistant.content, {
      links: payload.assistant.executionLinks || [],
      intel: payload.intel || [],
    });
    updateMeta();
  } catch (error) {
    removeLoading();
    addMessage("assistant", `请求失败：${error.message}\n\n请检查服务是否已启动（node server.js）以及网络是否可用。`);
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
    const board = `# 黑根咨询记录\n\n模式：${modes[state.mode].label}\n\n## 当前判断\n\n- 目标用户：${ventureBoard.user}\n- 核心问题：${ventureBoard.problem}\n- 当前证据：${ventureBoard.evidence}\n- 下一动作：${ventureBoard.next}\n\n## 对话\n\n`;
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
  await switchMode(state.mode, false);
})();
