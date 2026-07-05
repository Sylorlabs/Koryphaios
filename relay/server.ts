/**
 * Koryphaios Collaboration Relay Server
 *
 * Brokers WebSocket connections between a Koryphaios host and remote guests.
 * The host makes an outbound WS connection here — no local port exposed.
 * Guests connect via signed invite tokens. Nothing touches the host filesystem.
 */

import { randomBytes, createHmac, timingSafeEqual } from 'crypto';

interface CollaborationPolicy {
  sessionName: string;
  modelCatalog: Array<{ id: string; label: string; provider: string; reasoningLevels: string[] }>;
  joinMode: 'approval' | 'auto';
  defaultTierId: string;
  accessTiers: Array<{ id: string; name: string; color: string; allowedModels: string[]; reasoningByModel: Record<string, string[]>; permissions: Record<string, any> }>;
  allowedModels: string[];
  allowPrompts: boolean;
  requirePromptApproval: boolean;
  showDiffs: boolean;
  showAgentStatus: boolean;
  showParticipants: boolean;
}
const DEFAULT_POLICY: CollaborationPolicy = {
  sessionName: 'Team session', modelCatalog: [], joinMode: 'approval', defaultTierId: 'viewer', accessTiers: [
    { id: 'viewer', name: 'Viewer', color: '#60a5fa', allowedModels: [], reasoningByModel: {}, permissions: { viewChat: true, viewSystemMessages: false, viewDiffs: true, viewAgentStatus: true, viewParticipants: true, submitPrompts: false, autoExecutePrompts: false, useTools: false, fullSystemAccess: false, readPaths: [], writePaths: [], commandAllowlist: [], commandBlocklist: [] } },
    { id: 'collaborator', name: 'Collaborator', color: '#f59e0b', allowedModels: [], reasoningByModel: {}, permissions: { viewChat: true, viewSystemMessages: false, viewDiffs: true, viewAgentStatus: true, viewParticipants: true, submitPrompts: true, autoExecutePrompts: false, useTools: false, fullSystemAccess: false, readPaths: [], writePaths: [], commandAllowlist: [], commandBlocklist: [] } },
    { id: 'yolo', name: 'YOLO', color: '#ef4444', allowedModels: ['*'], reasoningByModel: {}, permissions: { viewChat: true, viewSystemMessages: true, viewDiffs: true, viewAgentStatus: true, viewParticipants: true, submitPrompts: true, autoExecutePrompts: true, useTools: true, fullSystemAccess: true, readPaths: ['**'], writePaths: ['**'], commandAllowlist: ['*'], commandBlocklist: [] } },
  ],
  allowedModels: [], allowPrompts: true, requirePromptApproval: true,
  showDiffs: true, showAgentStatus: true, showParticipants: true,
};

// ─── Config ─────────────────────────────────────────────────────────────────

const HOST_SECRET = process.env.HOST_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = Number(process.env.PORT || 8080);

if (!HOST_SECRET || !JWT_SECRET) {
  console.error('FATAL: HOST_SECRET and JWT_SECRET env vars are required');
  process.exit(1);
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface WsData {
  sessionId: string;
  role: 'host' | 'guest';
  guestId: string;
  name: string;
  tierId: string;
  admitted: boolean;
}

interface Session {
  id: string;
  hostWs: ReturnType<typeof Bun.serve> extends { upgrade: (...a: any[]) => any } ? any : any;
  guests: Map<string, { ws: any; name: string; tierId: string; admitted: boolean }>;
  history: object[];
  createdAt: number;
  joinCode: string;
  policy: CollaborationPolicy;
}

const sessions = new Map<string, Session>();

function makeJoinCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do code = Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  while ([...sessions.values()].some(s => s.joinCode === code));
  return code;
}

function tierFor(session: Session, tierId: string) {
  return session.policy.accessTiers.find(t => t.id === tierId)
    ?? session.policy.accessTiers.find(t => t.id === session.policy.defaultTierId)
    ?? session.policy.accessTiers[0];
}

