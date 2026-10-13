import express from 'express';
import cors from 'cors';

const app = express();

// Enable CORS for frontend requests
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Increase JSON body limit for image uploads (base64 images are large)
app.use(express.json({ limit: '50mb' }));

// Startup environment variable check
if (!process.env.GROQ_API_KEY) {
  console.error("FATAL: GROQ_API_KEY environment variable is not set in Render dashboard.");
}

// -----------------------------------------------------
// MODEL CONFIGURATION
// -----------------------------------------------------
// Groq decommissions models periodically. Check current list:
// https://console.groq.com/docs/models
// You can override these via Render environment variables.
const MODELS = {
  default:   process.env.GROQ_MODEL_DEFAULT   || "openai/gpt-oss-120b",
  reasoning: process.env.GROQ_MODEL_REASONING || "openai/gpt-oss-120b",
  vision:    process.env.GROQ_MODEL_VISION    || "qwen/qwen3.8-27b"
};
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// Max image size accepted from frontend (base64 string length, ~6MB raw image)
const MAX_IMAGE_BASE64_LENGTH = 8_000_000;

// -----------------------------------------------------
// SYSTEM PROMPTS
// -----------------------------------------------------
const SYSTEM_PROMPTS = {
  campus: `You are MudyCampus AI, a dedicated academic and educational assistant built specifically for tertiary students (Universities, Polytechnics, and Colleges).

STRICT RULE: You are ONLY allowed to answer educational, academic, career, and school-related questions (e.g., SIWES/IT reports, assignment questions, course explanations, project topics, study plans, CV writing, and exam prep).

IF the user asks a non-educational or off-topic question (e.g., gossip, sports news, relationship advice, casual chit-chat, entertainment, or irrelevant topics), respond with:
"I am MudyCampus AI, your academic assistant. I can only help you with educational questions, assignments, SIWES reports, project topics, and study guides! Please ask a school-related question."

FORMATTING: Use clean Markdown. Use **bold** for key terms, ### headings for sections, tables for comparisons, and numbered lists for steps. Never include raw code fences around normal text.

RESPONSE LENGTH: Keep answers focused and concise. Aim for under 250 words unless the student specifically asks for a detailed explanation, a full report, or a study guide. Long walls of text are hard to read on mobile.

MATH FORMATTING: Do not use LaTeX or math notation. Write all formulas in plain readable text. Use 'x' or '*' for multiplication, '/' for division, '^' for powers, 'sqrt' for square root, and Greek letters directly (rho, pi, theta, alpha, beta, delta). For example, write "P = rho*g*h" instead of LaTeX. This is essential because the app cannot render LaTeX.

TABLE FORMATTING: When you use tables, follow these rules:
- Always use pipe tables with a header row and a separator row of dashes.
- Always put a SPACE on both sides of every pipe symbol.
- Every row must have the SAME number of columns as the header row.
- Use as many columns as the content genuinely needs. For simple comparisons, 2-4 columns is ideal. For formulas, data, or detailed comparisons, use as many columns as needed.
- Keep cell content SHORT. Aim for under 8 words per cell.
- Never put line breaks inside a cell.
- Always leave a blank line before and after a table.`,
  
  platform: `You are Mudy AI, the official assistant for MudyHub — an earning and learning platform for African (especially Nigerian) students and young people.

WHAT YOU HELP WITH:
1. Explaining how MudyHub works: Paid Tasks, Jobs, Daily Rewards, Referral Program, Marketplace, Business Ads, Wallet & Withdrawals, Campus Hub (Quiz Arena, CGPA calculator, AI academic assistant), and Community/Social feed.
2. Practical advice on making money online: freelancing, content creation, digital skills that pay, how to start with little or no capital, and how to use MudyHub's own features (tasks, jobs, marketplace, referrals) to earn.
3. Advice on learning valuable skills: what skills are in demand, how to learn them for free or cheap, realistic timelines, and how those skills connect to earning opportunities on and off MudyHub.

HOW MUDYHUB WORKS (use this to answer platform questions accurately):
- Paid Tasks: users complete simple tasks (follow/like/watch/download) and submit proof; admin approves and pays out to wallet.
- Jobs: verified remote/local job listings users can apply to directly.
- Daily Rewards: a small bonus claimable once every 24 hours.
- Referral Program: users share a personal referral link and earn when new users sign up through it.
- Marketplace: users can list products/services (pending admin approval) or buy from other users.
- Business Ads / Boost Followers: users can pay to promote a business or grow social accounts to other MudyHub users.
- Wallet: shows balance, pending earnings, and withdrawal history; users request withdrawals to their bank account.
- Campus Hub: a student-focused section with a daily quiz (win a small cash reward), a CGPA calculator, and an AI academic assistant for schoolwork.

TONE: Be warm, practical, and encouraging — like a knowledgeable older student or mentor, not a corporate chatbot. Keep answers concise and actionable. Use Nigerian context naturally where relevant (Naira amounts, NUBAN, common platforms like TikTok/WhatsApp/Opay) but don't force it.

STRICT SCOPE: You do NOT answer general academic questions (what is computer science, solve this equation, explain photosynthesis, write my assignment). Those belong to the Campus Tutor, which is only available to verified students.

If a user asks a general academic question, respond with:
"That's a great academic question! For academic help, please open the Campus Hub → AI Tools tab. It's available to verified students. For now, is there anything I can help you with on MudyHub — earning, wallet, referrals, or marketplace?"

If asked something completely unrelated to MudyHub, earning, or learning skills (medical advice, sports, gossip, entertainment), politely redirect:
"I'm focused on helping with MudyHub, earning, and skills. Do you have a question in that area?"`
};
  
