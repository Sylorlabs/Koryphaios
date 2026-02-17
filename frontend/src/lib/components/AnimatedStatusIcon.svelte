<script lang="ts">
  import type { AgentStatus } from '@koryphaios/shared';

  interface Props {
    status: AgentStatus;
    size?: number;
    isManager?: boolean;
    static?: boolean;
  }

  let { status, size = 20, isManager = false, static: isStatic = false }: Props = $props();
</script>

<!-- Animated status icons with distinct animations per agent state -->

<div class="status-icon-container {isStatic ? 'static-mode' : ''}" style="width: {size}px; height: {size}px;">
{#if status === 'thinking'}
  <!-- Lightbulb bouncing animation -->
  <div class="status-icon thinking" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <defs>
        <clipPath id="bulb-fill">
          <path d="M12 4a5.5 5.5 0 0 1 3.7 9.6V16.5a1 1 0 0 1-1 1h-5.4a1 1 0 0 1-1-1v-2.9A5.5 5.5 0 0 1 12 4z"/>
        </clipPath>
      </defs>
      <!-- Bulb body -->
      <path d="M12 4a5.5 5.5 0 0 1 3.7 9.6V16.5a1 1 0 0 1-1 1h-5.4a1 1 0 0 1-1-1v-2.9A5.5 5.5 0 0 1 12 4z"
            class="text-yellow-400" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <g clip-path="url(#bulb-fill)">
        <rect x="6.5" y="4" width="11" height="13.5" class="bulb-fill-rect text-yellow-300" fill="currentColor"/>
      </g>
      <!-- Base lines -->
      <path d="M10 17.5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-yellow-400"/>
      <path d="M10.5 19h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" class="text-yellow-400/60"/>
      <!-- Glow rays -->
      <line x1="12" y1="1.5" x2="12" y2="0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-yellow-400 ray"/>
      <line x1="18.5" y1="4" x2="20" y2="2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-yellow-400 ray"/>
      <line x1="5.5" y1="4" x2="4" y2="2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-yellow-400 ray"/>
      <line x1="20.5" y1="9.5" x2="22" y2="9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-yellow-400 ray"/>
      <line x1="3.5" y1="9.5" x2="2" y2="9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-yellow-400 ray"/>
    </svg>
  </div>

{:else if status === 'tool_calling'}
  <!-- Terminal with typing cursor -->
  <div class="status-icon terminal" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.5" class="text-emerald-400"/>
      <path d="M7 9l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-400"/>
      <line x1="13" y1="15" x2="17" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-emerald-300 cursor-blink"/>
    </svg>
  </div>

{:else if status === 'streaming'}
  <!-- Flowing lines animation -->
  <div class="status-icon streaming" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <path d="M4 6h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-blue-400 stream-line line-1"/>
      <path d="M4 10h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-blue-300 stream-line line-2"/>
      <path d="M4 14h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-blue-400 stream-line line-3"/>
      <path d="M4 18h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-blue-300 stream-line line-4"/>
    </svg>
  </div>

{:else if status === 'verifying'}
  <!-- Magnifying glass scanning -->
  <div class="status-icon verifying" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <circle cx="11" cy="11" r="6" stroke="currentColor" stroke-width="1.5" class="text-purple-400"/>
      <path d="M15.5 15.5L20 20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-purple-400"/>
      <path d="M9 11h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-purple-300 scan-line"/>
    </svg>
  </div>

{:else if status === 'compacting'}
  <!-- Hydraulic press animation -->
  <div class="status-icon compacting" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <!-- Press plate (top, animates down) -->
      <rect x="5" y="3" width="14" height="3" rx="1" fill="currentColor" class="text-orange-400 press-plate"/>
      <!-- Content being compressed -->
      <rect x="7" y="10" width="10" height="6" rx="1" stroke="currentColor" stroke-width="1" class="text-orange-300 compress-target" fill="none"/>
      <path d="M9 12h6M9 14h4" stroke="currentColor" stroke-width="1" stroke-linecap="round" class="text-orange-300 compress-target"/>
      <!-- Base plate -->
      <rect x="5" y="19" width="14" height="2" rx="1" fill="currentColor" class="text-orange-400"/>
      <!-- Rails -->
      <line x1="6" y1="5" x2="6" y2="19" stroke="currentColor" stroke-width="1" class="text-orange-400/50"/>
      <line x1="18" y1="5" x2="18" y2="19" stroke="currentColor" stroke-width="1" class="text-orange-400/50"/>
    </svg>
  </div>

{:else if status === 'waiting_user' && isManager}
  <!-- Question mark bouncing (manager only) -->
  <div class="status-icon waiting-user" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" class="text-amber-400 pulse-ring"/>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-400"/>
      <circle cx="12" cy="17" r="0.5" fill="currentColor" class="text-amber-400 dot-bounce"/>
    </svg>
  </div>

{:else if status === 'done'}
  <!-- Checkmark with pop-in -->
  <div class="status-icon done" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" class="text-emerald-500 check-circle"/>
      <path d="M8 12l3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-400 check-mark"/>
    </svg>
  </div>

{:else if status === 'error'}
  <!-- Alert triangle - static, no animation -->
  <div class="status-icon error" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-red-500"/>
      <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="text-red-400"/>
      <circle cx="12" cy="16" r="0.5" fill="currentColor" class="text-red-400"/>
    </svg>
  </div>

{:else if status === 'reading'}
  <!-- Eyeball looking left/right with occasional blink -->
  <div class="status-icon reading" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <!-- Eye outline -->
      <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5" class="text-cyan-400"/>
      <!-- Iris -->
      <circle cx="12" cy="12" r="4" fill="currentColor" class="text-cyan-300 iris"/>
      <!-- Pupil -->
      <circle cx="12" cy="12" r="2" fill="currentColor" class="text-slate-900"/>
      <!-- Highlight -->
      <circle cx="13" cy="11" r="0.8" fill="currentColor" class="text-white highlight"/>
      <!-- Eyelid for blink -->
      <path d="M4 12h16" stroke="currentColor" stroke-width="1.5" class="text-cyan-400 eyelid" stroke-linecap="round"/>
    </svg>
  </div>

{:else if status === 'writing'}
  <!-- Pen writing animation -->
  <div class="status-icon writing" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <!-- Paper/document -->
      <rect x="4" y="4" width="14" height="16" rx="1" stroke="currentColor" stroke-width="1.5" class="text-amber-400"/>
      <!-- Lines on paper -->
      <line x1="7" y1="9" x2="15" y2="9" stroke="currentColor" stroke-width="1" class="text-amber-300 paper-line"/>
      <line x1="7" y1="13" x2="15" y2="13" stroke="currentColor" stroke-width="1" class="text-amber-300 paper-line"/>
      <line x1="7" y1="17" x2="12" y2="17" stroke="currentColor" stroke-width="1" class="text-amber-300 paper-line"/>
      <!-- Pen body -->
      <line x1="18" y1="6" x2="12" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="text-violet-400 pen-body"/>
      <!-- Pen tip -->
      <path d="M12 18l-1.5-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-violet-300 pen-tip"/>
      <!-- Ink line appearing -->
      <line x1="8" y1="9" x2="10" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="text-violet-500 ink-line"/>
    </svg>
  </div>

{:else}
  <!-- Idle: subtle breathing dot -->
  <div class="status-icon idle" style="width: {size}px; height: {size}px;">
    <svg viewBox="0 0 24 24" fill="none" width={size} height={size}>
      <circle cx="12" cy="12" r="4" class="text-[var(--color-text-muted)] idle-breathe" fill="currentColor" opacity="0.3"/>
    </svg>
  </div>
{/if}
</div>

<style>
  .status-icon-container {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .static-mode *, .static-mode {
    animation: none !important;
    stroke-dashoffset: 0 !important;
    opacity: 1 !important;
  }

  .status-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  /* ── Thinking: Lightbulb bounce ─────────────────── */
  .thinking {
    animation: lightbulb-bounce 1.2s ease-in-out infinite;
  }
  .thinking .ray {
    animation: ray-appear 1.2s ease-in-out infinite;
  }
  .thinking .bulb-fill-rect {
    animation: bulb-fill 1.2s ease-in-out infinite;
  }
  @keyframes lightbulb-bounce {
    0%, 100% { transform: translateY(6px); }
    30% { transform: translateY(3px) rotate(-5deg); }
    60% { transform: translateY(5px) rotate(3deg); }
  }
  @keyframes ray-appear {
    0%, 100% { opacity: 0; transform: scale(0.5); }
    20% { opacity: 0.3; transform: scale(0.7); }
    30% { opacity: 1; transform: scale(1); }
    40% { opacity:0.3; transform: scale(0.7); }
    50% { opacity: 0; transform: scale(0.5); }
  }
  @keyframes bulb-fill {
    0%, 100% { y: 17.5; height: 0; opacity: 0; }
    25% { y: 14; height: 3.5; opacity: 0.3; }
    35%, 50% { y: 4; height: 13.5; opacity: 1; }
    65% { y: 10; height: 7.5; opacity: 0.5; }
  }

  /* ── Terminal: typing cursor ────────────────────── */
  .terminal {
    animation: terminal-subtle 2s ease-in-out infinite;
  }
  .terminal .cursor-blink {
    animation: blink 0.8s step-end infinite;
  }
  @keyframes terminal-subtle {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.03); }
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  /* ── Streaming: flowing lines ───────────────────── */
  .stream-line {
    stroke-dasharray: 20;
    stroke-dashoffset: 20;
  }
  .line-1 { animation: stream-flow 1.5s ease-in-out infinite; }
  .line-2 { animation: stream-flow 1.5s ease-in-out infinite 0.2s; }
  .line-3 { animation: stream-flow 1.5s ease-in-out infinite 0.4s; }
  .line-4 { animation: stream-flow 1.5s ease-in-out infinite 0.6s; }
  @keyframes stream-flow {
    0% { stroke-dashoffset: 20; opacity: 0.3; }
    50% { stroke-dashoffset: 0; opacity: 1; }
    100% { stroke-dashoffset: -20; opacity: 0.3; }
  }

  /* ── Verifying: magnifying glass scan ───────────── */
  .verifying {
    animation: mag-scan 2s ease-in-out infinite;
  }
  .verifying .scan-line {
    animation: scan-sweep 1.5s ease-in-out infinite;
  }
  @keyframes mag-scan {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(2px); }
    75% { transform: translateX(-2px); }
  }
  @keyframes scan-sweep {
    0%, 100% { transform: translateY(-2px); opacity: 0.4; }
    50% { transform: translateY(2px); opacity: 1; }
  }

  /* ── Compacting: hydraulic press ────────────────── */
  .compacting .press-plate {
    animation: press-down 1.4s ease-in-out infinite;
  }
  .compacting .compress-target {
    animation: compress-squish 1.4s ease-in-out infinite;
  }
  @keyframes press-down {
    0%, 100% { transform: translateY(0); }
    40%, 60% { transform: translateY(5px); }
  }
  @keyframes compress-squish {
    0%, 100% { transform: scaleY(1); }
    40%, 60% { transform: scaleY(0.6); }
  }

  /* ── Waiting user: question mark bounce ─────────── */
  .waiting-user {
    animation: question-bounce 1.5s ease-in-out infinite;
  }
  .waiting-user .pulse-ring {
    animation: ring-pulse 1.5s ease-in-out infinite;
  }
  .waiting-user .dot-bounce {
    animation: dot-bob 1s ease-in-out infinite;
  }
  @keyframes question-bounce {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
  }
  @keyframes ring-pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }
  @keyframes dot-bob {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  /* ── Done: checkmark pop-in ─────────────────────── */
  .done .check-circle {
    animation: circle-draw 0.5s ease-out forwards;
    stroke-dasharray: 60;
    stroke-dashoffset: 60;
  }
  .done .check-mark {
    animation: check-draw 0.3s ease-out 0.3s forwards;
    stroke-dasharray: 20;
    stroke-dashoffset: 20;
  }
  @keyframes circle-draw {
    to { stroke-dashoffset: 0; }
  }
  @keyframes check-draw {
    to { stroke-dashoffset: 0; }
  }

  /* ── Error: static (no animation) ────────────────────── */
  /* Error icon has no animation - stays static */

  /* ── Idle: breathing ────────────────────────────── */
  .idle-breathe {
    animation: breathe 3s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { opacity: 0.2; r: 3; }
    50% { opacity: 0.5; r: 4.5; }
  }

  /* ── Reading: eyeball looking left/right with blink ───── */
  .reading .iris {
    animation: eyeball-look 3s ease-in-out infinite;
  }
  .reading .highlight {
    animation: highlight-move 3s ease-in-out infinite;
  }
  .reading .eyelid {
    animation: blink-slow 6s ease-in-out infinite;
  }
  @keyframes eyeball-look {
    0%, 100% { transform: translateX(0); }
    15% { transform: translateX(-2px); }
    30% { transform: translateX(0); }
    45% { transform: translateX(2px); }
    60% { transform: translateX(0); }
    75% { transform: translateX(-1px); }
    90% { transform: translateX(0); }
  }
  @keyframes highlight-move {
    0%, 100% { transform: translate(0, 0); }
    15% { transform: translate(-1px, 0); }
    30% { transform: translate(0, 0); }
    45% { transform: translate(1px, 0); }
    60% { transform: translate(0, 0); }
  }
  @keyframes blink-slow {
    0%, 90%, 100% { transform: scaleY(0); opacity: 0; }
    93% { transform: scaleY(1); opacity: 1; }
    96% { transform: scaleY(0); opacity: 0; }
  }

  /* ── Writing: pen moving back and forth ─────────────── */
  .writing .pen-body {
    animation: pen-write 1.5s ease-in-out infinite;
    transform-origin: 18px 6px;
  }
  .writing .pen-tip {
    animation: pen-tip-move 1.5s ease-in-out infinite;
  }
  .writing .ink-line {
    animation: ink-appear 1.5s ease-in-out infinite;
  }
  @keyframes pen-write {
    0%, 100% { transform: rotate(0deg) translate(0, 0); }
    25% { transform: rotate(-15deg) translate(-2px, 1px); }
    50% { transform: rotate(0deg) translate(0, 0); }
    75% { transform: rotate(10deg) translate(1px, -1px); }
  }
  @keyframes pen-tip-move {
    0%, 100% { transform: translate(0, 0); }
    25% { transform: translate(-1px, 1px); }
    50% { transform: translate(0, 0); }
    75% { transform: translate(1px, -1px); }
  }
  @keyframes ink-appear {
    0%, 20% { stroke-dasharray: 0; stroke-dashoffset: 0; opacity: 0; }
    30% { stroke-dasharray: 3; stroke-dashoffset: 0; opacity: 1; }
    80% { stroke-dasharray: 3; stroke-dashoffset: 0; opacity: 1; }
    100% { stroke-dasharray: 3; stroke-dashoffset: 0; opacity: 0; }
  }
</style>
