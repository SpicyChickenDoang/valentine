// services/geminiClient.js — Singleton SDK client
// Using @google/genai (the newer SDK for Gemini 2.0+)
const { GoogleGenAI } = require('@google/genai');

if (!process.env.GEMINI_API_KEY) {
  throw new Error('[geminiClient] GEMINI_API_KEY env var missing');
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Helper functions for common operations
// Note: The new SDK uses ai.models.generateContent() with model in params
// rather than separate model instances
async function generateContent({ model, contents, config }) {
  return await ai.models.generateContent({
    model,
    contents,
    config
  });
}

async function generateContentStream({ model, contents, config }) {
  return await ai.models.generateContentStream({
    model,
    contents,
    config
  });
}

module.exports = {
  ai,
  generateContent,
  generateContentStream,
  // Access submodules directly
  models: ai.models,
  caches: ai.caches,
  chats: ai.chats,
  files: ai.files,
  live: ai.live,
};