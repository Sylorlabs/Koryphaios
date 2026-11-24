// Voice conductor grammar.
//
// A spoken command is parsed by this deterministic grammar, never by a model:
// the same words always mean the same action, the parse costs nothing, and an
// utterance the grammar does not recognise is reported as `unknown` so the
// caller can ask before it spends a turn on it.
//
// Matching runs on a lower-cased, punctuation-light copy of the utterance;
// free-text payloads (a steering message, a note, a chat title) are taken from
// the original wording so capitalisation survives.

export type ConductorPanel = 'notes' | 'terminal' | 'settings' | 'voice_settings' | 'agents';

/** The agent roles a worker can be addressed by ("stop the critic"). */
export type ConductorRole = 'coder' | 'critic' | 'reviewer' | 'task' | 'summarizer';

export type AgentTarget =
  | { kind: 'all' }
  | { kind: 'manager' }
  /** 1-based position among the chat's workers, in the order they started. */
  | { kind: 'ordinal'; index: number }
  | { kind: 'role'; role: ConductorRole }
  | { kind: 'name'; name: string };

export type ConductorIntent =
  | { type: 'status'; target: AgentTarget }
  | { type: 'stop'; target: AgentTarget }
  | { type: 'steer'; target: AgentTarget; message: string }
  | { type: 'new_chat'; topic?: string }
  | { type: 'switch_chat'; query: string }
  | { type: 'open_panel'; panel: ConductorPanel }
  | { type: 'note'; text: string }
  | { type: 'read_aloud' }
  | { type: 'stop_reading' }
  | { type: 'delete_chat' }
  | { type: 'undo' }
  | { type: 'confirm' }
  | { type: 'deny' }
  | { type: 'unknown'; text: string };

/** Intents that change or end running work and so must be confirmed first. */
export function isDestructiveIntent(intent: ConductorIntent): boolean {
  return intent.type === 'stop' || intent.type === 'delete_chat';
}

// ─── Text helpers ────────────────────────────────────────────────────────────

const SEP = String.raw`[\s,]+`;
const OPT_SEP = String.raw`[\s,]*`;

/** Leading words people say before a command that carry no meaning. */
const LEADING_FILLER =
  /^(?:(?:um+|uh+|er+|so|okay|ok|alright|all right|now|and|please|hey|can you|could you|would you|will you|i want you to|i'd like you to|go ahead and|let's|lets)[\s,]+)+/i;
const TRAILING_FILLER = /(?:[\s,]+(?:please|thanks|thank you|now|for me))+$/i;

/**
 * Light cleanup that keeps the speaker's wording: whitespace collapsed,
 * sentence punctuation at the ends removed, filler words trimmed.
 */
