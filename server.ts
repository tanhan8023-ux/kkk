import express from "express";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));
  
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // --- API Routes ---
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
      forceModel
    } = req.body;

    const apiKey = apiSettings?.apiKey?.trim() || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: "API Key is missing" });
    }

    try {
      const ai = new GoogleGenAI({ apiKey });
      const modelName = forceModel || apiSettings?.model || 'gemini-3-flash-preview';
      
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

      // Send Push Notification if subscriptionId is provided
      if (subscriptionId && process.env.ONESIGNAL_REST_API_KEY && process.env.ONESIGNAL_APP_ID) {
        console.log(`Attempting to send push notification to ${subscriptionId}`);
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
          const pushResult = await pushResponse.json();
          console.log("OneSignal response:", pushResult);
        } catch (pushError) {
          console.error("Push notification error:", pushError);
        }
      } else {
        if (!subscriptionId) console.log("No subscriptionId provided for push.");
        if (!process.env.ONESIGNAL_REST_API_KEY) console.log("ONESIGNAL_REST_API_KEY is missing.");
        if (!process.env.ONESIGNAL_APP_ID) console.log("ONESIGNAL_APP_ID is missing.");
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
