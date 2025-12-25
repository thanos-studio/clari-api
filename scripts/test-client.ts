#!/usr/bin/env bun

/**
 * Clari API Interactive TUI Client
 * Usage: bun run test-client.ts
 */

import { input, select, confirm, password } from "@inquirer/prompts";
import ora from "ora";
import chalk from "chalk";
import { spawn } from "child_process";
import { createWriteStream, unlinkSync, existsSync } from "fs";
import { dirname, join } from "path";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";
const WS_BASE_URL = process.env.WS_BASE_URL || "ws://localhost:3000";
const SHOW_REQUEST_LOGS = process.env.SHOW_REQUEST_LOGS !== "false"; // Default: true

let JWT_TOKEN = process.env.JWT_TOKEN || "";
let currentSessionId: string | null = null;
let ws: WebSocket | null = null;
let recordingProcess: any = null;
let isRecording = false;
let currentUser: { id: string; email: string; name: string | null } | null = null;

// Request logging
function logHTTP(method: string, url: string, status?: number) {
  if (!SHOW_REQUEST_LOGS) return;
  
  const timestamp = new Date().toLocaleTimeString();
  let statusColor = chalk.white;
  
  if (status) {
    if (status >= 200 && status < 300) statusColor = chalk.green;
    else if (status >= 400) statusColor = chalk.red;
    else statusColor = chalk.yellow;
  }
  
  const statusText = status ? statusColor(`${status}`) : chalk.gray("pending");
  console.log(chalk.gray(`[${timestamp}]`) + ` ${chalk.bold(method)} ${chalk.cyan(url)} → ${statusText}`);
}

function logWS(type: string, message: string) {
  if (!SHOW_REQUEST_LOGS) return;
  
  const timestamp = new Date().toLocaleTimeString();
  let typeColor = chalk.white;
  
  if (type === "CONNECT") typeColor = chalk.cyan;
  else if (type === "SEND") typeColor = chalk.blue;
  else if (type === "RECV") typeColor = chalk.green;
  else if (type === "ERROR") typeColor = chalk.red;
  else if (type === "CLOSE") typeColor = chalk.yellow;
  
  console.log(chalk.gray(`[${timestamp}]`) + ` ${typeColor(`[WS ${type}]`)} ${message}`);
}

// Helper functions
function log(message: string) {
  console.log(chalk.cyan(message));
}

function logSuccess(message: string) {
  console.log(chalk.green(`✅ ${message}`));
}

function logError(message: string) {
  console.log(chalk.red(`❌ ${message}`));
}

function logInfo(message: string) {
  console.log(chalk.blue(`ℹ️  ${message}`));
}

function logWarning(message: string) {
  console.log(chalk.yellow(`⚠️  ${message}`));
}

function logDebug(message: string) {
  console.log(chalk.gray(`🔍 [DEBUG] ${message}`));
}

// API Functions
async function getUserInfo() {
  logDebug("Fetching user info...");
  
  try {
    logHTTP("GET", "/me");
    const response = await fetch(`${API_BASE_URL}/me`, {
      headers: {
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
    });

    logHTTP("GET", "/me", response.status);
    logDebug(`Response status: ${response.status}`);

    const data = await response.json();
    logDebug(`Response data: ${JSON.stringify(data)}`);

    if (response.ok) {
      currentUser = data.user;
      logSuccess(`Logged in as: ${currentUser?.name || currentUser?.email}`);
      return true;
    } else {
      logError(`Failed to get user info: ${JSON.stringify(data)}`);
      return false;
    }
  } catch (e) {
    logError(`Error fetching user info: ${e}`);
    return false;
  }
}

async function loginWithGoogle() {
  console.log("\n" + chalk.bold("🔐 Google OAuth Login"));
  logInfo("Please provide your Google ID Token from OAuth flow.\n");
  logWarning("Get it from: https://accounts.google.com/o/oauth2/v2/auth?...\n");

  logDebug(`Current API_BASE_URL: ${API_BASE_URL}`);

  const idToken = await password({
    message: "Enter your Google ID Token:",
  });

  logDebug(`Google ID Token: ${idToken}`);

  const spinner = ora("Authenticating with Google...").start();

  try {
    // Send idToken to server
    logHTTP("POST", "/auth/google");
    const response = await fetch(`${API_BASE_URL}/auth/google`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ idToken }),
    });

    logHTTP("POST", "/auth/google", response.status);
    logDebug(`Response status: ${response.status}`);

    const data = await response.json();
    logDebug(`Response data: ${JSON.stringify(data)}`);

    if (response.ok) {
      JWT_TOKEN = data.accessToken;
      currentUser = data.user;
      
      spinner.succeed(chalk.green("Login successful!"));
      logSuccess(`Logged in as: ${currentUser.name || currentUser.email}`);
      logDebug(`JWT Token: ${JWT_TOKEN}`);
      
      return true;
    } else {
      spinner.fail(chalk.red("Login failed"));
      logError(`Error: ${JSON.stringify(data)}`);
      return false;
    }
  } catch (e) {
    spinner.fail(chalk.red("Login failed"));
    logError(`Error: ${e}`);
    return false;
  }
}

