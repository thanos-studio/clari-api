import {Hono} from "hono";
import {AudioFormat, CommitStrategy, ElevenLabsClient, RealtimeEvents,} from "@elevenlabs/elevenlabs-js";
import {AzureOpenAI} from "openai";
import prisma from "../db";
import {authMiddleware} from "../middleware/auth";
import {uploadAudioToR2} from "../lib/r2";
import {verifyToken} from "../utils/jwt";

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

const CORRECTION_PROMPT = `너는 "실시간 텍스트 정규화 편집기"다.

규칙(중요도 순):
1) 의미/맥락 절대 변경 금지. 문장 재작성 최소화(필요한 부분만 교정).
2) 한국어로 적힌 전문용어·영문발음(음차)은 가능한 한 정확한 원어(영문, 공식 대소문자)로 치환. (최우선)
3) 오타/맞춤법/띄어쓰기/잘못 인식된 발화만 자연스럽게 교정.
4) 코드블록, \`인라인코드\`, URL, 파일경로, 키/ID, 숫자·단위는 그대로 유지(명백한 오타만 예외).

출력: 교정된 텍스트만. 설명/주석/요약 금지.`;

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

interface RecordingSession {
  sessionId: string;
  noteId: string;
  userId: string;
  audioChunks: Buffer[];
  startTime: number;
  sttConnection: any;
  transcriptText: string;
}

export const activeSessions = new Map<string, RecordingSession>();

export function createRecordingWebSocketHandler(upgradeWebSocket: any) {
  const recordingRouter = new Hono<{ Variables: Variables }>();

  // POST /session - 새 녹음 세션 생성
  recordingRouter.post("/session", authMiddleware, async (c) => {
    const userId = c.get("userId");
    const { title } = await c.req.json();

    console.log(`📝 [SESSION] Creating session for user: ${userId}`);
    console.log(`📝 [SESSION] Title: ${title}`);

    const note = await prisma.note.create({
      data: {
        title: title || "Untitled Recording",
        authorId: userId,
        recordingStatus: "recording",
        durationInSeconds: 0,
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
    
    // DB에서 Note 확인
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
      if (session) {
        if (session.sttConnection) {
          session.sttConnection.close();
        }
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

          let session = activeSessions.get(sessionId);

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

            console.log(`🎙️ [${sessionId}] Connecting to ElevenLabs STT...`);
            console.log(`   Model: scribe_v2_realtime`);
            console.log(`   Language: ko`);
            console.log(`   Sample Rate: ${SAMPLE_RATE}`);
            
            const sttConnection =
              await elevenlabsClient.speechToText.realtime.connect({
                modelId: "scribe_v2_realtime",
                languageCode: "ko",
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
            };

            activeSessions.set(sessionId, session);

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
                const text = data.text ?? "";
                
                if (text && text.trim().length > 0) {
                  console.log(`✅ [${sessionId}] COMMITTED: "${text}"`);
                  session!.transcriptText += text + " ";
                  ws.send(JSON.stringify({ type: "committed", text }));

                  normalizeTextWithGpt(text).then((formattedText) => {
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

            if (data.audio) {
              // Base64 오디오를 Buffer로 변환
              const audioBuffer = Buffer.from(data.audio, "base64");
              session.audioChunks.push(audioBuffer);

              // ElevenLabs로 전송
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
    if (session.sttConnection) {
      session.sttConnection.close();
    }

    const totalAudioBuffer = Buffer.concat(session.audioChunks);
    const durationInSeconds = Math.floor(
      (Date.now() - session.startTime) / 1000
    );

    const wavBuffer = createWavBuffer(totalAudioBuffer, SAMPLE_RATE);

    const r2Key = `recordings/${session.noteId}.wav`;
    const recordingUrl = await uploadAudioToR2(r2Key, wavBuffer, "audio/wav");

    await prisma.note.update({
      where: { id: session.noteId },
      data: {
        recordingUrl,
        durationInSeconds,
        recordingStatus: "completed",
        content: session.transcriptText.trim(),
      },
    });

    console.log(`✅ [${sessionId}] Recording uploaded to R2: ${recordingUrl}`);

    const result = {
      message: "Recording completed and uploaded successfully",
      recordingUrl,
      durationInSeconds,
      transcriptText: session.transcriptText.trim(),
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
