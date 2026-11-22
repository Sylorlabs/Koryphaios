// Answer a pending Koryphaios question over WebSocket.
// Usage: bun scripts/ws-answer.ts <sessionId> <bearerToken> <questionId> <selection>
const [sessionId, token, questionId, selection] = process.argv.slice(2);
const ws = new WebSocket(`ws://localhost:3101/ws`, { headers: { authorization: token } });
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe_session', sessionId }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'user_input', sessionId, questionId, selection }));
    console.log(`[ws] answered ${questionId} with: ${selection}`);
  }, 500);
});
ws.addEventListener('message', (event) => {
  let msg;
  try {
    msg = JSON.parse(String(event.data));
  } catch {
    return;
  }
  if (msg.type === 'stream.delta' || msg.type === 'ping') return;
  console.log(`[ws] ${msg.type} ${JSON.stringify(msg.payload ?? {}).slice(0, 250)}`);
});
setTimeout(() => process.exit(0), 15000);