export function cleanUtterance(text: string): string {
  let out = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  out = out.replace(/^[\s.,!?;:"'-]+/, '').replace(/[\s.,!?;:"'-]+$/, '');
  out = out.replace(LEADING_FILLER, '');
  out = out.replace(TRAILING_FILLER, '');
  return out.replace(/[\s.,!?;:]+$/, '').trim();
}

/** Lower-case matching form: also drops commas and apostrophes. */
function matchForm(text: string): string {
  return text
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[,;:!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalize(text: string): string {
  const trimmed = text.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

// ─── Ordinals ────────────────────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
};

/** What speech recognisers commonly write for a number said after "worker". */
const NUMBER_HOMOPHONES: Record<string, number> = {
  won: 1,
  to: 2,
  too: 2,
  tu: 2,
  for: 4,
  fore: 4,
  ate: 8,
};

/** "two", "2", "#2", "2nd", "second" → 2. Homophones only when `afterNoun`. */
export function parseOrdinal(word: string, afterNoun = false): number | null {
  const token = word.toLowerCase().replace(/^#/, '').trim();
  if (!token) return null;
  const digits = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(token);
  if (digits) {
    const value = Number(digits[1]);
    return value >= 1 ? value : null;
  }
  if (token in NUMBER_WORDS) return NUMBER_WORDS[token];
  if (token in ORDINAL_WORDS) return ORDINAL_WORDS[token];
  if (afterNoun && token in NUMBER_HOMOPHONES) return NUMBER_HOMOPHONES[token];
  return null;
}

// ─── Targets ─────────────────────────────────────────────────────────────────

const WORKER_NOUN = String.raw`(?:sub[\s-]?agent|agent|worker|helper|bot)`;

const ROLE_WORDS: Record<string, ConductorRole> = {
  coder: 'coder',
  'coding agent': 'coder',
  'code agent': 'coder',
  'code worker': 'coder',
  developer: 'coder',
  engineer: 'coder',
  critic: 'critic',
  reviewer: 'reviewer',
  'review agent': 'reviewer',
  'code reviewer': 'reviewer',
  'task agent': 'task',
  'task worker': 'task',
  summarizer: 'summarizer',
  summariser: 'summarizer',
};

const ALL_WORDS = new Set([
  'all',
  'everything',
  'everyone',
  'everybody',
  'it',
  'that',
  'this',
  'now',
  'it all',
  'all of it',
  'all of them',
  'them',
  'the run',
  'the task',
  'the work',
  'work',
  'all work',
  'the whole thing',
  'all agents',
  'all the agents',
  'all workers',
  'all the workers',
  'the agents',
  'the workers',
  'agents',
  'workers',
  'every agent',
  'every worker',
  'the team',
  'the chat',
  'this chat',
  'the session',
  'this session',
]);

const MANAGER_WORDS = new Set([
  'manager',
  'the manager',
  'kory',
  'cory',
  'corey',
  'kori',
  'the orchestrator',
  'orchestrator',
  'the main agent',
  'main agent',
  'the lead',
  'lead',
]);

/**
 * Parse who a command is addressed to. Returns null when the phrase does not
 * name anyone the grammar understands.
 */
export function parseAgentTarget(phrase: string): AgentTarget | null {
  const p = matchForm(phrase);
  if (!p) return null;
  if (ALL_WORDS.has(p)) return { kind: 'all' };
  if (MANAGER_WORDS.has(p)) return { kind: 'manager' };

  const bare = p.replace(/^(?:the|my|our)\s+/, '');
  if (MANAGER_WORDS.has(bare)) return { kind: 'manager' };
  if (ALL_WORDS.has(bare)) return { kind: 'all' };

  // "worker two", "agent number 2", "worker #3", "sub-agent 2nd"
  const nounFirst = new RegExp(String.raw`^${WORKER_NOUN}\s+(?:number\s+|no\.?\s+)?(#?\w+)$`).exec(
    bare,
  );
  if (nounFirst) {
    const index = parseOrdinal(nounFirst[1], true);
    if (index) return { kind: 'ordinal', index };
  }
  // "second worker", "2nd agent", "worker number two"
  const ordinalFirst = new RegExp(String.raw`^(#?\w+)\s+${WORKER_NOUN}$`).exec(bare);
  if (ordinalFirst) {
    const index = parseOrdinal(ordinalFirst[1]);
    if (index) return { kind: 'ordinal', index };
  }
  // "number two"
  const numberOnly = /^number\s+(\w+)$/.exec(bare);
  if (numberOnly) {
    const index = parseOrdinal(numberOnly[1], true);
    if (index) return { kind: 'ordinal', index };
  }

  const role = ROLE_WORDS[bare] ?? ROLE_WORDS[bare.replace(/\s+(?:agent|worker)$/, '')];
  if (role) return { kind: 'role', role };

  // A short bare word is taken as an agent's name ("stop Ada"). Longer phrases
  // are not names; they are sentences the grammar did not understand.
  if (/^[a-z][a-z0-9-]{1,30}(?:\s[a-z][a-z0-9-]{1,30})?$/.test(bare)) {
    return { kind: 'name', name: bare };
  }
  return null;
}

// ─── Intent patterns ─────────────────────────────────────────────────────────

const CONFIRM_WORDS = new Set([
  'yes',
  'yeah',
  'yea',
  'yep',
  'yup',
  'sure',
  'confirm',
  'confirmed',
  'do it',
  'yes do it',
  'go ahead',
  'go for it',
  'affirmative',
  'proceed',
  'yes please',
  'correct',
  'ok',
  'okay',
  'right',
  'send it',
  'yes send it',
]);

const DENY_WORDS = new Set([
  'no',
  'nope',
  'nah',
  'cancel',
  'cancel that',
  'never mind',
  'nevermind',
  'dont',
  'do not',
  'dont do it',
  'no thanks',
  'no thank you',
  'forget it',
  'forget that',
  'abort',
  'no dont',
  'negative',
  'leave it',
  'scratch that',
]);

export function isAffirmative(text: string): boolean {
  return CONFIRM_WORDS.has(matchForm(cleanUtterance(text)));
}

export function isNegative(text: string): boolean {
  return DENY_WORDS.has(matchForm(cleanUtterance(text)));
}

const STATUS_EXACT = new Set([
  'status',
  'status report',
  'status update',
  'give me a status',
  'give me a status update',
  'give me a status report',
  'give me an update',
  'update me',
  'progress',
  'progress report',
  'report',
  'whats happening',
  'what is happening',
  'whats going on',
  'what is going on',
  'hows it going',
  'how is it going',
  'how are things',
  'how are things going',
  'how are we doing',
  'where are we',
  'where are we at',
  'are we done',
  'is it done',
  'are you done',
  'any progress',
  'whats the status',
  'what is the status',
  'whats the progress',
  'who is working',
  'whos working',
  'whos running',
  'what is running',
  'whats running',
]);

const PANEL_WORDS: Record<string, ConductorPanel> = {
  note: 'notes',
  notes: 'notes',
  notebook: 'notes',
  'my notes': 'notes',
  terminal: 'terminal',
  terminals: 'terminal',
  shell: 'terminal',
  shells: 'terminal',
  console: 'terminal',
  'background shells': 'terminal',
  settings: 'settings',
  preferences: 'settings',
  options: 'settings',
  'voice settings': 'voice_settings',
  'voice preferences': 'voice_settings',
  agents: 'agents',
  agent: 'agents',
  'agent panel': 'agents',
  'agents panel': 'agents',
  'agent rail': 'agents',
  activity: 'agents',
  workers: 'agents',
};

function panelFor(phrase: string): ConductorPanel | null {
  const p = matchForm(phrase)
    .replace(/^(?:the|my)\s+/, '')
    .replace(/\s+(?:panel|pane|window|page|tab|view|sidebar|drawer)$/, '');
  return PANEL_WORDS[p] ?? null;
}

type Rule = (clean: string, form: string) => ConductorIntent | null;

const RULES: Rule[] = [
  // Undo first: "undo that" must never fall through to anything else.
  (_clean, form) =>
    /^(?:undo|undo that|undo it|undo the last (?:thing|action|command|one)|revert that|revert it|take that back|go back on that)$/.test(
      form,
    )
      ? { type: 'undo' }
      : null,

  // Confirmation words on their own.
  (_clean, form) => (CONFIRM_WORDS.has(form) ? { type: 'confirm' } : null),
  (_clean, form) =>
    DENY_WORDS.has(form) && form !== 'cancel' && form !== 'abort' ? { type: 'deny' } : null,

  // Speech playback control. Checked before "stop" so "stop reading" never
  // stops the agents.
  (_clean, form) =>
    /^(?:(?:stop|quit|cease|pause)\s+(?:reading|talking|speaking|the voice|playback|the playback|reading aloud|reading out loud)|be quiet|quiet|shut up|silence|hush|stop the audio|enough)$/.test(
      form,
    )
      ? { type: 'stop_reading' }
      : null,
  (_clean, form) =>
    /^(?:(?:read|say|speak|play)(?:\s+(?:me|us|out|aloud|back|it|that|this|the|last|latest|final|most recent|recent|reply|response|answer|message|again|out loud|loud|kory's|korys|managers|manager's))*|what did (?:it|kory|cory|corey|the manager|you) (?:just )?say|repeat that|repeat the last (?:reply|response|answer|message))$/.test(
      form,
    ) && !/^(?:say|speak|play)$/.test(form)
      ? { type: 'read_aloud' }
      : null,

  // Delete the open chat.
  (_clean, form) =>
    /^(?:delete|remove|trash|erase)\s+(?:this|the current|current|the|my)\s+(?:chat|session|conversation|thread)$/.test(
      form,
    )
      ? { type: 'delete_chat' }
      : null,

  // Stop / cancel.
  (_clean, form) => {
    const m =
      /^(?:stop|cancel|halt|abort|kill|end|terminate|interrupt|pause|freeze)(?:\s+(.+?))?(?:\s+(?:right now|immediately|now))?$/.exec(
        form,
      );
    if (!m) return null;
    const rest = m[1]?.trim();
    if (!rest) return { type: 'stop', target: { kind: 'all' } };
    // "stop working on X" / "stop doing that" are instructions, not targets.
    if (/^(?:working|doing|making|writing|using|trying)\b/.test(rest)) return null;
    const target = parseAgentTarget(rest);
    return target ? { type: 'stop', target } : null;
  },

  // Status.
  (_clean, form) => {
    if (STATUS_EXACT.has(form)) return { type: 'status', target: { kind: 'all' } };
    const m =
      /^(?:what|whats)(?:\s+(?:is|are|s))?\s+(.+?)\s+(?:doing|up to|working on|busy with|thinking about)(?:\s+(?:now|right now))?$/.exec(
        form,
      );
    if (m) {
      const target = parseAgentTarget(m[1]);
      if (target) return { type: 'status', target };
    }
    const how =
      /^(?:how is|hows|how are|is|are)\s+(.+?)\s+(?:doing|going|getting on|done|finished)$/.exec(
        form,
      );
    if (how) {
      const target = parseAgentTarget(how[1]);
      if (target) return { type: 'status', target };
    }
    const statusOf = /^(?:status|progress|update)\s+(?:of|on|for)\s+(.+)$/.exec(form);
    if (statusOf) {
      const target = parseAgentTarget(statusOf[1]);
      if (target) return { type: 'status', target };
    }
    return null;
  },

  // New chat, optionally with a topic that becomes its title.
  (clean) => {
    const m = new RegExp(
      String.raw`^(?:(?:start|open|create|make|begin)${SEP})?(?:(?:a|another)${SEP})?(?:new${SEP})?(?:chat|session|conversation|thread)(?:${SEP}(?:about|on|for|regarding|called|named|titled)${OPT_SEP}(.+))?$`,
      'i',
    ).exec(clean);
    if (!m) return null;
    // "open chat X" is a switch, not a new chat: require "new" or a creation verb.
    const head = clean.toLowerCase();
    if (!/\bnew\b/.test(head) && !/^(?:start|create|make|begin)\b/.test(head)) return null;
    const topic = m[1] ? capitalize(m[1]) : undefined;
    return topic ? { type: 'new_chat', topic } : { type: 'new_chat' };
  },

  // Open a panel.
  (clean) => {
    const m = new RegExp(
      String.raw`^(?:open|show|display|bring up|pull up|go to|switch to|toggle|view)${SEP}(.+)$`,
      'i',
    ).exec(clean);
    if (!m) return null;
    const panel = panelFor(m[1]);
    return panel ? { type: 'open_panel', panel } : null;
  },

  // Switch to another chat by title.
  (clean) => {
    const verbs = String.raw`(?:open|switch to|go to|show|jump to|take me to|go back to|return to|bring up|pull up)`;
    const nouns = String.raw`(?:chat|session|conversation|thread)`;
    const noun = new RegExp(
      String.raw`^${verbs}${SEP}(?:the${SEP}|my${SEP})?${nouns}${SEP}(?:(?:about|called|named|titled|on|for)${SEP})?(.+)$`,
      'i',
    ).exec(clean);
    if (noun) return { type: 'switch_chat', query: noun[1].trim() };
    const trailing = new RegExp(
      String.raw`^${verbs}${SEP}(?:the${SEP}|my${SEP})?(.+?)${SEP}${nouns}$`,
      'i',
    ).exec(clean);
    if (trailing && !/^(?:new|a new|another)$/i.test(trailing[1].trim()))
      return { type: 'switch_chat', query: trailing[1].trim() };
    return null;
  },

  // Dictate into notes.
  (clean) => {
    const m = new RegExp(
      String.raw`^(?:note|note down|take a note|take note|make a note|add a note|write a note|jot down|jot|write down|add to (?:my |the )?notes?|put in (?:my |the )?notes?)(?:${SEP}(?:that|saying|of|about))?(?:${OPT_SEP}[:\-]${OPT_SEP}|${SEP})(.+)$`,
      'i',
    ).exec(clean);
    if (!m) return null;
    const text = m[1].trim();
    return text ? { type: 'note', text: capitalize(text) } : null;
  },

  // Steering: "tell the manager to …", "ask worker two to …".
  (clean) => {
    const m = new RegExp(
      String.raw`^(?:tell|ask|instruct|have|get|remind|steer)${SEP}(.+?)${SEP}(?:to|that|about)${SEP}(.+)$`,
      'i',
    ).exec(clean);
    if (m) {
      const who = m[1].trim();
      const target = /^(?:it|him|her|them|you)$/i.test(who)
        ? ({ kind: 'manager' } as const)
        : parseAgentTarget(who);
      if (target && target.kind !== 'all') {
        const message = capitalize(m[2]);
        if (message) return { type: 'steer', target, message };
      }
    }
    const direct = new RegExp(
      String.raw`^(?:steer|steering|tell (?:the manager|kory)|message (?:the manager|kory))${OPT_SEP}[:\-]?${OPT_SEP}(.+)$`,
      'i',
    ).exec(clean);
    if (direct) {
      const message = capitalize(direct[1]);
      if (message) return { type: 'steer', target: { kind: 'manager' }, message };
    }
    return null;
  },
];

/** Parse one utterance (wake phrase already removed) into an intent. */
export function parseConductorUtterance(text: string): ConductorIntent {
  const clean = cleanUtterance(text);
  if (!clean) return { type: 'unknown', text: '' };
  const form = matchForm(clean);
  for (const rule of RULES) {
    const intent = rule(clean, form);
    if (intent) return intent;
  }
  return { type: 'unknown', text: clean };
}

// ─── Wake phrase ─────────────────────────────────────────────────────────────

export const DEFAULT_WAKE_PHRASE = 'Kory';

/** How recognisers commonly spell "Kory". Only used for the default phrase. */
const KORY_SPELLINGS = ['kory', 'cory', 'corey', 'kori', 'korey', 'kora', 'corie', 'khory'];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface WakeMatch {
  /** The wake word was said at the very start. */
  matched: boolean;
  /** Clearly addressed: a "hey" prefix or punctuation right after the name. */
  explicit: boolean;
  /** What followed the wake phrase, in the speaker's wording. */
  rest: string;
}

/**
 * Match a configured wake phrase at the start of a transcript. "Hey Kory",
 * "OK Kory" and "Kory," all match; the greeting is optional and may also be
 * part of the configured phrase itself.
 */
export function matchWakePhrase(text: string, phrase: string): WakeMatch {
  const none: WakeMatch = { matched: false, explicit: false, rest: text };
  const configured = phrase
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .replace(/\s+/g, ' ');
  const name = configured.replace(/^(?:hey|hi|ok|okay|yo)\s+/, '').trim();
  if (!name) return none;
  const spellings = name === 'kory' ? KORY_SPELLINGS : [name];
  const namePattern = spellings
    .map((spelling) =>
      spelling
        .split(' ')
        .map(escapeRegExp)
        .join(String.raw`[\s,]+`),
    )
    .join('|');
  const re = new RegExp(
    String.raw`^[\s"'(]*(?:(hey|hi|ok|okay|yo)[\s,]+)?(?:${namePattern})(?![\p{L}\p{N}])([\s]*[,.:;!?—-]+)?[\s]*(.*)$`,
    'isu',
  );
  const m = re.exec(text);
  if (!m) return none;
  return {
    matched: true,
    explicit: !!m[1] || !!m[2]?.trim(),
    rest: m[3] ?? '',
  };
}
