import {Hono} from "hono";
import {AudioFormat, ElevenLabsClient, RealtimeEvents} from "@elevenlabs/elevenlabs-js";
import {AzureOpenAI} from "openai";
import prisma from "../db";
import {authMiddleware} from "../middleware/auth";
import {uploadAudioToR2} from "../lib/r2";
import {verifyToken} from "../utils/jwt";
import {CommitStrategy} from "@elevenlabs/client";

type Variables = {
  userId: string;
};

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const SAMPLE_RATE = 16000;

const AZURE_ENDPOINT = process.env.AZURE_ENDPOINT;
const AZURE_API_KEY = process.env.AZURE_API_KEY;
const AZURE_API_VERSION = process.env.AZURE_API_VERSION ?? "2023-07-01-preview";
const AZURE_DEPLOYMENT = process.env.AZURE_DEPLOYMENT_NAME ?? "gpt-4";

const elevenlabsClient = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const azureClient = new AzureOpenAI({
  apiVersion: AZURE_API_VERSION,
  endpoint: AZURE_ENDPOINT,
  apiKey: AZURE_API_KEY,
});

const CORRECTION_PROMPT = `You are a "Real-time Text Normalization Editor".

Rules (in order of priority):
1) Never change meaning/context. Minimize sentence rewriting (only correct what's necessary).
2) Convert phonetic spellings of technical terms to their proper original form (English, official capitalization). (Highest priority)
   Examples: "api" -> "API", "react" -> "React", "javascript" -> "JavaScript", 
             "docker" -> "Docker", "typescript" -> "TypeScript", "github" -> "GitHub",
             "node" -> "Node", "db" -> "DB", "ui" -> "UI", "server" -> "server"
3) Only naturally correct typos/spelling/spacing/misrecognized speech.
4) Keep code blocks, \`inline code\`, URLs, file paths, keys/IDs, numbers/units as-is (except obvious typos).

Output: Only the corrected text. No explanations/comments/summaries.`;

const SUMMARY_PROMPT = `You are a "Text Summarization Expert".

Rules:
1) Summarize the key content of the given text in a maximum of 4 sentences.
2) Each sentence should be concise and clear, without being excessively long.
3) Maintain important keywords and context.
4) Output only the summary. No additional explanations or comments.

Output: Only the summarized text (maximum 4 sentences).`;

const TITLE_PROMPT = `You are a "Title Generation Expert".

Rules:
1) Identify the core topic of the given text and generate a concise title.
2) The title should be within 50 characters maximum.
3) Be specific and clear, but not excessively long.
4) Output only the title. No additional explanations or comments.

Output: Only the title.`;

async function normalizeTextWithGpt(text: string): Promise<string> {
  try {
    console.log(`🤖 [GPT] Normalizing text: ${text.substring(0, 50)}...`);
    const response = await azureClient.chat.completions.create({
      messages: [
        { role: "system", content: CORRECTION_PROMPT },
        { role: "user", content: text },
      ],
      max_completion_tokens: 1000,
      temperature: 0.3,
      top_p: 1.0,
      model: AZURE_DEPLOYMENT,
    });
    const normalized = response.choices[0]?.message?.content?.trim() ?? text;
    console.log(`✅ [GPT] Normalized: ${normalized}`);
    return normalized;
  } catch (e) {
    console.error("❌ [GPT] Error:", e);
    return text;
  }
}

async function summarizeTextWithGpt(text: string): Promise<string> {
  try {
    console.log(`🤖 [GPT] Summarizing text: ${text.substring(0, 50)}...`);
    const response = await azureClient.chat.completions.create({
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: text },
      ],
      max_completion_tokens: 300,
      temperature: 0.5,
      top_p: 1.0,
      model: AZURE_DEPLOYMENT,
    });
    const summary = response.choices[0]?.message?.content?.trim() ?? '';
    console.log(`✅ [GPT] Summary: ${summary}`);
    return summary;
  } catch (e) {
    console.error("❌ [GPT] Summary Error:", e);
    return '';
  }
}

async function generateTitleWithGpt(text: string): Promise<string> {
  try {
    console.log(`🤖 [GPT] Generating title: ${text.substring(0, 50)}...`);
    const response = await azureClient.chat.completions.create({
      messages: [
        { role: "system", content: TITLE_PROMPT },
        { role: "user", content: text },
      ],
      max_completion_tokens: 100,
      temperature: 0.5,
      top_p: 1.0,
      model: AZURE_DEPLOYMENT,
    });
    const title = response.choices[0]?.message?.content?.trim() ?? '';
    console.log(`✅ [GPT] Title: ${title}`);
    return title;
  } catch (e) {
    console.error("❌ [GPT] Title Error:", e);
    return '';
  }
}

