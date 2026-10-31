import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import dotenv from 'dotenv';
import {
  Document, Packer, Paragraph, TextRun, AlignmentType, ImageRun,
  PageBreak, Footer, PageNumber
} from 'docx';

dotenv.config();
const app = express();

// -----------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));

// -----------------------------------------------------
// ENV CHECK & FIREBASE ADMIN SETUP
// -----------------------------------------------------
if (!process.env.GROQ_API_KEY) {
  console.error("FATAL: GROQ_API_KEY environment variable is not set in Render dashboard.");
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("FATAL: FIREBASE_SERVICE_ACCOUNT environment variable is not set in Render dashboard.");
}

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://mudyhub-default-rtdb.firebaseio.com" // Make sure this is correct
  });
  console.log("✅ Firebase Admin initialized securely.");
} catch (error) {
  console.error("❌ Failed to initialize Firebase Admin. Check your FIREBASE_SERVICE_ACCOUNT JSON.");
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
1. Explaining how MudyHub works: Paid Tasks, Jobs, Daily Rewards, Referral Program, Marketplace, Business Ads, Wallet & Withdrawals, Campus Hub, and Community Feed.
2. Practical advice on making money online.
3. Advice on learning valuable skills.

HOW MUDYHUB WORKS:
- Paid Tasks: users complete tasks and submit proof; admin approves and pays to wallet.
- Jobs: verified remote/local listings.
- Daily Rewards: small bonus claimable once every 24 hours.
- Referral Program: users share a link and earn when new users sign up.
- Marketplace: users list products/services (admin-approved).
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

  const body = {
    model: model || MODELS.default,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    temperature,
    max_tokens: maxTokens
  };

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
    throw new Error(errMessage);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned an empty response.");
  return text;
}

