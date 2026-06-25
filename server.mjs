import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function loadDotEnv() {
  const path = join(__dirname, ".env");
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function normalizeApiKey(value) {
  const text = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!text) return "";
  const withoutBearer = text.replace(/^Bearer\s+/i, "").trim();
  return withoutBearer.split(/\s+/)[0] || "";
}

function looksLikeOpenRouterKey(value) {
  return /^sk-or-v1-[A-Za-z0-9_-]+$/.test(value);
}

function safePublicErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || "");
  if (/请求太大|payload|body too large|entity too large/i.test(raw)) {
    return "题目照片太大，服务器没有收到完整内容。请换一张更清晰但文件更小的照片，或只拍题目区域。";
  }
  if (/invalid header|Headers\.append|authorization|Bearer|sk-[A-Za-z0-9_-]+/i.test(raw)) {
    return "OpenRouter API key 格式不正确。请在 Render 环境变量里只填写一个新的 OpenRouter key，不要带空格、换行、Bearer 或其他 key。";
  }
  if (/401|403|unauthorized|forbidden|invalid.*key|auth/i.test(raw)) {
    return "OpenRouter API key 没有通过验证。请检查 key 是否有效、是否已充值、是否填在 OPENROUTER_API_KEY。";
  }
  if (/credit|quota|balance|payment|insufficient/i.test(raw)) {
    return "OpenRouter 账户余额或额度不足，请检查 OpenRouter 充值和模型权限。";
  }
  if (/timeout|timed out|abort/i.test(raw)) {
    return "OpenRouter 模型响应超时。请稍后再试，或换一张更清晰、更小的题目照片。";
  }
  return "OpenRouter 模型服务暂时不可用，请稍后重试或检查 Render 环境变量。";
}

class HttpError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

const PORT = Number(process.env.PORT || 8799);
const HOST = process.env.HOST || "0.0.0.0";
const OPENROUTER_API_KEY = normalizeApiKey(process.env.OPENROUTER_API_KEY);
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "qwen/qwen2.5-vl-72b-instruct";
const OPENROUTER_TIMEOUT_MS = 60_000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

const TASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "task_type",
    "task_confidence",
    "knowledge_point",
    "diagnosis",
    "evidence",
    "teacher_message",
    "next_question",
    "interaction_goal",
    "generalization_check",
    "needs_parent_info"
  ],
  properties: {
    task_type: {
      type: "string",
      description: "题型，例如方程题、几何题、统计题、应用题、整式化简、有理数计算等。"
    },
    task_confidence: {
      type: "string",
      enum: ["高", "中", "低"]
    },
    knowledge_point: {
      type: "string",
      description: "最可能涉及的七年级数学知识点。"
    },
    diagnosis: {
      type: "string",
      description: "对孩子当前卡点的诊断，必须基于题目和孩子表现。"
    },
    evidence: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string" }
    },
    teacher_message: {
      type: "string",
      description: "老师对孩子说的话，温和、短，不直接完整讲答案。"
    },
    next_question: {
      type: "string",
      description: "下一句追问。必须和孩子刚才的回答或题目有关，一次只问一个问题。"
    },
    interaction_goal: {
      type: "string",
      description: "下一问想确认什么。"
    },
    generalization_check: {
      type: "string",
      description: "如果孩子答过关键点后，可以用来举一反三的小题。若还不适合出题，说明暂不出。"
    },
    needs_parent_info: {
      type: "boolean",
      description: "如果题目或孩子表现信息不足，是否需要家长补充。"
    }
  }
};

