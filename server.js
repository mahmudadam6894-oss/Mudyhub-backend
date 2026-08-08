import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

const app = express();

// Enable CORS for all incoming requests from GitHub Pages
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Check key at startup
if (!process.env.GEMINI_API_KEY) {
  console.error("FATAL: GEMINI_API_KEY environment variable is not set. Set it in your Render dashboard.");
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const systemInstruction = `You are MudyCampus AI, a dedicated academic and educational assistant built specifically for tertiary students (Universities, Polytechnics, and Colleges).

STRICT RULE: You are ONLY allowed to answer educational, academic, career, and school-related questions (e.g., SIWES/IT reports, assignment questions, course explanations, project topics, study plans, CV writing, and exam prep).

IF the user asks a non-educational or off-topic question (e.g., gossip, sports news, relationship advice, casual chit-chat, entertainment, or irrelevant topics), respond with:
"I am MudyCampus AI, your academic assistant. I can only help you with educational questions, assignments, SIWES reports, project topics, and study guides! Please ask a school-related question."`;

app.post('/api/generate', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      response: "Server misconfiguration: GEMINI_API_KEY is missing on Render settings."
    });
  }

  const { prompt } = req.body;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ response: "Error: No prompt provided." });
  }

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-1.5-flash', // Updated to valid production model name
      contents: prompt,
      config: {
        systemInstruction: systemInstruction
      }
    });

    // Safely extract text output
    const textOutput = result.text || (result.candidates && result.candidates[0]?.content?.parts[0]?.text) || "";

    if (!textOutput) {
      console.error("Gemini returned no text output:", JSON.stringify(result));
      return res.status(502).json({
        response: "The AI model returned an empty response. Please try rephrasing your question."
      });
    }

    res.json({ response: textOutput });
  } catch (error) {
    console.error("Backend Error:", error);
    res.status(500).json({ 
      response: `Backend Error: ${error.message || "An unexpected error occurred while generating the response."}` 
    });
  }
});

// Health Check Route
app.get('/health', (req, res) => {
  res.json({
    status: "ok",
    geminiKeyConfigured: !!process.env.GEMINI_API_KEY
  });
});

app.get('/', (req, res) => {
  res.send("MudyHub AI Server is Running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini API key configured: ${!!process.env.GEMINI_API_KEY}`);
});
        
