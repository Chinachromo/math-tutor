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
const DEFAULT_TEXT_MODEL = "openai/gpt-5.5";
const DEFAULT_VISION_MODEL = "openai/gpt-5.5";
const OPENROUTER_TEXT_MODEL = process.env.OPENROUTER_TEXT_MODEL || DEFAULT_TEXT_MODEL;
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || DEFAULT_VISION_MODEL;
const OPENROUTER_TIMEOUT_MS = 120_000;

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
      description: "老师对孩子说的话，温和、短，不直接完整讲答案。这里不要放追问；如果孩子最新回答正确，必须先明确肯定。"
    },
    next_question: {
      type: "string",
      description: "下一句追问。必须和孩子刚才的回答或题目有关，只能问一个问题，不要重复 teacher_message 里的内容。"
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

const WORKSHEET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "scope", "difficulty", "questions", "answer_key"],
  properties: {
    title: { type: "string" },
    scope: { type: "string" },
    difficulty: { type: "string" },
    questions: {
      type: "array",
      minItems: 3,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "type_hint", "target_skill", "question"],
        properties: {
          number: { type: "integer" },
          type_hint: {
            type: "string",
            description: "必须是这些之一：自动判断、方程题、不等式题、整式化简题、有理数/实数计算题、几何题、平面直角坐标系题、统计与数据题、应用题"
          },
          target_skill: { type: "string" },
          question: { type: "string" }
        }
      }
    },
    answer_key: {
      type: "array",
      minItems: 3,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "answer"],
        properties: {
          number: { type: "integer" },
          answer: { type: "string" }
        }
      }
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
11. 如果孩子已经跨步骤说出正确思路和正确答案，不要倒退问中间小步骤，要直接肯定“这题已经会做了”，然后给一题举一反三。
12. teacher_message 只负责肯定、纠正或短解释，不要在 teacher_message 里提问；真正的问题只放在 next_question。
13. 如果 next_question 已经问了一个问题，teacher_message 里不要再出现“吗、多少、为什么、怎样、？”这类追问。
14. 如果学生出现概念误解，要先确认她是怎么想的，再用适合七年级学生的语言解释。
15. 只有当关键点通过后，才给一题举一反三检查。
16. 语言要像真实老师：温和、具体、根据现场调整，不要机械化。
17. 不要编造看不到的图片内容；如果图片不清楚或题目缺失，要明确要求补充。

回复前自检：
- 你的 task_type 是否能从题目文字或图片直接看出来？
- 你的 next_question 是否和这道题的具体条件有关？
- 你有没有不小心沿用“方程/移项/设未知数”等固定模板？如果有，改掉。
- 如果孩子最新回答已经正确，你有没有先认可并换到理由或举一反三？如果没有，改掉。
- 如果孩子已经说出了完整思路和答案，你有没有避免倒退追问中间小步骤？如果没有，改成举一反三。
- 你的 next_question 是否重复了上一句老师问题？如果重复，换一个更进一步的问题。
- teacher_message 和 next_question 是否同时在追问？如果是，teacher_message 改成肯定或短解释，只保留 next_question 追问。
- 若不能确信数学结论正确，就不要给结论，先追问确认。
`;

const WORKSHEET_INSTRUCTIONS = `
你是一位熟悉七年级数学（人教版）的课后练习命题老师。

任务：生成一份原创课后测试卷，用来检查学生是否真正掌握课堂知识。

严格规则：
1. 不要复制、改写、复刻任何市售教辅或试卷的具体题目。
2. 可以参考常见教辅的题型结构、难度梯度和考查方式，但题目必须原创。
3. 题目要符合七年级人教版数学范围，不能超纲。
4. 难度要有梯度：前面基础，中间变式，最后 1-2 题综合。
5. 每题只考一个主要能力，题干清楚，数字适合手算。
6. 不要出现市售参考书名称。
7. answer_key 给家长使用，简洁写答案或关键步骤。