async function loginWithJWT() {
  console.log("\n" + chalk.bold("🔑 Direct JWT Login"));
  logWarning("For testing only - paste your JWT token directly.\n");

  logDebug(`Current API_BASE_URL: ${API_BASE_URL}`);

  const token = await password({
    message: "Enter your JWT token:",
  });

  JWT_TOKEN = token;
  logDebug(`Token set: ${JWT_TOKEN}`);
  
  // Verify token by getting user info
  const success = await getUserInfo();
  if (success) {
    logSuccess("Login successful!");
  } else {
    logError("Login failed - invalid token");
    JWT_TOKEN = "";
  }
  
  return success;
}

async function createSession() {
  const title = await input({
    message: "Enter recording title:",
    default: `Recording ${new Date().toLocaleString()}`,
  });

  // Ask for language
  const languageCode = await select({
    message: "Select language:",
    choices: [
      { name: "🇰🇷 Korean", value: "ko" },
      { name: "🇺🇸 English", value: "en" },
      { name: "🇯🇵 Japanese", value: "ja" },
      { name: "🇨🇳 Chinese", value: "zh" },
    ],
    default: "ko",
  });

  // Ask if want to attach keyword packs
  const attachKeywordPacks = await confirm({
    message: "Attach keyword packs?",
    default: false,
  });

  let keywordPackIds: string[] = [];
  if (attachKeywordPacks) {
    // Fetch available packs
    const spinner = ora("Fetching keyword packs...").start();
    try {
      const response = await fetch(`${API_BASE_URL}/keywordpacks?limit=100`, {
        headers: { Authorization: `Bearer ${JWT_TOKEN}` },
      });
      const data = await response.json();
      
      if (response.ok && data.packs.length > 0) {
        spinner.stop();
        
        // Multi-select keyword packs
        const selectedPacks = await select({
          message: "Select keyword packs (Enter to continue):",
          choices: data.packs.map((pack: any) => ({
            name: `📦 ${pack.name} (${Array.isArray(pack.keywords) ? pack.keywords.length : 0} keywords)`,
            value: pack.id,
          })).concat([{ name: "✅ Done (no selection)", value: null }]),
        });
        
        if (selectedPacks) {
          keywordPackIds = [selectedPacks];
        }
      } else {
        spinner.succeed("No keyword packs available");
      }
    } catch (e) {
      spinner.fail(`Error: ${e}`);
    }
  }

  // Ask if want to attach external resources
  const attachResources = await confirm({
    message: "Attach external resources?",
    default: false,
  });

  let externalResourceIds: string[] = [];
  if (attachResources) {
    // Fetch available resources
    const spinner = ora("Fetching external resources...").start();
    try {
      const response = await fetch(`${API_BASE_URL}/externalresources?limit=100`, {
        headers: { Authorization: `Bearer ${JWT_TOKEN}` },
      });
      const data = await response.json();
      
      if (response.ok && data.resources.length > 0) {
        spinner.stop();
        
        // Multi-select resources
        const selectedResource = await select({
          message: "Select external resources (Enter to continue):",
          choices: data.resources.map((resource: any) => ({
            name: `🌐 ${resource.title} - ${resource.displayUrl}`,
            value: resource.id,
          })).concat([{ name: "✅ Done (no selection)", value: null }]),
        });
        
        if (selectedResource) {
          externalResourceIds = [selectedResource];
        }
      } else {
        spinner.succeed("No external resources available");
      }
    } catch (e) {
      spinner.fail(`Error: ${e}`);
    }
  }

  const spinner = ora("Creating session...").start();

  logDebug(`Creating session with title: ${title}`);
  logDebug(`Language: ${languageCode}`);
  logDebug(`KeywordPacks: ${keywordPackIds.join(", ") || "none"}`);
  logDebug(`ExternalResources: ${externalResourceIds.join(", ") || "none"}`);
  logDebug(`Using token: ${JWT_TOKEN}`);

  try {
    const response = await fetch(`${API_BASE_URL}/notes/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
      body: JSON.stringify({ 
        title,
        languageCode,
        keywordPackIds: keywordPackIds.length > 0 ? keywordPackIds : undefined,
        externalResourceIds: externalResourceIds.length > 0 ? externalResourceIds : undefined,
      }),
    });

    logDebug(`Response status: ${response.status}`);

    const data = await response.json();
    logDebug(`Response data: ${JSON.stringify(data)}`);

    if (response.ok) {
      currentSessionId = data.sessionId;
      spinner.succeed(chalk.green(`Session created: ${currentSessionId}`));
      logInfo(`Note ID: ${data.noteId}`);
      logInfo(`Language: ${languageCode}`);
      if (keywordPackIds.length > 0) logInfo(`Keyword Packs: ${keywordPackIds.length} attached`);
      if (externalResourceIds.length > 0) logInfo(`External Resources: ${externalResourceIds.length} attached`);
      
      // Show session menu immediately
      await sessionMenu();
      
      return true;
    } else {
      spinner.fail(chalk.red(`Failed: ${JSON.stringify(data)}`));
      return false;
    }
  } catch (e) {
    spinner.fail(chalk.red(`Error: ${e}`));
    return false;
  }
}

async function sessionMenu() {
  while (currentSessionId) {
    console.log("\n" + chalk.bold.cyan("📝 Current Session\n"));
    logInfo(`Session ID: ${currentSessionId}`);
    
    if (isRecording) {
      logWarning("🎙️  Recording in progress...\n");
    }
    
    const choices = [];
    
    if (!isRecording) {
      choices.push({ name: "🎤 Start Recording", value: "record" });
      choices.push({ name: "❌ Cancel Session", value: "cancel" });
      choices.push({ name: "🔙 Back to Main Menu", value: "back" });
    } else {
      choices.push({ name: "⏹️  Stop Recording", value: "stop" });
      choices.push({ name: "⏸️  Pause Recording", value: "pause" });
      choices.push({ name: "🔕 Toggle Keyword Detection", value: "toggle_keywords" });
      choices.push({ name: "💡 Toggle Resource Hints", value: "toggle_hints" });
    }
    
    const action = await select({
      message: "What would you like to do?",
      choices,
    });
    
    switch (action) {
      case "record":
        await startRecording();
        break;
      case "stop":
        await stopAndSaveRecording();
        return; // Exit session menu after stop
      case "pause":
        await pauseRecording();
        break;
      case "toggle_keywords":
        await toggleKeywordDetection();
        break;
      case "toggle_hints":
        await toggleResourceHints();
        break;
      case "cancel":
        await cancelRecording();
        return; // Exit session menu after cancel
      case "back":
        logWarning("Session is still active. Use Cancel to delete it.");
        return;
    }
  }
}

async function pauseRecording() {
  if (!isRecording) {
    logError("Not recording");
    return;
  }
  
  stopRecording(); // Stop audio capture but keep session
  logWarning("Recording paused. Select 'Start Recording' to resume.");
}

async function toggleKeywordDetection() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logError("WebSocket not connected");
    return;
  }

  const action = await select({
    message: "Keyword detection:",
    choices: [
      { name: "🔔 Turn ON", value: "on" },
      { name: "🔕 Turn OFF", value: "off" },
    ],
  });

  ws.send(JSON.stringify({ action: "keyword.control", data: action }));
  logInfo(`Keyword detection ${action === "on" ? "enabled" : "disabled"}`);
}

async function toggleResourceHints() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logError("WebSocket not connected");
    return;
  }

  const action = await select({
    message: "Resource hints:",
    choices: [
      { name: "💡 Turn ON", value: "on" },
      { name: "🔕 Turn OFF", value: "off" },
    ],
  });

  ws.send(JSON.stringify({ action: "hints.control", data: action }));
  logInfo(`Resource hints ${action === "on" ? "enabled" : "disabled"}`);
}

async function startRecording() {
  if (!currentSessionId) {
    logError("No active session. Create a session first.");
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const spinner = ora("Connecting to WebSocket...").start();

    const wsUrl = `${WS_BASE_URL}/notes/session/${currentSessionId}`;
    logDebug(`Connecting to: ${wsUrl}`);
    logDebug(`With Authorization: Bearer ${JWT_TOKEN}`);
    logWS("CONNECT", wsUrl);

    try {
      // Try WebSocket with Authorization header
      ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${JWT_TOKEN}`,
        },
      });

      ws.onerror = (error) => {
        logWS("ERROR", `Connection failed: ${error.message || "Unknown"}`);
        spinner.fail("WebSocket connection failed");
        logError(`WebSocket error: ${JSON.stringify(error)}`);
        logError(`Error type: ${error.type}`);
        logError(`Error message: ${error.message}`);
        
        // Fallback: Try with token in query parameter
        logWarning("Retrying with token in query parameter...");
        const fallbackUrl = `${WS_BASE_URL}/notes/session/${currentSessionId}?token=${encodeURIComponent(JWT_TOKEN)}`;
        logWS("CONNECT", `Fallback: ${fallbackUrl}`);
        
        ws = new WebSocket(fallbackUrl);
        
        ws.onerror = (err) => {
          logWS("ERROR", "Fallback failed");
          logError("Fallback connection also failed");
          resolve(false);
        };
        
        ws.onopen = () => {
          logWS("CONNECT", "Connected via query param");
          spinner.succeed("Connected to server (via query param)");
          setupWebSocketHandlers(resolve);
        };
        
        return;
      };

      ws.onopen = async () => {
        logWS("CONNECT", "Connected successfully");
        spinner.succeed("Connected to server");
        setupWebSocketHandlers(resolve);
      };
    } catch (e) {
      spinner.fail(`Connection failed: ${e}`);
      resolve(false);
    }
  });
}

