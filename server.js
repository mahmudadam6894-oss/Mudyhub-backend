import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import dotenv from 'dotenv';
import registerTrueConnection from './true-connection-routes.js';
import registerAdminV1 from './admin-v1-routes.js';
import registerPromote from './promote-routes.js';
import registerTasks from './tasks-routes.js';
import {
  Document, Packer, Paragraph, TextRun, AlignmentType, ImageRun,
  PageBreak, Footer, PageNumber, HeadingLevel, NumberFormat, TableOfContents
} from 'docx';

dotenv.config();
const app = express();

// -----------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------
const allowedOrigins = new Set(
  String(process.env.FRONTEND_ORIGINS || 'https://mudihub.netlify.app')
    .split(',').map(v => v.trim()).filter(Boolean)
);
app.use(cors({
  origin(origin, callback) {
    // Allow non-browser clients with no Origin header and only configured browser origins.
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));

// Master Control switches (Super Admin) enforced on the server, not just hidden in the UI.
let _guardCache = { at: 0, v: {} };
app.use(async (req, res, next) => {
  if (req.method !== 'POST' || req.path.startsWith('/api/admin/')) return next();
  try {
    if (Date.now() - _guardCache.at > 5000) _guardCache = { at: Date.now(), v: (await db.ref('platformSettings').once('value')).val() || {} };
    const s = _guardCache.v, p = req.path;
    if (s.emergencyLock === true) return res.status(503).json({ ok: false, error: 'MudyHub is temporarily locked for safety. Please try again later.' });
    if (s.walletOpsPaused === true && ['/api/withdraw', '/api/create-topup-intent', '/api/verify-topup'].includes(p)) return res.status(503).json({ ok: false, error: 'Wallet operations are paused for a short while. Please try again later.' });
    if (s.trueConnectionEnabled === false && p.startsWith('/api/tc/')) return res.status(503).json({ ok: false, error: 'True Connection is temporarily unavailable.' });
  } catch (e) { /* never block users because the settings read failed */ }
  return next();
});

// -----------------------------------------------------
// ENV CHECK & FIREBASE ADMIN SETUP
// -----------------------------------------------------
if (!process.env.GROQ_API_KEY) {
  console.error("FATAL: GROQ_API_KEY environment variable is not set in Render dashboard.");
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("FATAL: FIREBASE_SERVICE_ACCOUNT environment variable is not set in Render dashboard.");
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT is required. Server startup stopped.');
}
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://mudyhub-default-rtdb.firebaseio.com'
  });
  console.log('Firebase Admin initialized.');
} catch (error) {
  console.error('Firebase Admin initialization failed:', error.message);
  throw error;
}
const db = admin.database();

// -----------------------------------------------------
// MODEL CONFIG
// -----------------------------------------------------
const MODELS = {
  default:   process.env.GROQ_MODEL_DEFAULT   || "openai/gpt-oss-120b",
  reasoning: process.env.GROQ_MODEL_REASONING || "openai/gpt-oss-120b",
  vision:    process.env.GROQ_MODEL_VISION    || "qwen/qwen3.8-27b"
};
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_IMAGE_BASE64_LENGTH = 8_000_000;

// -----------------------------------------------------
// SYSTEM PROMPTS
// -----------------------------------------------------
const SYSTEM_PROMPTS = {
  campus: `You are MudyCampus AI, a dedicated academic and educational assistant built specifically for tertiary students (Universities, Polytechnics, and Colleges).

STRICT RULE: You are ONLY allowed to answer educational, academic, career, and school-related questions (e.g., SIWES/IT reports, assignment questions, course explanations, project topics, study plans, CV writing, and exam prep).

IF the user asks a non-educational or off-topic question, respond with:
"I am MudyCampus AI, your academic assistant. I can only help you with educational questions, assignments, SIWES reports, project topics, and study guides! Please ask a school-related question."

FORMATTING: Use clean Markdown. Use **bold** for key terms, ### headings for sections, tables for comparisons, and numbered lists for steps.

RESPONSE LENGTH: Keep answers focused and concise. Aim for under 250 words unless the student specifically asks for a detailed explanation.

MATH FORMATTING: Do not use LaTeX. Write all formulas in plain readable text. Use 'x' or '*' for multiplication, '/' for division, '^' for powers, 'sqrt' for square root, and Greek letters directly (rho, pi, theta, alpha, beta, delta).

TABLE FORMATTING:
- Use pipe tables with a header row and separator row of dashes.
- Put a SPACE on both sides of every pipe symbol.
- Every row must have the SAME number of columns.
- Keep cell content SHORT (under 8 words per cell).
- Leave a blank line before and after tables.`,

  platform: `You are Mudy AI, the official assistant for MudyHub — an earning and learning platform for African (especially Nigerian) students and young people.

WHAT YOU HELP WITH:
1. Explaining how MudyHub works: Paid Tasks, Jobs, Daily Rewards, Referral Program, Business Ads, Wallet & Withdrawals, Campus Hub, and Community Feed.
2. Practical advice on making money online.
3. Advice on learning valuable skills.

HOW MUDYHUB WORKS:
- Paid Tasks: users complete tasks and submit proof; admin approves and pays to wallet.
- Jobs: verified remote/local listings.
- Daily Rewards: small bonus claimable once every 24 hours.
- Referral Program: users share a link and earn when new users sign up.
- Wallet: shows balance, pending earnings, withdrawal history.
- Campus Hub: student-focused section with daily quiz, CGPA calculator, AI academic assistant.

TONE: Warm, practical, encouraging. Nigerian context where relevant.

STRICT SCOPE: You do NOT answer general academic questions. Those belong to the Campus Tutor (verified students only).

If a user asks a general academic question, respond with:
"That's a great academic question! For academic help, please open the Campus Hub → AI Tools tab. It's available to verified students. For now, is there anything I can help you with on MudyHub — earning, wallet, referrals, or marketplace?"

If asked something unrelated to MudyHub, earning, or learning, redirect politely.`
};

// -----------------------------------------------------
// CORE GROQ CALLER
// -----------------------------------------------------
async function callGroq({ systemPrompt, messages, model, jsonMode = false, maxTokens = 1024, temperature = 0.7 }) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set in Render Environment Variables.");
  }
  const useModel = model || MODELS.default;
  const isReasoningModel = /gpt-oss|qwen3|deepseek-r1/i.test(useModel);
  let tokens = maxTokens;

  // Reasoning models spend part of max_tokens "thinking". If that uses the whole budget the visible
  // answer comes back empty, so keep the thinking short and retry once with a bigger budget.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const body = {
      model: useModel,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature,
      max_tokens: tokens
    };
    if (/gpt-oss/i.test(useModel)) body.reasoning_effort = "low";
    if (jsonMode) body.response_format = { type: "json_object" };

    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMessage = `Groq API error (${response.status})`;
      try {
        const parsed = JSON.parse(errText);
        errMessage = parsed.error?.message || errMessage;
      } catch (e) {
        errMessage = errText || errMessage;
      }
      // Rate limit or temporary overload: wait and retry.
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise(r => setTimeout(r, 4000 * attempt));
        continue;
      }
      throw new Error(errMessage);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (text && String(text).trim()) return text;
    if (attempt < 3) {
      tokens = Math.min(Math.round(tokens * 1.7) + (isReasoningModel ? 1500 : 0), 16000);
      continue;
    }
  }
  throw new Error("Groq returned an empty response.");
}

// -----------------------------------------------------
// /api/generate — AI CHAT
// -----------------------------------------------------
app.post('/api/generate', async (req, res) => {
  try { const uid = await authenticatedUid(req); const userSnap = await db.ref(`users/${uid}`).once('value'); const u = userSnap.val(); if (!u || u.banned === true || u.status === 'banned') return res.status(403).json({ response: 'Your account is not permitted to use this service.' }); }
  catch (_) { return res.status(401).json({ response: 'Please sign in to use Mudy AI.' }); }
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ response: "Server misconfiguration: GROQ_API_KEY is not set." });
  }

  const { prompt, mode, history, thinkMode = false, imageBase64 = null, searchMode = false } = req.body;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ response: "Error: No prompt provided." });
  }

  const selectedMode = (mode === "platform") ? "platform" : "campus";
  let systemPrompt = SYSTEM_PROMPTS[selectedMode];

  if (searchMode) {
    systemPrompt += `\n\nSEARCH MODE IS ON: Be extra thorough. Cite specific Nigerian campus context.`;
  }

  const messages = [];
  if (Array.isArray(history) && history.length > 0) {
    history.forEach(h => {
      if (!h || typeof h.text !== "string" || !h.text.trim()) return;
      const role = (h.role === "model" || h.role === "assistant") ? "assistant" : "user";
      messages.push({ role, content: h.text });
    });
  }

  if (imageBase64) {
    if (typeof imageBase64 !== "string" || imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
      return res.status(400).json({ response: "Error: Image is too large (max ~6MB)." });
    }
    const imageUrl = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
    messages.push({
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    });
  } else {
    messages.push({ role: "user", content: prompt });
  }

  let model = MODELS.default;
  let maxTokens = 1024;
  if (imageBase64) { model = MODELS.vision; maxTokens = 2048; }
  else if (thinkMode) { model = MODELS.reasoning; maxTokens = 3072; }

  try {
    const responseText = await callGroq({ systemPrompt, messages, model, maxTokens });
    if (!responseText) {
      return res.status(502).json({ response: "The AI model returned an empty response." });
    }
    res.json({
      response: responseText,
      usedModel: model,
      mode: thinkMode ? "think" : (imageBase64 ? "vision" : "text")
    });
  } catch (error) {
    console.error("Backend Error:", error);
    let userMsg = error.message || "An unexpected error occurred.";
    if (userMsg.toLowerCase().includes("rate limit") || userMsg.includes("429")) {
      userMsg = "Mudy AI is busy right now. Please try again in a moment.";
    }
    res.status(500).json({ response: `Backend Error: ${userMsg}` });
  }
});

// -----------------------------------------------------
// /api/quiz
// -----------------------------------------------------
const QUIZ_SYSTEM_PROMPT = `You generate multiple-choice trivia questions for a student quiz app.

Generate exactly 5 general knowledge questions. Respond with ONLY valid JSON in this shape:
{"questions":[{"question":"...","options":["a","b","c","d"],"answer":0}]}

Rules: exactly 5 questions, 4 options each, "answer" is 0-3 index of correct option.`;

