import {Hono} from "hono";
import {AudioFormat, ElevenLabsClient, RealtimeEvents} from "@elevenlabs/elevenlabs-js";
import {AzureOpenAI} from "openai";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const SAMPLE_RATE = 16000;

const AZURE_ENDPOINT = process.env.AZURE_ENDPOINT;
const AZURE_API_KEY = process.env.AZURE_API_KEY;
const AZURE_API_VERSION = process.env.AZURE_API_VERSION ?? "2023-07-01-preview";
const AZURE_DEPLOYMENT = process.env.AZURE_DEPLOYMENT ?? "gpt-4";

const MAX_LINE_LENGTH = 40;
const MAX_LINES_PER_MESSAGE = 3;

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

async function normalizeTextWithGpt(text: string): Promise<string> {
  try {
    const response = await azureClient.chat.completions.create({
      messages: [
        { role: "system", content: CORRECTION_PROMPT },
        { role: "user", content: text },
      ],
      max_completion_tokens: 13107,
      temperature: 1.0,
      top_p: 1.0,
      model: AZURE_DEPLOYMENT,
    });
    return response.choices[0]?.message?.content?.trim() ?? text;
  } catch (e) {
    console.error("❌ GPT Error:", e);
    return text;
  }
}


function splitTextForAndroid(text: string): string[] {
  if (!text) return [];

  const sentences: string[] = [];
  let current = "";
  for (const char of text) {
    current += char;
    if (".!?".includes(char)) {
      sentences.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) {
    sentences.push(current.trim());
  }

  const chunks: string[] = [];
  let currentChunk = "";
  let currentLines = 0;

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    let tempLine = "";

    for (const word of words) {
      const testLine = tempLine ? `${tempLine} ${word}` : word;

      if (testLine.length > MAX_LINE_LENGTH) {
        if (tempLine) {
          currentChunk = currentChunk ? `${currentChunk}\n${tempLine}` : tempLine;
          currentLines++;

          if (currentLines >= MAX_LINES_PER_MESSAGE) {
            chunks.push(currentChunk);
            currentChunk = "";
            currentLines = 0;
          }
        }
        tempLine = word;
      } else {
        tempLine = testLine;
      }
    }

    if (tempLine) {
      currentChunk = currentChunk ? `${currentChunk}\n${tempLine}` : tempLine;
      currentLines++;

      if (currentLines >= MAX_LINES_PER_MESSAGE) {
        chunks.push(currentChunk);
        currentChunk = "";
        currentLines = 0;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.length ? chunks : [text];
}

export function createSttWebSocketHandler(upgradeWebSocket: any) {
  const sttRouter = new Hono();

  sttRouter.get(
    "/",
    upgradeWebSocket(() => {
      let sttConnection: Awaited<ReturnType<typeof elevenlabsClient.speechToText.realtime.connect>> | null = null;

      return {
        async onOpen(_event: any, ws: any) {
          console.log("WebSocket connected");

          try {
            sttConnection = await elevenlabsClient.speechToText.realtime.connect({
              modelId: "scribe_v2_realtime",
                languageCode: "en",
              sampleRate: SAMPLE_RATE,
                audioFormat: AudioFormat.PCM_16000
            });

            sttConnection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data: { text: any; }) => {
              const text = data.text ?? "";
              if (text) {
                const chunks = splitTextForAndroid(text);
                const message = { type: "partial", text, chunks };
                console.log(`\n📝 [PARTIAL] ${text}`);
                ws.send(JSON.stringify(message));
              }
            });

            sttConnection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data: { text: any; }) => {
              const text = data.text ?? "";
              if (!text) return;

              console.log(`✅ [COMMITTED] ${text}`);

              const chunks = splitTextForAndroid(text);
              const committedMessage = { type: "committed", text, chunks };
              ws.send(JSON.stringify(committedMessage));

              normalizeTextWithGpt(text).then((formattedText) => {
                const formattedChunks = splitTextForAndroid(formattedText);
                const formattedMessage = {
                  type: "formatted",
                  text: formattedText,
                  chunks: formattedChunks,
                };
                console.log(`\n✨ [FORMATTED] ${formattedText}`);
                ws.send(JSON.stringify(formattedMessage));
              }).catch((e) => {
                console.error("\n❌ Correction failed:", e);
              });
            });

            // Error event
            sttConnection.on(RealtimeEvents.ERROR, (error: any) => {
              console.error("❌ [STT ERROR]", error);
            });

            console.log("🔗 ElevenLabs STT connection complete, waiting for audio...\n");
          } catch (e) {
            console.error("❌ ElevenLabs connection failed:", e);
          }
        },

        async onMessage(event: any, ws: any) {
          try {
            const data = JSON.parse(event.data.toString());

            if (data.audio && sttConnection) {
              process.stdout.write("\r🟢 AUDIO ");

                sttConnection.send({
                    audioBase64: data.audio,
                });

              setTimeout(() => {
                process.stdout.write("\r⚪️ IDLE  ");
              }, 50);
            } else if (!data.audio) {
              console.log(`\n⚠️  [WARNING] Missing 'audio' key: ${Object.keys(data)}`);
            }
          } catch (e) {
            console.error("\n❌ Message parsing error:", e);
          }
        },

        async onClose() {
          console.log("\n🔌 WebSocket connection closed");
          if (sttConnection) {
              sttConnection.close();
          }
        },

        onError(event: any) {
          console.error("❌ WebSocket error:", event);
        },
      };
    })
  );

  return sttRouter;
}

export default createSttWebSocketHandler;
