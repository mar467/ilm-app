// Reads card files written in the Flashcard SOP block format.
// Pure module: no DOM. Runs in the browser and in Node (tests, pre-commit checks).
//
//   [LON01.cohsch.M1] M-DEF | active
//   C: Epistemology › Schools › Coherentism
//   Q: **coherentism** pictures beliefs as what?
//   A: a web
//   X: optional extra, shown under the answer
//   S: optional source, when it differs from the section's
//
// A section may open with one line of shared defaults: "S: ... · T: ..." (older files also put C: there).

const HEADER = /^\[([A-Za-z]+[0-9]*(?:\.[A-Za-z0-9_-]+)+)\]\s+([A-Z]-[A-Z0-9]+)\s*\|\s*([a-z-]+)\s*$/;
const FIELD = /^([CQAXST]):(?:\s(.*))?$/;
const FIELD_NAMES = { C: 'c', Q: 'q', A: 'a', X: 'x', S: 's', T: 't' };

export const STATUSES = ['active', 'needs-you', 'tbv', 'ref', 'todo', 'proposed', 'suspended', 'retired'];

export function hashText(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// "LON01.gettier.M13" -> { course: "LON", lesson: "01", slug: "gettier", level: "M", n: 13 }
export function parseId(id) {
  const parts = id.split('.');
  const head = /^([A-Za-z]+)([0-9]*)$/.exec(parts[0]) || [null, parts[0], ''];
  const tail = /^([A-Za-z])([0-9]+)$/.exec(parts[parts.length - 1]);
  return {
    course: head[1].toUpperCase(),
    lesson: head[2] || '',
    slug: parts.slice(1, tail ? -1 : undefined).join('.') || parts[0],
    level: tail ? tail[1].toUpperCase() : '',
    n: tail ? Number(tail[2]) : 0,
  };
}

// How the app treats a card. See the build plan, section 3.
export function cardKind(card) {
  if (card.status === 'needs-you') return 'needs-you';
  if (card.type === 'X-MAP') return 'aware';
  if (card.type.startsWith('X-') || ['tbv', 'todo', 'ref', 'proposed'].includes(card.status)) return 'ref';
  if (card.type === 'A-DO') return 'do';
  return 'recall';
}

function parseDefaults(line) {
  const out = {};
  let key = null;
  for (const piece of line.split(' · ')) {
    const m = /^([CST]):\s?(.*)$/.exec(piece.trim());
    if (m) { key = FIELD_NAMES[m[1]]; out[key] = m[2].trim(); }
    else if (key) out[key] += ' · ' + piece;
  }
  return out;
}

function clean(value) {
  const v = (value || '').replace(/[ \t]+$/gm, '').trim();
  return v === '—' || v === '-' ? '' : v;
}

export function parseCardFile(text, fallbackName = '') {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const cards = [];
  const problems = [];
  let title = '';
  let depth = 'standard';
  let section = '';
  let defaults = {};
  let cur = null;
  let field = null;

  const finish = () => {
    if (!cur) return;
    const raw = cur.raw;
    const idp = parseId(cur.id);
    const tags = ((raw.t ?? defaults.t) || '').split(/\s+/).filter(Boolean);
    const card = {
      id: cur.id,
      type: cur.type,
      status: cur.status,
      c: clean(raw.c ?? defaults.c),
      q: clean(raw.q),
      a: clean(raw.a),
      x: clean(raw.x),
      s: clean(raw.s ?? defaults.s),
      tags,
      depth: tags.includes('mastery') ? 'mastery' : depth,
      section,
      order: cards.length,
      line: cur.line,
      ...idp,
    };
    if (raw.c === undefined && !defaults.c) card.noContext = true;
    card.hash = hashText([card.type, card.status, card.c, card.q, card.a, card.x].join('\u0001'));
    cards.push(card);
    cur = null;
    field = null;
  };

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (/^```/.test(trimmed) || /^---+$/.test(trimmed)) { finish(); return; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading && !cur) {
      const level = heading[1].length;
      const textOf = heading[2].trim();
      if (level === 1 && !title && !/^part\b/i.test(textOf)) title = textOf;
      if (level === 1 && /^part\b/i.test(textOf)) depth = /mastery/i.test(textOf) ? 'mastery' : 'standard';
      if (level >= 2) { section = textOf; defaults = {}; }
      return;
    }
    const head = HEADER.exec(trimmed);
    if (head) {
      finish();
      cur = { id: head[1], type: head[2], status: head[3], raw: {}, line: i + 1 };
      return;
    }
    if (/^\[[^\]]+\]\s+\S+\s*\|/.test(trimmed)) {
      finish();
      problems.push({ id: trimmed.slice(0, 40), line: i + 1, msg: 'card header not understood' });
      return;
    }
    if (cur) {
      if (trimmed === '') { field = null; return; }
      // An indented line continues the open field, even when it looks like "C: ..."
      // (answers such as "F: ... / C: ..." rely on this). Field lines start at column 0.
      const indented = /^\s/.test(line);
      const f = FIELD.exec(trimmed);
      if (f && !(indented && field)) {
        field = FIELD_NAMES[f[1]];
        if (cur.raw[field] !== undefined) problems.push({ id: cur.id, line: i + 1, msg: `field ${f[1]} appears twice` });
        cur.raw[field] = f[2] || '';
        return;
      }
      if (field) { cur.raw[field] += '\n' + trimmed; return; }
      return;
    }
    if (/^[CST]:\s/.test(trimmed)) Object.assign(defaults, parseDefaults(trimmed));
  });
  finish();

  return { title: title || fallbackName, cards, problems };
}

// Tab-separated import (Anki-style): front, back, [source], [tags], [id]
export function parseTsv(text, fallbackName = 'Imported list') {
  const stripHtml = (s) => s
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li>/gi, '\n- ')
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
  const cards = [];
  const problems = [];
  text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
    if (!line.trim() || line.startsWith('#')) return;
    const cols = line.split('\t');
    if (cols.length < 2) { problems.push({ id: `line ${i + 1}`, line: i + 1, msg: 'needs at least a front and a back, separated by a tab' }); return; }
    const q = stripHtml(cols[0]);
    const a = stripHtml(cols[1]);
    const id = (cols[4] || '').trim() || `TSV.${hashText(q)}.M1`;
    const card = {
      id, type: 'M-FACT', status: 'active', c: '', q, a, x: '', s: stripHtml(cols[2] || ''),
      tags: (cols[3] || '').split(/\s+/).filter(Boolean), depth: 'standard', section: '',
      order: cards.length, line: i + 1, ...parseId(id),
    };
    card.hash = hashText([card.type, card.status, card.c, card.q, card.a, card.x].join('\u0001'));
    cards.push(card);
  });
  return { title: fallbackName, cards, problems };
}

export function looksLikeCardFile(text) {
  return /^\[[A-Za-z]+[0-9]*\.[^\]]+\]\s+[A-Z]-[A-Z0-9]+\s*\|/m.test(text);
}

export function parseAny(text, fallbackName = '') {
  if (looksLikeCardFile(text)) return parseCardFile(text, fallbackName);
  if (/\t/.test(text)) return parseTsv(text, fallbackName || 'Imported list');
  return { title: fallbackName, cards: [], problems: [{ id: '', line: 0, msg: 'no cards found: expected card blocks in the SOP format, or tab-separated lines' }] };
}

// The scripted checks from the Flashcard SOP, section 6 step 9.
const LEANING = /\b(the above|the lesson(?! \d)|the series|that (?:reply|argument|objection|example|claim)|this (?:reply|argument|objection|example|claim)|those claims|the example above)\b/i;
const LONG_ANSWER_OK = new Set(['A-SOL', 'A-PROB', 'A-CHK', 'M-STORY', 'M-VERB']);
const NO_BOLD_OK = new Set(['M-ABBR', 'M-PERS', 'M-REL', 'M-STORY', 'M-VERB', 'M-IMG']);

export function validateCards(cards) {
  const errors = [];
  const warnings = [];
  const ids = new Map();
  const fronts = new Map();
  for (const c of cards) {
    if (ids.has(c.id)) errors.push({ id: c.id, msg: `ID used twice (lines ${ids.get(c.id)} and ${c.line})` });
    ids.set(c.id, c.line);
    if (!STATUSES.includes(c.status)) errors.push({ id: c.id, msg: `unknown status "${c.status}"` });
    const typeLevel = c.type[0];
    if (c.level && typeLevel !== c.level) errors.push({ id: c.id, msg: `type ${c.type} does not match level ${c.level} in the ID` });
    if (!c.level) errors.push({ id: c.id, msg: 'ID should end with a level letter and number, like M1' });
    if (!c.q) errors.push({ id: c.id, msg: 'no question' });
    const kind = cardKind(c);
    if (!c.a && (kind === 'recall')) errors.push({ id: c.id, msg: 'no answer' });
    if (c.noContext || !c.c) warnings.push({ id: c.id, msg: 'no context line (C:)' });
    const key = (c.c + '\u0001' + c.q).toLowerCase().replace(/\s+/g, ' ');
    if (fronts.has(key)) warnings.push({ id: c.id, msg: `same context and question as ${fronts.get(key)}` });
    fronts.set(key, c.id);
    if (c.level === 'M' && kind !== 'needs-you' && !NO_BOLD_OK.has(c.type) && !/\*\*.+?\*\*/.test(c.q)) {
      warnings.push({ id: c.id, msg: 'level 1 question has no bold key term' });
    }
    if (c.type[0] !== 'X' && !LONG_ANSWER_OK.has(c.type) && c.a.split('\n').length > 4) {
      warnings.push({ id: c.id, msg: 'answer runs over four lines' });
    }
    if (c.type[0] !== 'X' && LEANING.test(c.q)) warnings.push({ id: c.id, msg: 'question may lean on another card ("' + LEANING.exec(c.q)[0] + '")' });
  }
  return { errors, warnings };
}

export function countByLevel(cards) {
  const out = { M: 0, U: 0, A: 0, X: 0 };
  for (const c of cards) out[c.level] = (out[c.level] || 0) + 1;
  return out;
}