function extractJsonFromText(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

function isValidQuizPayload(data) {
  if (!data || !Array.isArray(data.questions) || data.questions.length !== 5) return false;
  return data.questions.every(q =>
    q && typeof q.question === "string" &&
    Array.isArray(q.options) && q.options.length === 4 &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3
  );
}

app.get('/api/quiz', async (req, res) => {
  try { const uid = await authenticatedUid(req); const userSnap = await db.ref(`users/${uid}`).once('value'); const u = userSnap.val(); if (!u || u.banned === true || u.status === 'banned') return res.status(403).json({ error: 'Your account is not permitted to use this service.' }); }
  catch (_) { return res.status(401).json({ error: 'Please sign in to load the quiz.' }); }
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set." });
  try {
    const rawText = await callGroq({
      systemPrompt: QUIZ_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Generate 5 fresh quiz questions now." }],
      jsonMode: true
    });
    let quizData;
    try { quizData = extractJsonFromText(rawText); }
    catch (e) { return res.status(502).json({ error: "AI returned malformed quiz data." }); }
    if (!isValidQuizPayload(quizData)) {
      return res.status(502).json({ error: "AI returned an invalid quiz format." });
    }
    res.json(quizData);
  } catch (error) {
    console.error("Quiz error:", error);
    res.status(500).json({ error: error.message || "Failed to generate quiz." });
  }
});

// =====================================================
// SIWES REPORT GENERATOR — NUBAPOLY TEMPLATE (UPDATED)
// =====================================================

function getDepartmentReferences(dept) {
  const d = (dept || "").toLowerCase();
  const itf = "Industrial Training Fund (ITF). (2020). SIWES Guidelines and Information Manual. ITF Nigeria.";
  const nbte = "National Board for Technical Education (NBTE). (2019). Guidelines for Technical Education. NBTE.";
  const nuc = "National Universities Commission (NUC). (2018). Guidelines for Industrial Training. NUC.";

  if (d.includes("mechanical")) return [
    "Khanna, O. P. (2019). A Textbook of Production Technology. Dhanpat Rai Publications.",
    "Rao, P. N. (2018). Manufacturing Technology: Metal Cutting and Machine Tools. McGraw Hill Education.",
    "Kalpakjian, S., & Schmid, S. R. (2014). Manufacturing Engineering and Technology. Pearson.",
    itf, nbte, nuc
  ];
  if (d.includes("electrical")) return [
    "Theraja, B. L., & Theraja, A. K. (2018). A Textbook of Electrical Technology. S. Chand Publishing.",
    "Sedha, R. S. (2016). A Textbook of Electrical Technology. S. Chand Publishing.",
    "Bakshi, U. A., & Bakshi, M. V. (2017). Electrical Machines. Technical Publications.",
    itf, nbte, nuc
  ];
  // 🚨 FIXED: Added "it" and "information" to catch IT students properly
  if (d.includes("computer") || d.includes("software") || d.includes("it") || d.includes("information")) return [
    "Silberschatz, A., Galvin, P. B., & Gagne, G. (2018). Operating System Concepts. Wiley.",
    "Tanenbaum, A. S., & Wetherall, D. J. (2019). Computer Networks. Pearson.",
    "Sommerville, I. (2016). Software Engineering. Pearson.",
    itf, nbte, nuc
  ];
  if (d.includes("civil")) return [
    "Neville, A. M. (2018). Properties of Concrete. Pearson.",
    "Punmia, B. C., Jain, A. K., & Jain, A. K. (2017). Building Construction. Laxmi Publications.",
    "Varghese, P. C. (2018). Building Materials. PHI Learning.",
    itf, nbte, nuc
  ];
  if (d.includes("business") || d.includes("admin")) return [
    "Koontz, H., & Weihrich, H. (2018). Essentials of Management. McGraw Hill Education.",
    "Drucker, P. F. (2017). The Practice of Management. Routledge.",
    "Kotler, P., & Keller, K. L. (2016). Marketing Management. Pearson.",
    itf, nbte, nuc
  ];
  if (d.includes("account")) return [
    "Horngren, C. T., Datar, S. M., & Rajan, M. V. (2018). Cost Accounting. Pearson.",
    "Weygandt, J. J., Kimmel, P. D., & Kieso, D. E. (2019). Financial Accounting. Wiley.",
    "Kaplan, R. S., & Atkinson, A. A. (2015). Advanced Management Accounting. Pearson.",
    itf, nbte, nuc
  ];
  if (d.includes("science") || d.includes("lab")) return [
    "Okoye, C. O. (2018). Laboratory Techniques in Biological Sciences. Spectrum Books.",
    "Fifield, F. W., & Kealey, D. (2017). Principles and Practice of Analytical Chemistry. Wiley-Blackwell.",
    "Brown, T. L., LeMay, H. E., & Bursten, B. E. (2018). Chemistry: The Central Science. Pearson.",
    itf, nbte, nuc
  ];
  return [itf, nbte, nuc, "Workshop notes, demonstrations, and supervised practical instruction received during the SIWES attachment."];
}

const STUDENT_VOICE_RULE = `
CRITICAL WRITING RULES:
1. Write like a real Nigerian polytechnic student who paid attention during their attachment, not like a textbook or an AI.
2. Use SIMPLE, CLEAR sentences. Mix short and medium sentences. Start sentences with "I", "We", "My supervisor", "During my time", "I was shown", "I learned", "I observed".
3. FORMATTING: You may use **bold** for key terms or sub-headings. You may use dashes (-) for lists. NEVER use hashtags (#), asterisks for headers (***), or code blocks.
4. DO NOT HALLUCINATE COMPANY NAMES. You must ONLY use the exact organisation name provided in the context. Never invent names like "ABC Manufacturing" or "Delta Engineering".
5. AUTOMATIC FILLING: If the student leaves a field empty, YOU MUST INVENT highly realistic, professional details relevant to their department (e.g., if Mechanical, mention lathe machines, micrometers, CNC; if Electrical, mention multimeters, wiring). The report must be 100% complete.
6. Write in the PAST TENSE.
7. DO NOT start with "Certainly" or "Here is". Start directly with the content.
8. You must write detailed paragraphs to ensure the final document is between 20 to 25 pages when printed. Do not write excessively long chapters; follow the word count instructions exactly.
`;

function buildChapterPrompts(form) {
  const f = form;
  const dept = (f.dept || "General").toLowerCase();

  // 🚨 SMART AUTO-FILL LOGIC
  const b = (val, emptyInstruction) => {
    if (val && val.trim() && val !== "Not provided" && val !== "undefined") return val;
    return `[FIELD EMPTY - INVENT REALISTIC PROFESSIONAL DETAILS: ${emptyInstruction}]`;
  };

  return [
    {
      chapterNum: 1,
      title: "CHAPTER ONE: INTRODUCTION TO SIWES",
      prompt: `Write CHAPTER ONE of a Nigerian SIWES technical report. 
${STUDENT_VOICE_RULE}

STRUCTURE — use these exact sub-headings, and ensure you write a detailed paragraph after each one:
a. Definition of SIWES
b. Brief History of SIWES
c. Importance / Purpose of SIWES
d. Aim and Objectives of SIWES
e. Bodies Involved in the Management of SIWES and Their Roles

Student context:
- Name: ${b(f.fullName, "Use 'The Student'")}
- Institution: ${b(f.institution, "Use 'Nuhu Bamalli Polytechnic'")}
- Department: ${b(f.dept, "Use 'Engineering'")}
- Faculty: ${b(f.faculty, "Use 'School of Engineering'")}
- Level: ${b(f.level, "Use 'ND II'")}

Write exactly 900 words for this chapter. Use real SIWES facts (ITF, 1973, NBTE/NUC/NCCE).`
    },
    {
      chapterNum: 2,
      title: "CHAPTER TWO: " + (form.orgName || "ORGANISATION PROFILE").toUpperCase(),
      prompt: `Write CHAPTER TWO of a Nigerian SIWES report about the student's host organisation. 
${STUDENT_VOICE_RULE}

STRUCTURE — use these exact sub-headings:
a. Brief History of the Organisation
b. Mission of the Organisation
c. Vision of the Organisation
d. Organisational Chart
e. Roles Performed by the Organisation

Student context:
- Organisation: ${b(f.orgName, "INVENT a realistic company name")}
- Address: ${b(f.orgAddress, "INVENT a realistic Nigerian street address")}
- Sector: ${b(f.orgSector, "INVENT a sector relevant to the department")}
- History provided: ${b(f.orgHistory, "WRITE a realistic 1-paragraph history")}
- Mission provided: ${b(f.orgMission, "WRITE a professional corporate mission")}
- Vision provided: ${b(f.orgVision, "WRITE a professional corporate vision")}
- Student's unit: ${b(f.orgUnit, "INVENT a relevant department")}
- Student's role: ${b(f.jobRole, "INVENT a realistic intern job title")}
- Supervisor: ${b(f.supervisorName, "INVENT a Nigerian name")} (${b(f.supervisorPosition, "INVENT a job title")})

Write exactly 1,000 words for this chapter. Describe the organisational chart briefly.`
    },
    {
      chapterNum: 3,
      title: "CHAPTER THREE: PRACTICAL EXPERIENCE",
      prompt: `Write CHAPTER THREE of a Nigerian SIWES report describing the student's actual practical experience.
${STUDENT_VOICE_RULE}

STRUCTURE — use these sub-headings:
a. Experience Acquired in the Organisation (Break this down month by month: Month 1, Month 2, Month 3, Month 4)
b. Summary of Work Undertaken in the Organisation

Student context:
- Job role: ${b(f.jobRole, "INVENT a relevant intern role")}
- Work hours: ${b(f.workHours, "Assume 8:00 AM to 4:00 PM, Monday to Friday")}
- Daily routine: ${b(f.dailyRoutine, "INVENT a realistic daily routine")}
- Tools used: ${b(f.tools, `INVENT specific tools or software relevant to ${dept} (e.g., VS Code for CS, lathe machines for Mech)`)}
- Trainings: ${b(f.trainings, "INVENT a realistic workplace training")}
- Project title: ${b(f.projectTitle, "INVENT a realistic project title")}
- Project description: ${b(f.projectDesc, "INVENT a detailed description")}
- Project contribution: ${b(f.projectContribution, "INVENT what the student did")}
- Project tools: ${b(f.projectTools, "INVENT tools used for the project")}
- Month 1: ${b(f.month1, "Describe general orientation")}
- Month 2: ${b(f.month2, "Describe assisting senior staff")}
- Month 3: ${b(f.month3, "Describe working independently")}
- Month 4: ${b(f.month4, "Describe final project completion")}

Write exactly 1,800 words for this chapter. Detail exactly what the student did every single month.`
    },
    {
      chapterNum: 4,
      title: "CHAPTER FOUR: PROBLEMS, CHALLENGES AND SOLUTIONS",
      prompt: `Write CHAPTER FOUR of a Nigerian SIWES report about problems, challenges, and solutions.
${STUDENT_VOICE_RULE}

STRUCTURE:
a. Problems / Challenges Faced in the Organisation
b. Solutions to the Problems / Challenges Faced

Student context:
- Technical challenge 1: ${b(f.challenge1, "INVENT a realistic technical challenge")}
- Solution 1: ${b(f.challenge1Solution, "INVENT a realistic solution")}
- Technical challenge 2: ${b(f.challenge2, "INVENT a second technical challenge")}
- Solution 2: ${b(f.challenge2Solution, "INVENT a realistic solution")}
- Interpersonal challenges: ${b(f.challengeInterpersonal, "INVENT a teamwork issue")}
- Infrastructure issues: ${b(f.challengeInfrastructure, "INVENT a Nigerian infrastructure issue")}
- Lessons learned: ${b(f.challengeLessons, "Summarize key lessons")}

Write exactly 900 words. Make the challenges sound real and technical.`
    },
    {
      chapterNum: 5,
      title: "CHAPTER FIVE: SUMMARY, CONCLUSION AND RECOMMENDATION",
      prompt: `Write CHAPTER FIVE of a Nigerian SIWES report.
${STUDENT_VOICE_RULE}

STRUCTURE:
a. Summary
b. Conclusion
c. Recommendation

Student context:
- Technical skills: ${b(f.technicalSkills, "INVENT technical skills acquired")}
- Soft skills: ${b(f.softSkills, "INVENT soft skills acquired")}
- Relevance to course: ${b(f.relevance, "Explain how SIWES relates to the course")}
- Recommendations: ${b(f.recommendations, "INVENT 3 recommendations")}
- Advice: ${b(f.advice, "INVENT advice for future students")}

Write exactly 700 words. Ensure the conclusion sounds highly professional.`
    }
  ];
}

// -----------------------------------------------------
// Every report gets its own "writing personality" so two students with identical answers
// still receive clearly different reports.
// -----------------------------------------------------
const VAR_POOL = {
  tone: [
    "reflective and personal, as a student looking back on growth",
    "practical and procedural, focusing on how things were done step by step",
    "analytical, comparing classroom theory with what was seen on site",
    "observant and descriptive, painting the workplace scene in detail",
    "disciplined and formal, like a report written for a strict examiner"
  ],
  rhythm: [
    "mostly medium-length sentences with an occasional very short one for emphasis",
    "a mix of long explanatory sentences and brief clear statements",
    "compact paragraphs of 4 to 5 sentences, each built around one clear point",
    "flowing paragraphs that link each idea to the next with natural transitions"
  ],
  opening: [
    "open each major section with a concrete observation or situation",
    "open each major section with a short statement of its purpose",
    "open each major section by connecting it to the previous section",
    "open each major section with a question the student wanted answered"
  ],
  vocab: [
    "prefer words like: exposure, hands-on, procedure, supervision, workflow, standard practice",
    "prefer words like: familiarisation, competence, instruction, safety, routine, accuracy",
    "prefer words like: involvement, guidance, application, workplace culture, efficiency, practice",
    "prefer words like: orientation, responsibility, technique, coordination, quality, discipline"
  ],
  focus: [
    "give extra weight to safety and workplace discipline",
    "give extra weight to teamwork and communication with colleagues",
    "give extra weight to the link between classroom theory and site practice",
    "give extra weight to tools, equipment and measurable outcomes",
    "give extra weight to time management and responsibility"
  ]
};
function pickOne(arr) { return arr[crypto.randomInt(arr.length)]; }
function buildVariation() {
  return {
    seed: crypto.randomBytes(6).toString('hex'),
    tone: pickOne(VAR_POOL.tone), rhythm: pickOne(VAR_POOL.rhythm), opening: pickOne(VAR_POOL.opening),
    vocab: pickOne(VAR_POOL.vocab), focus: pickOne(VAR_POOL.focus)
  };
}
function variationBlock(v) {
  return `
UNIQUENESS ASSIGNMENT (report code ${v.seed}) — this report must read differently from any other report on the same topic:
- Tone: ${v.tone}.
- Sentence rhythm: ${v.rhythm}.
- Structure: ${v.opening}.
- Vocabulary: ${v.vocab}.
- Emphasis: ${v.focus}.
- Never reuse stock textbook sentences. Re-express every general fact (SIWES history, definitions, aims) in fresh wording and tie it to this student's course, organisation and own experience.
- Include concrete, specific details from the student's answers (names, tools, dates, tasks) wherever possible.`;
}

async function generateChapter(prompt, maxTokens = 4000, variation = null) {
  return callGroq({
    systemPrompt: `You are an expert Nigerian SIWES report writer. You write highly detailed, professional, and technical reports that read exactly like a real student wrote them. You follow the formatting rules strictly.${variation ? variationBlock(variation) : ''}`,
    messages: [{ role: "user", content: prompt }],
    model: MODELS.default,
    maxTokens: maxTokens,
    temperature: 0.9
  });
}

function stripMarkdown(text) {
  if (!text) return "";
  let c = text;
  // Remove hashtags and code blocks (we KEEP ** and - for the docx builder)
  c = c.replace(/^#{1,6}\s+/gm, "");
  c = c.replace(/```[\s\S]*?```/g, "");
  c = c.replace(/`([^`]+)`/g, "$1");
  c = c.replace(/^>\s+/gm, "");
  c = c.replace(/\n{3,}/g, "\n\n");
  return c.trim();
}

function parseChapter(text) {
  const out = [];
  const cleaned = stripMarkdown(text);
  const lines = cleaned.split(/\r?\n/);
  
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    
    // 1. Detect Bullet Points (starts with - or *)
    if (/^[-*+•]\s+/.test(line)) {
      out.push({ type: "bullet", text: line.replace(/^[-*+•]\s+/, "") });
      continue;
    }

    // 2. Detect Subheadings
    const isSubheading =
      /^[a-eA-E]\.\s+[A-Z]/.test(line) ||
      /^[a-eA-E]\)\s+/.test(line) ||
      (line.length < 80 && /^(definition|brief history|importance|aim|bodies|mission|vision|organisational chart|experience|summary|problems|solutions|conclusion|recommendation|references)\b/i.test(line));
      
    if (isSubheading) {
      out.push({ type: "subheading", text: line.replace(/\*\*/g, "") }); // Strip bold from headings
    } else {
      // Handle merged heading and text
      const mergedHeadingMatch = line.match(/^([a-eA-E]\.\s*[A-Za-z\s]{3,35})(.*)$/);
      if (mergedHeadingMatch && mergedHeadingMatch[2].trim().length > 0) {
        out.push({ type: "subheading", text: mergedHeadingMatch[1].replace(/\*\*/g, "").trim() });
        out.push({ type: "paragraph", text: mergedHeadingMatch[2].trim() });
      } else {
        out.push({ type: "paragraph", text: line });
      }
    }
  }
  return out;
}

function dataUriToBuffer(dataUri) {
  const base64 = dataUri.split(",")[1];
  return Buffer.from(base64, "base64");
}

// 🚨 FIXED: Handles bold text (**) natively inside Word
function docxPara(text, opts = {}) {
  const parts = String(text || "").split(/(\*\*.*?\*\*)/g);
  
  const children = parts.map(part => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return new TextRun({
        text: part.slice(2, -2),
        bold: true,
        italics: !!opts.italic,
        size: opts.size || 24,
        font: "Times New Roman"
      });
    }
    return new TextRun({
      text: part,
      bold: !!opts.bold,
      italics: !!opts.italic,
      size: opts.size || 24,
      font: "Times New Roman"
    });
  });

  return new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : (opts.right ? AlignmentType.RIGHT : AlignmentType.JUSTIFIED),
    spacing: { after: opts.afterSpacing ?? 160, line: 360 },
    children: children
  });
}

function docxHeading(text, level = 1, inToc = false) {
  const sizes = { 1: 32, 2: 28, 3: 26 };
  return new Paragraph({
    ...(inToc ? { heading: HeadingLevel.HEADING_1 } : {}),
    spacing: { before: 240, after: 200, line: 360 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({
      text: text, bold: true, color: "000000",
      size: sizes[level] || 26,
      font: "Times New Roman"
    })]
  });
}

function docxSubheading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 160, line: 360 },
    children: [new TextRun({
      text: text, bold: true, color: "000000", size: 26, font: "Times New Roman"
    })]
  });
}

function docxPageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
    }

// -----------------------------------------------------
// /api/siwes
// -----------------------------------------------------
                            
app.post('/api/siwes', async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "GROQ_API_KEY not set on server." });
  }

  let uid;
  try { uid = await authenticatedUid(req); }
  catch (_) { return res.status(401).json({ error: 'Please sign in before generating a SIWES report.' }); }
  const { uid: suppliedUid, formData, images } = req.body || {};
  if (suppliedUid && suppliedUid !== uid) return res.status(403).json({ error: 'The submitted account does not match your signed-in account.' });
  if (!formData || typeof formData !== 'object') return res.status(400).json({ error: 'Missing report form data.' });

  // 🚨 MANDATORY FIELD VALIDATION (Prevents wasted AI calls and protects the user)
  const requiredFields = ['fullName', 'matric', 'dept', 'institution', 'orgName', 'startDate', 'endDate'];
  for (const field of requiredFields) {
    if (!formData[field] || String(formData[field]).trim() === "") {
      return res.status(400).json({ error: `Missing required field: ${field}. Please go back and fill it in.` });
    }
  }

  const requestId = String(req.body?.requestId || '').trim();
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(requestId)) return res.status(400).json({ error: 'Invalid report request reference. Please try again.' });
  const reportFee = Number(process.env.SIWES_REPORT_FEE_NAIRA || 1000);
  if (!Number.isSafeInteger(reportFee) || reportFee < 0) return res.status(503).json({ error: 'SIWES report fee is not configured correctly.' });
  const siwesUserRef = db.ref(`users/${uid}`);
  const siwesUserSnap = await siwesUserRef.once('value');
  const siwesUser = siwesUserSnap.val();
  if (!siwesUser || siwesUser.banned === true || siwesUser.status === 'banned' || siwesUser.walletFrozen === true) return res.status(403).json({ error: 'Your account or wallet is restricted.' });
  if (siwesUser.siwesCharges && siwesUser.siwesCharges[requestId]) return res.status(409).json({ error: 'This report request has already been used. Start a new report request.' });
  try {
  let insufficientBalance = false;
  const chargeResult = await siwesUserRef.transaction(user => {
    if (user === null) return user;   // first local run is null in the Admin SDK: let Firebase retry with the real value
    const charges = user.siwesCharges || {};
    if (charges[requestId]) return;
    const balance = Number(user.walletBalance || 0);
    if (!Number.isFinite(balance) || balance < reportFee) { insufficientBalance = true; return; }
    user.walletBalance = balance - reportFee;
    charges[requestId] = { amount: reportFee, status: 'processing', createdAt: Date.now() };
    user.siwesCharges = charges;
    return user;
  });
  if (!chargeResult.committed) return res.status(400).json({ error: insufficientBalance ? 'Insufficient wallet balance.' : 'Could not reserve the SIWES report fee. Please retry.' });
  await db.ref(`users/${uid}/transactions/siwes_${requestId}`).set({ type:'siwes_report', amount:-reportFee, status:'processing', reference:requestId, createdAt:Date.now() });
  await db.ref(`walletLedger/${uid}/siwes_${requestId}`).set({ type:'siwes_report', direction:'debit', amount:reportFee, reference:requestId, description:'SIWES report generation fee', status:'processing', createdAt:Date.now() });

    console.log(`[SIWES] Starting for uid=${uid}, org=${formData.orgName}, dept=${formData.dept}`);

    const prompts = buildChapterPrompts(formData);
    const reportVariation = buildVariation();
    const chapters = [];

    for (const p of prompts) {
      console.log(`[SIWES] Generating ${p.title}...`);
      
      // 🚨 FIXED: 20-25 Page Token Limits
      const maxTokensForChapter = p.chapterNum === 3 ? 3500 : 2000; 
      const raw = await generateChapter(p.prompt, maxTokensForChapter, reportVariation); 
      
      chapters.push({ num: p.chapterNum, title: p.title, text: stripMarkdown(raw) });

      // Wait 10 seconds before the next chapter to avoid rate limit
      if (p.chapterNum < 5) {
        console.log(`[SIWES] Waiting 10s to avoid rate limit...`);
        await new Promise(r => setTimeout(r, 10000));
      }
        }
    console.log(`[SIWES] All chapters generated. Building DOCX...`);

    const children = [];

    // ===== TITLE PAGE =====
    children.push(docxPara(""));
    children.push(docxPara("A TECHNICAL REPORT ON", { center: true, bold: true, size: 28 }));
    children.push(docxPara("STUDENT INDUSTRIAL WORK EXPERIENCE SCHEME (SIWES)", { center: true, bold: true, size: 28 }));
    children.push(docxPara(""));
    children.push(docxPara("UNDERTAKEN AT", { center: true, bold: true, size: 24 }));
    children.push(docxPara(""));
    children.push(docxPara((formData.orgName || "").toUpperCase(), { center: true, bold: true, size: 28 }));
    children.push(docxPara(formData.orgAddress || "", { center: true, size: 22 }));
    children.push(docxPara(""));
    children.push(docxPara("SUBMITTED BY", { center: true, bold: true, size: 24 }));
    children.push(docxPara(""));
    children.push(docxPara((formData.fullName || "").toUpperCase(), { center: true, bold: true, size: 28 }));
    children.push(docxPara(formData.matric || "", { center: true, size: 24 }));
    children.push(docxPara(""));
    children.push(docxPara("DEPARTMENT OF " + (formData.dept || "").toUpperCase(), { center: true, bold: true, size: 24 }));
    children.push(docxPara("FACULTY OF " + (formData.faculty || "").toUpperCase(), { center: true, bold: true, size: 24 }));
    children.push(docxPara((formData.institution || "NUHU BAMALLI POLYTECHNIC, ZARIA").toUpperCase(), { center: true, bold: true, size: 26 }));
    children.push(docxPara(""));
    children.push(docxPara(`SIWES PERIOD: ${formData.startDate || ""} TO ${formData.endDate || ""}`, { center: true, bold: true, size: 22 }));
    children.push(docxPara(""));
    children.push(docxPara("IN PARTIAL FULFILMENT OF THE REQUIREMENTS FOR THE AWARD OF " + (formData.level || "NATIONAL DIPLOMA"), { center: true, italic: true, size: 22 }));
    children.push(docxPara(""));
    children.push(docxPara(new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long" }), { center: true, bold: true, size: 24 }));
    children.push(docxPageBreak());

    // ===== DECLARATION =====
    children.push(docxHeading("DECLARATION", 1));
    children.push(docxPara(""));
    {
      const nm = formData.fullName || "", org = formData.orgName || "the organisation";
      const decls = [
        `I, ${nm}, hereby declare that this SIWES technical report is my original work and has not been submitted elsewhere. It documents the industrial training I undertook at ${org} from ${formData.startDate || ""} to ${formData.endDate || ""}.`,
        `I, ${nm}, declare that the contents of this technical report are a true account of my Student Industrial Work Experience Scheme (SIWES) training at ${org} between ${formData.startDate || ""} and ${formData.endDate || ""}, and that this work has not been presented to any other institution for any award.`,
        `This is to declare that I, ${nm}, prepared this report from my own industrial training experience at ${org} during the period ${formData.startDate || ""} to ${formData.endDate || ""}. To the best of my knowledge, it has not been submitted for assessment elsewhere.`
      ];
      children.push(docxPara(pickOne(decls)));
    }
    children.push(docxPara(""));
    children.push(docxPara(""));
    children.push(docxPara("_________________________________"));
    children.push(docxPara((formData.fullName || "").toUpperCase(), { bold: true }));
    children.push(docxPara(`Date: ${new Date().toLocaleDateString("en-GB")}`));
    children.push(docxPageBreak());

    // ===== CERTIFICATION =====
    children.push(docxHeading("CERTIFICATION", 1));
    children.push(docxPara(""));
    children.push(docxPara(`This is to certify that this SIWES technical report was carried out by ${formData.fullName || "the student"} (${formData.matric || "Matric No."}) of the Department of ${formData.dept || ""}, ${formData.institution || "Nuhu Bamalli Polytechnic, Zaria"}, and is approved as meeting the requirements of the institution.`));
    children.push(docxPara(""));
    children.push(docxPara(""));
    children.push(docxPara("_________________________________"));
    children.push(docxPara((formData.supervisorName || "").toUpperCase(), { bold: true }));
    children.push(docxPara(`Industry Supervisor (${formData.supervisorPosition || ""})`));
    children.push(docxPara("Date: ___________________________"));
    children.push(docxPara(""));
    children.push(docxPara(""));
    children.push(docxPara("_________________________________"));
    children.push(docxPara("Engr. Shehu Bello", { bold: true }));
    children.push(docxPara("School Supervisor"));
    children.push(docxPara("Date: ___________________________"));
    children.push(docxPageBreak());

    // ===== DEDICATION =====
    children.push(docxHeading("DEDICATION", 1));
    children.push(docxPara(""));
    children.push(docxPara(pickOne([
      "This report is dedicated to Almighty Allah, to my family for their unwavering support throughout my academic journey, and to everyone who contributed to the success of my SIWES attachment.",
      "I dedicate this work to Almighty Allah for the strength and good health granted to me, and to my parents and well-wishers whose prayers and encouragement carried me through this training.",
      "This report is dedicated to my family, my lecturers and everyone who believed in me during my industrial attachment and my studies."
    ])));
    children.push(docxPageBreak());

    // ===== ACKNOWLEDGEMENT =====
    children.push(docxHeading("ACKNOWLEDGEMENT", 1));
    children.push(docxPara(""));
    {
      const org = formData.orgName || "the organisation", sup = formData.supervisorName || "my industry supervisor";
      const inst = formData.institution || "Nuhu Bamalli Polytechnic, Zaria";
      children.push(docxPara(pickOne([
        `I sincerely appreciate the management and staff of ${org} for giving me the opportunity to undertake my industrial training with them. My special thanks go to ${sup} for the guidance, patience, and practical mentorship throughout the attachment period.`,
        `My deepest gratitude goes to the management and staff of ${org} for accepting me for my industrial training. I am especially thankful to ${sup}, whose supervision and encouragement shaped my experience throughout the attachment.`,
        `I thank the management and staff of ${org} for the warm reception and the chance to learn on the job. I owe particular thanks to ${sup} for the time, instruction and support given to me during the programme.`
      ])));
      children.push(docxPara(""));
      children.push(docxPara(pickOne([
        `I also appreciate the management and lecturers of ${inst}, particularly the Department of ${formData.dept || "my department"}, for preparing me academically and for supervising my progress during the programme.`,
        `I am grateful to ${inst} and the Department of ${formData.dept || "my department"}, including my school supervisor, for the academic foundation and the follow-up visits that supported my training.`
      ])));
    }
    children.push(docxPara(""));
    children.push(docxPara("Finally, my gratitude goes to my family and friends for their encouragement and support throughout the programme."));
    children.push(docxPageBreak());

    const idxB = children.length;   // section B starts here (Roman numerals)
    // ===== TABLE OF CONTENTS =====
    children.push(docxHeading("TABLE OF CONTENTS", 1));
    children.push(docxPara(""));
    // Real Word table of contents: it lists the real headings with real page numbers
    // (Word asks once to update fields when the file is opened).
    children.push(new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }));
    children.push(docxPageBreak());

    // ===== LIST OF FIGURES =====
    children.push(docxHeading("LIST OF FIGURES", 1));
    children.push(docxPara(""));
    const figures = [];
    if (images?.logo?.data) figures.push("Figure 2.1: Organisation Logo");
    if (images?.organogram?.data) figures.push("Figure 2.2: Organisational Chart");
    if (images?.work1?.data) figures.push("Figure 3.1: Author on duty at the workshop");
    if (images?.work2?.data) figures.push("Figure 3.2: Author with colleagues during a task");
    if (images?.work3?.data) figures.push("Figure 3.3: Author operating equipment");
    if (images?.project1?.data) figures.push("Figure 3.4: Project work in progress");
    if (images?.project2?.data) figures.push("Figure 3.5: Completed project output");
    if (!figures.length) figures.push("No figures available for this report.");
    figures.forEach(f => children.push(docxPara(f, { size: 22, afterSpacing: 100 })));
    children.push(docxPageBreak());

    // ===== LIST OF TABLES =====
    children.push(docxHeading("LIST OF TABLES", 1));
    children.push(docxPara(""));
    children.push(docxPara("No separate data tables are required in this report.", { size: 22 }));
    children.push(docxPageBreak());

    // ===== ABSTRACT =====
    children.push(docxHeading("ABSTRACT", 1, true));
    children.push(docxPara(""));
    children.push(docxPara(
      `\nThis report presents a detailed account of the Student Industrial Work Experience Scheme (SIWES) attachment undertaken by ${formData.fullName || "the student"} at ${formData.orgName || "an organisation"} from ${formData.startDate || ""} to ${formData.endDate || ""}, as part of the ${formData.level || "ND II"} ${formData.dept || "programme"} at ${formData.institution || "Nuhu Bamalli Polytechnic, Zaria"}. During the attachment, the student worked in the ${formData.orgUnit || "relevant"} unit as a ${formData.jobRole || "student intern"}. The report covers the organisation's profile, the practical experience acquired, the projects handled, the technical and interpersonal challenges encountered, and the lessons learned. The SIWES programme provided invaluable practical exposure that complemented the theoretical knowledge gained in the classroom and significantly enhanced the student's technical and soft skills.`
    ));
    children.push(docxPageBreak());

    const idxC = children.length;   // section C starts here (Chapter 1, page 1)
    // ===== CHAPTERS =====
    for (const ch of chapters) {
      children.push(docxHeading(ch.title, 1, true));
      children.push(docxPara(""));

      if (images) {
        if (ch.num === 2 && images.logo?.data) {
          try {
            children.push(new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new ImageRun({ data: dataUriToBuffer(images.logo.data), transformation: { width: 180, height: 180 } })]
            }));
            children.push(docxPara("Figure 2.1: Organisation Logo", { center: true, italic: true, size: 20 }));
          } catch (e) { console.error("Logo image error:", e); }
        }

        if (ch.num === 3) {
          const workImgs = [images.work1, images.work2, images.work3].filter(i => i?.data);
          let figN = 1;
          for (const img of workImgs) {
            try {
              // 🚨 FIXED: Aspect ratio changed to 450x320
              children.push(new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new ImageRun({ data: dataUriToBuffer(img.data), transformation: { width: 450, height: 320 } })]
              }));
              children.push(docxPara(`Figure 3.${figN}: Author on duty at ${formData.orgName || "the organisation"}`, { center: true, italic: true, size: 20 }));
              figN++;
            } catch (e) { console.error("Work image error:", e); }
          }
          const projImgs = [images.project1, images.project2].filter(i => i?.data);
          for (const img of projImgs) {
            try {
              // 🚨 FIXED: Aspect ratio changed to 450x320
              children.push(new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new ImageRun({ data: dataUriToBuffer(img.data), transformation: { width: 450, height: 320 } })]
              }));
              children.push(docxPara(`Figure 3.${figN}: ${formData.projectTitle || "Project work"}`, { center: true, italic: true, size: 20 }));
              figN++;
            } catch (e) { console.error("Project image error:", e); }
          }
        }
      }

      const parsed = parseChapter(ch.text);
      for (const item of parsed) {
        if (item.type === "subheading") {
          children.push(docxSubheading(item.text));
        } else if (item.type === "bullet") {
          // 🚨 FIXED: Renders real Word bullet points
          children.push(new Paragraph({
            text: item.text,
            bullet: { level: 0 },
            spacing: { after: 120, line: 360 },
            style: "Normal"
          }));
        } else {
          children.push(docxPara(item.text));
        }
      }

      if (ch.num === 5) {
        children.push(docxSubheading("d. References"));
        children.push(docxPara(""));
        const refs = getDepartmentReferences(formData.dept);
        refs.forEach(r => children.push(docxPara(r, { size: 22, afterSpacing: 160 })));
      }

      children.push(docxPageBreak());
    }
     // ===== PACK AND SEND =====
    const pageMargin = { top: 1440, right: 1440, bottom: 1440, left: 1440 };
    const numberFooter = () => new Footer({
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: [PageNumber.CURRENT], font: "Times New Roman", size: 24 })]
      })]
    });
    // Drop the trailing page break of each part: a new section already starts on a new page.
    const partA = children.slice(0, idxB - 1);
    const partB = children.slice(idxB, idxC - 1);
    const partC = children.slice(idxC, children.length - 1);

    const doc = new Document({
      creator: formData.fullName || "MudyHub Student",
      title: "SIWES Technical Report",
      features: { updateFields: true },
      styles: {
        default: {
          heading1: { run: { font: "Times New Roman", size: 32, bold: true, color: "000000" }, paragraph: { alignment: AlignmentType.CENTER } },
          heading2: { run: { font: "Times New Roman", size: 26, bold: true, color: "000000" } }
        }
      },
      sections: [
        // A: title page, declaration, certification, dedication, acknowledgement — no page numbers
        { properties: { page: { margin: pageMargin } }, children: partA },
        // B: contents pages — Roman numerals starting at i
        { properties: { page: { margin: pageMargin, pageNumbers: { start: 1, formatType: NumberFormat.LOWER_ROMAN } } },
          footers: { default: numberFooter() }, children: partB },
        // C: Chapter One to the end — Arabic numerals starting at 1
        { properties: { page: { margin: pageMargin, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } } },
          footers: { default: numberFooter() }, children: partC }
      ]
    });

    const buffer = await Packer.toBuffer(doc);
    await db.ref(`users/${uid}/transactions/siwes_${requestId}`).update({ status:'completed', completedAt:Date.now() });
    await db.ref(`walletLedger/${uid}/siwes_${requestId}`).update({ status:'completed', completedAt:Date.now() });
    await siwesUserRef.child(`siwesCharges/${requestId}`).update({ status:'completed', completedAt:Date.now() });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="SIWES_Report_${formData.matric || uid}.docx"`);
    res.send(buffer);

    console.log(`[SIWES] ✅ Report sent for uid=${uid}, size=${buffer.length} bytes`);
  } catch (error) {
    console.error("[SIWES] Error:", error);
    let refunded = false;
    try {
      const refund = await siwesUserRef.transaction(user => {
        if (user === null) return user;   // first local run is null in the Admin SDK: let Firebase retry with the real value
        const charges = user.siwesCharges || {};
        const charge = charges[requestId];
        if (!charge || charge.status === 'completed' || charge.status === 'refunded') return user;
        const claims = user.siwesRefundClaims || {};
        if (claims[requestId]) return user;
        user.walletBalance = Number(user.walletBalance || 0) + reportFee;
        claims[requestId] = true; user.siwesRefundClaims = claims;
        charges[requestId] = { ...charge, status:'refunded', refundedAt:Date.now() };
        user.siwesCharges = charges; refunded = true;
        return user;
      });
      if (refund.committed && refunded) {
        await db.ref(`users/${uid}/transactions/siwes_${requestId}`).update({ status:'refunded', refundedAt:Date.now() });
        await db.ref(`walletLedger/${uid}/siwes_${requestId}`).update({ status:'refunded', refundedAt:Date.now() });
      }
    } catch (refundError) { console.error('[SIWES] Automatic refund failed:', refundError); }
    res.status(500).json({ error: (error.message || "Failed to generate SIWES report.") + (refunded ? ' The report fee has been returned to your wallet.' : ' If your wallet was charged, contact support with reference ' + requestId + '.') });
  }
});

