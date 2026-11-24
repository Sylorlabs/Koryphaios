/**
 * Static, searchable grid for the note icon picker. Every entry is a single
 * emoji grapheme (see `isNoteEmoji`); a unit test keeps this list valid.
 * Names are short keywords so search works offline without a dependency.
 */
export interface NoteEmojiEntry {
  emoji: string;
  name: string;
}

export interface NoteEmojiCategory {
  id: string;
  label: string;
  entries: readonly NoteEmojiEntry[];
}

const rows = (text: string): NoteEmojiEntry[] =>
  text.trim().split(/\s*\n\s*/).map((line) => {
    const [emoji, ...words] = line.trim().split(/\s+/);
    return { emoji: emoji!, name: words.join(' ') };
  });

export const NOTE_EMOJI_CATALOG: readonly NoteEmojiCategory[] = [
  {
    id: 'notes',
    label: 'Notes & work',
    entries: rows(`
📄 page document
📝 memo note write
📚 books library study
📖 open book reading
📓 notebook journal
📒 ledger notes
📔 notebook decorative
📑 bookmark tabs
🗂️ index dividers
📁 folder
📂 open folder
🗃️ archive box
📋 clipboard list
📌 pin
📍 location marker
🔖 bookmark tag
🏷️ label tag
✏️ pencil edit
🖊️ pen
🗒️ notepad
📐 ruler design
📏 measure
✅ task done check
☑️ checkbox
📅 calendar date
🗓️ schedule
⏰ alarm reminder
🎯 goal target
`),
  },
  {
    id: 'ideas',
    label: 'Ideas & thinking',
    entries: rows(`
💡 idea light bulb
🧠 brain thinking
🔍 search look
🔎 investigate
🧩 puzzle
🌱 seed growth
🔬 research science
🧪 experiment test lab
⚗️ alchemy experiment
🔭 explore telescope
🤔 question thinking
❓ question
❗ important
⚠️ warning
🚩 flag
💭 thought
🗝️ key insight
🪄 magic idea
🎨 design creative
✨ sparkle new
🚀 launch
🛠️ tools work
⚙️ settings gear
🔧 wrench fix
🪛 screwdriver
📊 chart data
📈 growth trend
📉 decline
🧮 calculate
`),
  },
  {
    id: 'links',
    label: 'Links & people',
    entries: rows(`
🔗 link reference
🔀 shuffle branch
🌐 web global
🧭 compass direction
🗺️ map
🤝 agreement partnership
👥 team people
🧑‍💻 developer coder
👩🏽‍💻 developer skin tone
👨‍🔬 scientist
👩‍🎨 artist
🙋 person question
💬 chat talk
🗣️ speaking
📣 announce
📨 message mail
📬 inbox
🔐 secure lock
🔑 access key
🛡️ shield safety
📡 signal
🪪 identity badge
🏠 home
🏢 office company
🏫 school
🏛️ institution
💼 business work
🧳 travel
`),
  },
  {
    id: 'status',
    label: 'Status & marks',
    entries: rows(`
⭐ star favorite
🌟 glowing star
❤️ heart love
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🔥 fire hot
💎 gem
🏆 trophy win
🥇 gold first
🎉 celebrate party
🎁 gift
🏁 finish
🟢 green circle
🔴 red circle
🟡 yellow circle
🔵 blue circle
⚫ black circle
⚪ white circle
🔶 orange diamond
🔷 blue diamond
♻️ recycle
⏳ hourglass waiting
🕐 clock time
💤 sleep idle
🆕 new
🆗 ok
🔒 locked
🔓 unlocked
`),
  },
  {
    id: 'nature',
    label: 'Nature & objects',
    entries: rows(`
🌍 earth world
🌊 wave ocean
🌋 volcano
🏔️ mountain
🌲 tree forest
🌸 blossom flower
🌻 sunflower
🍀 clover luck
🍁 leaf
🐢 turtle slow
🐙 octopus
🦉 owl wisdom
🐝 bee
🦋 butterfly
🐬 dolphin
🦊 fox
🐱 cat
🐶 dog
🦄 unicorn
🐉 dragon
☀️ sun
🌙 moon
⛅ cloud weather
❄️ snow
⚡ lightning
🌈 rainbow
🪐 planet
🔮 crystal ball
🧲 magnet
🪴 plant
☕ coffee
🍵 tea
🍎 apple
🍊 orange fruit
🥑 avocado
🍕 pizza
🎵 music
🎧 headphones
🎮 game
📷 camera photo
🎬 film
🎤 microphone
🏃 running
`),
  },
];

/**
 * Case-insensitive search over emoji names and category labels. An empty
 * query returns the full catalog grouped by category.
 */
export function searchNoteEmoji(query: string): readonly NoteEmojiEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const entries = NOTE_EMOJI_CATALOG.flatMap((category) =>
    category.entries.map((entry) => ({ ...entry, haystack: `${category.label} ${entry.name}`.toLowerCase() })),
  );
  if (terms.length === 0) return entries.map(({ emoji, name }) => ({ emoji, name }));
  return entries
    .filter((entry) => terms.every((term) => entry.haystack.includes(term)))
    .map(({ emoji, name }) => ({ emoji, name }));
}
