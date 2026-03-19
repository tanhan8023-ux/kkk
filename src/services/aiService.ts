import React from "react";
import { GoogleGenAI } from "@google/genai";
import { Persona, ApiSettings, WorldbookSettings, UserProfile } from "../types";
import { memoryService } from "./memoryService";

// 1. 生成歌词逻辑
export async function generateLyrics(
  title: string,
  artist: string,
  apiSettings: ApiSettings,
  worldbook: WorldbookSettings,
  userProfile: UserProfile,
  aiRef: React.MutableRefObject<GoogleGenAI | null>,
  forceModel?: string
): Promise<string> {
  try {
    let exactUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}`;
    if (artist && artist !== "未知艺术家") {
      exactUrl += `&artist_name=${encodeURIComponent(artist)}`;
    }
    const exactRes = await fetch(exactUrl);
    if (exactRes.ok) {
      const data = await exactRes.json();
      if (data && data.syncedLyrics) return data.syncedLyrics;
    }
    const searchQuery = artist && artist !== "未知艺术家" ? `${title} ${artist}` : title;
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(searchQuery)}`;
    const searchRes = await fetch(searchUrl);
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (Array.isArray(searchData) && searchData.length > 0) {
        const bestMatch = searchData.find((d: any) => d.syncedLyrics);
        if (bestMatch) return bestMatch.syncedLyrics;
      }
    }
  } catch (error) {
    console.error("LRCLIB API error:", error);
  }

  const artistText = artist && artist !== "未知艺术家" ? `，歌手为“${artist}”` : '';
  const prompt = `请在互联网上精准搜索歌曲《${title}》${artistText} 的歌词。要求返回 LRC 格式。`;
  
  const { responseText } = await fetchAiResponse(
    prompt, [], { id: 'lyrics_generator', name: 'Lyrics Generator', instructions: 'You are a lyrics generator.' } as any,
    apiSettings, worldbook, userProfile, aiRef, false, "", forceModel || "gemini-3-flash-preview",
    undefined, undefined, undefined, [{ googleSearch: {} }], true
  );
  
  return responseText || "[00:00.00] 抱歉，未找到该歌曲的歌词。";
}

// 2. 记忆提取逻辑
export async function extractAndSaveMemory(
  userMessage: string,
  aiResponse: string,
  aiRef: React.MutableRefObject<GoogleGenAI | null>,
  apiSettings: ApiSettings
): Promise<void> {
  const apiKey = apiSettings.apiKey?.trim() || process.env.GEMINI_API_KEY;
  if (!apiKey) return;
  const ai = new GoogleGenAI({ apiKey: apiKey as string });
  const prompt = `分析对话，提取用户偏好和上下文。请以 JSON 格式返回。`;
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `用户：${userMessage}\nAI：${aiResponse}\n${prompt}`,
      config: { responseMimeType: "application/json" }
    });
    if (response.text) {
      const { preference, context } = JSON.parse(response.text);
      if (preference || context) await memoryService.saveMemory(preference, context);
    }
  } catch (e) {}
}

// 3. 图片生成
export async function generateImage(prompt: string, providedApiKey: string): Promise<string> {
  let apiKey = providedApiKey?.trim() || process.env.GEMINI_API_KEY;
  if (!apiKey) return `https://api.dicebear.com/7.x/fun-emoji/svg?seed=${encodeURIComponent(prompt)}`;
  const ai = new GoogleGenAI({ apiKey });
  try {
    const imageResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: { parts: [{ text: prompt }] },
      config: { imageConfig: { aspectRatio: "1:1" } }
    });
    const part = imageResponse.candidates?.[0]?.content?.parts[0];
    if (part?.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
    throw new Error();
  } catch (e) {
    return `https://api.dicebear.com/7.x/fun-emoji/svg?seed=${encodeURIComponent(prompt)}`;
  }
}

// 4. 其他功能函数
export async function generatePersonaStatus(persona: Persona, apiSettings: ApiSettings, worldbook: WorldbookSettings, userProfile: UserProfile, aiRef: any) {
  const prompt = `写一段短状态。`;
  const { responseText } = await fetchAiResponse(prompt, [], persona, apiSettings, worldbook, userProfile, aiRef, false, "", undefined, undefined, undefined, undefined, undefined, true);
  return responseText;
}