const SYSTEM_INSTRUCTIONS = `
你是一位七年级数学（人教版）课后错题复盘老师。你的任务不是替代课堂教学，而是诊断学生自己的卡点，并用追问式辅导帮助她理解。

严格规则：
1. 第一步必须先读题并核题：题目让求什么、已知条件是什么、关键词或图形关系是什么。再判断题型和考点。
2. 题型判断必须有题目证据，不能因为示例、历史对话或常见模板就套用“方程题”。题目里没有方程或未知数关系时，不要判断为方程题。
3. 如果文字和图片信息冲突、图片不清楚、题目缺失，task_confidence 必须为“低”，needs_parent_info 必须为 true，并先请家长补充或确认题目，不能继续解。
4. 如果孩子或家长说“错了”“看错题目”“不是这个题型”，要立刻停止原判断，先承认可能看错，再回到读题和题型确认。
5. 追问必须根据题目、孩子错误步骤、孩子刚才的回答来生成。每次只问一个问题。不要一次讲一大段完整解法。
6. 如果孩子说“不知道”，要把问题变小，变成能回答的观察题或二选一问题。
7. 每一轮都必须先验算“孩子最新回答”。如果孩子最新回答是正确的，要先明确肯定，不要继续质疑同一个结论。
8. 如果孩子答案正确但理由没说清，下一问应追问“为什么/依据是什么”；如果理由也清楚，下一问应进入举一反三检查。
9. 不要重复上一轮已经问过、且孩子已经回答过的问题。例如已经确认通分或最小公倍数后，不要再次问同一个最小公倍数。
10. 分数通分题要说“分母 24 和 8 的最小公倍数”，不要说“1/24 和 1/8 的最小公倍数”。
11. 如果学生出现概念误解，要先确认她是怎么想的，再用适合七年级学生的语言解释。
12. 只有当关键点通过后，才给一题举一反三检查。
13. 语言要像真实老师：温和、具体、根据现场调整，不要机械化。
14. 不要编造看不到的图片内容；如果图片不清楚或题目缺失，要明确要求补充。

回复前自检：
- 你的 task_type 是否能从题目文字或图片直接看出来？
- 你的 next_question 是否和这道题的具体条件有关？
- 你有没有不小心沿用“方程/移项/设未知数”等固定模板？如果有，改掉。
- 如果孩子最新回答已经正确，你有没有先认可并换到理由或举一反三？如果没有，改掉。
- 你的 next_question 是否重复了上一句老师问题？如果重复，换一个更进一步的问题。
- 若不能确信数学结论正确，就不要给结论，先追问确认。
`;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    let tooLarge = false;
    const chunks = [];
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        fail(new HttpError("请求太大，请压缩图片或减少内容。", 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError("请求格式不是有效 JSON。", 400));
      }
    });
    req.on("error", fail);
  });
}

function outputTextFromChatCompletion(data) {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => part?.text || "").join("");
  }
  return "";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("模型没有返回 JSON。");
    return JSON.parse(match[0]);
  }
}

function localDemoTutor(payload, reason = "未配置 OPENROUTER_API_KEY") {
  const text = `${payload.question || ""} ${payload.situation || ""} ${payload.latestReply || ""}`;
  let taskType = "题型待确认";
  let knowledgePoint = "先确认题目目标和已知条件";
  let nextQuestion = "这题最后让你求什么？你能先指出一个已知条件吗？";

  if (/方程|解.*x|=/.test(text)) {
    taskType = "方程题";
    knowledgePoint = "等式性质与未知数";
    nextQuestion = "你觉得这一步的目标是让哪一边更简单？";
  } else if (/化简|同类项|[a-zA-Z].*[()（）]/.test(text)) {
    taskType = "整式化简题";
    knowledgePoint = "去括号与合并同类项";
    nextQuestion = "你觉得第一步要先处理括号、符号，还是先找同类项？";
  } else if (/角|平行|垂直|线段|直线/.test(text)) {
    taskType = "几何题";
    knowledgePoint = "读图、条件和角的关系";
    nextQuestion = "题目给了哪些几何条件？你能先说出一个吗？";
  } else if (/统计|频数|平均|样本|调查|图表/.test(text)) {
    taskType = "统计与数据题";
    knowledgePoint = "读表、数据指标与问题目标";
    nextQuestion = "题目给的是表格、图，还是一组数据？它让你求哪个指标？";
  } else if (/甲|乙|路程|速度|单价|总价|利润|工程/.test(text)) {
    taskType = "应用题";
    knowledgePoint = "找要求量、已知量和数量关系";
    nextQuestion = "题目最后要求什么？如果设一个未知数，你觉得应该设谁？";
  }

  return {
    task_type: taskType,
    task_confidence: taskType === "题型待确认" ? "低" : "中",
    knowledge_point: knowledgePoint,
    diagnosis: `演示模式：${reason}。当前只能做基础规则判断。`,
    evidence: [reason, "这是本地演示返回", `根据文字线索暂判：${taskType}`],
    teacher_message: "我先不直接讲答案。我们先把这题看清楚，找到真正卡住的位置。",
    next_question: nextQuestion,
    interaction_goal: "确认题型入口和孩子第一处卡点。",
    generalization_check: "暂不出举一反三题，先等孩子回答上面的追问。",
    needs_parent_info: taskType === "题型待确认"
  };
}