// -----------------------------------------------------
// Core Groq caller
// -----------------------------------------------------
async function callGroq({ systemPrompt, messages, model, jsonMode = false, maxTokens = 1024 }) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set in Render Environment Variables.");
  }

  const body = {
    model: model || MODELS.default,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages
    ],
    temperature: 0.7,
    max_tokens: maxTokens
  };

  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

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
  if (!text) {
    throw new Error("Groq returned an empty response.");
  }
  return text;
}

// -----------------------------------------------------
// /api/generate — main AI endpoint (chat + think + image)
// -----------------------------------------------------
app.post('/api/generate', async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({
      response: "Server misconfiguration: GROQ_API_KEY is not set in Render Environment Variables."
    });
  }

  const {
    prompt,
    mode,
    history,
    thinkMode = false,
    imageBase64 = null,
    searchMode = false
  } = req.body;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ response: "Error: No prompt provided." });
  }

  const selectedMode = (mode === "platform") ? "platform" : "campus";
  let systemPrompt = SYSTEM_PROMPTS[selectedMode];

  if (searchMode) {
    systemPrompt += `\n\nSEARCH MODE IS ON: Be extra thorough. Cite specific Nigerian campus context, examples, and standards where relevant.`;
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

    const imageUrl = imageBase64.startsWith("data:")
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;

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

  if (imageBase64) {
    model = MODELS.vision;
    maxTokens = 2048;
  } else if (thinkMode) {
    model = MODELS.reasoning;
    maxTokens = 3072;
  }

  try {
    const responseText = await callGroq({ systemPrompt, messages, model, maxTokens });

    if (!responseText) {
      return res.status(502).json({
        response: "The AI model returned an empty response. Please try rephrasing your question."
      });
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
    } else if (userMsg.toLowerCase().includes("model") && userMsg.toLowerCase().includes("not found")) {
      userMsg = "AI model unavailable. Please contact support.";
    }

    res.status(500).json({ response: `Backend Error: ${userMsg}` });
  }
});

// -----------------------------------------------------
// Quiz Generator — returns 5 MCQs as JSON
// -----------------------------------------------------
const QUIZ_SYSTEM_PROMPT = `You generate multiple-choice trivia questions for a student quiz app.

Generate exactly 5 general knowledge questions covering a random mix of topics (science, technology, history, geography, current affairs, basic academics, etc.). Vary the topics each time.

Respond with ONLY valid JSON. Use exactly this shape:

{
  "questions": [
    {
      "question": "string",
      "options": ["string", "string", "string", "string"],
      "answer": 0
    }
  ]
}

Rules:
- Exactly 5 questions in the array.
- Exactly 4 options per question.
- "answer" is the zero-based index (0-3) of the correct option.
- Questions must have a single unambiguous correct answer.
- Keep questions and options concise (under 20 words each).`;