export async function checkIfPersonaIsOffline(persona: Persona, apiSettings: ApiSettings, worldbook: WorldbookSettings, userProfile: UserProfile, aiRef: any, context: any[] = []) {
  const prompt = `判断在线或离线。`;
  const { responseText } = await fetchAiResponse(prompt, context, persona, apiSettings, worldbook, userProfile, aiRef, false, "", "gemini-3-flash-preview", undefined, undefined, undefined, undefined, true);
  return responseText.includes('离线');
}

export async function summarizeChat(messages: any[], persona: Persona, apiSettings: ApiSettings, worldbook: WorldbookSettings, userProfile: UserProfile, aiRef: any) {
  const prompt = `总结聊天记录。`;
  const { responseText } = await fetchAiResponse(prompt, messages, persona, apiSettings, worldbook, userProfile, aiRef, false, "", undefined, undefined, undefined, undefined, undefined, true);
  return responseText;
}

export async function generateUserRemark(persona: Persona, apiSettings: ApiSettings, worldbook: WorldbookSettings, userProfile: UserProfile, aiRef: any) {
  const prompt = `起个备注名。`;
  const { responseText } = await fetchAiResponse(prompt, [], persona, apiSettings, worldbook, userProfile, aiRef, false, "", undefined, undefined, undefined, undefined, undefined, true);
  return responseText.trim();
}

export async function generateDiaryEntry(persona: Persona, apiSettings: ApiSettings, worldbook: WorldbookSettings, userProfile: UserProfile, aiRef: any) {
  const prompt = `写日记。JSON输出。`;
  const { responseText } = await fetchAiResponse(prompt, [], persona, apiSettings, worldbook, userProfile, aiRef, false, "", undefined, undefined, undefined, undefined, undefined, true);
  try {
    return JSON.parse(responseText.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch (e) {
    return { title: "无题", content: responseText };
  }
}

export async function generateMoment(persona: Persona, apiSettings: ApiSettings, worldbook: WorldbookSettings) {
  const apiKey = apiSettings.apiKey?.trim() || process.env.GEMINI_API_KEY;
  const prompt = `发朋友圈，带[IMAGE: 画面]`;
  const ai = new GoogleGenAI({ apiKey: apiKey as string });
  const res = await ai.models.generateContent({ model: "gemini-3-flash-preview", contents: prompt });
  let content = res.text || "";
  let imageUrl;
  const imageMatch = content.match(/\[IMAGE:\s*([^\]]+)\]/i);
  if (imageMatch) {
    content = content.replace(imageMatch[0], "").trim();
    imageUrl = await generateImage(imageMatch[1], apiKey as string);
  }
  return { content, imageUrl };
}

export async function generateXHSPost(apiSettings: ApiSettings, worldbook: WorldbookSettings, userProfile: UserProfile, aiRef: any) {
  const prompt = `生成小红书。`;
  const { responseText } = await fetchAiResponse(prompt, [], { id: 'xhs' } as any, apiSettings, worldbook, userProfile, aiRef, false, "", undefined, undefined, undefined, undefined, undefined, true);
  const data = JSON.parse(responseText.match(/\{[\s\S]*\}/)?.[0] || "{}");
  const [mainImg, avatarImg] = await Promise.all([generateImage(data.imagePrompt, apiSettings.apiKey), generateImage(data.authorAvatarPrompt, apiSettings.apiKey)]);
  return { title: data.title, content: data.content, images: [mainImg], authorName: data.authorName, authorAvatar: avatarImg };
}

async function describeImage(imageUrl: string, apiKey: string) {
  const ai = new GoogleGenAI({ apiKey });
  const mimeType = imageUrl.match(/data:(image\/[^;]+);base64,/)?.[1];
  if (!mimeType) return null;
  const res = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{ role: "user", parts: [{ text: "客观描述图片内容" }, { inlineData: { mimeType, data: imageUrl.split(',')[1] } }] }]
  });
  return res.text?.trim() || null;
}

