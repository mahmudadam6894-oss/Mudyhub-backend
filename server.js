import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.use(cors());
app.use(express.json());

// Fail loudly at startup if the key is missing, instead of silently
// initializing a broken client that fails on every request later.
if (!process.env.GEMINI_API_KEY) {
  console.error("FATAL: GEMINI_API_KEY environment variable is not set. Set it in your Render dashboard under Environment.");
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const systemInstruction = `You are MudyCampus AI, a dedicated academic and educational assistant built specifically for tertiary students (Universities, Polytechnics, and Colleges).

STRICT RULE: You are ONLY allowed to answer educational, academic, career, and school-related questions (e.g., SIWES/IT reports, assignment questions, course explanations, project topics, study plans, CV writing, and exam prep).

IF the user asks a non-educational or off-topic question (e.g., gossip, sports news, relationship advice, casual chit-chat, entertainment, or irrelevant topics), respond with:
"I am MudyCampus AI, your academic assistant. I can only help you with educational questions, assignments, SIWES reports, project topics, and study guides! Please ask a school-related question."`;

app.post('/api/generate', async (req, res) => {
  // Guard: catch the missing-key case explicitly before even calling Gemini
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Server misconfiguration: GEMINI_API_KEY is not set. Contact the administrator."
    });
  }

  const { prompt } = req.body;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "No prompt provided." });
  }

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction: systemInstruction
      }
    });

    // Safely extract text output
    const textOutput = result.text || (result.candidates && result.candidates[0]?.content?.parts[0]?.text) || "";

    if (!textOutput) {
      // The API call succeeded but returned no usable text — surface this
      // as an explicit error instead of silently sending an empty string.
      console.error("Gemini returned no text output. Raw result:", JSON.stringify(result));
      return res.status(502).json({
        error: "The AI model returned an empty response. This may be due to content filtering or a temporary model issue — please try rephrasing your question."
      });
    }

    res.json({ response: textOutput });
  } catch (error) {
    console.error("Backend Error:", error);
    res.status(500).json({ error: error.message || "An unexpected error occurred while generating the response." });
  }
});

// Simple health check so you (or Render) can quickly verify the server is up
// and correctly configured, without needing a real Gemini request.
app.get('/health', (req, res) => {
  res.json({
    status: "ok",
    geminiKeyConfigured: !!process.env.GEMINI_API_KEY
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini API key configured: ${!!process.env.GEMINI_API_KEY}`);
});
