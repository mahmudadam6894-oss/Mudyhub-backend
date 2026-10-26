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
function blank(v) {
  return (v && typeof v === 'string' && v.trim()) ? v.trim() : "Not provided";
}

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
  if (d.includes("computer") || d.includes("software") || d.includes("it ")) return [
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
3. NEVER use markdown symbols like ##, **, ###, or bullet points. Write in flowing, detailed paragraphs only.
4. DO NOT HALLUCINATE COMPANY NAMES. You must ONLY use the exact organisation name provided in the context. Never invent names like "ABC Manufacturing" or "Delta Engineering".
5. AUTOMATIC FILLING: If the student leaves a field empty, YOU MUST INVENT highly realistic, professional details relevant to their department (e.g., if Mechanical, mention lathe machines, micrometers, CNC; if Electrical, mention multimeters, wiring). The report must be 100% complete.
6. Write in the PAST TENSE.
7. DO NOT start with "Certainly" or "Here is". Start directly with the content.
8. You must write extensive, deep, and detailed paragraphs to ensure the final document is between 20 to 25 pages when printed. Do not summarize; elaborate every point.
`;

function buildChapterPrompts(form) {
  const f = form;
  // This helper checks if a field is empty and tells the AI to invent it
  const b = (val) => (val && val.trim() && val !== "Not provided") ? val : "[FIELD EMPTY - YOU MUST INVENT REALISTIC PROFESSIONAL DETAILS]";

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
- Name: ${b(f.fullName)}
- Institution: ${b(f.institution)}
- Department: ${b(f.dept)}
- Faculty: ${b(f.faculty)}
- Level: ${b(f.level)}

Write at least 1,800 words for this chapter. Use real SIWES facts (ITF, 1973, NBTE/NUC/NCCE).`
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
- Organisation: ${b(f.orgName)}
- Address: ${b(f.orgAddress)}
- Sector: ${b(f.orgSector)}
- History provided: ${b(f.orgHistory)}
- Mission provided: ${b(f.orgMission)}
- Vision provided: ${b(f.orgVision)}
- Student's unit: ${b(f.orgUnit)}
- Student's role: ${b(f.jobRole)}
- Supervisor: ${b(f.supervisorName)} (${b(f.supervisorPosition)})

Write at least 1,800 words for this chapter. Describe the organisational chart in detail (who reports to who).`
    },
    {
      chapterNum: 3,
      title: "CHAPTER THREE: PRACTICAL EXPERIENCE",
      prompt: `Write CHAPTER THREE of a Nigerian SIWES report describing the student's actual practical experience. This is the LONGEST chapter.
${STUDENT_VOICE_RULE}

STRUCTURE — use these sub-headings:
a. Experience Acquired in the Organisation (Break this down month by month: Month 1, Month 2, Month 3, Month 4)
b. Summary of Work Undertaken in the Organisation

Student context:
- Job role: ${b(f.jobRole)}
- Work hours: ${b(f.workHours)}
- Daily routine: ${b(f.dailyRoutine)}
- Tools used: ${b(f.tools)}
- Trainings: ${b(f.trainings)}
- Project title: ${b(f.projectTitle)}
- Project description: ${b(f.projectDesc)}
- Project contribution: ${b(f.projectContribution)}

Write at least 3,500 words for this chapter. Detail exactly what the student did every single month. Explain how tools like (${b(f.tools)}) were used.`
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
- Technical challenge 1: ${b(f.challenge1)}
- Solution 1: ${b(f.challenge1Solution)}
- Technical challenge 2: ${b(f.challenge2)}
- Solution 2: ${b(f.challenge2Solution)}
- Interpersonal challenges: ${b(f.challengeInterpersonal)}
- Infrastructure issues: ${b(f.challengeInfrastructure)}

Write at least 2,000 words. Make the challenges sound real and technical (e.g., power fluctuations, machine breakdown, communication gaps). Explain the solutions step-by-step.`
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
- Technical skills: ${b(f.technicalSkills)}
- Soft skills: ${b(f.softSkills)}
- Relevance to course: ${b(f.relevance)}
- Recommendations: ${b(f.recommendations)}

Write at least 1,500 words. Ensure the conclusion sounds highly professional. DO NOT write "References" here, we add them separately.`
    }
  ];
}

async function generateChapter(prompt, maxTokens = 4000) {
  return callGroq({
    systemPrompt: `You are an expert Nigerian SIWES report writer. You write highly detailed, professional, and technical reports that read exactly like a real student wrote them. You NEVER use markdown symbols. You write ONLY in flowing paragraphs.`,
    messages: [{ role: "user", content: prompt }],
    model: MODELS.default,
    maxTokens: maxTokens,
    temperature: 0.75
  });
}

function stripMarkdown(text) {
  if (!text) return "";
  let c = text;
  c = c.replace(/^#{1,6}\s+/gm, "");
  c = c.replace(/\*\*(.+?)\*\*/g, "$1");
  c = c.replace(/\*(.+?)\*/g, "$1");
  c = c.replace(/`([^`]+)`/g, "$1");
  c = c.replace(/^[-*•]\s+/gm, "");
  c = c.replace(/^\s*\d+\.\s+/gm, "");
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
    
    // Check if it's a subheading
    const isSubheading =
      /^[a-eA-E]\.\s+[A-Z]/.test(line) ||
      /^[a-eA-E]\)\s+/.test(line) ||
      (line.length < 80 && /^(definition|brief history|importance|aim|bodies|mission|vision|organisational chart|experience|summary|problems|solutions|conclusion|recommendation|references)\b/i.test(line));
      
    if (isSubheading) {
      out.push({ type: "subheading", text: line });
    } else {
      // Handle merged heading and text (e.g., "a. Definition of SIWESI first heard...")
      const mergedHeadingMatch = line.match(/^([a-eA-E]\.\s*[A-Za-z\s]{3,35})(.*)$/);
      if (mergedHeadingMatch) {
        out.push({ type: "subheading", text: mergedHeadingMatch[1].trim() });
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

function docxPara(text, opts = {}) {
  return new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : (opts.right ? AlignmentType.RIGHT : AlignmentType.JUSTIFIED),
    spacing: { after: opts.afterSpacing ?? 160, line: 360 },
    children: [new TextRun({
      text: text,
      bold: !!opts.bold,
      italics: !!opts.italic,
      size: opts.size || 24,
      font: "Times New Roman"
    })]
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

// ✅ FIXED: Hard page breaks
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

  try {
    console.log(`[SIWES] Starting for uid=${uid}, org=${formData.orgName}, dept=${formData.dept}`);

    const prompts = buildChapterPrompts(formData);
    const chapters = [];

    for (const p of prompts) {
      console.log(`[SIWES] Generating ${p.title}...`);
      
      // Increase tokens for Chapter 3 (Practical Experience) as it's the longest
      const maxTokensForChapter = p.chapterNum === 3 ? 4000 : 2500; 
      const raw = await generateChapter(p.prompt, maxTokensForChapter); 
      
      chapters.push({ num: p.chapterNum, title: p.title, text: stripMarkdown(raw) });

      // Wait 15 seconds before the next chapter to avoid rate limit
      if (p.chapterNum < 5) {
        console.log(`[SIWES] Waiting 15s to avoid rate limit...`);
        await new Promise(r => setTimeout(r, 15000));
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
              children.push(new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new ImageRun({ data: dataUriToBuffer(img.data), transformation: { width: 400, height: 300 } })]
              }));
              children.push(docxPara(`Figure 3.${figN}: Author on duty at ${formData.orgName || "the organisation"}`, { center: true, italic: true, size: 20 }));
              figN++;
            } catch (e) { console.error("Work image error:", e); }
          }
          const projImgs = [images.project1, images.project2].filter(i => i?.data);
          for (const img of projImgs) {
            try {
              children.push(new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new ImageRun({ data: dataUriToBuffer(img.data), transformation: { width: 400, height: 300 } })]
              }));
              children.push(docxPara(`Figure 3.${figN}: ${formData.projectTitle || "Project work"}`, { center: true, italic: true, size: 20 }));
              figN++;
            } catch (e) { console.error("Project image error:", e); }
          }
        }
      }

      const parsed = parseChapter(ch.text);
      for (const item of parsed) {
        if (item.type === "subheading") children.push(docxSubheading(item.text));
        else children.push(docxPara(item.text));
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

// --- A. SECURE TOP-UP (Paystack) ---
app.post("/api/verify-topup", async (req, res) => {
  try {
    const idToken = req.headers.authorization?.split("Bearer ")[1];
    if (!idToken) return res.status(401).json({ error: "Unauthorized" });
    
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const userId = decodedToken.uid;

    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: "Reference is required" });

    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const paystackData = await paystackRes.json();

    if (!paystackData.status || paystackData.data.status !== "success") {
      return res.status(400).json({ error: "Payment not successful on Paystack" });
    }

    const amountPaid = paystackData.data.amount / 100; // Convert Kobo to Naira

    // Idempotency check
    const topupRef = db.ref(`walletTopups/${userId}/${reference}`);
    const snapshot = await topupRef.once("value");
    if (snapshot.exists()) {
      return res.status(400).json({ error: "This payment was already credited." });
    }

    // Credit wallet securely
    const walletRef = db.ref(`users/${userId}/walletBalance`);
    await walletRef.transaction((current) => (current || 0) + amountPaid);

    // Log the topup
    await topupRef.set({
      amount: amountPaid,
      reference,
      status: "completed",
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    // Notify user
    await db.ref(`notifications/${userId}`).push({
      type: "topup",
      amount: amountPaid,
      message: `Wallet credited with ₦${amountPaid.toLocaleString()}.`,
      createdAt: admin.database.ServerValue.TIMESTAMP,
      read: false
    });

    return res.status(200).json({ message: "Wallet credited", amount: amountPaid });

  } catch (error) {
    console.error("Topup Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- B. SECURE WITHDRAWAL (Direct to Bank) ---
app.post("/api/withdraw", async (req, res) => {
  try {
    const idToken = req.headers.authorization?.split("Bearer ")[1];
    if (!idToken) return res.status(401).json({ error: "Unauthorized" });
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const userId = decodedToken.uid;

    const { amount, bankCode, accountNumber, accountName } = req.body;
    const withdrawAmount = Number(amount);

    if (withdrawAmount < 1000) return res.status(400).json({ error: "Minimum is ₦1000" });

    const walletRef = db.ref(`users/${userId}/walletBalance`);
    const walletSnap = await walletRef.once("value");
    const currentBalance = walletSnap.val() || 0;
    
    if (currentBalance < withdrawAmount) {
      return res.status(400).json({ error: "Insufficient funds" });
    }

    // Deduct wallet
    await walletRef.transaction((current) => {
        if (current >= withdrawAmount) return current - withdrawAmount;
        return current;
    });

    // Create Paystack Recipient
    const recipientRes = await fetch("https://api.paystack.co/transferrecipient", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "nuban",
        name: accountName,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: "NGN"
      })
    });
    const recipientData = await recipientRes.json();

    if (!recipientData.status) {
        // Refund if recipient fails
        await walletRef.transaction((current) => (current || 0) + withdrawAmount);
        return res.status(400).json({ error: "Invalid bank details" });
    }

    // Initiate Transfer
    const transferRes = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source: "balance",
        amount: withdrawAmount * 100,
        recipient: recipientData.data.recipient_code,
        reason: "MudyHub Withdrawal"
      })
    });
    const transferData = await transferRes.json();

    if (!transferData.status) {
        // Refund if transfer fails
        await walletRef.transaction((current) => (current || 0) + withdrawAmount);
        return res.status(400).json({ error: "Transfer failed. Funds returned." });
    }

    // Log the withdrawal
    await db.ref(`withdrawalRequests`).push({
      uid: userId,
      amount: withdrawAmount,
      bankCode,
      accountNumber,
      accountName,
      status: "processing",
      paystackRef: transferData.data.reference,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    return res.status(200).json({ message: "Withdrawal processing", reference: transferData.data.reference });

  } catch (error) {
    console.error("Withdraw Error:", error);
    res.status(500).json({ error: "Internal server error" });
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
