import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import path from "path";

dotenv.config();

// Initialize Database
const db = new Database("chat.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    personaId TEXT,
    role TEXT,
    text TEXT,
    timestamp TEXT,
    createdAt INTEGER,
    isRead INTEGER DEFAULT 0
  )
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));
  
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // --- API Routes ---
  
  // Get messages from server
  app.get("/api/messages/:personaId", (req, res) => {
    const { personaId } = req.params;
    const { lastTimestamp } = req.query;
    
    let query = "SELECT * FROM messages WHERE personaId = ?";
    const params = [personaId];
    
    if (lastTimestamp) {
      query += " AND createdAt > ?";
      params.push(lastTimestamp as string);
    }
    
    query += " ORDER BY createdAt ASC";
    
    const rows = db.prepare(query).all(...params);
    res.json(rows);
  });

  app.post("/api/chat", async (req, res) => {
    const { 
      message, 
      history, 
      persona, 
      apiSettings, 
      worldbook, 
      userProfile, 
      subscriptionId,
      additionalSystemInstructions,
      forceModel,
      messageId // Client-side generated ID for the user message
    } = req.body;

    // Save user message to DB if it doesn't exist
    if (messageId && persona?.id) {
      const existing = db.prepare("SELECT id FROM messages WHERE id = ?").get(messageId);
      if (!existing) {
        db.prepare("INSERT INTO messages (id, personaId, role, text, timestamp, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
          .run(messageId, persona.id, 'user', message, new Date().toLocaleTimeString(), Date.now());
      }
    }

    const settingsKey = apiSettings?.apiKey?.trim();
    const envKey = process.env.GEMINI_API_KEY;
    const apiKey = settingsKey || envKey;

    if (!apiKey) {
      console.error("API Key is missing from both settings and environment.");
      console.log("Available environment keys:", Object.keys(process.env).filter(k => k.includes("KEY") || k.includes("API")));
      return res.status(400).json({ error: "API Key is missing. Please configure GEMINI_API_KEY in your environment or provide it in settings." });
    }

    const source = settingsKey ? "apiSettings" : "process.env.GEMINI_API_KEY";
    const maskedKey = apiKey.length > 8 ? `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}` : "****";
    
    console.log(`[API Key Debug] Source: ${source}`);
    console.log(`[API Key Debug] Masked Key: ${maskedKey}`);
    console.log(`[API Key Debug] Length: ${apiKey.length}`);

    const placeholders = ["YOUR_API_KEY", "MY_GEMINI_API_KEY", "undefined", "null", "PLACEHOLDER", "ENTER_KEY_HERE"];
    if (placeholders.includes(apiKey) || apiKey.includes("INSERT_") || apiKey.includes("YOUR_")) {
      console.error(`[API Key Debug] CRITICAL: API Key appears to be a placeholder: "${apiKey}"`);
      return res.status(400).json({ error: `Invalid API Key: The key provided ("${apiKey}") appears to be a placeholder. Please provide a real Gemini API key.` });
    }

    if (!apiKey.startsWith("AIza")) {
      console.warn(`[API Key Debug] WARNING: API Key does not start with "AIza". This is unusual for Google API keys.`);
    }

    try {
      const modelName = forceModel || apiSettings?.model || 'gemini-3-flash-preview';
      console.log(`[AI Request Debug] Model: ${modelName}`);
      
      const ai = new GoogleGenAI({ apiKey });
      const now = new Date();
      const timeString = now.toLocaleString('zh-CN');

      const fullSystemInstruction = [
        worldbook?.globalPrompt ? `【全局规则】\n${worldbook.globalPrompt}` : "",
        worldbook?.jailbreakPrompt ? `【破限协议】\n${worldbook.jailbreakPrompt}` : "",
        `【当前时间】${timeString}。`,
        persona?.instructions ? `【角色人设】\n${persona.instructions}` : "",
        persona?.prompt ? `【专属提示词】\n${persona.prompt}` : "",
        `【用户人设】\n${userProfile?.persona || '一个普通人'}`,
        `【回复规范】绝对锁定身份。拒绝客服腔。动作描写用括号包裹。严禁替用户说话。`,
        additionalSystemInstructions || ""
      ].filter(Boolean).join('\n\n');

      const contents = history.map((m: any) => ({
        role: m.role === 'model' || m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || m.text }]
      }));
      contents.push({ role: 'user', parts: [{ text: message }] });

      const response = await ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction: fullSystemInstruction,
          temperature: apiSettings?.temperature || 0.7,
        }
      });

      const responseText = response.text || "";
      const cleanedText = responseText.replace(/\[ID:\s*[^\]]+\]/gi, '').replace(/\|\|\|/g, '').trim();

      // Save AI response to DB
      if (persona?.id) {
        db.prepare("INSERT INTO messages (id, personaId, role, text, timestamp, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
          .run(Date.now().toString(), persona.id, 'model', cleanedText, new Date().toLocaleTimeString(), Date.now());
      }

      // Send Push Notification if subscriptionId is provided
      if (subscriptionId && process.env.ONESIGNAL_REST_API_KEY && process.env.ONESIGNAL_APP_ID) {
        console.log(`[Push Debug] Attempting to send push notification to subscriptionId: ${subscriptionId}`);
        try {
          const pushResponse = await fetch("https://onesignal.com/api/v1/notifications", {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Authorization": `Basic ${process.env.ONESIGNAL_REST_API_KEY}`
            },
            body: JSON.stringify({
              app_id: process.env.ONESIGNAL_APP_ID,
              include_subscription_ids: [subscriptionId],
              contents: { en: cleanedText, zh: cleanedText },
              headings: { en: persona?.name || "AI Chatbot", zh: persona?.name || "AI 聊天机器人" },
              data: { personaId: persona?.id }
            })
          });
          const pushResult: any = await pushResponse.json();
          console.log("[Push Debug] OneSignal response:", JSON.stringify(pushResult));
          if (pushResult.errors) {
            console.error("[Push Debug] OneSignal errors:", pushResult.errors);
          }
        } catch (pushError) {
          console.error("[Push Debug] Push notification fetch error:", pushError);
        }
      } else {
        console.log("[Push Debug] Skipping push notification.");
        if (!subscriptionId) console.log("[Push Debug] Reason: No subscriptionId provided.");
        if (!process.env.ONESIGNAL_REST_API_KEY) console.log("[Push Debug] Reason: ONESIGNAL_REST_API_KEY is missing.");
        if (!process.env.ONESIGNAL_APP_ID) console.log("[Push Debug] Reason: ONESIGNAL_APP_ID is missing.");
      }

      res.json({ responseText: cleanedText });
    } catch (error: any) {
      console.error("Server-side AI error:", error);
      res.status(500).json({ error: error.message || "Internal Server Error" });
    }
  });

  // --- Vite Middleware ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production: Serve static files from dist
    app.use(express.static("dist"));

    // SPA fallback: Serve index.html for any unknown routes (excluding API routes which are handled above)
    app.get("*", (req, res) => {
      res.sendFile("index.html", { root: "dist" });
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