function buildUserPrompt(payload) {
  const recentHistory = (payload.history || []).slice(-10);
  const history = recentHistory
    .slice(-10)
    .map(item => `${item.role === "child" ? "孩子" : "老师"}：${item.text}`)
    .join("\n");
  const lastTeacherMessage = [...recentHistory].reverse().find(item => item.role !== "child")?.text || "无";

  return `
请进行一次真实老师式数学诊断。

学生背景：
- 年级：七年级
- 教材：人教版数学

当前来源：${payload.mode || "未说明"}
题目入口：${payload.source === "book" ? "书中选题" : "上传照片或手动录入"}
题型线索：${payload.taskHint || "自动判断"}
题目文字：
${payload.question || "未提供"}

孩子当时的表现或错误步骤：
${payload.situation || "未提供"}

孩子最新回答：
${payload.latestReply || "还没有回答，这是第一轮诊断。"}

上一句老师问题：
${lastTeacherMessage}

对话历史：
${history || "无"}

重要要求：
1. 如果只看到图片、文字未提供，请先根据图片读题；如果图片看不清，不要猜。
2. 如果题目文字是“未提供”，不要沿用任何示例题。
3. 如果家长或孩子指出你看错了，要重新判断题目，不要维护上一次结论。
4. evidence 至少写出一个来自题目本身的判断依据；如果没有依据，就写“题目信息不足”。
5. 先判断“孩子最新回答”是否正确或部分正确；正确时不要继续当作错误处理。
6. 如果孩子已经回答了上一句老师问题，next_question 必须推进到下一层理解或举一反三，不能重复上一句。

请返回结构化 JSON。不要输出 JSON 之外的文字。
`;
}

async function callOpenRouter(payload) {
  if (!OPENROUTER_API_KEY) {
    return { mode: "demo", provider: "OpenRouter", result: localDemoTutor(payload) };
  }
  if (!looksLikeOpenRouterKey(OPENROUTER_API_KEY)) {
    throw new Error("OpenRouter API key 格式不正确。");
  }

  const content = [{ type: "text", text: buildUserPrompt(payload) }];
  if (payload.imageDataUrl && /^data:image\//.test(payload.imageDataUrl)) {
    content.push({
      type: "image_url",
      image_url: { url: payload.imageDataUrl }
    });
  }

  const body = {
    model: OPENROUTER_MODEL,
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTIONS },
      { role: "user", content }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "math_tutor_diagnosis",
        strict: true,
        schema: TASK_SCHEMA
      }
    },
    temperature: 0.2
  };

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://ai-math-tutor-online.onrender.com",
      "X-Title": "AI Math Tutor"
    },
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `OpenRouter API 请求失败：${response.status}`;
    throw new Error(message);
  }

  const text = outputTextFromChatCompletion(data);
  return {
    mode: "ai",
    provider: "OpenRouter",
    model: OPENROUTER_MODEL,
    result: safeJsonParse(text)
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = join(__dirname, pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        hasApiKey: Boolean(OPENROUTER_API_KEY),
        apiKeyFormatOk: !OPENROUTER_API_KEY || looksLikeOpenRouterKey(OPENROUTER_API_KEY),
        provider: "OpenRouter",
        model: OPENROUTER_MODEL,
        mode: OPENROUTER_API_KEY ? "ai" : "demo"
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/tutor") {
      const payload = await readBody(req);
      try {
        const result = await callOpenRouter(payload);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 502, {
          error: safePublicErrorMessage(error),
          mode: "demo",
          provider: "OpenRouter",
          result: localDemoTutor(payload, "OpenRouter 模型服务暂时不可用")
        });
      }
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const statusCode = error && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    sendJson(res, statusCode, {
      error: safePublicErrorMessage(error),
      mode: "demo",
      provider: "OpenRouter",
      result: localDemoTutor({}, "服务器处理请求时出错")
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI math tutor is running at http://${HOST}:${PORT}`);
  console.log(OPENROUTER_API_KEY ? `Using OpenRouter model: ${OPENROUTER_MODEL}` : "OPENROUTER_API_KEY is not set; running in demo mode.");
});
