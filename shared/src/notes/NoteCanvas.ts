export interface NoteCanvasCard {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  noteId?: string;
  color: string;
}

export interface NoteCanvasEdge {
  id: string;
  from: string;
  to: string;
}

export interface NoteCanvasDocument {
  v: 1;
  name: string;
  cards: NoteCanvasCard[];
  edges: NoteCanvasEdge[];
}

export const NOTE_CANVAS_MAX_CARDS = 2000;
export const NOTE_CANVAS_MAX_EDGES = 5000;

/** Reject the entire document rather than silently dropping a user's cards. */
export function validateNoteCanvas(value: unknown): NoteCanvasDocument {
  const fail = (message: string): never => {
    throw new Error(`Invalid canvas: ${message}`);
  };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return fail('expected an object');
    return value as Record<string, unknown>;
  };
  const keys = (row: Record<string, unknown>, allowed: string[]) => {
    if (Object.keys(row).some((key) => !allowed.includes(key))) fail('unknown field');
  };
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\r\n\0]/.test(value))
      return fail('invalid ID');
    return value;
  };
  const number = (value: unknown, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      return fail('invalid geometry');
    return value;
  };
  const doc = object(value);
  keys(doc, ['v', 'name', 'cards', 'edges']);
  if (doc.v !== 1) fail('unsupported version');
  if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 200)
    fail('name must contain 1–200 characters');
  if (!Array.isArray(doc.cards) || doc.cards.length > NOTE_CANVAS_MAX_CARDS)
    fail('too many or missing cards');
  if (!Array.isArray(doc.edges) || doc.edges.length > NOTE_CANVAS_MAX_EDGES)
    fail('too many or missing edges');
  const cards = (doc.cards as unknown[]).map((value): NoteCanvasCard => {
    const card = object(value);
    keys(card, ['id', 'x', 'y', 'w', 'h', 'text', 'noteId', 'color']);
    if (typeof card.text !== 'string' || card.text.length > 100_000) fail('invalid card text');
    if (typeof card.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(card.color))
      fail('invalid card color');
    return {
      id: id(card.id),
      x: number(card.x, -1_000_000, 1_000_000),
      y: number(card.y, -1_000_000, 1_000_000),
      w: number(card.w, 80, 1200),
      h: number(card.h, 60, 1200),
      text: card.text as string,
      color: card.color as string,
      ...(card.noteId === undefined ? {} : { noteId: id(card.noteId) }),
    };
  });
  const cardIds = new Set(cards.map((card) => card.id));
  if (cardIds.size !== cards.length) fail('duplicate card ID');
  const edges = (doc.edges as unknown[]).map((value): NoteCanvasEdge => {
    const edge = object(value);
    keys(edge, ['id', 'from', 'to']);
    const from = id(edge.from),
      to = id(edge.to);
    if (from === to || !cardIds.has(from) || !cardIds.has(to))
      fail('edge endpoints must be distinct existing cards');
    return { id: id(edge.id), from, to };
  });
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) fail('duplicate edge ID');
  if (new Set(edges.map((edge) => JSON.stringify([edge.from, edge.to]))).size !== edges.length)
    fail('duplicate directed edge');
  return { v: 1, name: doc.name as string, cards, edges };
}

export function canvasFromNotes(
  name: string,
  notes: Array<{ id: string; title: string }>,
): NoteCanvasDocument {
  return validateNoteCanvas({
    v: 1,
    name,
    cards: notes.map((note, index) => ({
      id: `note-${index}`,
      noteId: note.id,
      text: note.title,
      x: (index % 4) * 240,
      y: Math.floor(index / 4) * 180,
      w: 220,
      h: 140,
      color: '#8b7ec8',
    })),
    edges: [],
  });
}