// -----------------------------------------------------
// /api/generate — AI CHAT
// -----------------------------------------------------
app.post('/api/generate', async (req, res) => {
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

async function generateChapter(prompt, maxTokens = 4000) {
  return callGroq({
    systemPrompt: `You are an expert Nigerian SIWES report writer. You write highly detailed, professional, and technical reports that read exactly like a real student wrote them. You follow the formatting rules strictly.`,
    messages: [{ role: "user", content: prompt }],
    model: MODELS.default,
    maxTokens: maxTokens,
    temperature: 0.75
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

function docxHeading(text, level = 1) {
  const sizes = { 1: 32, 2: 28, 3: 26 };
  return new Paragraph({
    spacing: { before: 240, after: 200, line: 360 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({
      text: text, bold: true,
      size: sizes[level] || 26,
      font: "Times New Roman"
    })]
  });
}

function docxSubheading(text) {
  return new Paragraph({
    spacing: { before: 200, after: 160, line: 360 },
    children: [new TextRun({
      text: text, bold: true, size: 26, font: "Times New Roman"
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
                  const { uid, formData, images } = req.body;
  if (!uid || !formData) return res.status(400).json({ error: "Missing uid or formData." });

  // 🚨 MANDATORY FIELD VALIDATION (Prevents wasted AI calls and protects the user)
  const requiredFields = ['fullName', 'matric', 'dept', 'institution', 'orgName', 'startDate', 'endDate'];
  for (const field of requiredFields) {
    if (!formData[field] || String(formData[field]).trim() === "") {
      return res.status(400).json({ error: `Missing required field: ${field}. Please go back and fill it in.` });
    }
  }

  try {
    console.log(`[SIWES] Starting for uid=${uid}, org=${formData.orgName}, dept=${formData.dept}`);

    const prompts = buildChapterPrompts(formData);
    const chapters = [];

    for (const p of prompts) {
      console.log(`[SIWES] Generating ${p.title}...`);
      
      // 🚨 FIXED: 20-25 Page Token Limits
      const maxTokensForChapter = p.chapterNum === 3 ? 3500 : 2000; 
      const raw = await generateChapter(p.prompt, maxTokensForChapter); 
      
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
    children.push(docxPara(`I, ${formData.fullName || ""}, hereby declare that this SIWES technical report is my original work and has not been submitted elsewhere. It documents the industrial training I undertook at ${formData.orgName || "the organisation"} from ${formData.startDate || ""} to ${formData.endDate || ""}.`));
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
    children.push(docxPara("This report is dedicated to Almighty Allah, to my family for their unwavering support throughout my academic journey, and to everyone who contributed to the success of my SIWES attachment."));
    children.push(docxPageBreak());

    // ===== ACKNOWLEDGEMENT =====
    children.push(docxHeading("ACKNOWLEDGEMENT", 1));
    children.push(docxPara(""));
    children.push(docxPara(`I sincerely appreciate the management and staff of ${formData.orgName || "the organisation"} for giving me the opportunity to undertake my industrial training with them. My special thanks go to ${formData.supervisorName || "my industry supervisor"} for the guidance, patience, and practical mentorship throughout the attachment period.`));
    children.push(docxPara(""));
    children.push(docxPara(`I also appreciate the management and lecturers of ${formData.institution || "Nuhu Bamalli Polytechnic, Zaria"}, particularly the Department of ${formData.dept || "my department"} and my school supervisor, for facilitating this SIWES programme.`));
    children.push(docxPara(""));
    children.push(docxPara("Finally, my gratitude goes to my family and friends for their encouragement and support throughout the programme."));
    children.push(docxPageBreak());

    // ===== TABLE OF CONTENTS =====
    children.push(docxHeading("TABLE OF CONTENTS", 1));
    children.push(docxPara(""));
    const toc = [
      "Title Page .................................................. i",
      "Declaration ................................................. ii",
      "Certification ............................................... iii",
      "Dedication .................................................. iv",
      "Acknowledgement ............................................. v",
      "Table of Contents ........................................... vi",
      "List of Figures ............................................. vii",
      "List of Tables .............................................. viii",
      "Abstract .................................................... ix",
      "",
      "CHAPTER ONE: INTRODUCTION TO SIWES",
      "    a. Definition of SIWES ................................... 1",
      "    b. Brief History of SIWES ................................ 2",
      "    c. Importance / Purpose of SIWES ......................... 4",
      "    d. Aim and Objectives of SIWES ........................... 6",
      "    e. Bodies Involved in the Management of SIWES ........... 7",
      "",
      `CHAPTER TWO: ${(formData.orgName || "ORGANISATION PROFILE").toUpperCase()}`,
      "    a. Brief History of the Organisation ..................... 9",
      "    b. Mission of the Organisation ........................... 11",
      "    c. Vision of the Organisation ............................ 12",
      "    d. Organisational Chart .................................. 13",
      "    e. Roles Performed by the Organisation ................... 14",
      "",
      "CHAPTER THREE: PRACTICAL EXPERIENCE",
      "    a. Experience Acquired in the Organisation ............... 17",
      "    b. Summary of Work Undertaken ............................ 25",
      "",
      "CHAPTER FOUR: PROBLEMS, CHALLENGES AND SOLUTIONS",
      "    a. Problems / Challenges Faced ........................... 28",
      "    b. Solutions to the Problems ............................. 30",
      "",
      "CHAPTER FIVE: SUMMARY, CONCLUSION AND RECOMMENDATION",
      "    a. Summary ............................................... 32",
      "    b. Conclusion ............................................ 33",
      "    c. Recommendation ........................................ 34",
      "    d. References ............................................ 35"
    ];
    toc.forEach(line => children.push(docxPara(line, { size: 22, afterSpacing: 60 })));
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
    children.push(docxHeading("ABSTRACT", 1));
    children.push(docxPara(""));
    children.push(docxPara(
      `\nThis report presents a detailed account of the Student Industrial Work Experience Scheme (SIWES) attachment undertaken by ${formData.fullName || "the student"} at ${formData.orgName || "an organisation"} from ${formData.startDate || ""} to ${formData.endDate || ""}, as part of the ${formData.level || "ND II"} ${formData.dept || "programme"} at ${formData.institution || "Nuhu Bamalli Polytechnic, Zaria"}. During the attachment, the student worked in the ${formData.orgUnit || "relevant"} unit as a ${formData.jobRole || "student intern"}. The report covers the organisation's profile, the practical experience acquired, the projects handled, the technical and interpersonal challenges encountered, and the lessons learned. The SIWES programme provided invaluable practical exposure that complemented the theoretical knowledge gained in the classroom and significantly enhanced the student's technical and soft skills.`
    ));
    children.push(docxPageBreak());

    // ===== CHAPTERS =====
    for (const ch of chapters) {
      children.push(docxHeading(ch.title, 1));
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
  const doc = new Document({
      creator: formData.fullName || "MudyHub Student",
      title: "SIWES Technical Report",
      sections: [{
        properties: {
          page: {
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
          }
        },
        // ✅ ADDED: Page Numbers in Footer
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: ["Page ", PageNumber.CURRENT],
                    font: "Times New Roman",
                    size: 24, 
                    color: "666666" 
                  }),
                ],
              }),
            ],
          }),
        },
        children
      }]
    });

    const buffer = await Packer.toBuffer(doc);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="SIWES_Report_${formData.matric || uid}.docx"`);
    res.send(buffer);

    console.log(`[SIWES] ✅ Report sent for uid=${uid}, size=${buffer.length} bytes`);
  } catch (error) {
    console.error("[SIWES] Error:", error);
    res.status(500).json({ error: error.message || "Failed to generate SIWES report." });
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
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded.uid;
}
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
    if (!user.email) return res.status(400).json({ error: "Add and verify an email address before funding your wallet." });
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
    if (user.banned === true || user.walletFrozen === true) return res.status(403).json({ error: "Your account or wallet is restricted. Contact support." });
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

    const result = await walletRef.transaction(current => {
      const balance = Number(current || 0);
      if (!Number.isFinite(balance) || balance < withdrawAmount) return;
      return balance - withdrawAmount;
    });
    if (!result.committed) {
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
  
