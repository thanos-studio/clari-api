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

const CORRECTION_PROMPT = `너는 "실시간 텍스트 정규화 편집기"다.

규칙(중요도 순):
1) 의미/맥락 절대 변경 금지. 문장 재작성 최소화(필요한 부분만 교정).
2) 한국어로 적힌 전문용어·영문발음(음차)은 가능한 한 정확한 원어(영문, 공식 대소문자)로 치환. (최우선)
3) 오타/맞춤법/띄어쓰기/잘못 인식된 발화만 자연스럽게 교정.
4) 코드블록, \`인라인코드\`, URL, 파일경로, 키/ID, 숫자·단위는 그대로 유지(명백한 오타만 예외).

출력: 교정된 텍스트만. 설명/주석/요약 금지.`;

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
          console.log("WebSocket 연결됨");

          try {
            // ElevenLabs STT 연결
            sttConnection = await elevenlabsClient.speechToText.realtime.connect({
              modelId: "scribe_v2_realtime",
              languageCode: "ko",
              sampleRate: SAMPLE_RATE,
                audioFormat: AudioFormat.PCM_16000
            });

            // Partial transcript 이벤트
            sttConnection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data: { text: any; }) => {
              const text = data.text ?? "";
              if (text) {
                const chunks = splitTextForAndroid(text);
                const message = { type: "partial", text, chunks };
                console.log(`\n📝 [PARTIAL] ${text}`);
                ws.send(JSON.stringify(message));
              }
            });

            // Committed transcript 이벤트
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
                console.error("\n❌ 교정 실패:", e);
              });
            });

            // Error 이벤트
            sttConnection.on(RealtimeEvents.ERROR, (error: any) => {
              console.error("❌ [STT ERROR]", error);
            });

            console.log("🔗 ElevenLabs STT 연결 완료, 오디오 대기 중...\n");
          } catch (e) {
            console.error("❌ ElevenLabs 연결 실패:", e);
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
              console.log(`\n⚠️  [WARNING] 'audio' 키 없음: ${Object.keys(data)}`);
            }
          } catch (e) {
            console.error("\n❌ 메시지 파싱 오류:", e);
          }
        },

        async onClose() {
          console.log("\n🔌 WebSocket 연결 종료");
          if (sttConnection) {
              sttConnection.close();
          }
        },

        onError(event: any) {
          console.error("❌ WebSocket 오류:", event);
        },
      };
    })
  );

  return sttRouter;
}

export default createSttWebSocketHandler;