function extractJsonFromText(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

function isValidQuizPayload(data) {
  if (!data || !Array.isArray(data.questions) || data.questions.length !== 5) return false;
  return data.questions.every(q =>
    q &&
    typeof q.question === "string" && q.question.trim() &&
    Array.isArray(q.options) && q.options.length === 4 &&
    q.options.every(o => typeof o === "string" && o.trim()) &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3
  );
}

app.get('/api/quiz', async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({
      error: "Server misconfiguration: GROQ_API_KEY is not set in Render Environment Variables."
    });
  }

  try {
    const rawText = await callGroq({
      systemPrompt: QUIZ_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Generate a new set of 5 quiz questions now." }],
      jsonMode: true
    });

    let quizData;
    try {
      quizData = extractJsonFromText(rawText);
    } catch (parseErr) {
      console.error("Quiz JSON parse failed. Raw text:", rawText);
      return res.status(502).json({ error: "AI returned malformed quiz data. Please try again." });
    }

    if (!isValidQuizPayload(quizData)) {
      console.error("Quiz payload failed validation:", JSON.stringify(quizData));
      return res.status(502).json({ error: "AI returned an invalid quiz format. Please try again." });
    }

    res.json(quizData);
  } catch (error) {
    console.error("Quiz generation error:", error);
    res.status(500).json({ error: error.message || "Failed to generate quiz." });
  }
});

// -----------------------------------------------------
// Health check
// -----------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: "ok",
    groqKeyConfigured: !!process.env.GROQ_API_KEY,
    models: MODELS,
    modes: Object.keys(SYSTEM_PROMPTS),
    features: {
      think: true,
      vision: true,
      search: true
    }
  });
});
// ============================================================================
// SIWES REPORT GENERATOR
// ============================================================================
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun, Table, TableRow, TableCell, WidthType, BorderStyle } from "docx";

// -----------------------------------------------------
// Chapter prompts — each chapter gets its own Groq call
// -----------------------------------------------------
function buildChapterPrompts(form) {
    const f = form;
    const blank = (v) => (v && v.trim && v.trim()) ? v : "Not provided";

    return [
        {
            chapterNum: 1,
            title: "CHAPTER ONE: INTRODUCTION",
            prompt: `Write CHAPTER ONE of a Nigerian SIWES technical report in formal academic English.

STRUCTURE (use these exact subheadings as bold headings):
1.1 Definition of SIWES
1.2 Brief History of SIWES
1.3 Importance and Purpose of SIWES
1.4 Aim and Objectives of SIWES
1.5 Bodies Involved in the Management of SIWES and Their Roles

Student context:
- Name: ${blank(f.fullName)}
- Institution: ${blank(f.institution)}
- Department: ${blank(f.dept)}
- Level: ${blank(f.level)}

Write 1,200-1,500 words. Use formal Nigerian polytechnic academic English. Reference real facts about SIWES (established under ITF Act, coordinated by ITF/NUC/NBTE, etc.). Do not invent sources. End with "---" on its own line.`
        },
        {
            chapterNum: 2,
            title: "CHAPTER TWO: ORGANISATION PROFILE",
            prompt: `Write CHAPTER TWO of a Nigerian SIWES report about the organisation where the student did their attachment.

STRUCTURE (use these exact subheadings):
2.1 Brief History of the Organisation
2.2 Mission of the Organisation
2.3 Vision of the Organisation
2.4 Organisational Chart and Structure
2.5 Roles Performed by the Organisation

Student context:
- Organisation: ${blank(f.orgName)}
- Address: ${blank(f.orgAddress)}
- Sector: ${blank(f.orgSector)}
- Student's unit: ${blank(f.orgUnit)}
- Student's role: ${blank(f.jobRole)}
- History provided: ${blank(f.orgHistory)}
- Mission provided: ${blank(f.orgMission)}
- Vision provided: ${blank(f.orgVision)}

Write 1,200-1,500 words. Where the student provided specific details, use them. Where details are missing, write plausible general descriptions but do NOT invent specific facts like founding dates or CEO names. End with "---" on its own line.`
        },
        {
            chapterNum: 3,
            title: "CHAPTER THREE: WORK EXPERIENCE",
            prompt: `Write CHAPTER THREE of a Nigerian SIWES report describing the student's practical work experience.

STRUCTURE:
3.1 Introduction to the Work Experience
3.2 Daily Routine and Work Schedule
3.3 Month-by-Month Activities
3.4 Tools, Software and Equipment Used
3.5 Trainings, Meetings and Workshops Attended
3.6 Projects Undertaken
3.7 Achievements

Student context:
- Job role: ${blank(f.jobRole)}
- Work hours: ${blank(f.workHours)}
- Month 1: ${blank(f.month1)}
- Month 2: ${blank(f.month2)}
- Month 3: ${blank(f.month3)}
- Month 4: ${blank(f.month4)}
- Tools used: ${blank(f.tools)}
- Trainings attended: ${blank(f.trainings)}
- Project title: ${blank(f.projectTitle)}
- Project description: ${blank(f.projectDesc)}
- Student's contribution: ${blank(f.projectContribution)}
- Project tools: ${blank(f.projectTools)}
- Biggest achievement: ${blank(f.achievement)}
- Commendation: ${blank(f.award)}

Write 2,500-3,000 words. Elaborate on each month using the student's specific answers. Make it vivid and detailed. Use tables where useful (e.g. a table of tools). End with "---" on its own line.`
        },
        {
            chapterNum: 4,
            title: "CHAPTER FOUR: CHALLENGES AND SOLUTIONS",
            prompt: `Write CHAPTER FOUR of a Nigerian SIWES report about the challenges the student faced and how they were solved.

STRUCTURE:
4.1 Introduction
4.2 Technical Challenges Faced
4.3 Solutions to Technical Challenges
4.4 Interpersonal Challenges
4.5 Logistical Challenges (Transport, Accommodation, etc.)
4.6 Lessons Learned From These Challenges

Student context:
- Challenge 1: ${blank(f.challenge1)}
- Solution 1: ${blank(f.challenge1Solution)}
- Challenge 2: ${blank(f.challenge2)}
- Solution 2: ${blank(f.challenge2Solution)}
- Interpersonal challenges: ${blank(f.challengeInterpersonal)}
- Logistics challenges: ${blank(f.challengeLogistics)}
- Lessons learned: ${blank(f.challengeLessons)}

Write 1,200-1,500 words. Elaborate on each challenge with real-world examples. Use the student's specific details. End with "---" on its own line.`
        },
        {
            chapterNum: 5,
            title: "CHAPTER FIVE: SUMMARY, CONCLUSION AND RECOMMENDATIONS",
            prompt: `Write CHAPTER FIVE of a Nigerian SIWES report.

STRUCTURE:
5.1 Summary
5.2 Conclusion
5.3 Recommendations
5.4 References

Student context:
- Technical skills acquired: ${blank(f.technicalSkills)}
- Soft skills acquired: ${blank(f.softSkills)}
- How it relates to course of study: ${blank(f.relevance)}
- Advice for future students: ${blank(f.advice)}
- Recommendations: ${blank(f.recommendations)}

Write 800-1,000 words. For the References section (5.4), provide 5-8 generic academic references in APA format related to SIWES/industrial training/engineering/IT — use real book/paper titles that actually exist (e.g., ITF publications, textbooks on industrial training). End with "---" on its own line.`
        }
    ];
}

