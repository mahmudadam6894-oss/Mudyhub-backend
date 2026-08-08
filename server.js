import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();

// Enable CORS for frontend requests
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Startup environment variable check
if (!process.env.GEMINI_API_KEY) {
  console.error("FATAL: GEMINI_API_KEY environment variable is not set in Render dashboard.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Current stable model as of August 2026. If this ever starts returning a
// 404 "model not found" error again, check https://ai.google.dev/gemini-api/docs/models
// for the current model list and update MODEL_NAME below.
const MODEL_NAME = "gemini-3.6-flash";

// -----------------------------------------------------
// SYSTEM PROMPTS — one per assistant "mode"
// -----------------------------------------------------
const SYSTEM_PROMPTS = {
  // Campus Hub's academic assistant (unchanged from before)
  campus: `You are MudyCampus AI, a dedicated academic and educational assistant built specifically for tertiary students (Universities, Polytechnics, and Colleges).

STRICT RULE: You are ONLY allowed to answer educational, academic, career, and school-related questions (e.g., SIWES/IT reports, assignment questions, course explanations, project topics, study plans, CV writing, and exam prep).

IF the user asks a non-educational or off-topic question (e.g., gossip, sports news, relationship advice, casual chit-chat, entertainment, or irrelevant topics), respond with:
"I am MudyCampus AI, your academic assistant. I can only help you with educational questions, assignments, SIWES reports, project topics, and study guides! Please ask a school-related question."`,

  // MudyHub's general platform + earning + skills assistant
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

app.post('/api/generate', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      response: "Server misconfiguration: GEMINI_API_KEY is not set in Render Environment Variables."
    });
  }

  const { prompt, mode, history } = req.body;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ response: "Error: No prompt provided." });
  }

  // Pick the system prompt for the requested mode. Defaults to "campus" so
  // existing callers that don't send a mode keep working unchanged.
  const selectedMode = (mode === "platform") ? "platform" : "campus";
  const systemInstruction = SYSTEM_PROMPTS[selectedMode];

  try {
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: systemInstruction
    });

    let responseText;

    // If a conversation history array was sent, use multi-turn chat so the
    // model remembers earlier messages. Otherwise fall back to a single
    // one-shot generateContent call (this is what Campus Hub uses today).
    if (Array.isArray(history) && history.length > 0) {
      // Expecting history items shaped like: { role: "user" | "model", text: "..." }
      const formattedHistory = history
        .filter(h => h && typeof h.text === "string" && h.text.trim())
        .map(h => ({
          role: h.role === "assistant" || h.role === "model" ? "model" : "user",
          parts: [{ text: h.text }]
        }));

      const chat = model.startChat({ history: formattedHistory });
      const result = await chat.sendMessage(prompt);
      responseText = result.response.text();
    } else {
      const result = await model.generateContent(prompt);
      responseText = result.response.text();
    }

    if (!responseText) {
      return res.status(502).json({
        response: "The AI model returned an empty response. Please try rephrasing your question."
      });
    }

    res.json({ response: responseText });
  } catch (error) {
    console.error("Backend Error:", error);
    res.status(500).json({
      response: `Backend Error: ${error.message || "An unexpected error occurred."}`
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: "ok",
    geminiKeyConfigured: !!process.env.GEMINI_API_KEY,
    model: MODEL_NAME,
    modes: Object.keys(SYSTEM_PROMPTS)
  });
});

app.get('/', (req, res) => {
  res.send("MudyHub AI Server is Live!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Using model: ${MODEL_NAME}`);
});
            