function setupWebSocketHandlers(resolve: (value: boolean) => void) {
  if (!ws) return;
  
  logSuccess("Ready to record!");

  // Start audio recording
  console.log("\n" + "=".repeat(60));
  console.log(chalk.bold.yellow("🎤 RECORDING..."));
  console.log(chalk.gray("Press Ctrl+C or select Stop from menu to finish"));
  console.log("=".repeat(60));
  console.log("");

  isRecording = true;

  try {
    const recorder = spawn("sox", [
      "-d",
      "-t",
      "raw",
      "-r",
      "16000",
      "-e",
      "signed",
      "-b",
      "16",
      "-c",
      "1",
      "-",
    ]);

    recordingProcess = recorder;

    let audioChunkCount = 0;
    
    recorder.stdout.on("data", (chunk: Buffer) => {
      if (ws && ws.readyState === WebSocket.OPEN && isRecording) {
        // JSON + Base64 전송 (기존 방식)
        const base64Audio = chunk.toString("base64");
        ws.send(JSON.stringify({ audio: base64Audio }));
        
        audioChunkCount++;
        
        // Show audio activity indicator every 50 chunks
        if (audioChunkCount % 50 === 0) {
          process.stdout.write(chalk.gray("."));
        }
      }
    });

    recorder.stderr.on("data", (data) => {
      // Ignore sox status messages
    });

    recorder.on("close", (code) => {
      if (code !== null && code !== 0 && code !== 130) {
        logWarning(`Recording process exited with code ${code}`);
      }
    });

    recorder.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        logError("Sox not found. Please install: brew install sox");
        stopRecording();
      } else {
        logError(`Recording error: ${err.message}`);
      }
    });
  } catch (err: any) {
    logError(`Failed to start recording: ${err.message}`);
    stopRecording();
  }

  if (ws) {
    let lastPartialText = "";
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        
        // Debug log
        if (data.type === "partial" || data.type === "committed" || data.type === "formatted") {
          const textPreview = data.text ? data.text.substring(0, 30) : "(empty)";
          logWS("RECV", `${data.type}: ${textPreview}`);
        }

        switch (data.type) {
          case "ready":
            // Already handled in onopen
            break;
          case "partial":
            // 실시간 중간 결과 (회색, 같은 줄에 덮어쓰기)
            if (data.text && data.text.trim()) {
              lastPartialText = data.text;
              process.stdout.write("\r" + " ".repeat(120) + "\r"); // Clear line
              process.stdout.write(chalk.gray(`📝 [실시간] ${data.text}\n`));
            }
            break;
          case "committed":
            // 확정된 텍스트 (녹색, 새 줄)
            if (data.text && data.text.trim()) {
              process.stdout.write("\r" + " ".repeat(120) + "\r"); // Clear line
              console.log(chalk.green.bold(`✅ [확정] ${data.text}\n`));
              lastPartialText = "";
            } else {
              console.log(chalk.yellow(`⚠️  Empty COMMITTED received`));
            }
            break;
          case "formatted":
            // GPT 교정된 텍스트 (파랑, 굵게)
            if (data.text && data.text.trim()) {
              console.log(chalk.blue.bold(`✨ [교정] ${data.text}\n`));
            } else {
              console.log(chalk.yellow(`⚠️  Empty FORMATTED received`));
            }
            break;
          case "keywords":
            // Detected keywords from keyword packs
            if (data.keywords && data.keywords.length > 0) {
              console.log(chalk.magenta.bold(`\n🔍 [키워드 감지]`));
              data.keywords.forEach((kw: any) => {
                console.log(chalk.magenta(`  • ${kw.name}: ${kw.description}`));
              });
              console.log("");
            }
            break;
          case "hints":
            // Hints from external resources
            if (data.hints && data.hints.length > 0) {
              console.log(chalk.cyan.bold(`\n💡 [외부 자료 힌트]`));
              data.hints.forEach((hint: any) => {
                console.log(chalk.cyan(`  📚 [${hint.resourceTitle}]`));
                console.log(chalk.cyan(`     ${hint.hint}`));
                console.log(chalk.gray(`     출처: ${hint.sourceUrl}`));
              });
              console.log("");
            }
            break;
          case "keyword.status":
            logInfo(`Keyword detection: ${data.enabled ? "ON" : "OFF"}`);
            break;
          case "hints.status":
            logInfo(`Resource hints: ${data.enabled ? "ON" : "OFF"}`);
            break;
          case "error":
            process.stdout.write("\r" + " ".repeat(120) + "\r"); // Clear line
            logError(data.error);
            break;
        }
      } catch (e) {
        // Ignore
      }
    };

    ws.onclose = () => {
      logWS("CLOSE", "Connection closed");
      process.stdout.write("\r" + " ".repeat(120) + "\r"); // Clear partial text
      console.log(""); // New line
      logInfo("WebSocket disconnected");
      if (isRecording) {
        stopRecording();
      }
    };
  }

  resolve(true);
}