function pathAllowed(path: string, patterns: string[]): boolean {
  if (patterns.includes('**')) return true;
  const clean = path.replace(/^\.\//, '');
  return patterns.some(pattern => {
    const prefix = pattern.replace(/\*\*?$/, '').replace(/^\.\//, '');
    return clean === prefix.replace(/\/$/, '') || clean.startsWith(prefix);
  });
}

function eventAllowed(event: any, tier: ReturnType<typeof tierFor>): boolean {
  if (!tier) return false;
  const p = tier.permissions;
  if (event.type === 'chat') return p.viewChat !== false;
  if (event.type === 'diff') return p.viewDiffs !== false && pathAllowed(String(event.path || ''), p.readPaths?.length ? p.readPaths : ['**']);
  if (event.type === 'agent-status') return p.viewAgentStatus !== false;
  if (event.type === 'log') return p.viewSystemMessages === true;
  return true;
}

// ─── JWT (simple HMAC-based, no deps) ───────────────────────────────────────

function sign(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', JWT_SECRET!).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token: string): Record<string, any> | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', JWT_SECRET!).update(data).digest('base64url');
  try {
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (parsed.exp && parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function checkHostSecret(req: Request): boolean {
  const header = req.headers.get('x-host-secret') ?? '';
  try {
    return timingSafeEqual(Buffer.from(header), Buffer.from(HOST_SECRET!));
  } catch {
    return false;
  }
}

// ─── Guest HTML ─────────────────────────────────────────────────────────────

const GUEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Koryphaios — Live Session</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0a0a0f;color:#e2e8f0;font-family:'SF Mono','Fira Code',monospace;min-height:100vh;display:flex;flex-direction:column}
    header{background:#111118;border-bottom:1px solid #1e1e2e;padding:16px 24px;display:flex;align-items:center;gap:12px;flex-shrink:0}
    header h1{font-size:14px;font-weight:700;letter-spacing:.1em;color:#c890ab}
    .badge{background:#1e1e2e;border:1px solid #2d2d3e;padding:3px 10px;border-radius:20px;font-size:11px;color:#64748b}
    .badge.live{border-color:#22c55e40;color:#22c55e;background:#22c55e10}
    .badge.offline{color:#ef444480;border-color:#ef444420;background:#ef444408}
    #status-bar{padding:5px 16px;font-size:11px;border-bottom:1px solid #1e1e2e;background:#0d0d14;color:#64748b;flex-shrink:0}
    #log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:6px}
    .entry{padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.6;border:1px solid transparent}
    .entry.chat{background:#111118;border-color:#1e1e2e}
    .entry.chat .who{font-size:10px;color:#64748b;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em}
    .entry.chat .who.human{color:#c890ab}
    .entry.chat .who.agent{color:#60a5fa}
    .entry.log-line{color:#475569;font-size:11px}
    .entry.diff-view{background:#0d1117;border-color:#1e2a1e}
    .entry.diff-view .fname{font-size:11px;color:#22c55e;margin-bottom:8px}
    pre.diff{white-space:pre;font-size:11px;line-height:1.4;overflow-x:auto}
    .da{color:#22c55e}.dr{color:#ef4444}.dc{color:#475569}
    .entry.status-entry{background:#0d0d14;border-color:#1e1e2e;display:flex;align-items:center;gap:8px;font-size:11px;color:#94a3b8}
    .dot{width:6px;height:6px;border-radius:50%;background:#22c55e;flex-shrink:0;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .entry.pending{background:#1a1208;border-color:#ca8a0430}
    .entry.pending .who{color:#ca8a04}
    footer{padding:12px 24px;border-top:1px solid #1e1e2e;background:#111118;flex-shrink:0}
    .input-row{display:flex;gap:8px}
    #prompt-in{flex:1;background:#0d0d14;border:1px solid #1e1e2e;border-radius:8px;padding:8px 12px;color:#e2e8f0;font-family:inherit;font-size:13px;outline:none;resize:none;height:40px}
    #prompt-in:focus{border-color:#c890ab40}
    #send-btn{background:#c890ab;color:#0a0a0f;border:none;border-radius:8px;padding:0 20px;font-weight:700;font-size:12px;cursor:pointer;white-space:nowrap}
    #send-btn:disabled{opacity:.35;cursor:not-allowed}
    .viewer-note{color:#475569;font-size:11px;text-align:center;padding:8px 0}
    .k-select{position:relative;min-width:170px;max-width:240px}.k-select-trigger{height:40px;width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;background:#0d0d14;border:1px solid #2d2d3e;border-radius:9px;color:#e2e8f0;padding:0 11px;font:11px inherit;cursor:pointer}.k-select-trigger:after{content:'⌄';color:#77778a}.k-select-menu{display:none;position:absolute;bottom:46px;left:0;z-index:30;min-width:100%;max-height:240px;overflow:auto;padding:5px;background:#16161f;border:1px solid #343442;border-radius:11px;box-shadow:0 18px 50px #0009}.k-select.open .k-select-menu{display:block}.k-select-option{display:block;width:100%;border:0;background:transparent;color:#c9c9d3;padding:9px 10px;border-radius:7px;text-align:left;font:11px inherit;cursor:pointer;white-space:nowrap}.k-select-option:hover,.k-select-option.selected{background:#292936;color:#fff}
    #policy-bar{display:flex;gap:8px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid #1e1e2e;background:#0d0d14}
    .policy-chip{border:1px solid #2d2d3e;border-radius:999px;padding:3px 9px;font-size:10px;color:#94a3b8}.policy-chip.on{border-color:#22c55e50;color:#86efac}.policy-chip.off{color:#64748b;text-decoration:line-through}
    #connect-screen{position:fixed;inset:0;background:#0a0a0f;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
    #connect-screen h2{font-size:18px;color:#c890ab}
    #connect-screen p{color:#64748b;font-size:13px;max-width:360px;text-align:center}
    .spinner{width:24px;height:24px;border:2px solid #1e1e2e;border-top-color:#c890ab;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .hidden{display:none!important}
    #participants{display:flex;gap:6px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid #1e1e2e;background:#0d0d14;flex-shrink:0}
    .participant{background:#1e1e2e;border-radius:20px;padding:2px 10px;font-size:10px;color:#94a3b8}
    :root{color-scheme:dark;--panel:#111117;--line:#292936;--text:#f4f4f5;--muted:#9292a3;--accent:#d49ab8}
    body{background:radial-gradient(circle at 50% -20%,#281724 0,transparent 38%),#08080c;color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}
    header{background:#0f0f15e8;backdrop-filter:blur(18px);border-color:var(--line);padding:14px clamp(16px,3vw,32px);position:sticky;top:0;z-index:5}.brand-mark{width:30px;height:30px;border-radius:10px;background:linear-gradient(135deg,#e4b3cc,#9f5c81);display:grid;place-items:center;color:#160d13;font-weight:900}header h1{color:#f3d6e5}
    #log{padding:24px clamp(16px,5vw,72px);gap:12px;max-width:1200px;width:100%;margin:0 auto}.entry{padding:14px 16px;border-radius:14px;font-size:13px;box-shadow:0 8px 30px #0002}.entry.chat{background:linear-gradient(145deg,#15151d,#111118);border-color:var(--line)}.entry.diff-view{border-color:#23402d;border-radius:14px}.entry.diff-view .fname{display:flex;justify-content:space-between;gap:12px;font-size:12px}.diff-stats{color:#94a3b8;font-size:10px}
    footer{padding:14px clamp(16px,5vw,72px);border-color:var(--line);background:#0f0f15e8;backdrop-filter:blur(18px)}footer>*{max-width:1056px;margin-left:auto;margin-right:auto}
    #connect-screen{background:radial-gradient(circle at 50% 20%,#351c2e 0,transparent 42%),#08080c;padding:24px;z-index:20}.join-card{width:min(440px,100%);border:1px solid #343442;background:#111117e8;backdrop-filter:blur(20px);border-radius:24px;padding:34px;box-shadow:0 30px 90px #0008;text-align:center}.join-logo{width:58px;height:58px;margin:0 auto 18px;border-radius:18px;background:linear-gradient(135deg,#edc0d7,#9f5c81);display:grid;place-items:center;color:#160d13;font-size:24px;font-weight:900}#connect-screen h2{font-size:22px;color:#f6e8ef;margin-bottom:8px}#connect-screen p{color:#9292a3;font-size:13px;line-height:1.5;margin:0 auto 20px}#guest-name{width:100%;border:1px solid #343442;background:#0b0b10;color:#f4f4f5;border-radius:12px;padding:13px 14px;font:14px inherit;outline:none;margin-bottom:10px}#guest-name:focus{border-color:#c890ab}#join-btn{width:100%;border:0;border-radius:12px;padding:13px;background:linear-gradient(135deg,#dba8c2,#b87398);color:#170d13;font:700 13px inherit;cursor:pointer}.join-security{font-size:10px;color:#626274;margin-top:14px}
    #participants,#policy-bar{padding-left:clamp(16px,3vw,32px);padding-right:clamp(16px,3vw,32px)}#access-panel{padding:12px clamp(16px,3vw,32px);border-bottom:1px solid var(--line);background:#0b0b10;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.access-item{border:1px solid #252532;background:#111117;border-radius:10px;padding:9px 11px}.access-label{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#666678}.access-value{font:11px 'SF Mono',monospace;color:#c9c9d3;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    @media(max-width:640px){.input-row{flex-wrap:wrap}.k-select{width:100%;max-width:none}#send-btn{height:40px}.join-card{padding:26px 20px}}
    .native-cta{margin-left:auto;color:#d9a9c2;text-decoration:none;font-size:11px;font-weight:700;border:1px solid #56384a;border-radius:9px;padding:7px 10px}.native-cta:hover{background:#c890ab15}
  </style>
</head>
<body>
  <div id="connect-screen">
    <div class="join-card">
      <div class="join-logo">K</div>
      <div class="spinner hidden" id="spinner"></div>
      <h2>Join live workspace</h2>
      <p id="connect-msg">You were invited to a Koryphaios team session. The host controls your access.</p>
      <div id="join-form"><input id="guest-name" maxlength="40" autocomplete="name" placeholder="Your display name" /><button id="join-btn">Continue to session</button><div class="join-security">🔒 Signed invite · Host-controlled permissions</div></div>
    </div>
  </div>
  <header class="hidden" id="app-header">
    <span class="brand-mark">K</span>
    <h1>KORYPHAIOS</h1>
    <span class="badge live" id="live-badge">● LIVE</span>
    <span class="badge" id="role-badge"></span>
    <span class="badge" id="session-badge">Session</span>
    <a class="native-cta" href="https://koryphaios.com" target="_blank" rel="noopener noreferrer">For full features, get the Koryphaios app →</a>
  </header>
  <div id="status-bar" class="hidden"></div>
  <div id="participants" class="hidden"></div>
  <div id="policy-bar" class="hidden"></div>
  <div id="access-panel" class="hidden"></div>
  <div id="log" class="hidden"></div>
  <footer class="hidden" id="footer">
    <div id="viewer-note" class="viewer-note hidden">You have viewer access — read only</div>
    <div class="input-row" id="input-row" style="display:none">
      <div class="k-select" id="model-select"><button type="button" class="k-select-trigger">Host selects model</button><div class="k-select-menu"></div></div>
      <div class="k-select" id="reasoning-select"><button type="button" class="k-select-trigger">Default reasoning</button><div class="k-select-menu"></div></div>
      <textarea id="prompt-in" placeholder="Send a prompt to the host's agent..."></textarea>
      <button id="send-btn">Send</button>
    </div>
  </footer>

  <script>
  (function(){
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    let name = (params.get('name') || '').slice(0,40);
    if(!token){ setMsg('Invalid link — no token.'); spin(false); return; }

    const logEl = document.getElementById('log');
    const statusBar = document.getElementById('status-bar');
    const participantsEl = document.getElementById('participants');
    let role = 'viewer';
    let participants = {};
    let ws;
    let peer;
    let dataChannel;
    let policy = {};
    let currentTier = null;

    function selectValue(id){return document.getElementById(id).dataset.value||'';}
    function setSelectOptions(id,options,onchange){
      var root=document.getElementById(id),trigger=root.querySelector('.k-select-trigger'),menu=root.querySelector('.k-select-menu');menu.innerHTML='';
      var current=root.dataset.value||'';if(!options.some(function(option){return option.value===current;}))current=options[0]&&options[0].value||'';root.dataset.value=current;
      options.forEach(function(option){var button=document.createElement('button');button.type='button';button.className='k-select-option'+(option.value===current?' selected':'');button.textContent=option.label;button.onclick=function(){root.dataset.value=option.value;trigger.textContent=option.label;root.classList.remove('open');setSelectOptions(id,options,onchange);if(onchange)onchange();};menu.appendChild(button);if(option.value===current)trigger.textContent=option.label;});
      trigger.onclick=function(){document.querySelectorAll('.k-select.open').forEach(function(item){if(item!==root)item.classList.remove('open');});root.classList.toggle('open');};
    }
    document.addEventListener('click',function(event){if(!event.target.closest('.k-select'))document.querySelectorAll('.k-select.open').forEach(function(item){item.classList.remove('open');});});

    function renderReasoning(){
      var model=selectValue('model-select'); var select=document.getElementById('reasoning-select');
      var levels=currentTier&&currentTier.reasoningByModel&&currentTier.reasoningByModel[model]||[];
      setSelectOptions('reasoning-select',[{value:'',label:'Default reasoning'}].concat(levels.map(function(level){return{value:level,label:level==='off'?'Reasoning off':level.charAt(0).toUpperCase()+level.slice(1)+' reasoning'};})));
      select.style.display=levels.length?'':'none';
    }

    function renderPolicy(){
      if(policy.sessionName){document.getElementById('session-badge').textContent=policy.sessionName;document.title=policy.sessionName+' — Koryphaios';}
      var bar=document.getElementById('policy-bar'); bar.innerHTML='';
      var permissions=currentTier&&currentTier.permissions||{};
      [['viewChat','Chat'],['viewDiffs','Code changes'],['viewSystemMessages','System messages'],['viewAgentStatus','Agent activity'],['viewParticipants','Participants'],['submitPrompts','Prompts'],['useTools','Tools']].forEach(function(item){
        var chip=document.createElement('span'); var on=permissions[item[0]]===true;
        chip.className='policy-chip '+(on?'on':'off'); chip.textContent=(on?'✓ ':'— ')+item[1]; bar.appendChild(chip);
      });
      var tierModels=(currentTier&&currentTier.allowedModels)||[]; var selectable=tierModels.includes('*')?(policy.modelCatalog||[]).map(function(model){return model.id;}):tierModels;
      setSelectOptions('model-select',[{value:'',label:'Host selects model'}].concat(selectable.map(function(model){var def=(policy.modelCatalog||[]).find(function(item){return item.id===model;});return{value:model,label:def?def.label+' · '+def.provider:(model.split(':').slice(1).join(':')||model)};})),renderReasoning);
      renderReasoning();
      participantsEl.style.display = permissions.viewParticipants===false ? 'none' : '';
      document.getElementById('input-row').style.display = currentTier && currentTier.permissions.submitPrompts ? 'flex' : 'none';
      var panel=document.getElementById('access-panel');
      var models=((currentTier&&currentTier.allowedModels)||[]); var reads=permissions.readPaths||[]; var writes=permissions.writePaths||[];
      panel.innerHTML='<div class="access-item"><div class="access-label">Access profile</div><div class="access-value">'+h(currentTier&&currentTier.name||role)+'</div></div>'+
        '<div class="access-item"><div class="access-label">Models</div><div class="access-value" title="'+h(models.join(', '))+'">'+h(models.includes('*')?'All host models':models.length?models.join(', '):'Host-selected only')+'</div></div>'+
        '<div class="access-item"><div class="access-label">Readable paths</div><div class="access-value" title="'+h(reads.join(', '))+'">'+h(reads.length?reads.join(', '):'None')+'</div></div>'+
        '<div class="access-item"><div class="access-label">Writable paths</div><div class="access-value" title="'+h(writes.join(', '))+'">'+h(writes.length?writes.join(', '):'None')+'</div></div>'+
        '<div class="access-item"><div class="access-label">Allowed commands</div><div class="access-value">'+h((permissions.commandAllowlist||[]).length?(permissions.commandAllowlist||[]).join(', '):'Standard sandbox')+'</div></div>'+
        '<div class="access-item"><div class="access-label">Blocked commands</div><div class="access-value">'+h((permissions.commandBlocklist||[]).length?(permissions.commandBlocklist||[]).join(', '):'None added by host')+'</div></div>';
    }

    function spin(v){ document.getElementById('spinner').style.display = v?'':'none'; }
    function setMsg(t){ document.getElementById('connect-msg').textContent = t; }
    function setStatus(t){ statusBar.textContent = t; }
    function h(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function renderParticipants(){
      participantsEl.innerHTML = '';
      Object.values(participants).forEach(function(p){
        var el = document.createElement('span');
        el.className='participant';
        el.textContent = (p.name||'?') + ' · ' + (p.role||'viewer');
        participantsEl.appendChild(el);
      });
    }

    function addEntry(cls, html){
      var d = document.createElement('div');
      d.className = 'entry ' + cls;
      d.innerHTML = html;
      logEl.appendChild(d);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function sendToHost(payload){
      var encoded=JSON.stringify(payload);
      if(dataChannel&&dataChannel.readyState==='open'){dataChannel.send(encoded);return;}
      if(ws&&ws.readyState===1)ws.send(encoded);
    }

    async function startPeer(){
      if(peer||!ws||ws.readyState!==1||typeof RTCPeerConnection==='undefined')return;
      try{
        peer=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
        dataChannel=peer.createDataChannel('koryphaios',{ordered:true});
        dataChannel.onopen=function(){setStatus('Connected directly · relay ready');};
        dataChannel.onclose=function(){setStatus('Connected via relay');};
        dataChannel.onmessage=function(event){try{handleMsg(JSON.parse(String(event.data)));}catch(err){}};
        peer.onicecandidate=function(event){if(event.candidate&&ws&&ws.readyState===1)ws.send(JSON.stringify({type:'rtc-ice',candidate:event.candidate.toJSON()}));};
        var offer=await peer.createOffer();await peer.setLocalDescription(offer);
        ws.send(JSON.stringify({type:'rtc-offer',description:peer.localDescription}));
      }catch(err){peer=null;dataChannel=null;setStatus('Connected via relay');}
    }

    function handleMsg(msg){
      if(msg.type==='init'){
        document.getElementById('connect-screen').classList.add('hidden');
        role = msg.role;
        currentTier = msg.tier || (msg.policy && msg.policy.accessTiers || []).find(function(t){return t.id===role;}) || null;
        document.getElementById('role-badge').textContent = (currentTier&&currentTier.name||role).toUpperCase();
        document.getElementById('session-badge').textContent = msg.sessionName || ('Viewing ' + h(msg.hostName||'host') + "'s session");
        document.title = (msg.sessionName || 'Live Session') + ' — Koryphaios';
        participants = msg.participants || {};
        policy = msg.policy || {};
        renderPolicy();
        renderParticipants();
        if(role==='viewer'){
          document.getElementById('viewer-note').classList.remove('hidden');
        } else if(currentTier && currentTier.permissions.submitPrompts) {
          document.getElementById('input-row').style.display='flex';
        }
        (msg.history||[]).forEach(handleMsg);
        startPeer();
      } else if(msg.type==='chat'){
        var cls = msg.from==='human'?'human':'agent';
        addEntry('chat','<div class="who '+cls+'">'+h(msg.from==='human'?'👤 User':'🤖 Agent')+'</div><div>'+h(msg.content)+'</div>');
      } else if(msg.type==='log'){
        addEntry('log-line', h(msg.content));
      } else if(msg.type==='diff'){
        var rawLines=(msg.diff||'').split('\\n'); var added=rawLines.filter(function(l){return l.startsWith('+')&&!l.startsWith('+++')}).length; var removed=rawLines.filter(function(l){return l.startsWith('-')&&!l.startsWith('---')}).length;
        var lines = rawLines.map(function(l){
          if(l.startsWith('+')) return '<span class="da">'+h(l)+'</span>';
          if(l.startsWith('-')) return '<span class="dr">'+h(l)+'</span>';
          return '<span class="dc">'+h(l)+'</span>';
        }).join('\\n');
        addEntry('diff-view','<div class="fname"><span>📄 '+h(msg.path)+'</span><span class="diff-stats">+'+added+' / −'+removed+'</span></div><pre class="diff">'+lines+'</pre>');
      } else if(msg.type==='agent-status'){
        setStatus(msg.status||'');
        addEntry('status-entry','<span class="dot"></span>'+h(msg.status));
      } else if(msg.type==='approval-request'){
        addEntry('pending','<div class="who" style="color:#ca8a04">⏳ Pending approval from '+h(msg.name||'guest')+'</div><div>'+h(msg.content)+'</div>');
      } else if(msg.type==='approval-result'){
        addEntry('log-line', msg.approved ? '✅ Prompt approved' : '❌ Prompt rejected');
      } else if(msg.type==='policy-updated'){
        policy=msg.policy||{}; renderPolicy(); addEntry('log-line','Host updated team access controls');
      } else if(msg.type==='tier-updated'){
        currentTier=msg.tier; role=currentTier.id; policy=msg.policy||policy; document.getElementById('role-badge').textContent=currentTier.name.toUpperCase(); renderPolicy(); addEntry('log-line','Host assigned your access tier: '+h(currentTier.name));
      } else if(msg.type==='join-pending'){
        document.getElementById('connect-screen').classList.remove('hidden'); setMsg(msg.message||'Waiting for host approval'); spin(true);
      } else if(msg.type==='join-rejected'){
        document.getElementById('connect-screen').classList.remove('hidden'); setMsg('The host declined this join request.'); spin(false);
      } else if(msg.type==='guest-joined'){
        participants[msg.guestId] = {name:msg.name, role:msg.role};
        renderParticipants();
        addEntry('log-line','👤 '+h(msg.name)+' joined as '+h(msg.role));
      } else if(msg.type==='guest-left'){
        delete participants[msg.guestId];
        renderParticipants();
        addEntry('log-line','👤 '+h(msg.name)+' left');
      } else if(msg.type==='host-disconnected'){
        setStatus('Host disconnected');
        document.getElementById('live-badge').textContent='○ OFFLINE';
        document.getElementById('live-badge').className='badge offline';
      } else if(msg.type==='rtc-answer'&&peer){
        peer.setRemoteDescription(msg.description).catch(function(){});
      } else if(msg.type==='rtc-ice'&&peer&&msg.candidate){
        peer.addIceCandidate(msg.candidate).catch(function(){});
      } else if(msg.type==='error'){
        setMsg(msg.message||'Error');
        spin(false);
      }
    }

    function connect(){
      var proto = location.protocol==='https:'?'wss://':'ws://';
      ws = new WebSocket(proto + location.host + '/ws?token=' + encodeURIComponent(token) + '&name=' + encodeURIComponent(name));
      ws.onopen = function(){
        document.getElementById('connect-screen').classList.add('hidden');
        ['app-header','status-bar','participants','policy-bar','access-panel','log','footer'].forEach(function(id){
          document.getElementById(id).classList.remove('hidden');
        });
        setStatus('Connected');
      };
      ws.onmessage = function(e){
        try{ handleMsg(JSON.parse(e.data)); }catch(err){}
      };
      ws.onclose = function(){
        setStatus('Disconnected');
        document.getElementById('live-badge').textContent='○ OFFLINE';
        document.getElementById('live-badge').className='badge offline';
      };
      ws.onerror = function(){
        setMsg('Connection failed — link may be expired or invalid.');
        spin(false);
      };
    }

    document.getElementById('send-btn').onclick = function(){
      var val = document.getElementById('prompt-in').value.trim();
      if(!val || !ws || ws.readyState!==1) return;
      sendToHost({type:'guest-prompt', content:val, name:name, model:selectValue('model-select'), reasoningLevel:selectValue('reasoning-select')});
      document.getElementById('prompt-in').value='';
    };
    document.getElementById('prompt-in').addEventListener('keydown', function(e){
      if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); document.getElementById('send-btn').click(); }
    });

    function beginJoin(){
      var input=document.getElementById('guest-name'); name=(input.value||name||'Guest').trim().slice(0,40)||'Guest';
      document.getElementById('join-form').classList.add('hidden'); setMsg('Connecting securely…'); spin(true); connect();
    }
    document.getElementById('join-btn').onclick=beginJoin;
    document.getElementById('guest-name').addEventListener('keydown',function(e){if(e.key==='Enter')beginJoin();});
    if(name){document.getElementById('guest-name').value=name;beginJoin();}else{document.getElementById('guest-name').focus();}
  })();
  </script>
</body>
</html>`;

// ─── HTTP + WS Server ────────────────────────────────────────────────────────

const server = Bun.serve<WsData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // CORS for Koryphaios frontend
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-host-secret',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const json = (body: object, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // Health
    if (url.pathname === '/health') {
      return json({ ok: true, sessions: sessions.size });
    }

    // Host creates / retrieves a session
    if (url.pathname === '/session' && req.method === 'POST') {
      if (!checkHostSecret(req)) return json({ ok: false, error: 'Unauthorized' }, 401);
      const body = await req.json().catch(() => ({})) as any;
      const sessionId: string = body.sessionId || randomBytes(12).toString('hex');

      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          id: sessionId,
          hostWs: null,
          guests: new Map(),
          history: [],
          createdAt: Date.now(),
          joinCode: makeJoinCode(),
          policy: { ...DEFAULT_POLICY },
        });
      }

      const sessionToken = sign({
        sessionId,
        role: 'host',
        exp: Date.now() + 48 * 60 * 60 * 1000,
      });

      return json({ ok: true, sessionId, sessionToken, joinCode: sessions.get(sessionId)!.joinCode });
    }

    // Host-owned policy is the relay's source of truth for every guest.
    if (url.pathname.match(/^\/session\/[^/]+\/policy$/) && req.method === 'POST') {
      if (!checkHostSecret(req)) return json({ ok: false, error: 'Unauthorized' }, 401);
      const session = sessions.get(url.pathname.split('/')[2]);
      if (!session) return json({ ok: false, error: 'Session not found' }, 404);
      const patch = await req.json().catch(() => ({})) as Partial<CollaborationPolicy>;
      session.policy = { ...DEFAULT_POLICY, ...session.policy, ...patch, requirePromptApproval: true };
      const update = JSON.stringify({ type: 'policy-updated', policy: session.policy });
      session.guests.forEach(g => {
        if (!session.policy.accessTiers.some(t => t.id === g.tierId)) g.tierId = session.policy.defaultTierId;
        g.ws.data.tierId = g.tierId;
        g.ws.send(update);
        g.ws.send(JSON.stringify({ type: 'tier-updated', tier: tierFor(session, g.tierId), policy: session.policy }));
      });
      return json({ ok: true, policy: session.policy });
    }

    // Native Koryphaios clients exchange a short host code for a signed guest URL.
    if (url.pathname.startsWith('/code/') && req.method === 'GET') {
      const code = decodeURIComponent(url.pathname.slice(6)).trim().toUpperCase();
      const session = [...sessions.values()].find(s => s.joinCode === code);
      if (!session) return json({ ok: false, error: 'Invalid or inactive join code' }, 404);
      const tierId = session.policy.defaultTierId;
      const token = sign({ sessionId: session.id, role: 'guest', tierId, exp: Date.now() + 24 * 60 * 60 * 1000 });
      return json({ ok: true, sessionId: session.id, sessionName: session.policy.sessionName, tierId, inviteUrl: `${url.protocol}//${url.host}/join?token=${encodeURIComponent(token)}` });
    }

    // Host creates an invite link for a session
    if (url.pathname.match(/^\/session\/[^/]+\/invite$/) && req.method === 'POST') {
      if (!checkHostSecret(req)) return json({ ok: false, error: 'Unauthorized' }, 401);
      const sessionId = url.pathname.split('/')[2];
      if (!sessions.has(sessionId)) return json({ ok: false, error: 'Session not found' }, 404);

      const body = await req.json().catch(() => ({})) as any;
      const requestedTier = String(body.tierId || body.role || 'viewer');
      const tierId = sessions.get(sessionId)!.policy.accessTiers.some(t => t.id === requestedTier) ? requestedTier : sessions.get(sessionId)!.policy.defaultTierId;
      const ttlMs = Number(body.ttlMs) || 7 * 24 * 60 * 60 * 1000;

      const inviteToken = sign({ sessionId, role: 'guest', tierId, exp: Date.now() + ttlMs });
      const inviteUrl = `${url.protocol}//${url.host}/join?token=${encodeURIComponent(inviteToken)}`;

      return json({ ok: true, inviteUrl, inviteToken, tierId });
    }

    // Guest join page
    if (url.pathname === '/join') {
      return new Response(GUEST_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token');
      const name = (url.searchParams.get('name') || 'Guest').slice(0, 40);
      if (!token) return new Response('Missing token', { status: 400 });

      const payload = verify(token);
      if (!payload) return new Response('Invalid or expired token', { status: 401 });

      const session = sessions.get(payload.sessionId);
      if (!session) return new Response('Session not found', { status: 404 });

      const upgraded = server.upgrade(req, {
        data: {
          sessionId: payload.sessionId,
          role: payload.role,
          guestId: randomBytes(6).toString('hex'),
          name,
          tierId: payload.tierId || 'viewer',
          admitted: payload.role === 'host',
        } satisfies WsData,
      });
      if (upgraded) return undefined as any;
      return new Response('Upgrade failed', { status: 500 });
    }

    return new Response('Not found', { status: 404 });
  },

  websocket: {
    open(ws) {
      const { sessionId, role, guestId, name, tierId } = ws.data;
      const session = sessions.get(sessionId);
      if (!session) { ws.close(4004, 'Session not found'); return; }

      if (role === 'host') {
        session.hostWs = ws;
        console.log(`[${sessionId}] host connected`);
        // Send pending guest list to host
        const guestList = Array.from(session.guests.entries()).map(([id, g]) => ({
          guestId: id, name: g.name, tierId: g.tierId, admitted: g.admitted,
        }));
        ws.send(JSON.stringify({ type: 'guest-list', guests: guestList }));
      } else {
        const admitted = session.policy.joinMode === 'auto';
        ws.data.admitted = admitted;
        session.guests.set(guestId, { ws, name, tierId, admitted });
        console.log(`[${sessionId}] guest "${name}" (${tierId}) connected`);

        if (!admitted) {
          ws.send(JSON.stringify({ type: 'join-pending', message: 'Waiting for host approval' }));
          session.hostWs?.send(JSON.stringify({ type: 'join-request', guestId, name, tierId }));
          return;
        }

        // Send init + history to new guest
        const participantMap: Record<string, { name: string; role: string }> = {};
        session.guests.forEach((g, id) => { if (g.admitted) participantMap[id] = { name: g.name, role: g.tierId }; });

        ws.send(JSON.stringify({
          type: 'init',
          role: tierId,
          tier: tierFor(session, tierId),
          hostName: 'Host',
          sessionName: session.policy.sessionName,
          participants: session.policy.showParticipants ? participantMap : {},
          history: session.history.filter((event: any) =>
            (event.type !== 'diff' || session.policy.showDiffs) &&
            (event.type !== 'agent-status' || session.policy.showAgentStatus)),
          policy: session.policy,
        }));

        // Notify host and other guests
        const joinMsg = JSON.stringify({ type: 'guest-joined', guestId, name, role: tierId });
        session.hostWs?.send(joinMsg);
        if (session.policy.showParticipants) session.guests.forEach((g, id) => { if (id !== guestId) g.ws.send(joinMsg); });
      }
    },

    message(ws, message) {
      const { sessionId, role, guestId, name } = ws.data;
      const session = sessions.get(sessionId);
      if (!session) return;

      let msg: any;
      try { msg = JSON.parse(String(message)); } catch { return; }

      if (role === 'host') {
        if ((msg.type === 'rtc-answer' || msg.type === 'rtc-ice') && msg.guestId) {
          session.guests.get(String(msg.guestId))?.ws.send(JSON.stringify(msg));
          return;
        }
        if (msg.type === 'join-decision' && msg.guestId) {
          const guest = session.guests.get(String(msg.guestId));
          if (!guest) return;
          if (!msg.approved) { guest.ws.send(JSON.stringify({ type: 'join-rejected' })); guest.ws.close(4003, 'Join rejected'); return; }
          const requestedTier = String(msg.tierId || guest.tierId);
          guest.tierId = session.policy.accessTiers.some(t => t.id === requestedTier) ? requestedTier : session.policy.defaultTierId;
          guest.admitted = true;
          guest.ws.data.tierId = guest.tierId;
          guest.ws.data.admitted = true;
          const tier = tierFor(session, guest.tierId)!;
          guest.ws.send(JSON.stringify({ type: 'init', role: guest.tierId, tier, hostName: 'Host', sessionName: session.policy.sessionName, participants: {}, history: session.history.filter(e => eventAllowed(e, tier)), policy: session.policy }));
          session.guests.forEach(g => { if (g.admitted && tierFor(session, g.tierId)?.permissions.viewParticipants) g.ws.send(JSON.stringify({ type: 'guest-joined', guestId: msg.guestId, name: guest.name, role: guest.tierId })); });
          return;
        }
        if (msg.type === 'assign-tier' && msg.guestId) {
          const guest = session.guests.get(String(msg.guestId));
          if (!guest || !session.policy.accessTiers.some(t => t.id === msg.tierId)) return;
          guest.tierId = String(msg.tierId); guest.ws.data.tierId = guest.tierId;
          guest.ws.send(JSON.stringify({ type: 'tier-updated', tier: tierFor(session, guest.tierId), policy: session.policy }));
          return;
        }
        // Host → broadcast to all guests; also append relevant events to history
        const excluded = new Set(Array.isArray(msg.excludeGuestIds) ? msg.excludeGuestIds.map(String) : []);
        session.guests.forEach((g, id) => {
          if (!excluded.has(id) && g.admitted && eventAllowed(msg, tierFor(session, g.tierId))) {
            const { excludeGuestIds: _excluded, ...payload } = msg;
            g.ws.send(JSON.stringify(payload));
          }
        });

        // Keep a rolling history (last 200 events) for late-joining guests
        if (['chat', 'diff', 'agent-status'].includes(msg.type)) {
          session.history.push(msg);
          if (session.history.length > 200) session.history.shift();
        }

        // Handle approval results directed at specific guests
        if (msg.type === 'approval-result' && msg.guestId) {
          const target = session.guests.get(msg.guestId);
          target?.ws.send(JSON.stringify({ type: 'approval-result', approved: msg.approved }));
        }
      } else {
        const guest = session.guests.get(guestId);
        if (!guest?.admitted) return;
        const tier = tierFor(session, guest.tierId);
        if (msg.type === 'rtc-offer' || msg.type === 'rtc-ice') {
          session.hostWs?.send(JSON.stringify({ ...msg, guestId, tierId: guest.tierId }));
          return;
        }
        // Guest → forward to host only
        if (msg.type === 'guest-prompt' && tier?.permissions.submitPrompts) {
          const requestedModel = String(msg.model || '');
          const model = requestedModel && (tier.allowedModels.includes('*') || tier.allowedModels.includes(requestedModel)) ? requestedModel : '';
          const requestedReasoning = String(msg.reasoningLevel || '');
          const allowedReasoning = model ? (tier.reasoningByModel?.[model] || []) : [];
          const reasoningLevel = requestedReasoning && allowedReasoning.includes(requestedReasoning) ? requestedReasoning : '';
          session.hostWs?.send(JSON.stringify({
            type: 'guest-prompt',
            guestId,
            name,
            role: guest.tierId,
            tierId: guest.tierId,
            autoExecute: tier.permissions.autoExecutePrompts && tier.permissions.fullSystemAccess,
            content: String(msg.content).slice(0, 4000),
            model,
            reasoningLevel,
            commandAllowlist: tier.permissions.commandAllowlist || [],
            commandBlocklist: tier.permissions.commandBlocklist || [],
          }));
        }
      }
    },

    close(ws) {
      const { sessionId, role, guestId, name } = ws.data;
      const session = sessions.get(sessionId);
      if (!session) return;

      if (role === 'host') {
        session.hostWs = null;
        console.log(`[${sessionId}] host disconnected`);
        const msg = JSON.stringify({ type: 'host-disconnected' });
        session.guests.forEach(g => g.ws.send(msg));
      } else {
        session.guests.delete(guestId);
        console.log(`[${sessionId}] guest "${name}" disconnected`);
        const msg = JSON.stringify({ type: 'guest-left', guestId, name });
        session.hostWs?.send(msg);
        session.guests.forEach(g => g.ws.send(msg));
      }
    },
  },
});

// Evict sessions older than 48 hours with no host
setInterval(() => {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff && !s.hostWs) {
      sessions.delete(id);
      console.log(`[${id}] session evicted`);
    }
  }
}, 60 * 60 * 1000);

console.log(`Koryphaios relay running on :${PORT}`);