function preprocessTextWithVocabulary(text: string, pronunciationMap: Map<string, string>, synonymMap: Map<string, string>): string {
  if (pronunciationMap.size === 0 && synonymMap.size === 0) return text;
  
  let processed = text;
  
  const sortedPronunciations = Array.from(pronunciationMap.entries())
    .sort((a, b) => b[0].length - a[0].length);
  
  for (const [phonetic, original] of sortedPronunciations) {
    const regex = new RegExp(phonetic, 'gi');
    processed = processed.replace(regex, original);
  }
  
  const sortedSynonyms = Array.from(synonymMap.entries())
    .sort((a, b) => b[0].length - a[0].length);
  
  for (const [synonym, original] of sortedSynonyms) {
    const escapedSynonym = synonym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedSynonym}\\b`, 'gi');
    processed = processed.replace(regex, original);
  }
  
  return processed;
}

interface RecordingSession {
  sessionId: string;
  noteId: string;
  userId: string;
  audioChunks: Buffer[];
  startTime: number;
  sttConnection: any; // ElevenLabs realtime STT connection
  transcriptText: string;
  languageCode: string;
  keywordPack?: { name: string; description: string; koreanPronunciation?: string; synonyms?: string[] }[];
  keywordDetectionEnabled: boolean;
  externalResources?: Array<{ id: string; title: string; displayUrl: string; scrapedContent: string }>;
  resourceHintsEnabled: boolean;
  pronunciationMap: Map<string, string>;
  synonymMap: Map<string, string>;
}

export const activeSessions = new Map<string, RecordingSession>();

export function createRecordingWebSocketHandler(upgradeWebSocket: any) {
  const recordingRouter = new Hono<{ Variables: Variables }>();

  // POST /session - 새 녹음 세션 생성
  recordingRouter.post("/session", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const { title, languageCode, keywordPackIds, externalResourceIds } = await c.req.json();

    const language = languageCode || "en";

    console.log(`📝 [SESSION] Creating session for user: ${userId}`);
    console.log(`📝 [SESSION] Title: ${title}`);
    console.log(`📝 [SESSION] Language: ${language}`);
    console.log(`📝 [SESSION] KeywordPack IDs: ${keywordPackIds}`);
    console.log(`📝 [SESSION] ExternalResource IDs: ${externalResourceIds}`);

    const note = await prisma.note.create({
      data: {
        title: title || "Untitled Recording",
        authorId: userId,
        recordingStatus: "recording",
        durationInSeconds: 0,
        content: JSON.stringify({ languageCode: language }),
        keywordPackIds: keywordPackIds || [],
        externalResourceIds: externalResourceIds || [],
      },
    });

    console.log(`✅ [SESSION] Session created: ${note.id}`);

    return c.json({
      sessionId: note.id,
      noteId: note.id,
      message: "Session created. Connect to WebSocket to start recording.",
    });
  });

  recordingRouter.post("/session/stop", authMiddleware, async (c) => {
    const userId = c.get("userId");
    
    console.log(`🛑 [STOP] Stop request from user: ${userId}`);
    const { sessionId } = await c.req.json();

    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      return c.json({ error: "Session not found or already stopped" }, 404);
    }

    if (session.userId !== userId) {
      return c.json({ error: "Access denied" }, 403);
    }

    try {
      const result = await finalizeRecording(sessionId);
      return c.json(result);
    } catch (e: any) {
      console.error(`❌ [${sessionId}] Stop error:`, e);
      return c.json({ error: e.message || "Failed to stop recording" }, 500);
    }
  });

  recordingRouter.post("/session/cancel", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const { sessionId } = await c.req.json();

    if (!sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }

    const session = activeSessions.get(sessionId);

    const note = await prisma.note.findUnique({
      where: { id: sessionId },
    });

    if (!note) {
      return c.json({ error: "Session not found" }, 404);
    }

    if (note.authorId !== userId) {
      return c.json({ error: "Access denied" }, 403);
    }

    try {
      if (session && session.sttConnection) {
        session.sttConnection.close();
      }
      
      if (session) {
        activeSessions.delete(sessionId);
        console.log(`🗑️ [${sessionId}] Session cancelled and removed`);
      }

      // DB에서 Note 삭제
      await prisma.note.delete({
        where: { id: sessionId },
      });

      console.log(`✅ [${sessionId}] Recording cancelled and deleted`);

      return c.json({
        message: "Recording cancelled and deleted successfully",
        sessionId,
      });
    } catch (e: any) {
      console.error(`❌ [${sessionId}] Cancel error:`, e);
      return c.json({ error: e.message || "Failed to cancel recording" }, 500);
    }
  });

  recordingRouter.get(
    "/session/:sessionId",
    upgradeWebSocket((c: any) => {
      const sessionId = c.req.param("sessionId");

      const authHeader = c.req.header("Authorization");
      let token = c.req.query("token");
      
      console.log(`📡 [${sessionId}] WebSocket upgrade request`);
      console.log(`🔑 [${sessionId}] Auth header: ${authHeader}`);
      console.log(`🔑 [${sessionId}] Query token: ${token}`);

      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7);
        console.log(`✅ [${sessionId}] Token from header: ${token}`);
      } else if (token) {
        console.log(`✅ [${sessionId}] Token from query: ${token}`);
      }

      return {
        async onOpen(_event: any, ws: any) {
          console.log(`📡 [${sessionId}] WebSocket connected`);

          if (!token) {
            console.log(`❌ [${sessionId}] No token provided`);
            ws.send(JSON.stringify({ error: "Unauthorized: No token" }));
            ws.close();
            return;
          }

          const payload = verifyToken(token);
          if (!payload) {
            console.log(`❌ [${sessionId}] Invalid token`);
            ws.send(JSON.stringify({ error: "Unauthorized: Invalid token" }));
            ws.close();
            return;
          }

          const userId = payload.userId;
          console.log(`✅ [${sessionId}] Authenticated user: ${userId}`);

          let session: RecordingSession | undefined = activeSessions.get(sessionId);

          if (!session) {
            const note = await prisma.note.findUnique({
              where: { id: sessionId },
            });

            if (!note) {
              console.log(`❌ [${sessionId}] Note not found`);
              ws.send(JSON.stringify({ error: "Session not found" }));
              ws.close();
              return;
            }

            if (note.authorId !== userId) {
              console.log(`❌ [${sessionId}] User ${userId} does not own note (owner: ${note.authorId})`);
              ws.send(JSON.stringify({ error: "Access denied" }));
              ws.close();
              return;
            }

            console.log(`✅ [${sessionId}] Access granted for user ${userId}`);

            // Load KeywordPacks if attached to the note
            let keywordPackData: { name: string; description: string; koreanPronunciation?: string; synonyms?: string[] }[] = [];
            const pronunciationMap = new Map<string, string>();
            const synonymMap = new Map<string, string>();
            
            if (note.keywordPackIds && Array.isArray(note.keywordPackIds) && note.keywordPackIds.length > 0) {
              console.log(`📚 [${sessionId}] Loading ${note.keywordPackIds.length} KeywordPacks`);
              
              const keywordPacks = await prisma.keywordPack.findMany({
                where: { id: { in: note.keywordPackIds } },
              });
              
              keywordPacks.forEach(pack => {
                if (Array.isArray(pack.keywords)) {
                  const keywords = pack.keywords as { name: string; description: string; koreanPronunciation?: string; synonyms?: string[] }[];
                  keywordPackData.push(...keywords);
                  
                  // Build pronunciation map and synonym map for preprocessing
                  keywords.forEach(keyword => {
                    // Add Korean pronunciation mapping
                    if (keyword.koreanPronunciation && keyword.koreanPronunciation.trim()) {
                      pronunciationMap.set(keyword.koreanPronunciation, keyword.name);
                    }
                    
                    // Add synonym mappings
                    if (keyword.synonyms && Array.isArray(keyword.synonyms)) {
                      keyword.synonyms.forEach(synonym => {
                        if (synonym && synonym.trim() && synonym !== keyword.name) {
                          synonymMap.set(synonym, keyword.name);
                        }
                      });
                    }
                  });
                }
              });
              
              console.log(`✅ [${sessionId}] Loaded ${keywordPackData.length} total keywords from ${keywordPacks.length} packs`);
              console.log(`✅ [${sessionId}] Built pronunciation map with ${pronunciationMap.size} entries`);
              console.log(`✅ [${sessionId}] Built synonym map with ${synonymMap.size} entries`);
            }

            // Load ExternalResources if attached to the note
            let externalResourcesData: Array<{ id: string; title: string; displayUrl: string; scrapedContent: string }> = [];
            if (note.externalResourceIds && Array.isArray(note.externalResourceIds) && note.externalResourceIds.length > 0) {
              console.log(`📚 [${sessionId}] Loading ${note.externalResourceIds.length} ExternalResources`);
              
              const resources = await prisma.externalResource.findMany({
                where: { id: { in: note.externalResourceIds } },
                select: {
                  id: true,
                  title: true,
                  displayUrl: true,
                  scrapedContent: true,
                },
              });
              
              externalResourcesData = resources.map(r => ({
                id: r.id,
                title: r.title,
                displayUrl: r.displayUrl,
                scrapedContent: r.scrapedContent || '',
              }));
              
              console.log(`✅ [${sessionId}] Loaded ${externalResourcesData.length} external resources`);
            }

            let languageCode = "en";
            try {
              const contentData = note.content ? JSON.parse(note.content) : {};
              languageCode = contentData.languageCode || "en";
            } catch (e) {
              console.warn(`⚠️ [${sessionId}] Failed to parse content, using default language: en`);
            }

            console.log(`🎙️ [${sessionId}] Connecting to ElevenLabs STT...`);
            console.log(`   Model: scribe_v2_realtime`);
            console.log(`   Language: ${languageCode}`);
            console.log(`   Sample Rate: ${SAMPLE_RATE}`);
            
            const sttConnection =
              await elevenlabsClient.speechToText.realtime.connect({
                modelId: "scribe_v2_realtime",
                languageCode: languageCode,
                sampleRate: SAMPLE_RATE,
                audioFormat: AudioFormat.PCM_16000,
                commitStrategy: CommitStrategy.VAD,
                vadSilenceThresholdSecs: 1.0,
                vadThreshold: 0.3,
              });

            console.log(`✅ [${sessionId}] ElevenLabs STT connected`);
            console.log(`   VAD Commit: enabled (1.0s silence threshold)`);

            console.log(`🔍 [${sessionId}] Testing STT connection...`);

            session = {
              sessionId,
              noteId: note.id,
              userId: note.authorId,
              audioChunks: [],
              startTime: Date.now(),
              sttConnection,
              transcriptText: "",
              languageCode: languageCode,
              keywordPack: keywordPackData,
              keywordDetectionEnabled: keywordPackData.length > 0,
              externalResources: externalResourcesData,
              resourceHintsEnabled: externalResourcesData.length > 0,
              pronunciationMap: pronunciationMap,
              synonymMap: synonymMap,
            };

              if (session) {
                  activeSessions.set(sessionId, <RecordingSession>session);
              }

            console.log(`📡 [${sessionId}] Setting up STT event listeners...`);
            
            sttConnection.on(
              RealtimeEvents.PARTIAL_TRANSCRIPT,
              (data: { text: string }) => {
                const text = data.text ?? "";
                
                if (text && text.trim().length > 0) {
                  console.log(`📝 [${sessionId}] PARTIAL: "${text}"`);
                  ws.send(JSON.stringify({ type: "partial", text }));
                } else {
                  console.log(`⚠️  [${sessionId}] Empty PARTIAL (ignoring)`);
                }
              }
            );

            sttConnection.on(
              RealtimeEvents.COMMITTED_TRANSCRIPT,
              async (data: { text: string }) => {
                const rawText = data.text ?? "";
                
                if (rawText && rawText.trim().length > 0) {
                  console.log(`✅ [${sessionId}] COMMITTED (raw): "${rawText}"`);
                  
                  // Preprocess text with vocabulary and synonym maps
                  const preprocessedText = preprocessTextWithVocabulary(rawText, session!.pronunciationMap, session!.synonymMap);
                  
                  if (preprocessedText !== rawText) {
                    console.log(`🔄 [${sessionId}] PREPROCESSED: "${preprocessedText}"`);
                  }
                  
                  session!.transcriptText += preprocessedText + " ";
                  ws.send(JSON.stringify({ type: "committed", text: preprocessedText }));

                  // Check for keywords in the transcribed text
                  if (session!.keywordDetectionEnabled && session!.keywordPack && session!.keywordPack.length > 0) {
                    const detectedKeywords: { name: string; description: string }[] = [];
                    const detectedKeywordNames = new Set<string>(); // Prevent duplicates
                    
                    session!.keywordPack.forEach(keyword => {
                      const textLower = preprocessedText.toLowerCase();
                      let isDetected = false;
                      
                      // 1. Check main keyword name
                      const keywordLower = keyword.name.toLowerCase();
                      const keywordRegex = new RegExp(`\\b${keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                      if (keywordRegex.test(textLower)) {
                        isDetected = true;
                      }
                      
                      // 2. Check synonyms
                      if (!isDetected && keyword.synonyms && Array.isArray(keyword.synonyms)) {
                        for (const synonym of keyword.synonyms) {
                          const synonymLower = synonym.toLowerCase();
                          const synonymRegex = new RegExp(`\\b${synonymLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                          if (synonymRegex.test(textLower)) {
                            isDetected = true;
                            console.log(`🔍 [${sessionId}] Keyword detected via synonym: "${keyword.name}" (matched: "${synonym}")`);
                            break;
                          }
                        }
                      }
                      
                      // Add to detected list if found and not already added
                      if (isDetected && !detectedKeywordNames.has(keyword.name)) {
                        detectedKeywords.push(keyword);
                        detectedKeywordNames.add(keyword.name);
                        console.log(`🔍 [${sessionId}] Keyword detected: "${keyword.name}"`);
                      }
                    });

                    // Send detected keywords to client
                    if (detectedKeywords.length > 0) {
                      ws.send(JSON.stringify({ 
                        type: "keywords", 
                        keywords: detectedKeywords 
                      }));
                    }
                  }

                  // Check for hints from external resources
                  if (session!.resourceHintsEnabled && session!.externalResources && session!.externalResources.length > 0) {
                    const hints: Array<{ resourceId: string; resourceTitle: string; hint: string; sourceUrl: string }> = [];
                    
                    for (const resource of session!.externalResources) {
                      // Search for relevant content in scraped data
                      const textLower = preprocessedText.toLowerCase();
                      const contentLines = resource.scrapedContent.split('\n').filter(line => line.trim());
                      
                      // Find lines that might be relevant (simple keyword matching)
                      const words = textLower.split(/\s+/).filter(w => w.length > 2);
                      
                      for (const line of contentLines) {
                        const lineLower = line.toLowerCase();
                        let matchCount = 0;
                        
                        for (const word of words) {
                          if (lineLower.includes(word)) {
                            matchCount++;
                          }
                        }
                        
                        // If multiple words match, consider it a hint
                        if (matchCount >= 2 && line.length > 20 && line.length < 200) {
                          hints.push({
                            resourceId: resource.id,
                            resourceTitle: resource.title,
                            hint: line.trim(),
                            sourceUrl: resource.displayUrl,
                          });
                          
                          console.log(`💡 [${sessionId}] Hint found from "${resource.title}"`);
                          break; // Only one hint per resource per transcript
                        }
                      }
                    }

                    // Send hints to client
                    if (hints.length > 0) {
                      ws.send(JSON.stringify({ 
                        type: "hints", 
                        hints 
                      }));
                    }
                  }

                  normalizeTextWithGpt(preprocessedText).then((formattedText) => {
                    console.log(`✨ [${sessionId}] FORMATTED: "${formattedText}"`);
                    ws.send(JSON.stringify({ type: "formatted", text: formattedText }));
                  }).catch((e) => {
                    console.error(`❌ [${sessionId}] GPT formatting failed:`, e);
                  });
                } else {
                  console.log(`⚠️  [${sessionId}] Empty COMMITTED (ignoring)`);
                }
              }
            );

            sttConnection.on(RealtimeEvents.ERROR, (error: any) => {
              console.error(`❌ [${sessionId}] STT ERROR:`, error);
              ws.send(JSON.stringify({ type: "error", error: String(error) }));
            });

            sttConnection.on(RealtimeEvents.OPEN, () => {
              console.log(`✅ [${sessionId}] STT Connection READY`);
            });
            
            sttConnection.on(RealtimeEvents.CLOSE, () => {
              console.log(`🔌 [${sessionId}] STT Connection CLOSED`);
            });

            console.log(`📡 [${sessionId}] Event listeners registered`);
            console.log(`🎙️ [${sessionId}] Recording session started (VAD: 1.0s threshold)`);
          } else {
            console.log(`🔄 [${sessionId}] Reconnected to existing session`);
          }

          ws.send(
            JSON.stringify({
              type: "ready",
              sessionId,
              message: "Ready to record",
            })
          );
        },

        async onMessage(event: any, ws: any) {
          const session = activeSessions.get(sessionId);
          if (!session) {
            ws.send(JSON.stringify({ error: "Session not found" }));
            return;
          }

          try {
            const data = JSON.parse(event.data.toString());


            if (data.action === "keyword.control") {
              if (data.data === "off") {
                session.keywordDetectionEnabled = false;
                console.log(`🔕 [${sessionId}] Keyword detection disabled`);
                ws.send(JSON.stringify({ type: "keyword.status", enabled: false }));
              } else if (data.data === "on") {
                session.keywordDetectionEnabled = true;
                console.log(`🔔 [${sessionId}] Keyword detection enabled`);
                ws.send(JSON.stringify({ type: "keyword.status", enabled: true }));
              }
              return;
            }


            if (data.action === "hints.control") {
              if (data.data === "off") {
                session.resourceHintsEnabled = false;
                console.log(`🔕 [${sessionId}] Resource hints disabled`);
                ws.send(JSON.stringify({ type: "hints.status", enabled: false }));
              } else if (data.data === "on") {
                session.resourceHintsEnabled = true;
                console.log(`🔔 [${sessionId}] Resource hints enabled`);
                ws.send(JSON.stringify({ type: "hints.status", enabled: true }));
              }
              return;
            }

            if (data.audio) {
              const audioBuffer = Buffer.from(data.audio, "base64");
              session.audioChunks.push(audioBuffer);

              if (session.sttConnection) {
                try {
                  session.sttConnection.send({
                    audioBase64: data.audio,
                  });

                  if (session.audioChunks.length % 100 === 0) {
                    console.log(`🟢 [${sessionId}] Sent ${session.audioChunks.length} audio chunks to ElevenLabs`);
                  }
                } catch (e) {
                  console.error(`❌ [${sessionId}] Failed to send audio to ElevenLabs:`, e);
                }
              } else {
                console.error(`❌ [${sessionId}] STT connection is null!`);
              }
            }
          } catch (e) {
            console.error(`❌ [${sessionId}] Message error:`, e);
            ws.send(
              JSON.stringify({ type: "error", error: "Invalid message format" })
            );
          }
        },

        async onClose() {
          console.log(`🔌 [${sessionId}] WebSocket disconnected`);
        },

        onError(event: any) {
          console.error(`❌ [${sessionId}] WebSocket error:`, event);
        },
      };
    })
  );

  recordingRouter.get("/record/:noteId", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const noteId = c.req.param("noteId");

    const note = await prisma.note.findUnique({
      where: { id: noteId },
    });

    if (!note) {
      return c.json({ error: "Note not found" }, 404);
    }

    if (!note.isPublic && note.authorId !== userId) {
      return c.json({ error: "Access denied" }, 403);
    }

    if (!note.recordingUrl) {
      return c.json({ error: "Recording not available" }, 404);
    }

    return c.json({
      recordingUrl: note.recordingUrl,
      durationInSeconds: note.durationInSeconds,
    });
  });

  return recordingRouter;
}


async function finalizeRecording(sessionId: string) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  console.log(`🛑 [${sessionId}] Finalizing recording...`);

  try {
    const totalAudioBuffer = Buffer.concat(session.audioChunks);
    const durationInSeconds = Math.floor(
      (Date.now() - session.startTime) / 1000
    );

    const wavBuffer = createWavBuffer(totalAudioBuffer, SAMPLE_RATE);
    console.log(`📁 [${sessionId}] WAV file created: ${wavBuffer.length} bytes`);

    const r2Key = `recordings/${session.noteId}.wav`;
    const recordingUrl = await uploadAudioToR2(r2Key, wavBuffer, "audio/wav");
    console.log(`✅ [${sessionId}] Uploaded to R2: ${recordingUrl}`);

    console.log(`🎙️ [${sessionId}] Calling ElevenLabs STT API...`);
    
    const languageCode = session.languageCode || 'en';
    
    const formData = new FormData();

      formData.append("cloud_storage_url", recordingUrl);
    formData.append('model_id', 'scribe_v2');
    formData.append('language_code', languageCode);
    formData.append('diarize', 'true');

    const sttResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY!,
      },
      body: formData,
    });

    if (!sttResponse.ok) {
      const errorText = await sttResponse.text();
      throw new Error(`ElevenLabs STT API error: ${errorText}`);
    }

    const sttResult = await sttResponse.json();
    console.log(`✅ [${sessionId}] STT completed`);
    console.log(`   Text: ${sttResult.text?.substring(0, 100)}...`);
    console.log(`   Words: ${sttResult.words?.length || 0}`);

    let formattedText = sttResult.text || '';
    if (formattedText.trim()) {
      console.log(`🤖 [${sessionId}] Formatting with GPT...`);
      try {
        formattedText = await normalizeTextWithGpt(formattedText);
        console.log(`✅ [${sessionId}] GPT formatting complete`);
      } catch (e) {
        console.error(`⚠️ [${sessionId}] GPT formatting failed, using original:`, e);
      }
    }

    let aiSummary = '';
    if (formattedText.trim()) {
      console.log(`🤖 [${sessionId}] Generating summary with GPT...`);
      try {
        aiSummary = await summarizeTextWithGpt(formattedText);
        console.log(`✅ [${sessionId}] GPT summary complete`);
      } catch (e) {
        console.error(`⚠️ [${sessionId}] GPT summary failed:`, e);
      }
    }

    let generatedTitle = '';
    if (formattedText.trim()) {
      console.log(`🤖 [${sessionId}] Generating title with GPT...`);
      try {
        generatedTitle = await generateTitleWithGpt(formattedText);
        console.log(`✅ [${sessionId}] GPT title complete`);
      } catch (e) {
        console.error(`⚠️ [${sessionId}] GPT title generation failed:`, e);
      }
    }

    const contentJson = {
      language_code: sttResult.language_code || 'en',
      language_probability: sttResult.language_probability || 0.0,
      text: sttResult.text || '',
      formatted_text: formattedText,
      words: sttResult.words || [],
      duration_seconds: durationInSeconds,
      sample_rate: SAMPLE_RATE,
      transcribed_at: new Date().toISOString(),
    };

    const speakerIds = new Set<string>();
    if (sttResult.words) {
      sttResult.words.forEach((word: any) => {
        if (word.speaker_id) {
          speakerIds.add(word.speaker_id);
        }
      });
    }

    const speakers = Array.from(speakerIds)
      .sort()
      .map((speaker_id, index) => ({
        speaker_id,
        speaker_name: `Speaker ${index + 1}`,
      }));

    console.log(`👥 [${sessionId}] Detected ${speakers.length} speakers`);

    await prisma.note.update({
      where: { id: session.noteId },
      data: {
        title: generatedTitle || undefined,
        recordingUrl,
        durationInSeconds,
        recordingStatus: "completed",
        content: JSON.stringify(contentJson, null, 2),
        aiSummary: aiSummary || null,
        speakers: speakers.length > 0 ? JSON.parse(JSON.stringify(speakers)) : null,
        lastUpdated: new Date(),
      },
    });

    console.log(`✅ [${sessionId}] Recording finalized and saved to DB`);

    const speakerSummary: Record<string, { text: string; wordCount: number }> = {};
    if (sttResult.words) {
      sttResult.words.forEach((word: any) => {
        const speakerId = word.speaker_id || 'unknown';
        if (!speakerSummary[speakerId]) {
          speakerSummary[speakerId] = { text: '', wordCount: 0 };
        }
        speakerSummary[speakerId].text += word.text + ' ';
        speakerSummary[speakerId].wordCount++;
      });
    }

    const result = {
      message: "Recording completed and transcribed successfully",
      recordingUrl,
      durationInSeconds,
      transcript: {
        text: sttResult.text || '',
        formatted: formattedText,
        language: sttResult.language_code || 'en',
        language_probability: sttResult.language_probability || 0.0,
        word_count: sttResult.words?.length || 0,
      },
      speakers: Object.entries(speakerSummary).map(([speakerId, data]) => ({
        speaker_id: speakerId,
        text: data.text.trim(),
        word_count: data.wordCount,
      })),
    };

    activeSessions.delete(sessionId);

    return result;
  } catch (e) {
    console.error(`❌ [${sessionId}] Finalization error:`, e);

    await prisma.note.update({
      where: { id: session.noteId },
      data: {
        recordingStatus: "failed",
      },
    });

    throw e;
  }
}

function createWavBuffer(audioData: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = audioData.length;

  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, audioData]);
}

export default createRecordingWebSocketHandler;