function stopRecording() {
  if (recordingProcess) {
    recordingProcess.kill("SIGTERM");
    recordingProcess = null;
  }
  isRecording = false;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  ws = null;
}

async function stopAndSaveRecording() {
  if (!currentSessionId) {
    logError("No active session.");
    return false;
  }

  stopRecording();

  const spinner = ora("Stopping and transcribing recording...").start();

  try {
    const response = await fetch(`${API_BASE_URL}/notes/session/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
      body: JSON.stringify({ sessionId: currentSessionId }),
    });

    const data = await response.json();

    if (response.ok) {
      spinner.succeed(chalk.green("Recording saved and transcribed!"));
      
      console.log(chalk.bold("\n📊 Recording Info:"));
      logInfo(`Duration: ${data.durationInSeconds} seconds`);
      logInfo(`URL: ${data.recordingUrl}`);
      
      if (data.transcript) {
        console.log(chalk.bold("\n📝 Transcript:"));
        console.log(chalk.cyan(`Language: ${data.transcript.language} (${(data.transcript.language_probability * 100).toFixed(1)}%)`));
        console.log(chalk.white(`Words: ${data.transcript.word_count}`));
        console.log(chalk.bold("\n🔤 Original Text:"));
        console.log(chalk.white(data.transcript.text));
        console.log(chalk.bold("\n✨ Formatted Text:"));
        console.log(chalk.green(data.transcript.formatted));
      }

      if (data.speakers && data.speakers.length > 0) {
        console.log(chalk.bold("\n👥 Speakers:"));
        data.speakers.forEach((speaker: any) => {
          console.log(chalk.yellow(`  ${speaker.speaker_id}: ${speaker.word_count} words`));
          console.log(chalk.gray(`    "${speaker.text.substring(0, 100)}..."`));
        });
      }

      // Ask if user wants to download
      const shouldDownload = await confirm({
        message: "Download recording file?",
        default: true,
      });

      if (shouldDownload) {
        await downloadRecording(data.recordingUrl);
      }

      currentSessionId = null;
      return true;
    } else {
      spinner.fail(chalk.red(`Failed: ${JSON.stringify(data)}`));
      return false;
    }
  } catch (e) {
    spinner.fail(chalk.red(`Error: ${e}`));
    return false;
  }
}

async function cancelRecording() {
  if (!currentSessionId) {
    logError("No active session.");
    return false;
  }

  const confirmed = await confirm({
    message: "Are you sure you want to cancel and delete this recording?",
    default: false,
  });

  if (!confirmed) {
    logInfo("Cancelled.");
    return false;
  }

  stopRecording();

  const spinner = ora("Cancelling recording...").start();

  try {
    const response = await fetch(`${API_BASE_URL}/notes/session/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
      body: JSON.stringify({ sessionId: currentSessionId }),
    });

    const data = await response.json();

    if (response.ok) {
      spinner.succeed(chalk.green("Recording cancelled and deleted"));
      currentSessionId = null;
      return true;
    } else {
      spinner.fail(chalk.red(`Failed: ${JSON.stringify(data)}`));
      return false;
    }
  } catch (e) {
    spinner.fail(chalk.red(`Error: ${e}`));
    return false;
  }
}