// =====================================================================
// MINI-BANK ROUTES (SECURE MONEY HANDLING)
// =====================================================================

// --- A. Paystack wallet funding: one canonical wallet, test/live key pairs ---
function paystackMode() { return String(process.env.PAYSTACK_MODE || "test").toLowerCase() === "live" ? "live" : "test"; }
function paystackKeys() {
  const mode = paystackMode();
  const clean = v => String(v || "").trim().replace(/^["']|["']$/g, "");
  // Preferred names first; then legacy names, accepted only if the key prefix matches the active mode.
  const pick = (names, prefix) => {
    for (const n of names) { const v = clean(process.env[n]); if (v && v.startsWith(prefix)) return v; }
    return "";
  };
  return mode === "live"
    ? { mode, publicKey: pick(["PAYSTACK_LIVE_PUBLIC_KEY", "PAYSTACK_PUBLIC_KEY"], "pk_live_"), secretKey: pick(["PAYSTACK_LIVE_SECRET_KEY", "PAYSTACK_SECRET_KEY"], "sk_live_") }
    : { mode, publicKey: pick(["PAYSTACK_TEST_PUBLIC_KEY", "PAYSTACK_PUBLIC_KEY"], "pk_test_"), secretKey: pick(["PAYSTACK_TEST_SECRET_KEY", "PAYSTACK_SECRET_KEY"], "sk_test_") };
}
async function authenticatedUid(req) {
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  if (!token) throw new Error("Unauthorized");
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (_) {
    throw new Error("Unauthorized");
  }
}


// =====================================================================
// ADMIN AUTHORIZATION + AUDIT — all privileged actions are server-checked
// =====================================================================
const ADMIN_MODULES = new Set(['tasks', 'campaigns', 'withdrawals', 'campus', 'support', 'verification', 'moderation', 'trueConnection', 'business']);
async function requireAdmin(req, permission = null) {
  const uid = await authenticatedUid(req);
  const authUser = await admin.auth().getUser(uid).catch(() => null);
  if (!authUser || authUser.disabled || !authUser.emailVerified) throw new Error('Forbidden');
  const snap = await db.ref(`admins/${uid}`).once('value');
  const raw = snap.val();
  if (!raw) throw new Error('Forbidden');
  const record = raw === true ? { role: 'super_admin', status: 'active', name: 'Super Admin' } : raw;
  if (record.status === 'banned' || record.status === 'disabled') throw new Error('Forbidden');
  if (!['super_admin', 'normal_admin'].includes(record.role)) throw new Error('Forbidden');
  if (permission && record.role !== 'super_admin') {
    const allowed = permission === 'tc:moderate'
      ? record.permissions?.trueConnection === true
      : record.permissions?.[permission] === true;
    if (!allowed) throw new Error('Forbidden');
  }
  return { uid, role: record.role, name: record.name || record.fullName || 'Admin', permissions: record.permissions || {}, status: record.status || 'active' };
}
async function writeAudit(actor, action, targetType = 'platform', targetId = '', reason = '', before = null, after = null) {
  const entry = {
    adminUid: actor.uid, adminName: actor.name || 'Admin', role: actor.role,
    action: String(action || 'admin_action').slice(0, 120), targetType: String(targetType || '').slice(0, 80),
    targetId: String(targetId || '').slice(0, 160), reason: String(reason || '').slice(0, 500),
    before: before == null ? null : before, after: after == null ? null : after, createdAt: Date.now()
  };
  const ref = db.ref('adminAuditLog').push();
  await ref.set(entry);
  await db.ref('admin_logs').push().set(entry);
  return ref.key;
}
function adminResponseError(res, error) {
  const status = error.message === 'Unauthorized' ? 401 : error.message === 'Forbidden' ? 403 : 400;
  return res.status(status).json({ ok: false, error: status === 403 ? 'You do not have permission for this action.' : error.message || 'Admin action failed.' });
}
app.get('/api/admin/me', async (req, res) => {
  try { return res.json({ ok: true, admin: await requireAdmin(req) }); }
  catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/log', async (req, res) => {
  try { const actor = await requireAdmin(req); const id = await writeAudit(actor, req.body?.action || 'admin_log'); return res.json({ ok: true, id }); }
  catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/manager/grant', async (req, res) => {
  try {
    const actor = await requireAdmin(req);
    if (actor.role !== 'super_admin') throw new Error('Forbidden');
    const uid = String(req.body?.uid || '').trim();
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(uid)) throw new Error('Invalid user ID.');
    const authUser = await admin.auth().getUser(uid);
    if (authUser.disabled) throw new Error('This account is disabled.');
    const current = await db.ref(`admins/${uid}`).once('value');
    if (current.exists()) throw new Error('This user already has an admin record.');
    const record = { name: String(req.body?.name || authUser.displayName || 'Admin').slice(0,100), phone: String(req.body?.phone || '').slice(0,30), role: 'normal_admin', status: 'active', permissions: {}, createdAt: Date.now(), createdBy: actor.uid };
    await db.ref(`admins/${uid}`).set(record);
    await writeAudit(actor, 'grant_admin_access', 'admin', uid, '', null, { role: record.role, status: record.status });
    return res.json({ ok: true });
  } catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/manager/update', async (req, res) => {
  try {
    const actor = await requireAdmin(req);
    if (actor.role !== 'super_admin') throw new Error('Forbidden');
    const uid = String(req.body?.uid || '').trim();
    if (!uid || uid === actor.uid) throw new Error('You cannot change your own admin record here.');
    const targetRef = db.ref(`admins/${uid}`); const snap = await targetRef.once('value');
    if (!snap.exists()) throw new Error('Admin not found.');
    const old = snap.val(); if (old === true || old.role === 'super_admin') throw new Error('Super Admin records cannot be changed here.');
    const patch = {};
    if (req.body?.status !== undefined) {
      if (!['active','banned','disabled'].includes(req.body.status)) throw new Error('Invalid admin status.');
      patch.status = req.body.status;
    }
    if (req.body?.permissions !== undefined) {
      const perms = req.body.permissions || {};
      const keys = Object.keys(perms).filter(k => perms[k] === true);
      if (keys.length > 3) throw new Error('A Normal Admin can have no more than 3 assigned modules.');
      if (keys.some(k => !ADMIN_MODULES.has(k))) throw new Error('One or more permissions are not available in V1.');
      patch.permissions = Object.fromEntries([...ADMIN_MODULES].map(k => [k, keys.includes(k)]));
    }
    if (!Object.keys(patch).length) throw new Error('No valid admin changes supplied.');
    await targetRef.update(patch);
    await writeAudit(actor, 'update_admin', 'admin', uid, '', old, patch);
    return res.json({ ok: true });
  } catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/wallet/adjust', async (req, res) => {
  try {
    const actor = await requireAdmin(req);
    if (actor.role !== 'super_admin') throw new Error('Forbidden');
    const uid = String(req.body?.uid || '').trim();
    const amount = Number(req.body?.amount);
    const reason = String(req.body?.reason || '').trim().slice(0,500);
    if (!uid || uid === actor.uid || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000 || reason.length < 10) throw new Error('Provide a valid user, adjustment amount (maximum ₦1,000,000), and a reason of at least 10 characters.');
    const adjustmentId = db.ref(`walletLedger/${uid}`).push().key;
    const userRef = db.ref(`users/${uid}`);
    const targetSnap = await userRef.once('value');
    if (!targetSnap.exists()) throw new Error('User not found.');
    const ledgerRef = db.ref(`walletLedger/${uid}/${adjustmentId}`);
    await ledgerRef.set({ type:'admin_adjustment', direction:amount>0?'credit':'debit', amount:Math.abs(amount), signedAmount:amount, reference:adjustmentId, description:reason, status:'processing', createdAt:Date.now(), adminUid:actor.uid, adminName:actor.name });
    const result = await userRef.transaction(user => {
      if (user === null) return user;   // first local run is null in the Admin SDK: let Firebase retry with the real value
      const claims = user.adminWalletAdjustments || {};
      if (claims[adjustmentId]) return user;
      const balance = Number(user.walletBalance || 0);
      const next = Math.round((balance + amount) * 100) / 100;
      if (!Number.isFinite(next) || next < 0) return;
      user.walletBalance = next;
      claims[adjustmentId] = { amount, reason, by:actor.uid, at:Date.now() };
      user.adminWalletAdjustments = claims;
      return user;
    });
    if (!result.committed) {
      await ledgerRef.update({ status:'failed', failedAt:Date.now(), failureReason:'Wallet transaction was not committed.' });
      throw new Error('Wallet adjustment was not committed. Check the user balance and try again.');
    }
    await ledgerRef.update({ status:'completed', completedAt:Date.now(), balanceAfter:Number(result.snapshot.val()?.walletBalance || 0) });
    await writeAudit(actor, 'admin_wallet_adjustment', 'userWallet', uid, reason, { balanceBefore:Number(targetSnap.val()?.walletBalance || 0) }, { amount, adjustmentId, balanceAfter:Number(result.snapshot.val()?.walletBalance || 0) });
    await db.ref(`notifications/${uid}/wallet_adjust_${adjustmentId}`).set({ type:'wallet_adjustment', amount, message:amount>0?`An admin adjustment of ₦${amount.toLocaleString()} was credited to your wallet.`:`An admin adjustment of ₦${Math.abs(amount).toLocaleString()} was debited from your wallet.`, createdAt:Date.now(), read:false });
    return res.json({ok:true, adjustmentId, balance:Number(result.snapshot.val()?.walletBalance || 0)});
  } catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/user/ban', async (req, res) => {
  try {
    const actor = await requireAdmin(req, 'support');
    const uid = String(req.body?.uid || '').trim();
    const banned = req.body?.banned === true;
    const reason = String(req.body?.reason || '').trim().slice(0,500);
    if (!uid || uid === actor.uid) throw new Error('Invalid target user.');
    const userRef = db.ref(`users/${uid}`); const snap = await userRef.once('value');
    if (!snap.exists()) throw new Error('User not found.');
    const before = { banned: snap.val().banned === true, status: snap.val().status || 'active' };
    await userRef.update({ banned, status: banned ? 'banned' : 'active', bannedAt: banned ? Date.now() : null, bannedBy: banned ? actor.uid : null, banReason: banned ? (reason || 'Policy violation') : null });
    await writeAudit(actor, banned ? 'ban_user' : 'unban_user', 'user', uid, reason, before, { banned, status: banned ? 'banned' : 'active' });
    await db.ref(`notifications/${uid}`).push({ type: 'account_status', message: banned ? 'Your MudyHub account has been restricted. Contact support for assistance.' : 'Your MudyHub account restriction has been lifted.', createdAt: Date.now(), read: false });
    return res.json({ ok: true });
  } catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/task/review', async (req, res) => {
  try {
    const actor = await requireAdmin(req, 'tasks');
    const id = String(req.body?.id || '').trim(); const decision = req.body?.decision;
    const reason = String(req.body?.reason || '').trim().slice(0,500);
    if (!id || !['approve','reject'].includes(decision)) throw new Error('Invalid task review request.');
    const itemRef = db.ref(`submissions/${id}`); const snap = await itemRef.once('value');
    if (!snap.exists()) throw new Error('Submission not found.');
    const item = snap.val();
    if (item.status === 'approved' || item.status === 'rejected') throw new Error('This submission has already been reviewed.');
    const uid = String(item.userId || item.uid || ''); if (!uid) throw new Error('Submission has no user ID.');
    if (decision === 'reject') {
      // Give the slot back (once) and let the user try again.
      if (item.slotReserved === true && item.campaignId && ['campaigns','adminCreatedTasks','adminAds'].includes(item.srcNode)) {
        const rel = await db.ref(`slotReleases/${id}`).transaction(cur => cur ? undefined : { at: Date.now() });
        if (rel.committed) {
          const field = item.srcNode === 'adminAds' ? 'viewsCompleted' : 'completedSlots';
          await db.ref(`${item.srcNode}/${item.campaignId}/${field}`).transaction(cur => Math.max(0, Number(cur || 0) - 1));
          await db.ref(`taskClaims/${item.campaignId}/${uid}`).remove();
        }
      }
      await itemRef.update({ status: 'rejected', rejectionReason: reason || 'Submission did not meet the task requirements.', reviewedAt: Date.now(), reviewedBy: actor.uid });
      await db.ref(`notifications/${uid}`).push({ type:'task_rejected', message:`Your task submission was rejected. Reason: ${reason || 'Submission did not meet the task requirements.'}`, createdAt:Date.now(), read:false });
      await writeAudit(actor, 'reject_task_submission', 'submission', id, reason, {status:item.status}, {status:'rejected'});
      return res.json({ ok:true, status:'rejected' });
    }
    // Never trust a reward typed into the browser: take it from the campaign/task record when one exists.
    let gross = Number(item.rewardAmount || 0);
    const sourceId = String(item.campaignId || '').trim();
    let srcNode = null, srcData = null;
    if (sourceId && !/[.#$\[\]\/]/.test(sourceId)) {
      for (const node of ['campaigns', 'adminCreatedTasks', 'adminAds']) {
        const src = (await db.ref(`${node}/${sourceId}`).once('value')).val();
        const trusted = src ? Number(src.reward ?? src.rewardPerAction ?? src.rewardPerView ?? 0) : 0;
        if (Number.isFinite(trusted) && trusted > 0) { gross = trusted; srcNode = node; srcData = src; break; }
      }
    }
    if (!Number.isFinite(gross) || gross <= 0 || gross > 1000000) throw new Error('Invalid task reward amount.');
    const settings = (await db.ref('platformSettings').once('value')).val() || {};
    const rate = Math.min(1, Math.max(0, Number(settings.platformFeeRate ?? 0.20)));
    const calculatedFee = Math.round(gross * rate * 100) / 100;
    const calculatedNet = Math.round((gross - calculatedFee) * 100) / 100;
    const userRef = db.ref(`users/${uid}`);
    let alreadyCredited = false, net = calculatedNet, fee = calculatedFee;
    const credit = await userRef.transaction(user => {
      if (user === null) return user;   // first local run is null in the Admin SDK: let Firebase retry with the real value
      const claims = user.adminCreditClaims || {};
      const existing = claims[`task_${id}`];
      if (existing) { alreadyCredited = true; net = Number(existing.net || calculatedNet); fee = Number(existing.fee || calculatedFee); return user; }
      user.walletBalance = Number(user.walletBalance || 0) + calculatedNet;
      user.lifetimeEarned = Number(user.lifetimeEarned || 0) + calculatedNet;
      claims[`task_${id}`] = { net: calculatedNet, fee: calculatedFee, gross, at: Date.now() }; user.adminCreditClaims = claims;
      return user;
    });
    if (!credit.committed || !credit.snapshot.exists()) throw new Error('Wallet credit could not be committed.');
    const ts = Date.now();
    if (fee > 0 && !alreadyCredited) {
      const revenueClaim = await db.ref(`platformRevenue/creditClaims/task_${id}`).transaction(cur => cur ? undefined : { by:actor.uid, at:ts, fee });
      if (revenueClaim.committed) {
        await db.ref('platformRevenue/total').transaction(v => Number(v || 0) + fee);
        await db.ref('platformRevenue/bySource/earning_hub').transaction(v => Number(v || 0) + fee);
        await db.ref('platformRevenue/recent').push({ amount:fee, gross, userShare:net, source:'earning_hub', sourceId:id, userId:uid, description:item.campaignTitle || 'Earning Hub task payout', createdAt:ts });
      }
    }
    await db.ref(`walletLedger/${uid}/task_${id}`).set({ type:'earning', direction:'credit', amount:net, gross, fee, reference:id, description:item.campaignTitle || 'Earning Hub task payout', status:'completed', createdAt:ts, adminUid:actor.uid });
    await itemRef.update({ status:'approved', reviewedAt:ts, reviewedBy:actor.uid, netCredited:net, platformFee:fee });
    await db.ref(`notifications/${uid}/task_${id}`).set({ type:'payout', amount:net, gross, fee, message:`Your task reward of ₦${net.toLocaleString()} has been credited to your wallet.`, createdAt:ts, read:false });
    await writeAudit(actor, 'approve_task_submission', 'submission', id, '', {status:item.status, reward:gross}, {status:'approved', netCredited:net, platformFee:fee});
    return res.json({ ok:true, status:'approved', netCredited:net, platformFee:fee });
  } catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/withdrawal/action', async (req, res) => {
  try {
    const actor = await requireAdmin(req, 'withdrawals');
    const id = String(req.body?.id || '').trim(); const action = req.body?.action;
    const reason = String(req.body?.reason || '').trim().slice(0,500);
    if (!id || !['approve','reject_refund','fraud_review','force_approve'].includes(action)) throw new Error('Invalid withdrawal action.');
    if (action === 'force_approve' && actor.role !== 'super_admin') throw new Error('Forbidden');
    const reqRef = db.ref(`withdrawalRequests/${id}`); const snap = await reqRef.once('value');
    if (!snap.exists()) throw new Error('Withdrawal request not found.');
    const w = snap.val(); const uid = String(w.uid || w.userId || ''); const amount = Number(w.amount || 0);
    if (!uid || !Number.isFinite(amount) || amount <= 0) throw new Error('Withdrawal record is incomplete.');
    if (!['pending','processing'].includes(w.status)) throw new Error('This withdrawal is no longer awaiting review.');
    if (action === 'approve' || action === 'force_approve') {
      if (action === 'force_approve' && reason.length < 10) throw new Error('Force-approval requires a reason of at least 10 characters.');
      await reqRef.update({ status:'approved', payoutStatus:'approved_awaiting_manual_payout', payoutNotice:'Admin approved this request; bank payout must be completed and confirmed separately.', approvedAt:Date.now(), approvedBy:actor.uid, ...(action === 'force_approve' ? {forceApprovedBy:actor.uid, forceApproveReason:reason} : {}) });
      await db.ref(`notifications/${uid}`).push({ type:'withdrawal_approved', amount, message:`Your withdrawal of ₦${amount.toLocaleString()} has been approved. Bank payout is not yet confirmed.`, createdAt:Date.now(), read:false });
      await writeAudit(actor, action === 'force_approve' ? 'force_approve_withdrawal' : 'approve_withdrawal', 'withdrawal', id, reason, {status:w.status}, {status:'approved', payoutStatus:'approved_awaiting_manual_payout'});
      return res.json({ok:true,status:'approved'});
    }
    if (action === 'fraud_review') {
      if (reason.length < 5) throw new Error('Provide a fraud-review reason of at least 5 characters.');
      await db.ref(`users/${uid}`).update({ walletFrozen:true, walletFrozenAt:Date.now(), walletFrozenBy:actor.uid, walletFreezeReason:reason });
      await reqRef.update({ status:'processing', payoutStatus:'fraud_review', rejectionReason:reason, fraudReviewAt:Date.now(), fraudReviewBy:actor.uid });
      await writeAudit(actor, 'withdrawal_fraud_review', 'withdrawal', id, reason, {status:w.status}, {status:'processing', payoutStatus:'fraud_review'});
      await db.ref(`notifications/${uid}`).push({ type:'withdrawal_review', message:'Your withdrawal is under additional security review. The requested funds remain reserved.', createdAt:Date.now(), read:false });
      return res.json({ok:true,status:'processing'});
    }
    if (!reason) throw new Error('A rejection reason is required.');
    const userRef = db.ref(`users/${uid}`);
    let alreadyRefunded = false;
    const refund = await userRef.transaction(user => {
      if (user === null) return user;   // first local run is null in the Admin SDK: let Firebase retry with the real value
      const claims = user.adminRefundClaims || {};
      if (claims[`withdrawal_${id}`]) { alreadyRefunded = true; return user; }
      user.walletBalance = Number(user.walletBalance || 0) + amount;
      claims[`withdrawal_${id}`] = { amount, at: Date.now() }; user.adminRefundClaims = claims;
      return user;
    });
    if (!refund.committed || !refund.snapshot.exists()) throw new Error('User record is unavailable; refund was not processed.');
    await reqRef.update({ status:'rejected', rejectionReason:reason, rejectedAt:Date.now(), refundedAt:Date.now(), refundedAmount:amount, refundProcessedBy:actor.uid });
    if (w.ledgerId) await db.ref(`walletLedger/${uid}/${w.ledgerId}`).update({status:'refunded', refundedAt:Date.now(), refundReason:reason});
    await db.ref(`walletLedger/${uid}/withdrawal_refund_${id}`).set({type:'withdrawal_refund',direction:'credit',amount,reference:id,description:'Refund for rejected withdrawal',status:'completed',createdAt:Date.now(),adminUid:actor.uid});
    await db.ref(`notifications/${uid}/withdrawal_rejected_${id}`).set({type:'withdrawal_rejected',amount,message:`Withdrawal rejected. ${reason}. Funds returned to your wallet.`,createdAt:Date.now(),read:false});
    await writeAudit(actor, 'reject_withdrawal_refund', 'withdrawal', id, reason, {status:w.status}, {status:'rejected', refundedAmount:amount});
    return res.json({ok:true,status:'rejected',refundedAmount:amount});
  } catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/campaign/review', async (req, res) => {
  try {
    const actor = await requireAdmin(req, 'campaigns');
    const id = String(req.body?.id || '').trim();
    const node = req.body?.node === 'adminAds' ? 'adminAds' : 'campaigns';
    const decision = req.body?.decision;
    const reason = String(req.body?.reason || '').trim().slice(0,500);
    if (!id || !['approve','reject'].includes(decision)) throw new Error('Invalid campaign review request.');
    const itemRef = db.ref(`${node}/${id}`); const snap = await itemRef.once('value');
    if (!snap.exists()) throw new Error('Campaign not found.');
    const item = snap.val();
    if (!['pending','review'].includes(item.status)) throw new Error('This campaign is not awaiting review.');
    if (decision === 'reject') {
      if (!reason) throw new Error('A rejection reason is required.');
      const creatorUid = String(item.creatorId || item.userId || '');
      const escrow = Math.max(0, Number(item.totalEscrowLocked || 0));
      if (escrow > 0 && creatorUid) {
        const userRef = db.ref(`users/${creatorUid}`);
        let alreadyRefunded = false;
        const refund = await userRef.transaction(user => {
          if (user === null) return user;   // first local run is null in the Admin SDK: let Firebase retry with the real value
          const claims = user.adminRefundClaims || {};
          if (claims[`campaign_${id}`]) { alreadyRefunded = true; return user; }
          user.walletBalance = Number(user.walletBalance || 0) + escrow;
          claims[`campaign_${id}`] = { amount:escrow, at:Date.now() }; user.adminRefundClaims = claims;
          return user;
        });
        if (!refund.committed || !refund.snapshot.exists()) throw new Error('Campaign escrow refund could not be committed. Review the account before retrying.');
        await db.ref(`walletLedger/${creatorUid}/campaign_refund_${id}`).set({type:'campaign_refund',direction:'credit',amount:escrow,reference:id,description:'Refund for rejected Promote campaign',status:'completed',createdAt:Date.now(),adminUid:actor.uid});
      }
      await itemRef.update({status:'rejected',rejectionReason:reason,reviewedAt:Date.now(),reviewedBy:actor.uid,totalEscrowLocked:0,escrowReleasedAt:Date.now()});
      if (creatorUid) await db.ref(`notifications/${creatorUid}/campaign_rejected_${id}`).set({type:'campaign_rejected',message:`Your campaign was rejected. Reason: ${reason}${escrow>0?' Escrow was returned to your wallet.':''}`,createdAt:Date.now(),read:false});
      await writeAudit(actor,'reject_campaign','campaign',id,reason,{status:item.status,totalEscrowLocked:escrow},{status:'rejected',refunded:escrow});
      return res.json({ok:true,status:'rejected',refunded:escrow});
    }
    await itemRef.update({status:'active',reviewedAt:Date.now(),reviewedBy:actor.uid});
    const creatorUid = String(item.creatorId || item.userId || '');
    if (creatorUid) await db.ref(`notifications/${creatorUid}`).push({type:'campaign_approved',message:'Your Promote campaign is now live.',createdAt:Date.now(),read:false});
    await writeAudit(actor,'approve_campaign','campaign',id,'',{status:item.status},{status:'active'});
    return res.json({ok:true,status:'active'});
  } catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/campus/review', async (req, res) => {
  try {
    const actor = await requireAdmin(req, 'campus'); const uid = String(req.body?.uid || '').trim();
    const decision = req.body?.decision; const reason = String(req.body?.reason || '').trim().slice(0,500);
    if (!uid || !['approve','reject'].includes(decision)) throw new Error('Invalid campus review request.');
    const status = decision === 'approve' ? 'approved' : 'rejected'; const patch = {status, reviewedAt:Date.now(), reviewedBy:actor.uid};
    if (decision === 'reject') patch.rejectionReason = reason || 'Verification details could not be confirmed.';
    await db.ref(`campusVerifications/${uid}`).update(patch);
    await db.ref(`users/${uid}/campusVerification`).update(patch);
    await db.ref(`notifications/${uid}`).push({type:'campus_verification',message:decision === 'approve' ? 'Your Campus Hub verification has been approved.' : `Your Campus Hub verification was declined. ${patch.rejectionReason}`,createdAt:Date.now(),read:false});
    await writeAudit(actor, 'review_campus_verification', 'campusVerification', uid, reason, null, patch);
    return res.json({ok:true,status});
  } catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/support/resolve', async (req, res) => {
  try {
    const actor = await requireAdmin(req, 'support'); const id = String(req.body?.id || '').trim();
    if (!id) throw new Error('Ticket ID is required.');
    const ticketRef = db.ref(`supportTickets/${id}`); const snap = await ticketRef.once('value');
    if (!snap.exists()) throw new Error('Support ticket not found.');
    const before = snap.val(); await ticketRef.update({status:'resolved',resolvedAt:Date.now(),resolvedBy:actor.uid});
    await writeAudit(actor, 'resolve_support_ticket', 'supportTicket', id, '', {status:before.status}, {status:'resolved'});
    return res.json({ok:true});
  } catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/settings', async (req, res) => {
  try {
    const actor = await requireAdmin(req); if (actor.role !== 'super_admin') throw new Error('Forbidden');
    const input = req.body?.updates || {}; const allowed = ['platformFeeRate','minWithdrawal','minTopup','maxTopup','referralBonus','requireAdminApproval','campusVerificationRequired','announcement','announcementActive','maintenanceMode','maintenanceMessage','supportEmail','supportWhatsApp','featureFlags','emergencyLock','walletOpsPaused','trueConnectionEnabled','trueConnectionRequiresApproval'];
    const patch = {}; for (const key of allowed) if (Object.prototype.hasOwnProperty.call(input,key)) patch[key] = input[key];
    if (!Object.keys(patch).length) throw new Error('No supported V1 settings supplied.');
    if (patch.platformFeeRate !== undefined && (!Number.isFinite(Number(patch.platformFeeRate)) || Number(patch.platformFeeRate)<0 || Number(patch.platformFeeRate)>1)) throw new Error('Platform fee rate must be between 0 and 1.');
    if (patch.minTopup !== undefined && (!Number.isFinite(Number(patch.minTopup)) || Number(patch.minTopup)<0)) throw new Error('Minimum top-up is invalid.');
    if (patch.maxTopup !== undefined && (!Number.isFinite(Number(patch.maxTopup)) || Number(patch.maxTopup)<0)) throw new Error('Maximum top-up is invalid.');
    if (patch.minTopup !== undefined && patch.maxTopup !== undefined && Number(patch.maxTopup)<Number(patch.minTopup)) throw new Error('Maximum top-up cannot be lower than minimum top-up.');
    for (const k of ['emergencyLock','walletOpsPaused','trueConnectionEnabled','trueConnectionRequiresApproval']) if (patch[k] !== undefined && typeof patch[k] !== 'boolean') throw new Error('Invalid value for ' + k + '.');
    if (patch.featureFlags !== undefined) {
      const flags = patch.featureFlags || {}; const allowedFlags = new Set(['earningHubEnabled','jobsEnabled','campusEnabled','aiEnabled','socialEnabled']);
      if (Object.keys(flags).some(k => !allowedFlags.has(k) || typeof flags[k] !== 'boolean')) throw new Error('Only V1 feature flags are supported.');
      patch.featureFlags = flags;
    }
    const before = (await db.ref('platformSettings').once('value')).val() || {};
    await db.ref('platformSettings').update({...patch, updatedAt:Date.now(), updatedBy:actor.uid});
    await writeAudit(actor, 'update_platform_settings', 'platformSettings', 'root', '', before, patch);
    return res.json({ok:true});
  } catch (e) { return adminResponseError(res, e); }
});
app.post('/api/admin/publish', async (req, res) => {
  try {
    const actor = await requireAdmin(req); if (actor.role !== 'super_admin') throw new Error('Forbidden');
    const type = String(req.body?.type || ''); const p = req.body?.payload || {};
    const title = String(p.title || '').trim().slice(0,120); if (title.length < 3) throw new Error('Enter a valid title.');
    const now = Date.now(); let node, payload;
    if (type === 'campaign') {
      const reward=Number(p.reward), slots=Math.floor(Number(p.totalSlots));
      if (!Number.isFinite(reward) || reward < 20 || !Number.isInteger(slots) || slots<1 || slots>100000) throw new Error('Invalid campaign reward or target slots.');
      if (!/^https?:\/\//i.test(String(p.targetUrl||'')) || String(p.instructions||'').trim().length<20) throw new Error('Campaign URL or instructions are invalid.');
      const required=reward*slots; const external=p.isExternalCustomerCampaign===true;
      if (external && (String(p.customerName||'').trim().length<2 || Number(p.customerPaymentReceived)<required)) throw new Error('External customer payment must cover the complete campaign budget.');
      node='campaigns'; payload={...p,title,creatorId:actor.uid,creatorName:actor.name,createdByAdmin:true,status:'active',createdAt:now,updatedAt:now,totalSlots:slots,reward,platformBudget:external?0:required,customerOutstanding:external?Math.max(0,required-Number(p.customerPaymentReceived)):0};
    } else if (type === 'watch_ad') {
      const reward=Number(p.rewardPerView), slots=Math.floor(Number(p.totalSlots));
      if (!Number.isFinite(reward) || reward<10 || !Number.isInteger(slots) || slots<1 || slots>100000) throw new Error('Invalid sponsored ad reward or target viewers.');
      if (!/^https?:\/\//i.test(String(p.videoUrl||'')) || !/^https?:\/\//i.test(String(p.actionLink||''))) throw new Error('Video and action links must be valid http(s) URLs.');
      const required=reward*slots; const external=p.isExternalCustomerCampaign===true;
      if (external && (String(p.customerName||'').trim().length<2 || Number(p.customerPaymentReceived)<required)) throw new Error('External customer payment must cover the complete ad budget.');
      node='adminAds'; payload={...p,title,creatorId:actor.uid,creatorName:actor.name,createdByAdmin:true,status:'active',createdAt:now,updatedAt:now,totalSlots:slots,rewardPerView:reward,platformBudget:external?0:required,customerOutstanding:external?Math.max(0,required-Number(p.customerPaymentReceived)):0};
    } else if (type === 'job') {
      const budget=Number(p.budget); if (!Number.isFinite(budget)||budget<0 || String(p.description||'').trim().length<10 || String(p.location||'').trim().length<2) throw new Error('Job description, location or budget is invalid.');
      node='jobs'; payload={...p,title,posterId:actor.uid,posterName:actor.name,createdByAdmin:true,status:'open',createdAt:now,updatedAt:now};
    } else throw new Error('Only V1 campaigns, sponsored ads and jobs can be published here.');
    const ref=db.ref(node).push(); payload.id=ref.key; await ref.set(payload);
    await writeAudit(actor,'publish_v1_content',node,ref.key,'',null,{title,type});
    return res.json({ok:true,id:ref.key,node});
  } catch (e) { return adminResponseError(res, e); }
});

// True Connection server routes: matching, eligibility, requests and moderation are server-only.
registerTrueConnection({ app, admin, db, authenticatedUid, requireAdmin, writeAudit });
// V1 admin extras: user lookup/verify, verification (KYC) review, content moderation, mark-withdrawal-paid.
registerAdminV1({ app, admin, db, requireAdmin, writeAudit, adminResponseError });
registerPromote({ app, admin, db, authenticatedUid });
registerTasks({ app, admin, db, authenticatedUid });
app.get("/api/payment-config", async (req, res) => {
  const keys = paystackKeys();
  if (!keys.publicKey) return res.status(503).json({ error: `Paystack ${keys.mode} public key is not configured (it must start with pk_${keys.mode}_).` });
  return res.json({ mode: keys.mode, publicKey: keys.publicKey, minTopup: Number(process.env.MIN_TOPUP_NAIRA || 100), maxTopup: Number(process.env.MAX_TOPUP_NAIRA || 100000) });
});
app.post("/api/create-topup-intent", async (req, res) => {
  try {
    const uid = await authenticatedUid(req);
    const amount = Number(req.body?.amount);
    const min = Number(process.env.MIN_TOPUP_NAIRA || 100), max = Number(process.env.MAX_TOPUP_NAIRA || 100000);
    if (!Number.isSafeInteger(amount) || amount < min || amount > max) return res.status(400).json({ error: `Top-up must be between ₦${min} and ₦${max}.` });
    const keys = paystackKeys();
    if (!keys.publicKey || !keys.secretKey) return res.status(503).json({ error: `Paystack ${keys.mode} keys are not configured on the server.` });
    const user = await admin.auth().getUser(uid);
    if (!user.email || !user.emailVerified) return res.status(403).json({ error: "Verify your email address before funding your wallet." });
    const reference = `mudy_${keys.mode}_${crypto.randomUUID()}`;
    await db.ref(`topupIntents/${uid}/${reference}`).set({ uid, amount, amountKobo: amount * 100, currency: "NGN", mode: keys.mode, status: "created", email: user.email, createdAt: admin.database.ServerValue.TIMESTAMP });
    return res.json({ reference, email: user.email, amount, mode: keys.mode });
  } catch (error) { return res.status(error.message === "Unauthorized" ? 401 : 500).json({ error: error.message || "Could not create payment." }); }
});
app.post("/api/verify-topup", async (req, res) => {
  try {
    const uid = await authenticatedUid(req);
    const reference = String(req.body?.reference || "").trim();
    if (!reference || reference.length > 120) return res.status(400).json({ error: "Valid payment reference is required." });
    const keys = paystackKeys();
    if (!keys.secretKey) return res.status(503).json({ error: `Paystack ${keys.mode} secret key is not configured.` });
    const intentRef = db.ref(`topupIntents/${uid}/${reference}`);
    const intentSnap = await intentRef.once("value");
    if (!intentSnap.exists()) return res.status(400).json({ error: "Payment intent not found for this account." });
    const intent = intentSnap.val();
    if (intent.uid !== uid || intent.mode !== keys.mode || intent.status === "cancelled") return res.status(400).json({ error: "Payment does not match this account or payment mode." });
    const topupRef = db.ref(`walletTopups/${uid}/${reference}`);
    const existing = await topupRef.once("value");
    if (existing.exists() && existing.val()?.status === "completed") return res.json({ success: true, amount: existing.val().amount, alreadyCredited: true });
    const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${keys.secretKey}` } });
    const paystack = await verifyResponse.json();
    const tx = paystack?.data;
    if (!paystack?.status || tx?.status !== "success") return res.status(400).json({ error: "Paystack has not confirmed a successful payment." });
    if (Number(tx.amount) !== Number(intent.amountKobo) || tx.currency !== "NGN" || String(tx.reference) !== reference) return res.status(400).json({ error: "Verified payment amount, currency or reference does not match the payment request." });
    if (String(tx.customer?.email || "").toLowerCase() !== String(intent.email || "").toLowerCase()) return res.status(400).json({ error: "Paystack payer email does not match the payment intent." });
    const claim = await topupRef.transaction(current => {
      if (!current) return { uid, amount: intent.amount, reference, mode: keys.mode, currency: "NGN", status: "processing", createdAt: admin.database.ServerValue.TIMESTAMP };
      if (current.status === "credit_failed") return { ...current, status: "processing", retriedAt: Date.now() };
      return current;
    });
    const claimedRecord = claim.snapshot.val();
    if (claimedRecord?.status === "completed") return res.json({ success: true, amount: claimedRecord.amount, alreadyCredited: true });
    if (Number(claimedRecord?.amount) !== Number(intent.amount) || claimedRecord?.uid !== uid) return res.status(409).json({ error: "Top-up reference is already associated with a different payment." });
    // Idempotent credit: first claim this reference, then add to the wallet leaf. (Aborting a transaction on a null first read caused credit failures.)
    const creditFlagRef = db.ref(`users/${uid}/topupCredits/${reference}`);
    const flag = await creditFlagRef.transaction(current => (current ? undefined : true));
    if (flag.committed) {
      const walletResult = await db.ref(`users/${uid}/walletBalance`).transaction(current => Number(current || 0) + Number(intent.amount));
      if (!walletResult.committed) {
        await creditFlagRef.remove().catch(() => {});
        await topupRef.update({ status: "credit_failed", failureReason: "Wallet transaction not committed" });
        return res.status(500).json({ error: "Payment verified but wallet credit failed. Try again or contact support with your reference." });
      }
    }
    await topupRef.update({ status: "completed", verifiedAt: admin.database.ServerValue.TIMESTAMP, paystackTransactionId: tx.id || null });
    await intentRef.update({ status: "completed", completedAt: admin.database.ServerValue.TIMESTAMP });
    await db.ref(`users/${uid}/transactions/${reference}`).set({ type: "topup", amount: intent.amount, reference, mode: keys.mode, description: "Paystack wallet top-up", status: "completed", createdAt: admin.database.ServerValue.TIMESTAMP });
    await db.ref(`notifications/${uid}`).push({ type: "topup", amount: intent.amount, message: `Wallet credited with ₦${Number(intent.amount).toLocaleString()}.`, createdAt: admin.database.ServerValue.TIMESTAMP, read: false });
    return res.json({ success: true, amount: intent.amount, mode: keys.mode });
  } catch (error) { console.error("Topup verification error:", error); return res.status(error.message === "Unauthorized" ? 401 : 500).json({ error: error.message || "Payment verification failed." }); }
});
// --- B. WITHDRAWAL: atomic request reservation, no fee, manual payout review ---
app.post("/api/withdraw", async (req, res) => {
  let uid = null, requestRef = null, ledgerRef = null, walletRef = null, deducted = false;
  let withdrawAmount = 0;
  try {
    uid = await authenticatedUid(req);
    const { amount, bankCode, bankName, accountNumber, accountName, pin } = req.body || {};
    withdrawAmount = Number(amount);
    if (!Number.isSafeInteger(withdrawAmount) || withdrawAmount < 1) return res.status(400).json({ error: "Enter a valid whole-naira withdrawal amount." });
    if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: "Valid 4-digit PIN required." });
    if (!bankCode || !bankName) return res.status(400).json({ error: "Select a bank." });
    if (!/^\d{10}$/.test(String(accountNumber || ""))) return res.status(400).json({ error: "Account number must be 10 digits." });
    if (!accountName || String(accountName).trim().length < 3) return res.status(400).json({ error: "Enter account holder name." });

    const userRef = db.ref(`users/${uid}`);
    const userSnap = await userRef.once("value");
    const user = userSnap.val();
    if (!user) return res.status(404).json({ error: "User not found." });
    const authUser = await admin.auth().getUser(uid);
    if (!authUser.emailVerified) return res.status(403).json({ error: "Verify your email address before requesting a withdrawal." });
    if (user.banned === true || user.status === 'banned' || user.walletFrozen === true) return res.status(403).json({ error: "Your account or wallet is restricted. Contact support." });
    if (!user.pinHash) return res.status(400).json({ error: "No wallet PIN set. Please set one in Settings." });
    const enteredHash = crypto.createHash("sha256").update(pin).digest("hex");
    if (enteredHash !== user.pinHash) return res.status(401).json({ error: "Incorrect Wallet PIN." });

    requestRef = db.ref("withdrawalRequests").push();
    ledgerRef = db.ref(`walletLedger/${uid}`).push();
    walletRef = db.ref(`users/${uid}/walletBalance`);

    // Create a durable reservation record before touching the balance.
    await requestRef.set({
      id: requestRef.key, uid, userId: uid, amount: withdrawAmount, fee: 0, netAmount: withdrawAmount,
      mode: paystackMode(), bank: String(bankName), bankName: String(bankName), bankCode: String(bankCode),
      accountNumber: String(accountNumber), accountName: String(accountName).trim(),
      status: "creating", payoutStatus: "not_paid", payoutNotice: "No bank payout has occurred.",
      createdAt: admin.database.ServerValue.TIMESTAMP, timestamp: Date.now(), ledgerId: ledgerRef.key
    });

    // Firebase first calls this with null (a guess); aborting there would wrongly reject every withdrawal.
    // Return a placeholder on null so Firebase retries with the real balance, and only debit when the real check passes.
    let canDebit = false;
    const result = await walletRef.transaction(current => {
      canDebit = false;
      if (current === null) return 0;
      const balance = Number(current);
      if (!Number.isFinite(balance) || balance < withdrawAmount) return;
      canDebit = true;
      return balance - withdrawAmount;
    });
    if (!result.committed || !canDebit) {
      await requestRef.remove();
      return res.status(400).json({ error: "Insufficient available wallet balance." });
    }
    deducted = true;
    const now = admin.database.ServerValue.TIMESTAMP;
    await Promise.all([
      requestRef.update({ status: "pending", balanceBefore: Number(result.snapshot.val()) + withdrawAmount, balanceAfter: Number(result.snapshot.val()), reservedAt: now }),
      ledgerRef.set({ id: ledgerRef.key, type: "withdrawal", direction: "debit", amount: withdrawAmount, reference: requestRef.key, description: "Withdrawal request — funds reserved", status: "pending", createdAt: now }),
      db.ref(`users/${uid}/transactions/${requestRef.key}`).set({ type: "withdrawal", direction: "debit", amount: withdrawAmount, reference: requestRef.key, description: "Withdrawal request — funds reserved", status: "pending", fee: 0, createdAt: now })
    ]);
    await db.ref(`notifications/${uid}`).push({
      type: "withdrawal_requested", amount: withdrawAmount,
      message: `Withdrawal request of ₦${withdrawAmount.toLocaleString()} submitted for admin review. No bank payout has yet occurred.`,
      createdAt: now, read: false
    });
    return res.json({ success: true, requestId: requestRef.key, newBalance: Number(result.snapshot.val()), fee: 0, message: "Withdrawal request submitted. Funds are reserved while admin reviews it." });
  } catch (error) {
    console.error("Withdraw Error:", error);
    // If any post-debit write failed, restore the user's balance and remove the incomplete request.
    if (deducted && walletRef) {
      try { await walletRef.transaction(current => Number(current || 0) + withdrawAmount); } catch (refundError) { console.error("Withdrawal rollback failed:", refundError); }
    }
    if (requestRef) await requestRef.remove().catch(() => {});
    if (ledgerRef) await ledgerRef.remove().catch(() => {});
    return res.status(error.message === "Unauthorized" ? 401 : 500).json({ error: error.message || "Withdrawal request failed." });
  }
});

// -----------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: "ok",
    groqKeyConfigured: !!process.env.GROQ_API_KEY,
    firebaseAdminConfigured: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    models: MODELS,
    modes: Object.keys(SYSTEM_PROMPTS),
    features: { think: true, vision: true, search: true, siwes: true, miniBank: true }
  });
});

app.get('/', (req, res) => {
  res.send("MudyHub AI & Mini-Bank Server is Live!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Models:`, MODELS);
});


        