// -----------------------------------------------------
// Call Groq for one chapter (non-streaming, long output)
// -----------------------------------------------------
async function generateChapter(prompt, maxTokens = 4096) {
    const response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
            model: MODELS.default,
            messages: [
                { role: "system", content: "You are an expert Nigerian academic report writer. You produce clean, formal, well-structured SIWES technical reports. Never use LaTeX. Never use markdown code fences. Use plain text with bold headings written in CAPITAL LETTERS. Never include intro like 'Sure, here is...'. Start directly with the content." },
                { role: "user", content: prompt }
            ],
            temperature: 0.65,
            max_tokens: maxTokens
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq ${response.status}: ${errText}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
}

// -----------------------------------------------------
// Helpers — DOCX building blocks
// -----------------------------------------------------
function dataUriToBuffer(dataUri) {
    const base64 = dataUri.split(",")[1];
    return Buffer.from(base64, "base64");
}

function para(text, opts = {}) {
    return new Paragraph({
        alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { after: 120, line: 360 },
        children: [
            new TextRun({
                text,
                bold: !!opts.bold,
                italics: !!opts.italic,
                size: opts.size || 24, // 12pt
                font: "Times New Roman"
            })
        ]
    });
}

function heading(text, level = 1) {
    const sizes = { 1: 32, 2: 28, 3: 26 };
    return new Paragraph({
        spacing: { before: 240, after: 120, line: 360 },
        children: [
            new TextRun({
                text,
                bold: true,
                size: sizes[level] || 26,
                font: "Times New Roman"
            })
        ]
    });
}

function pageBreak() {
    return new Paragraph({ children: [new TextRun({ text: "", break: 1 })] });
}

