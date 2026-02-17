#!/usr/bin/env bun
// Eval Runner - Runs benchmark tasks against Koryphaios

import { BENCHMARK_TASKS, evaluateOutput, generateReport, formatReport } from "../src/eval/benchmark";

const API_BASE = process.env.KORYPHAIOS_URL || "http://localhost:3001";

async function createSession(): Promise<string> {
  const response = await fetch(`${API_BASE}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data.token;
}

async function sendMessage(token: string, sessionId: string, content: string): Promise<string> {
  const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ content }),
  });
  
  if (!response.ok) {
    throw new Error(`Failed to send message: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data.id;
}

async function waitForCompletion(sessionId: string, token: string, timeoutMs: number): Promise<string> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to get messages: ${response.statusText}`);
    }
    
    const data = await response.json();
    const messages = data.data;
    
    // Check if the last message is from assistant (meaning it's complete)
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === "assistant") {
      // Extract content from blocks
      const content = lastMessage.content
        .map((block: any) => block.text || "")
        .join("\n");
      return content;
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error("Timeout waiting for completion");
}

async function runTask(task: typeof BENCHMARK_TASKS[0]): Promise<any> {
  console.log(`\nRunning task: ${task.name}...`);
  const startTime = Date.now();
  
  try {
    const token = await createSession();
    const sessionId = token.split(".")[0]; // Extract session ID from token
    
    await sendMessage(token, sessionId, task.description);
    
    const output = await waitForCompletion(sessionId, token, task.timeout || 30000);
    
    const success = task.expectedKeywords 
      ? evaluateOutput(output, task.expectedKeywords)
      : output.length > 0;
    
    return {
      taskId: task.id,
      success,
      durationMs: Date.now() - startTime,
      turns: 1,
      output,
    };
  } catch (error: any) {
    return {
      taskId: task.id,
      success: false,
      durationMs: Date.now() - startTime,
      turns: 1,
      error: error.message,
    };
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  KORYPHAIOS EVALUATION SUITE");
  console.log("═══════════════════════════════════════════════════");
  
  // Check if server is running
  try {
    const healthResponse = await fetch(`${API_BASE}/health/live`);
    if (!healthResponse.ok) {
      console.error("Server is not healthy. Exiting.");
      process.exit(1);
    }
    console.log("✓ Server is healthy\n");
  } catch (error) {
    console.error("Cannot connect to server. Make sure Koryphaios is running.");
    console.error(`Expected at: ${API_BASE}`);
    process.exit(1);
  }
  
  const results = [];
  
  for (const task of BENCHMARK_TASKS) {
    const result = await runTask(task);
    results.push(result);
    
    const status = result.success ? "✓" : "✗";
    console.log(`  ${status} ${task.id}: ${result.success ? "PASS" : "FAIL"} (${(result.durationMs / 1000).toFixed(1)}s)`);
    
    // Add delay between tasks
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  const report = generateReport(results);
  console.log("\n" + formatReport(report));
  
  // Exit with appropriate code
  process.exit(report.passRate >= 70 ? 0 : 1);
}

main().catch(console.error);