async function listNotes() {
  const spinner = ora("Fetching notes...").start();

  try {
    const response = await fetch(`${API_BASE_URL}/notes?limit=20`, {
      headers: {
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
    });

    const data = await response.json();

    if (response.ok) {
      spinner.succeed(`Found ${data.notes.length} notes`);

      if (data.notes.length === 0) {
        logInfo("No notes yet. Create a recording first!");
        return;
      }

      console.log("\n" + chalk.bold("📚 Your Notes:"));
      data.notes.forEach((note: any, index: number) => {
        console.log(
          chalk.cyan(`${index + 1}.`) +
            ` ${note.title} ` +
            chalk.gray(`(${note.durationInSeconds}s)`) +
            ` - ${new Date(note.createdAt).toLocaleString()}`
        );
      });

      const action = await select({
        message: "What do you want to do?",
        choices: [
          { name: "Download a recording", value: "download" },
          { name: "View note details", value: "view" },
          { name: "Delete a note", value: "delete" },
          { name: "Back to main menu", value: "back" },
        ],
      });

      if (action === "back") return;

      const noteIndex = await input({
        message: "Enter note number:",
        validate: (value) => {
          const num = parseInt(value);
          if (isNaN(num) || num < 1 || num > data.notes.length) {
            return "Invalid number";
          }
          return true;
        },
      });

      const selectedNote = data.notes[parseInt(noteIndex) - 1];

      if (action === "download") {
        await downloadRecordingByNoteId(selectedNote.id);
      } else if (action === "view") {
        await viewNote(selectedNote.id);
      } else if (action === "delete") {
        await deleteNote(selectedNote.id);
      }
      
      // Wait for user to press Enter before returning
      await input({
        message: chalk.gray("Press Enter to continue..."),
      });
    } else {
      spinner.fail(chalk.red(`Failed: ${JSON.stringify(data)}`));
    }
  } catch (e) {
    spinner.fail(chalk.red(`Error: ${e}`));
  }
}

async function viewNote(noteId: string) {
  const spinner = ora("Fetching note details...").start();

  try {
    const response = await fetch(`${API_BASE_URL}/notes/${noteId}`, {
      headers: {
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
    });

    const data = await response.json();

    if (response.ok) {
      spinner.succeed("Note details:");
      console.log("\n" + chalk.bold("📄 Note Details:"));
      console.log(chalk.cyan("Title:") + ` ${data.note.title}`);
      console.log(chalk.cyan("Duration:") + ` ${data.note.durationInSeconds} seconds`);
      console.log(chalk.cyan("Status:") + ` ${data.note.recordingStatus}`);
      console.log(chalk.cyan("Created:") + ` ${new Date(data.note.createdAt).toLocaleString()}`);
      if (data.note.content) {
        console.log("\n" + chalk.bold("📝 Transcript:"));
        console.log(chalk.white(data.note.content));
      }
      if (data.note.recordingUrl) {
        console.log("\n" + chalk.cyan("Recording URL:") + ` ${data.note.recordingUrl}`);
      }
    } else {
      spinner.fail(chalk.red(`Failed: ${JSON.stringify(data)}`));
    }
  } catch (e) {
    spinner.fail(chalk.red(`Error: ${e}`));
  }
}

async function deleteNote(noteId: string) {
  const confirmed = await confirm({
    message: "Are you sure you want to delete this note?",
    default: false,
  });

  if (!confirmed) {
    logInfo("Cancelled.");
    return;
  }

  const spinner = ora("Deleting note...").start();

  try {
    const response = await fetch(`${API_BASE_URL}/notes/${noteId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
    });

    const data = await response.json();

    if (response.ok) {
      spinner.succeed(chalk.green("Note deleted successfully"));
    } else {
      spinner.fail(chalk.red(`Failed: ${JSON.stringify(data)}`));
    }
  } catch (e) {
    spinner.fail(chalk.red(`Error: ${e}`));
  }
}

async function downloadRecordingByNoteId(noteId: string) {
  const spinner = ora("Fetching recording URL...").start();

  try {
    const response = await fetch(`${API_BASE_URL}/notes/record/${noteId}`, {
      headers: {
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
    });

    const data = await response.json();

    if (response.ok) {
      spinner.succeed("Got recording URL");
      await downloadRecording(data.recordingUrl);
    } else {
      spinner.fail(chalk.red(`Failed: ${JSON.stringify(data)}`));
    }
  } catch (e) {
    spinner.fail(chalk.red(`Error: ${e}`));
  }
}

async function downloadRecording(url: string) {
  const filename = await input({
    message: "Enter filename to save:",
    default: `recording_${Date.now()}.wav`,
  });

  const spinner = ora(`Downloading to ${filename}...`).start();

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await Bun.write(filename, buffer);

    spinner.succeed(chalk.green(`Downloaded: ${filename} (${buffer.length} bytes)`));
  } catch (e) {
    spinner.fail(chalk.red(`Download failed: ${e}`));
  }
}

async function manageKeywordPacks() {
  console.log("\n" + chalk.bold("🔖 Keyword Packs Management\n"));
  
  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: "📋 List all keyword packs", value: "list" },
      { name: "➕ Create new keyword pack", value: "create" },
      { name: "➕ Add keyword to pack", value: "add_keyword" },
      { name: "🤖 AI Autocomplete (get description suggestions)", value: "autocomplete" },
      { name: "🚀 AI Autofill (generate keywords from query)", value: "autofill" },
      { name: "🔙 Back to main menu", value: "back" },
    ],
  });

  if (action === "back") return;

  if (action === "list") {
    const spinner = ora("Fetching keyword packs...").start();
    try {
      const response = await fetch(`${API_BASE_URL}/keywordpacks`, {
        headers: { Authorization: `Bearer ${JWT_TOKEN}` },
      });
      const data = await response.json();
      
      if (response.ok) {
        spinner.succeed(`Found ${data.packs.length} keyword packs`);
        if (data.packs.length === 0) {
          logInfo("No keyword packs yet.");
        } else {
          data.packs.forEach((pack: any) => {
            console.log(chalk.cyan(`\n📦 ${pack.name} (${pack.id})`));
            console.log(chalk.gray(`   Created: ${new Date(pack.createdAt).toLocaleString()}`));
            console.log(chalk.gray(`   Keywords: ${Array.isArray(pack.keywords) ? pack.keywords.length : 0}`));
          });
        }
      } else {
        spinner.fail(`Failed: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      spinner.fail(`Error: ${e}`);
    }
  } else if (action === "create") {
    const name = await input({ message: "Keyword pack name:" });
    
    const spinner = ora("Creating keyword pack...").start();
    try {
      const response = await fetch(`${API_BASE_URL}/keywordpacks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${JWT_TOKEN}`,
        },
        body: JSON.stringify({ name, keywords: [] }),
      });
      const data = await response.json();
      
      if (response.ok) {
        spinner.succeed(`Created: ${data.pack.id}`);
        logInfo(`Use this ID when creating sessions: ${data.pack.id}`);
      } else {
        spinner.fail(`Failed: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      spinner.fail(`Error: ${e}`);
    }
  } else if (action === "add_keyword") {
    // Fetch available packs
    const packsSpinner = ora("Fetching keyword packs...").start();
    try {
      const packsResponse = await fetch(`${API_BASE_URL}/keywordpacks?limit=100`, {
        headers: { Authorization: `Bearer ${JWT_TOKEN}` },
      });
      const packsData = await packsResponse.json();
      
      if (packsResponse.ok && packsData.packs.length > 0) {
        packsSpinner.stop();
        
        const packId = await select({
          message: "Select keyword pack:",
          choices: packsData.packs.map((pack: any) => ({
            name: `📦 ${pack.name} (${Array.isArray(pack.keywords) ? pack.keywords.length : 0} keywords)`,
            value: pack.id,
          })),
        });
        
        const keywordName = await input({ message: "Enter keyword name:" });
        const keywordDesc = await input({ message: "Enter keyword description:" });
        
        const spinner = ora("Adding keyword...").start();
        try {
          const response = await fetch(`${API_BASE_URL}/keywordpacks/${packId}/keywords`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${JWT_TOKEN}`,
            },
            body: JSON.stringify({ name: keywordName, description: keywordDesc }),
          });
          const data = await response.json();
          
          if (response.ok) {
            spinner.succeed("Keyword added successfully!");
          } else {
            spinner.fail(`Failed: ${JSON.stringify(data)}`);
          }
        } catch (e) {
          spinner.fail(`Error: ${e}`);
        }
      } else {
        packsSpinner.fail("No keyword packs available. Create one first!");
      }
    } catch (e) {
      packsSpinner.fail(`Error: ${e}`);
    }
  } else if (action === "autocomplete") {
    const keywordName = await input({ message: "Enter keyword name (for description suggestions):" });
    
    const spinner = ora("Generating AI suggestions...").start();
    try {
      const response = await fetch(`${API_BASE_URL}/keywordpacks/ai/autocomplete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${JWT_TOKEN}`,
        },
        body: JSON.stringify({ name: keywordName }),
      });
      const data = await response.json();
      
      if (response.ok && data.suggestions) {
        spinner.succeed(`Generated ${data.suggestions.length} suggestions:`);
        console.log(chalk.bold("\n💡 AI Suggestions:\n"));
        data.suggestions.forEach((suggestion: string, index: number) => {
          console.log(chalk.cyan(`${index + 1}. ${suggestion}`));
        });
        
        const selected = await select({
          message: "Select a description:",
          choices: data.suggestions.map((s: string, i: number) => ({
            name: s,
            value: i,
          })).concat([{ name: "❌ Cancel", value: -1 }]),
        });
        
        if (selected !== -1) {
          const selectedDesc = data.suggestions[selected];
          
          // Fetch available packs for dropdown
          const packsSpinner = ora("Fetching keyword packs...").start();
          try {
            const packsResponse = await fetch(`${API_BASE_URL}/keywordpacks?limit=100`, {
              headers: { Authorization: `Bearer ${JWT_TOKEN}` },
            });
            const packsData = await packsResponse.json();
            
            if (packsResponse.ok && packsData.packs.length > 0) {
              packsSpinner.stop();
              
              const packId = await select({
                message: "Select keyword pack to add to:",
                choices: packsData.packs.map((pack: any) => ({
                  name: `📦 ${pack.name} (${Array.isArray(pack.keywords) ? pack.keywords.length : 0} keywords)`,
                  value: pack.id,
                })),
              });
              
              const addSpinner = ora("Adding keyword...").start();
              try {
                const addResponse = await fetch(`${API_BASE_URL}/keywordpacks/${packId}/keywords`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${JWT_TOKEN}`,
                  },
                  body: JSON.stringify({ name: keywordName, description: selectedDesc }),
                });
                
                const addData = await addResponse.json();
                
                if (addResponse.ok) {
                  addSpinner.succeed("Keyword added with AI description!");
                } else {
                  addSpinner.fail(`Failed to add keyword: ${JSON.stringify(addData)}`);
                }
              } catch (e) {
                addSpinner.fail(`Error: ${e}`);
              }
            } else {
              packsSpinner.fail("No keyword packs available. Create one first!");
            }
          } catch (e) {
            packsSpinner.fail(`Error: ${e}`);
          }
        }
      } else {
        spinner.fail(`Failed: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      spinner.fail(`Error: ${e}`);
    }
  } else if (action === "autofill") {
    const query = await input({ message: "Enter search query (e.g., 'AWS 관련 단어'):" });
    const count = await input({ message: "How many keywords? (default: 50):", default: "50" });
    
    console.log(chalk.cyan("\n🚀 Starting AI Autofill..."));
    console.log(chalk.gray("Step 1: Searching with Perplexity..."));
    
    const autofillSpinner = ora("Searching with Perplexity...").start();
    
    try {
      const response = await fetch(`${API_BASE_URL}/keywordpacks/ai/autofill`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${JWT_TOKEN}`,
        },
        body: JSON.stringify({ query, count: parseInt(count) }),
      });
      const data = await response.json();
      
      if (response.ok && data.keywords) {
        autofillSpinner.stop();
        
        // Show stats
        if (data.stats) {
          console.log(chalk.bold.cyan("\n📊 Performance Stats:"));
          console.log(chalk.gray(`  Perplexity Search: ${data.stats.perplexityTime}ms`));
          console.log(chalk.gray(`  GPT Extraction: ${data.stats.gptTime}ms`));
          console.log(chalk.green(`  Total Time: ${data.stats.totalTime}ms`));
          console.log(chalk.gray(`  Requested: ${data.stats.requestedCount} keywords`));
          console.log(chalk.green(`  Generated: ${data.stats.actualCount} keywords\n`));
        }
        
        logSuccess(`Generated ${data.keywords.length} keywords!`);
        
        console.log(chalk.bold(`\n🚀 Generated Keywords (showing first 10):\n`));
        data.keywords.slice(0, 10).forEach((kw: any, index: number) => {
          console.log(chalk.cyan(`${index + 1}. ${kw.name}`));
          console.log(chalk.gray(`   ${kw.description}\n`));
        });
        
        const shouldAdd = await confirm({
          message: `Add all ${data.keywords.length} keywords to a pack?`,
          default: true,
        });
        
        if (shouldAdd) {
          // Fetch available packs
          const packsSpinner = ora("Fetching keyword packs...").start();
          try {
            const packsResponse = await fetch(`${API_BASE_URL}/keywordpacks?limit=100`, {
              headers: { Authorization: `Bearer ${JWT_TOKEN}` },
            });
            const packsData = await packsResponse.json();
            
            if (packsResponse.ok && packsData.packs.length > 0) {
              packsSpinner.stop();
              
              const packId = await select({
                message: "Select keyword pack to add to:",
                choices: packsData.packs.map((pack: any) => ({
                  name: `📦 ${pack.name} (${Array.isArray(pack.keywords) ? pack.keywords.length : 0} keywords)`,
                  value: pack.id,
                })),
              });
              
              const updateSpinner = ora("Updating keyword pack...").start();
              const updateResponse = await fetch(`${API_BASE_URL}/keywordpacks/${packId}`, {
                method: "PATCH",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${JWT_TOKEN}`,
                },
                body: JSON.stringify({ keywords: data.keywords }),
              });
              
              if (updateResponse.ok) {
                updateSpinner.succeed(`Added ${data.keywords.length} keywords to pack!`);
              } else {
                updateSpinner.fail("Failed to update pack");
              }
            } else {
              packsSpinner.fail("No keyword packs available. Create one first!");
            }
          } catch (e) {
            packsSpinner.fail(`Error: ${e}`);
          }
        }
      } else {
        autofillSpinner.fail(`Failed: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      autofillSpinner.fail(`Error: ${e}`);
    }
  }

  await input({ message: chalk.gray("Press Enter to continue...") });
}

async function manageExternalResources() {
  console.log("\n" + chalk.bold("🌐 External Resources Management\n"));
  
  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: "📋 List all external resources", value: "list" },
      { name: "➕ Create new external resource", value: "create" },
      { name: "🔙 Back to main menu", value: "back" },
    ],
  });

  if (action === "back") return;

  if (action === "list") {
    const spinner = ora("Fetching external resources...").start();
    try {
      const response = await fetch(`${API_BASE_URL}/externalresources`, {
        headers: { Authorization: `Bearer ${JWT_TOKEN}` },
      });
      const data = await response.json();
      
      if (response.ok) {
        spinner.succeed(`Found ${data.resources.length} external resources`);
        if (data.resources.length === 0) {
          logInfo("No external resources yet.");
        } else {
          data.resources.forEach((resource: any) => {
            console.log(chalk.cyan(`\n🌐 ${resource.title} (${resource.id})`));
            console.log(chalk.gray(`   URL: ${resource.displayUrl}`));
            console.log(chalk.gray(`   Created: ${new Date(resource.createdAt).toLocaleString()}`));
          });
        }
      } else {
        spinner.fail(`Failed: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      spinner.fail(`Error: ${e}`);
    }
  } else if (action === "create") {
    const url = await input({ message: "Enter website URL:" });
    
    const spinner = ora("Scraping website with Firecrawl...").start();
    try {
      const response = await fetch(`${API_BASE_URL}/externalresources`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${JWT_TOKEN}`,
        },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      
      if (response.ok) {
        spinner.succeed(`Created: ${data.resource.title} (${data.resource.id})`);
        logInfo(`Display URL: ${data.resource.displayUrl}`);
        logInfo(`Use this ID when creating sessions: ${data.resource.id}`);
      } else {
        spinner.fail(`Failed: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      spinner.fail(`Error: ${e}`);
    }
  }

  await input({ message: chalk.gray("Press Enter to continue...") });
}