export async function transcribeAudio(audioBase64: string, mimeType: string, apiSettings: ApiSettings, aiRef: any) {
  const apiKey = apiSettings.apiKey?.trim() || process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({ apiKey: apiKey as string });
  const res = await ai.models.generateContent({ model: "gemini-3-flash-preview", contents: { parts: [{ inlineData: { mimeType, data: audioBase64 } }, { text: "提取歌词" }] } });
  return res.text || "失败";
}

// 5. 核心对话接口 (整合修复后的逻辑)
export async function fetchAiResponse(
  promptText: string, 
  contextMessages: any[] = [], 
  persona: Persona,
  apiSettings: ApiSettings,
  worldbook: WorldbookSettings,
  userProfile: UserProfile,
  aiRef: React.MutableRefObject<GoogleGenAI | null>,
  enableQuote: boolean = true,
  additionalSystemInstructions: string = "",
  forceModel?: string,
  customApiSettings?: Partial<ApiSettings>,
  isOffline?: boolean,
  imageUrl?: string,
  tools?: any[],
  isSystemTask: boolean = false,
  disableActions: boolean = false
) {
  const effectiveApiSettings = { ...apiSettings, ...customApiSettings };
  const apiKey = effectiveApiSettings.apiKey?.trim() || process.env.GEMINI_API_KEY;
  
  // 视觉感知预处理
  let imageDescription: string | null = null;
  if (imageUrl && imageUrl.startsWith('data:image')) {
    imageDescription = await describeImage(imageUrl, apiKey as string);
    if (imageDescription) {
      promptText = `【视觉感知报告】\n用户刚刚发了一张照片，内容描述：\n"${imageDescription}"\n\n${promptText}`;
    }
  }

  const now = new Date();
  const timeString = now.toLocaleString('zh-CN');
  const memories = await memoryService.getMemories();

  // 构建完整的系统指令
  const fullSystemInstruction = [
    worldbook.globalPrompt ? `【全局规则】\n${worldbook.globalPrompt}` : "",
    worldbook.jailbreakPrompt ? `【破限协议】\n${worldbook.jailbreakPrompt}` : "",
    `【当前时间】${timeString}。`,
    isOffline ? `【离线模式】回复必须以“[自动回复] ”开头。` : "【在线模式】",
    persona.instructions ? `【角色人设】\n${persona.instructions}` : "",
    persona.prompt ? `【专属提示词】\n${persona.prompt}` : "",
    `【用户人设】\n${userProfile.persona || '一个普通人'}`,
    `【回复规范】绝对锁定身份。拒绝客服腔。动作描写用括号包裹。严禁替用户说话。`,
    additionalSystemInstructions,
    disableActions ? "【严禁动作描写】只输出对话文字。" : ""
  ].filter(Boolean).join('\n\n');

  const ai = new GoogleGenAI({ apiKey: apiKey as string });
  const contents = contextMessages.map(m => ({
    role: m.role === 'model' || m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content || m.text }]
  }));
  
  // 处理当前输入
  const currentParts: any[] = [];
  if (imageUrl && !effectiveApiSettings.apiUrl) {
    const mimeMatch = imageUrl.match(/data:(image\/[^;]+);base64,/);
    if (mimeMatch) currentParts.push({ inlineData: { mimeType: mimeMatch[1], data: imageUrl.split(',')[1] } });
  }
  currentParts.push({ text: promptText });
  contents.push({ role: 'user', parts: currentParts });

  try {
    const response = await ai.models.generateContent({
      model: forceModel || effectiveApiSettings.model || 'gemini-3-flash-preview',
      contents: contents,
      config: {
        systemInstruction: fullSystemInstruction,
        temperature: effectiveApiSettings.temperature,
      }
    });

    const text = response.text || "...";
    if (!isSystemTask) await extractAndSaveMemory(promptText, text, aiRef, effectiveApiSettings);
    
    return { responseText: processAiResponse(text), imageDescription };
  } catch (error: any) {
    throw error;
  }
}

export function processAiResponse(responseText: string) {
  return responseText.replace(/\[ID:\s*[^\]]+\]/gi, '').replace(/\|\|\|/g, '').trim();
}