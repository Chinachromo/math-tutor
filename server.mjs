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

const PORT = Number(process.env.PORT || 8799);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
你是一位七年级数学（人教版）课后错题复盘老师。你的任务不是替代课堂教学，而是诊断孩子自己的卡点，并用追问式辅导帮助她理解。

严格规则：
1. 第一步必须判断题型和考点。如果题目不清楚，要先问澄清问题，不能套用方程或任何固定模板。
2. 追问必须根据题目、孩子错误步骤、孩子刚才的回答来生成。
3. 每次只问一个问题。不要一次讲一大段完整解法。
4. 如果孩子说“不知道”，要把问题变小，变成能回答的观察题或二选一问题。
5. 如果孩子出现概念误解，要先确认她是怎么想的，再用适合 12 岁孩子的比喻解释。
6. 只有当关键点通过后，才给一题举一反三检查。
7. 语言要像真实老师：温和、具体、根据现场调整，不要机械化。
8. 不要编造看不到的图片内容；如果图片不清楚或题目缺失，要明确要求补充。
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
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("请求太大，请压缩图片或减少内容。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("请求格式不是有效 JSON。"));
      }
    });
    req.on("error", reject);
  });
}

function outputTextFromResponse(data) {
  if (typeof data.output_text === "string") return data.output_text;
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (typeof part.text === "string") return part.text;
    }
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

function localDemoTutor(payload) {
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
    diagnosis: "演示模式：还没有连接真实模型，只能做基础规则判断。接入 OPENAI_API_KEY 后会根据题目和孩子回答做智能诊断。",
    evidence: ["当前没有检测到 OPENAI_API_KEY", "这是本地演示返回", `根据文字线索暂判：${taskType}`],
    teacher_message: "我先不直接讲答案。我们先把这题看清楚，找到真正卡住的位置。",
    next_question: nextQuestion,
    interaction_goal: "确认题型入口和孩子第一处卡点。",
    generalization_check: "暂不出举一反三题，先等孩子回答上面的追问。",
    needs_parent_info: taskType === "题型待确认"
  };
}

function buildUserPrompt(payload) {
  const history = (payload.history || [])
    .slice(-10)
    .map(item => `${item.role === "child" ? "孩子" : "老师"}：${item.text}`)
    .join("\n");

  return `
请进行一次真实老师式数学诊断。

学生背景：
- 年龄：12 岁
- 教材：七年级数学（人教版）

当前来源：${payload.mode || "未说明"}
题型线索：${payload.taskHint || "自动判断"}
题目文字：
${payload.question || "未提供"}

孩子当时的表现或错误步骤：
${payload.situation || "未提供"}

孩子最新回答：
${payload.latestReply || "还没有回答，这是第一轮诊断。"}

对话历史：
${history || "无"}

请返回结构化 JSON。不要输出 JSON 之外的文字。
`;
}

async function callOpenAI(payload) {
  if (!OPENAI_API_KEY) {
    return { mode: "demo", result: localDemoTutor(payload) };
  }

  const content = [{ type: "input_text", text: buildUserPrompt(payload) }];
  if (payload.imageDataUrl && /^data:image\//.test(payload.imageDataUrl)) {
    content.push({
      type: "input_image",
      image_url: payload.imageDataUrl,
      detail: "auto"
    });
  }

  const body = {
    model: OPENAI_MODEL,
    instructions: SYSTEM_INSTRUCTIONS,
    input: [{ role: "user", content }],
    text: {
      format: {
        type: "json_schema",
        name: "math_tutor_diagnosis",
        strict: true,
        schema: TASK_SCHEMA
      }
    }
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `OpenAI API 请求失败：${response.status}`;
    throw new Error(message);
  }

  const text = outputTextFromResponse(data);
  return {
    mode: "ai",
    model: OPENAI_MODEL,
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
        hasOpenAIKey: Boolean(OPENAI_API_KEY),
        model: OPENAI_MODEL,
        mode: OPENAI_API_KEY ? "ai" : "demo"
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/tutor") {
      const payload = await readBody(req);
      const result = await callOpenAI(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, {
      error: message,
      mode: "demo",
      result: localDemoTutor({})
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI math tutor is running on port ${PORT}`);
  console.log(OPENAI_API_KEY ? `Using OpenAI model: ${OPENAI_MODEL}` : "OPENAI_API_KEY is not set; running in demo mode.");
});