// -----------------------------------------------------
// Parse chapter text — split into paragraphs & headings
// -----------------------------------------------------
function renderChapterBody(chapterText) {
    const out = [];
    const lines = chapterText.split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line === "---") continue;

        // Detect heading — lines that start with number.number or are ALL CAPS short
        const isNumberedHeading = /^\d+\.\d+(\.\d+)?\s+[A-Z]/.test(line);
        const isAllCapsHeading = line.length < 80 && line === line.toUpperCase() && /[A-Z]/.test(line);

        if (isNumberedHeading || isAllCapsHeading) {
            out.push(heading(line, 2));
        } else {
            out.push(para(line));
        }
    }

    return out;
}

// -----------------------------------------------------
// Main endpoint
// -----------------------------------------------------
app.post('/api/siwes', async (req, res) => {
    if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ error: "GROQ_API_KEY not set on server." });
    }

    const { uid, formData, images } = req.body;

    if (!uid || !formData) {
        return res.status(400).json({ error: "Missing uid or formData." });
    }

    try {
        console.log(`[SIWES] Starting for uid=${uid}, org=${formData.orgName}`);

        const prompts = buildChapterPrompts(formData);
        const chapters = [];

        // Generate each chapter sequentially (avoid Groq rate limits)
        for (const p of prompts) {
            console.log(`[SIWES] Generating ${p.title}...`);
            const text = await generateChapter(p.prompt, p.chapterNum === 3 ? 6000 : 4096);
            chapters.push({ num: p.chapterNum, title: p.title, text });
        }

        console.log(`[SIWES] All 5 chapters generated. Building DOCX...`);

        // -------------------------------------------------
        // Build the DOCX
        // -------------------------------------------------
        const children = [];

        // ===== COVER PAGE =====
        children.push(para("A TECHNICAL REPORT ON STUDENT INDUSTRIAL WORK EXPERIENCE SCHEME (SIWES)", {
            center: true, bold: true, size: 32
        }));
        children.push(para(""));
        children.push(para("SUBMITTED BY", { center: true, bold: true }));
        children.push(para(formData.fullName || "", { center: true, bold: true, size: 28 }));
        children.push(para(formData.matric || "", { center: true }));
        children.push(para(""));
        children.push(para("DEPARTMENT OF " + (formData.dept || "").toUpperCase(), { center: true, bold: true }));
        children.push(para("FACULTY OF " + (formData.faculty || "").toUpperCase(), { center: true, bold: true }));
        children.push(para((formData.institution || "").toUpperCase(), { center: true, bold: true }));
        children.push(para(""));
        children.push(para(`SIWES PERIOD: ${formData.startDate || ""} TO ${formData.endDate || ""}`, { center: true }));
        children.push(para(""));
        children.push(para("IN PARTIAL FULFILMENT OF THE REQUIREMENTS FOR THE AWARD OF NATIONAL DIPLOMA (ND)", {
            center: true, italic: true
        }));
        children.push(para(""));
        children.push(para(new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long" }), { center: true, bold: true }));

        children.push(pageBreak());

        // ===== DECLARATION =====
        children.push(heading("DECLARATION", 1));
        children.push(para(`I, ${formData.fullName || ""}, hereby declare that this SIWES technical report is my original work and has not been submitted elsewhere.`));
        children.push(para(""));
        children.push(para("_____________________________", {}));
        children.push(para(formData.fullName || "", { bold: true }));
        children.push(para(`Date: ${new Date().toLocaleDateString("en-GB")}`));
        children.push(pageBreak());

        // ===== CERTIFICATION =====
        children.push(heading("CERTIFICATION", 1));
        children.push(para("This is to certify that this SIWES report was carried out by the above-named student and is approved as meeting the requirements of the institution."));
        children.push(para(""));
        children.push(para("Industry Supervisor: " + (formData.supervisorName || "_________________")));
        children.push(para("Position: " + (formData.supervisorPosition || "_________________")));
        children.push(para("Signature & Date: _____________________________"));
        children.push(para(""));
        children.push(para("School Supervisor: _____________________________"));
        children.push(para("Signature & Date: _____________________________"));
        children.push(pageBreak());

        // ===== DEDICATION =====
        children.push(heading("DEDICATION", 1));
        children.push(para("This report is dedicated to Almighty God and to my family for their support and encouragement throughout the SIWES period."));
        children.push(pageBreak());

        // ===== ACKNOWLEDGEMENT =====
        children.push(heading("ACKNOWLEDGEMENT", 1));
        children.push(para(`I sincerely appreciate the management and staff of ${formData.orgName || "the organisation"} for giving me the opportunity to undertake my industrial training with them. My special thanks go to ${formData.supervisorName || "my industry supervisor"} for their guidance and mentorship.`));
        children.push(para(`I also appreciate the management of ${formData.institution || "my institution"} for facilitating this SIWES programme, and my family for their unwavering support.`));
        children.push(pageBreak());

        // ===== ABSTRACT =====
        children.push(heading("ABSTRACT", 1));
        children.push(para(`This report presents a detailed account of my Student Industrial Work Experience Scheme (SIWES) attachment at ${formData.orgName || "an organisation"}, undertaken from ${formData.startDate || ""} to ${formData.endDate || ""}. During this period, I was attached to the ${formData.orgUnit || "relevant"} unit where I served as a ${formData.jobRole || "student intern"}. The report covers the organisation's profile, the daily activities and projects undertaken, technical and interpersonal challenges encountered, and the lessons learned. The SIWES programme provided invaluable practical exposure that complemented the theoretical knowledge gained in the classroom, and it significantly enhanced my technical and soft skills.`));
        children.push(pageBreak());

        // ===== TABLE OF CONTENTS (simple) =====
        children.push(heading("TABLE OF CONTENTS", 1));
        children.push(para("Preliminary Pages .......................................... i"));
        children.push(para("Chapter One: Introduction ................................... 1"));
        children.push(para("Chapter Two: Organisation Profile ........................... 8"));
        children.push(para("Chapter Three: Work Experience .............................. 15"));
        children.push(para("Chapter Four: Challenges and Solutions ...................... 25"));
        children.push(para("Chapter Five: Summary, Conclusion and Recommendations ....... 30"));
        children.push(pageBreak());

        // ===== CHAPTERS =====
        for (const ch of chapters) {
            // Chapter title
            children.push(heading(ch.title, 1));
            children.push(para(""));

            // Optional images per chapter
            if (images) {
                if (ch.num === 2 && images.logo && images.logo.data) {
                    try {
                        const buf = dataUriToBuffer(images.logo.data);
                        children.push(new Paragraph({
                            alignment: AlignmentType.CENTER,
                            children: [new ImageRun({
                                data: buf,
                                transformation: { width: 200, height: 200 }
                            })]
                        }));
                        children.push(para("Figure 2.1: Organisation Logo", { center: true, italic: true, size: 20 }));
                    } catch (e) { console.error("Logo image error:", e); }
                }

                if (ch.num === 3) {
                    const workImgs = [images.work1, images.work2, images.work3].filter(i => i && i.data);
                    let figN = 1;
                    for (const img of workImgs) {
                        try {
                            const buf = dataUriToBuffer(img.data);
                            children.push(new Paragraph({
                                alignment: AlignmentType.CENTER,
                                children: [new ImageRun({
                                    data: buf,
                                    transformation: { width: 400, height: 300 }
                                })]
                            }));
                            children.push(para(`Figure 3.${figN}: Author at work`, { center: true, italic: true, size: 20 }));
                            figN++;
                        } catch (e) { console.error("Work image error:", e); }
                    }

                    const projImgs = [images.project1, images.project2].filter(i => i && i.data);
                    for (const img of projImgs) {
                        try {
                            const buf = dataUriToBuffer(img.data);
                            children.push(new Paragraph({
                                alignment: AlignmentType.CENTER,
                                children: [new ImageRun({
                                    data: buf,
                                    transformation: { width: 400, height: 300 }
                                })]
                            }));
                            children.push(para(`Figure 3.${figN}: Project screenshot`, { center: true, italic: true, size: 20 }));
                            figN++;
                        } catch (e) { console.error("Project image error:", e); }
                    }
                }
            }

            // Chapter body
            const bodyParas = renderChapterBody(ch.text);
            bodyParas.forEach(p => children.push(p));

            children.push(pageBreak());
        }

        // -------------------------------------------------
        // Pack and send
        // -------------------------------------------------
        const doc = new Document({
            creator: formData.fullName || "MudyHub Student",
            title: "SIWES Technical Report",
            sections: [{
                properties: {
                    page: {
                        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } // 1 inch
                    }
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
        res.status(500).json({
            error: error.message || "Failed to generate SIWES report."
        });
    }
});

app.get('/', (req, res) => {
  res.send("MudyHub AI Server is Live!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Models:`, MODELS);
});

