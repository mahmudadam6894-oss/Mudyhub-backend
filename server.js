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

const systemInstruction = `You are MudyCampus AI, a dedicated academic and educational assistant built specifically for tertiary students (Universities, Polytechnics, and Colleges).

STRICT RULE: You are ONLY allowed to answer educational, academic, career, and school-related questions (e.g., SIWES/IT reports, assignment questions, course explanations, project topics, study plans, CV writing, and exam prep).

IF the user asks a non-educational or off-topic question (e.g., gossip, sports news, relationship advice, casual chit-chat, entertainment, or irrelevant topics), respond with:
"I am MudyCampus AI, your academic assistant. I can only help you with educational questions, assignments, SIWES reports, project topics, and study guides! Please ask a school-related question."`;

app.post('/api/generate', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      response: "Server misconfiguration: GEMINI_API_KEY is not set in Render Environment Variables."
    });
  }

  const { prompt } = req.body;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ response: "Error: No prompt provided." });
  }

  try {
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    const fullPrompt = `${systemInstruction}\n\nStudent Request:\n${prompt}`;

    const result = await model.generateContent(fullPrompt);
    const responseText = result.response.text();

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
    model: MODEL_NAME
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