请返回结构化 JSON。不要输出 JSON 之外的文字。
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

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function lcm(a, b) {
  return Math.abs(a * b) / gcd(a, b);
}

function reduceFraction(numerator, denominator) {
  const divisor = gcd(numerator, denominator);
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor
  };
}

function parseSimpleFractionAddition(question) {
  const match = String(question || "").match(/(\d+)\s*\/\s*(\d+)\s*\+\s*(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  const [, a, b, c, d] = match.map(Number);
  if (!b || !d) return null;
  const commonDenominator = lcm(b, d);
  const numerator = a * (commonDenominator / b) + c * (commonDenominator / d);
  const reduced = reduceFraction(numerator, commonDenominator);
  const changed = b === commonDenominator
    ? { from: `${c}/${d}`, to: `${c * (commonDenominator / d)}/${commonDenominator}` }
    : { from: `${a}/${b}`, to: `${a * (commonDenominator / b)}/${commonDenominator}` };
  return {
    lcm: commonDenominator,
    result: `${reduced.numerator}/${reduced.denominator}`,
    changed
  };
}

function textContainsFraction(text, expected) {
  const [expectedNumerator, expectedDenominator] = expected.split("/").map(Number);
  const matches = String(text || "").matchAll(/(\d+)\s*\/\s*(\d+)/g);
  for (const match of matches) {
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (denominator && numerator * expectedDenominator === expectedNumerator * denominator) return true;
  }
  return false;
}

function textContainsNumber(text, expected) {
  return new RegExp(`(^|[^0-9])${expected}([^0-9]|$)`).test(String(text || ""));
}

function replyShowsFractionReasoning(reply, fractionCheck) {
  const text = String(reply || "");
  const mentionsCommonDenominator = textContainsNumber(text, fractionCheck.lcm)
    && /公倍数|最小公倍数|通分|同分母|分母/.test(text);
  const mentionsResultFlow = /所以|因此|结果|等于|=|相加/.test(text);
  return mentionsCommonDenominator && mentionsResultFlow;
}

function trimTeacherQuestion(text) {
  const sentence = String(text || "").split(/[？?]/)[0].trim();
  return sentence || text;
}

function polishTutorResult(result, payload) {
  const polished = { ...result };
  const fractionCheck = parseSimpleFractionAddition(payload.question);
  const reply = payload.latestReply || "";
  const answeredCorrectly = fractionCheck && textContainsFraction(reply, fractionCheck.result);
  const showsReasoning = answeredCorrectly && replyShowsFractionReasoning(reply, fractionCheck);

  if (showsReasoning) {
    polished.teacher_message = `对，你这道题已经会做了。你先找到分母的公倍数 ${fractionCheck.lcm}，再把分数通成同分母，所以结果是 ${fractionCheck.result}。`;
    polished.next_question = "我们换一题检查一下：1/18 + 1/6 等于多少？";
    polished.interaction_goal = "确认学生能把同样的通分方法迁移到新题。";
    polished.generalization_check = "1/18 + 1/6 = ?";
    polished.task_confidence = "高";
    polished.needs_parent_info = false;
    return polished;
  }

  if (answeredCorrectly) {
    polished.teacher_message = `对，这一步是正确的。分母的最小公倍数是 ${fractionCheck.lcm}，所以 ${fractionCheck.changed.from} 可以变成 ${fractionCheck.changed.to}，相加后就是 ${fractionCheck.result}。`;
    polished.next_question = `你能说说为什么 ${fractionCheck.changed.from} 要变成 ${fractionCheck.changed.to} 吗？`;
    polished.interaction_goal = "确认学生理解通分时分子和分母要同时乘同一个数。";
    polished.generalization_check = "等她能说清楚原因后，再出一题：1/18 + 1/6 = ?";
    return polished;
  }

  if (polished.teacher_message && /[？?]|为什么|多少|怎样|怎么/.test(polished.teacher_message) && polished.next_question) {
    polished.teacher_message = trimTeacherQuestion(polished.teacher_message);
  }

  return polished;
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

function worksheetQuestionBank(chapter) {
  const banks = {
    "七上：有理数": {
      type: "有理数/实数计算题",
      skills: ["正负数意义", "有理数加减", "有理数乘除", "绝对值", "混合运算"],
      questions: [
        ["计算：-7 + 12 - 5。", "-7 + 12 - 5 = 0"],
        ["计算：(-3) × 4 - 18 ÷ (-6)。", "-12 + 3 = -9"],
        ["若 |a| = 5，且 a < 0，求 a + 8。", "a = -5，所以 a + 8 = 3"],
        ["把 -2，0，3，-5 按从小到大的顺序排列。", "-5 < -2 < 0 < 3"],
        ["计算：-2 × (3 - 8) + 6。", "10 + 6 = 16"]
      ]
    },
    "七上：整式的加减": {
      type: "整式化简题",
      skills: ["同类项", "去括号", "合并同类项", "代数式求值", "整体代入"],
      questions: [
        ["化简：5a - 2a + 3。", "3a + 3"],
        ["化简：4x + 3 - (x - 5)。", "3x + 8"],
        ["化简：2(3m - 1) - (m + 4)。", "5m - 6"],
        ["若 a = -2，求 3a^2 - 2a + 1 的值。", "17"],
        ["化简并求值：2x + (3x - 4) - (x + 1)，其中 x = 2。", "4x - 5，值为 3"]
      ]
    },
    "七上：一元一次方程": {
      type: "方程题",
      skills: ["等式性质", "移项", "去括号", "去分母", "列方程"],
      questions: [
        ["解方程：3x + 5 = 20。", "x = 5"],
        ["解方程：2(x - 3) = 10。", "x = 8"],
        ["解方程：(x + 2) / 3 = 5。", "x = 13"],
        ["一个数的 3 倍少 4 等于 20，求这个数。", "设这个数为 x，3x - 4 = 20，x = 8"],
        ["甲数比乙数大 6，甲乙两数和为 32，求甲数。", "甲数 19"]
      ]
    },
    "七上：几何图形初步": {
      type: "几何题",
      skills: ["线段和差", "角的和差", "补角", "余角", "读图关系"],
      questions: [
        ["已知线段 AB = 12 cm，点 C 是 AB 的中点，求 AC。", "AC = 6 cm"],
        ["若一个角为 38°，求它的余角。", "52°"],
        ["若一个角的补角是 125°，求这个角。", "55°"],
        ["已知∠AOB = 70°，OC 平分∠AOB，求∠AOC。", "35°"],
        ["点 B 在线段 AC 上，AB = 5 cm，BC = 8 cm，求 AC。", "13 cm"]
      ]
    },
    "七下：相交线与平行线": {
      type: "几何题",
      skills: ["对顶角", "邻补角", "平行线判定", "平行线性质", "角度推理"],
      questions: [
        ["两条直线相交，若一个角为 65°，求它的对顶角。", "65°"],
        ["两条直线相交，若一个角为 110°，求它的邻补角。", "70°"],
        ["已知 a ∥ b，一条截线形成的一个内错角为 48°，求对应的内错角。", "48°"],
        ["若同旁内角分别为 3x° 和 2x°，且两直线平行，求 x。", "3x + 2x = 180，x = 36"],
        ["若两条直线被第三条直线所截，一组同位角相等，能判断什么？", "两条直线平行"]
      ]
    },
    "七下：实数": {
      type: "有理数/实数计算题",
      skills: ["平方根", "算术平方根", "立方根", "无理数估算", "实数比较"],
      questions: [
        ["求 49 的算术平方根。", "7"],
        ["求 -27 的立方根。", "-3"],
        ["比较大小：√5 与 2。", "√5 > 2"],
        ["若 x^2 = 16，求 x。", "x = ±4"],
        ["估算 √10 在哪两个相邻整数之间。", "3 和 4 之间"]
      ]
    },
    "七下：平面直角坐标系": {
      type: "平面直角坐标系题",
      skills: ["象限判断", "坐标读写", "点的平移", "坐标轴上的点", "距离关系"],
      questions: [
        ["点 A(3, -2) 在第几象限？", "第四象限"],
        ["点 B(-4, 0) 在哪条坐标轴上？", "x 轴"],
        ["点 P(2, 3) 向左平移 5 个单位后坐标是多少？", "(-3, 3)"],
        ["点 Q(-1, -2) 向上平移 4 个单位后坐标是多少？", "(-1, 2)"],
        ["若点 M(a, 3) 在 y 轴上，求 a。", "a = 0"]
      ]
    },
    "七下：二元一次方程组": {
      type: "方程题",
      skills: ["代入消元", "加减消元", "解方程组", "简单应用", "检验解"],
      questions: [
        ["解方程组：x + y = 7，x - y = 1。", "x = 4，y = 3"],
        ["解方程组：2x + y = 8，y = 2。", "x = 3，y = 2"],
        ["解方程组：x + 2y = 10，x = 4。", "x = 4，y = 3"],
        ["若 x = 2，y = 3，求 3x - y 的值。", "3"],
        ["甲乙两数和为 12，甲比乙大 4，求甲数。", "甲数 8"]
      ]
    },
    "七下：不等式与不等式组": {
      type: "不等式题",
      skills: ["不等式性质", "解一元一次不等式", "数轴表示", "不等式组", "实际意义"],
      questions: [
        ["解不等式：x + 3 > 8。", "x > 5"],
        ["解不等式：2x - 1 ≤ 7。", "x ≤ 4"],
        ["解不等式：-3x < 6。", "x > -2"],
        ["写出不等式 x ≥ -1 的一个整数解。", "如 -1、0、1 等"],
        ["解不等式组：x > 1，x ≤ 4。", "1 < x ≤ 4"]
      ]
    },
    "七下：数据的收集整理与描述": {
      type: "统计与数据题",
      skills: ["频数", "频率", "样本容量", "条形图", "扇形图"],
      questions: [
        ["一组调查共 40 人，其中喜欢篮球的有 12 人，求喜欢篮球的频率。", "12/40 = 0.3"],
        ["某频数表中各组频数为 5、8、7，求样本容量。", "20"],
        ["如果某类人数占 25%，总人数为 80，求这类人数。", "20"],
        ["条形统计图中甲组为 15 人，乙组为 22 人，哪组人数更多？多多少？", "乙组多，多 7 人"],
        ["抽查 50 件产品，合格 48 件，求合格频率。", "48/50 = 0.96"]
      ]
    }
  };
  return banks[chapter] || banks["七上：有理数"];
}

function localWorksheet(payload, reason = "未配置 OPENROUTER_API_KEY") {
  const count = Math.max(3, Math.min(10, Number(payload.count || 8)));
  const bank = worksheetQuestionBank(payload.chapter);
  const questions = [];
  const answerKey = [];
  for (let index = 0; index < count; index += 1) {
    const source = bank.questions[index % bank.questions.length];
    const skill = bank.skills[index % bank.skills.length];
    questions.push({
      number: index + 1,
      type_hint: bank.type,
      target_skill: skill,
      question: source[0]
    });
    answerKey.push({
      number: index + 1,
      answer: source[1]
    });
  }
  return {
    title: `${payload.chapter || "七年级数学"}课后测试卷`,
    scope: `${payload.chapter || "七年级数学"}｜${payload.focus ? `薄弱点：${payload.focus}` : "原创基础练习"}｜${reason}`,
    difficulty: payload.difficulty || "基础巩固",
    questions,
    answer_key: answerKey
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

function buildWorksheetPrompt(payload) {
  const count = Math.max(3, Math.min(10, Number(payload.count || 8)));
  return `
请生成一份原创课后测试卷。

教材背景：七年级数学（人教版）
测试范围：${payload.chapter || "七上：有理数"}
难度：${payload.difficulty || "基础巩固"}
题量：${count}
最近薄弱点：${payload.focus || "未说明"}

命题要求：
1. 不复制任何市售参考书、练习册、试卷原题。
2. 参考常见优质教辅的题型分布：基础计算/概念辨析/变式应用/综合小题。
3. 每道题都要能手算，适合课后 10-20 分钟完成。
4. 题号必须从 1 连续编号到 ${count}。
5. type_hint 必须使用给定枚举中的文字，方便后续错题诊断。
`;
}

async function callOpenRouter(payload) {
  if (!OPENROUTER_API_KEY) {
    return { mode: "demo", provider: "OpenRouter", result: polishTutorResult(localDemoTutor(payload), payload) };
  }
  if (!looksLikeOpenRouterKey(OPENROUTER_API_KEY)) {
    throw new Error("OpenRouter API key 格式不正确。");
  }

  const hasImage = Boolean(payload.imageDataUrl && /^data:image\//.test(payload.imageDataUrl));
  const selectedModel = hasImage ? OPENROUTER_VISION_MODEL : OPENROUTER_TEXT_MODEL;
  const content = [{ type: "text", text: buildUserPrompt(payload) }];
  if (hasImage) {
    content.push({
      type: "image_url",
      image_url: { url: payload.imageDataUrl }
    });
  }

  const body = {
    model: selectedModel,
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
    }
  };

  if (!/^openai\/gpt-5\.5\b/.test(selectedModel)) {
    body.temperature = 0.2;
  }

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
    model: selectedModel,
    result: polishTutorResult(safeJsonParse(text), payload)
  };
}

async function callOpenRouterWorksheet(payload) {
  if (!OPENROUTER_API_KEY) {
    return { mode: "demo", provider: "OpenRouter", result: localWorksheet(payload) };
  }
  if (!looksLikeOpenRouterKey(OPENROUTER_API_KEY)) {
    throw new Error("OpenRouter API key 格式不正确。");
  }

  const body = {
    model: OPENROUTER_TEXT_MODEL,
    messages: [
      { role: "system", content: WORKSHEET_INSTRUCTIONS },
      { role: "user", content: buildWorksheetPrompt(payload) }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "math_worksheet",
        strict: true,
        schema: WORKSHEET_SCHEMA
      }
    }
  };

  if (!/^openai\/gpt-5\.5\b/.test(OPENROUTER_TEXT_MODEL)) {
    body.temperature = 0.4;
  }

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

  return {
    mode: "ai",
    provider: "OpenRouter",
    model: OPENROUTER_TEXT_MODEL,
    result: safeJsonParse(outputTextFromChatCompletion(data))
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
        model: OPENROUTER_TEXT_MODEL === OPENROUTER_VISION_MODEL
          ? OPENROUTER_TEXT_MODEL
          : `文字 ${OPENROUTER_TEXT_MODEL}｜图片 ${OPENROUTER_VISION_MODEL}`,
        textModel: OPENROUTER_TEXT_MODEL,
        visionModel: OPENROUTER_VISION_MODEL,
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
          result: polishTutorResult(localDemoTutor(payload, "OpenRouter 模型服务暂时不可用"), payload)
        });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/worksheet") {
      const payload = await readBody(req);
      try {
        const result = await callOpenRouterWorksheet(payload);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 502, {
          error: safePublicErrorMessage(error),
          mode: "demo",
          provider: "OpenRouter",
          result: localWorksheet(payload, "OpenRouter 模型服务暂时不可用")
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
  console.log(OPENROUTER_API_KEY
    ? `Using OpenRouter models: text=${OPENROUTER_TEXT_MODEL}, vision=${OPENROUTER_VISION_MODEL}`
    : "OPENROUTER_API_KEY is not set; running in demo mode.");
});
