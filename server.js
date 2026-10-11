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
app.use(express.json({ limit: '15mb' }));

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

MATH FORMATTING — CRITICAL: NEVER use LaTeX or math notation (no $, no \\rho, no \\frac, no \\sqrt, no _{}, no ^{}). Write all formulas in plain, readable text. 
- Write "P = ρgh" not "$P = \\rho g h$"
- Write "F = m × a" not "$F = m \\cdot a$"
- Write "v = d/t" not "$v = \\frac{d}{t}$"
- Use × for multiplication, / for division, ^ for powers (e.g., x^2), √ for square root, and Greek letters directly (ρ, π, θ, α, β, Δ).
This is essential because the app cannot render LaTeX — students must see readable formulas.`,

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

If asked something completely unrelated to MudyHub, earning, or learning skills (e.g. medical advice, legal advice, unrelated trivia), politely redirect: mention you're focused on helping with MudyHub, earning, and skills, and ask if they have a question in that area.`
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

app.get('/', (req, res) => {
  res.send("MudyHub AI Server is Live!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Models:`, MODELS);
});
