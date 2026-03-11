// services/geminiClient.js — Singleton SDK client
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Pre-configured models for convenience
const flash = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
const flashLite = ai.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

module.exports = { ai, flash, flashLite };