// Main menu
async function mainMenu() {
  console.clear();
  console.log(chalk.bold.cyan("\n🎙️  Clari API Interactive Client\n"));
  
  logDebug(`API URL: ${API_BASE_URL}`);
  logDebug(`WS URL: ${WS_BASE_URL}`);
  logDebug(`JWT Token: ${JWT_TOKEN || '(none)'}`);

  if (!JWT_TOKEN) {
    logWarning("You are not logged in.\n");
  } else {
    if (currentUser) {
      logSuccess(`Logged in as: ${currentUser.name || currentUser.email} (${currentUser.id})\n`);
    } else {
      logSuccess("Logged in ✓\n");
    }
  }

  if (isRecording) {
    logInfo(`Recording in progress... (Session: ${currentSessionId?.slice(0, 8)}...)\n`);
  } else if (currentSessionId) {
    logInfo(`Active session: ${currentSessionId.slice(0, 8)}...\n`);
  }

  const choices = [];

  if (!JWT_TOKEN) {
    choices.push({ name: "🔐 Login with Google ID Token", value: "login" });
    choices.push({ name: "🔑 Login with JWT Token (Dev)", value: "login_jwt" });
  } else {
    choices.push({ name: "🎬 Start New Recording Session", value: "create" });
    choices.push({ name: "📚 View My Notes", value: "list" });
    choices.push({ name: "🔖 Manage Keyword Packs", value: "keywordpacks" });
    choices.push({ name: "🌐 Manage External Resources", value: "resources" });
  }

  choices.push({ name: "🚪 Exit", value: "exit" });

  const action = await select({
    message: "What would you like to do?",
    choices,
  });

  switch (action) {
    case "login":
      await loginWithGoogle();
      break;
    case "login_jwt":
      await loginWithJWT();
      break;
    case "create":
      await createSession();
      break;
    case "list":
      await listNotes();
      break;
    case "keywordpacks":
      await manageKeywordPacks();
      break;
    case "resources":
      await manageExternalResources();
      break;
    case "exit":
      if (isRecording) {
        stopRecording();
      }
      console.log(chalk.cyan("\n👋 Goodbye!\n"));
      process.exit(0);
  }

  // Wait a bit before showing menu again
  await new Promise((resolve) => setTimeout(resolve, 500));
  await mainMenu();
}

// Handle Ctrl+C
process.on("SIGINT", async () => {
  console.log("\n");
  if (isRecording) {
    logWarning("Recording interrupted!");

    const shouldSave = await confirm({
      message: "Save recording before exit?",
      default: true,
    });

    if (shouldSave) {
      await stopAndSaveRecording();
    } else {
      stopRecording();
    }
  }

  console.log(chalk.cyan("\n👋 Goodbye!\n"));
  process.exit(0);
});

// Start the app
mainMenu().catch((e) => {
  logError(`Fatal error: ${e}`);
  process.exit(1);
});

