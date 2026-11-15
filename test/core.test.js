// Run with: node --test test/
// The lesson 1 test reads the real card file from the data repository when it is checked out
// next to this one (or at $ILM_DATA). It is skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCardFile, parseAny, validateCards, countByLevel, cardKind, parseId } from '../docs/js/parser.js';
import { toHtml, humanInterval } from '../docs/js/render.js';
import { replay, buildQueue, nextCard, DEFAULT_SETTINGS, Rating, effective, stateOf } from '../docs/js/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = process.env.ILM_DATA || path.join(here, '..', '..', 'ilm-data');
const lesson1 = path.join(dataRoot, 'courses', 'londoniyyah', 'cards', '01 Epistemology and Theories of Truth - cards.md');

const SAMPLE = `# Sample course, Lesson 1 — cards

# Part A: standard depth

## A1. First section

S: L1 §1 [0:10] · T: sample l01 one

\`\`\`
[SAM01.alpha.M1] M-DEF | active
C: Topic › Alpha
Q: **alpha** is what?
A: the first letter

[SAM01.alpha.M2] M-FACT | active
C: Topic › Alpha
Q: **alpha** comes before what?
A: beta
X: An extra note.
S: L1 §1 [0:30]

[SAM01.alpha.U1] U-CMP | active
C: Topic › Alpha
Q: how do **alpha** and **beta** differ?
A: A: first
   C: this line starts like a field but is part of the answer

[SAM01.alpha.A1] A-DO | active
C: Topic › Alpha
Q: aloud: say the first two letters.
A: (do it; pass if it came out smoothly)

[SAM01.alpha.M3] M-PERS | needs-you
C: Topic › Alpha
Q: a time I used alpha?
A: (your own example)
\`\`\`

## A2. Second section

S: L1 §2 · T: sample l01 two

\`\`\`
[SAM01.beta.M1] M-NAME | active
C: Topic › Beta
Q: **bāʾ** (الباء) means?
A: the letter b

[SAM01.map.X1] X-MAP | ref
C: Sample
Q: (exists) gamma, the third letter.
A: —
\`\`\`

# Part B: what mastery depth adds

## B1. Details

S: L1 §3 · T: sample l01 mastery

\`\`\`
[SAM01.beta.M2] M-FACT | active
C: Topic › Beta
Q: **beta** is which letter in order?
A: the second
\`\`\`
`;

test('parser reads the block format', () => {
  const { title, cards, problems } = parseCardFile(SAMPLE);
  assert.equal(title, 'Sample course, Lesson 1 — cards');
  assert.deepEqual(problems, []);
  assert.equal(cards.length, 8);
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(byId['SAM01.alpha.M1'].c, 'Topic › Alpha');
  assert.equal(byId['SAM01.alpha.M1'].s, 'L1 §1 [0:10]');
  assert.equal(byId['SAM01.alpha.M2'].s, 'L1 §1 [0:30]');
  assert.equal(byId['SAM01.alpha.M2'].x, 'An extra note.');
  assert.deepEqual(byId['SAM01.alpha.M1'].tags, ['sample', 'l01', 'one']);
  assert.equal(byId['SAM01.alpha.U1'].a, 'A: first\nC: this line starts like a field but is part of the answer');
  assert.equal(byId['SAM01.alpha.U1'].c, 'Topic › Alpha');
  assert.equal(byId['SAM01.map.X1'].a, '');
  assert.equal(byId['SAM01.beta.M1'].depth, 'standard');
  assert.equal(byId['SAM01.beta.M2'].depth, 'mastery');
  assert.equal(byId['SAM01.beta.M1'].section, 'A2. Second section');
  assert.equal(cardKind(byId['SAM01.alpha.A1']), 'do');
  assert.equal(cardKind(byId['SAM01.alpha.M3']), 'needs-you');
  assert.equal(cardKind(byId['SAM01.map.X1']), 'aware');
  assert.deepEqual(parseId('LON01.gettier.M13'), { course: 'LON', lesson: '01', slug: 'gettier', level: 'M', n: 13 });
  const { errors } = validateCards(cards);
  assert.deepEqual(errors, []);
});

test('validator catches the SOP checks', () => {
  const bad = SAMPLE.replace('[SAM01.alpha.M2] M-FACT', '[SAM01.alpha.M1] U-HOW').replace('Q: **alpha** is what?', 'Q: alpha is what, per the above?');
  const { cards } = parseCardFile(bad);
  const { errors, warnings } = validateCards(cards);
  assert.ok(errors.some((e) => /used twice/.test(e.msg)));
  assert.ok(errors.some((e) => /does not match level/.test(e.msg)));
  assert.ok(warnings.some((w) => /no bold key term/.test(w.msg)));
  assert.ok(warnings.some((w) => /lean on another card/.test(w.msg)));
});

test('tab-separated lists import too', () => {
  const { cards, problems } = parseAny('What is <b>alpha</b>?\tthe first letter\tBook p.1\ttag1 tag2\nsecond\tanswer', 'list');
  assert.deepEqual(problems, []);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].q, 'What is **alpha**?');
  assert.equal(cards[0].s, 'Book p.1');
  assert.ok(cards[0].id.startsWith('TSV.'));
});

test('lesson 1 imports cleanly and matches its own header counts', { skip: !fs.existsSync(lesson1) && 'data repository not checked out' }, () => {
  const text = fs.readFileSync(lesson1, 'utf8');
  const { title, cards, problems } = parseCardFile(text);
  assert.equal(title, 'Londoniyyah, Lesson 1: Epistemology and Theories of Truth — cards');
  assert.deepEqual(problems, []);
  assert.equal(cards.length, 281);
  assert.deepEqual(countByLevel(cards), { M: 196, U: 46, A: 25, X: 14 });
  const std = cards.filter((c) => c.depth === 'standard');
  const mas = cards.filter((c) => c.depth === 'mastery');
  assert.deepEqual(countByLevel(std), { M: 145, U: 44, A: 24, X: 14 });
  assert.deepEqual(countByLevel(mas), { M: 51, U: 2, A: 1, X: 0 });
  assert.equal(std.filter((c) => c.status === 'needs-you').length, 5);
  assert.equal(std.filter((c) => c.type === 'A-DO').length, 7);
  assert.equal(cards.filter((c) => !c.c).length, 0, 'every card has a context line');
  const { errors, warnings } = validateCards(cards);
  assert.deepEqual(errors, []);
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(byId['LON01.cohsch.M1'].c, 'Epistemology › Schools › Coherentism');
  assert.equal(byId['LON01.cohsch.M1'].q, '**coherentism** pictures beliefs as what?');
  assert.equal(byId['LON01.cohsch.U1'].a.split('\n').length, 2);
  assert.equal(byId['LON00.map.X1'].q.split('\n').length, 27);
  assert.equal(byId['LON01.verdict.A2'].a.split('\n').length, 5);
  assert.equal(byId['LON01.jtb.M6'].s, 'L1 §3 [5:55]');
  assert.equal(byId['LON01.epist.M1'].s, 'L1 key terms');
  assert.ok(byId['LON01.aql.M1'].q.includes('العقل'));
  console.log(`  lesson 1: ${cards.length} cards, ${warnings.length} warnings`);
  for (const w of warnings) console.log(`    ${w.id}: ${w.msg}`);
});

test('text rendering: bold, gaps, Arabic, escaping', () => {
  assert.match(toHtml('**ʿaql** (العقل) means?'), /<strong>ʿaql<\/strong> \(<span class="ar" lang="ar" dir="rtl">العقل<\/span>\)/);
  assert.match(toHtml('a <b> & c'), /a &lt;b&gt; &amp; c/);
  assert.match(toHtml('x [[...]] y'), /class="gap"/);
  assert.match(toHtml('1) one\n2) two'), /class="ln li"/);
  assert.equal(humanInterval(10 * 60000), '10m');
  assert.equal(humanInterval(3 * 86400000), '3d');
});

function setup() {
  const { cards } = parseCardFile(SAMPLE);
  cards.forEach((c) => { c.added = 1000; });
  return cards;
}
const T0 = new Date('2026-11-16T15:00:00Z').getTime();
let seq = 0;
const ev = (type, card, extra = {}) => ({ id: 'e' + (++seq), seq, type, card, t: extra.t || T0 + seq * 1000, ...extra });

test('new cards come in file order, higher levels wait for level 1', () => {
  const cards = setup();
  const settings = { ...DEFAULT_SETTINGS, mastery: {} };
  let q = buildQueue(cards, replay([], settings), settings, T0);
  assert.deepEqual(q.fresh.map((i) => i.card.id), ['SAM01.alpha.M1', 'SAM01.alpha.M2', 'SAM01.beta.M1']);
  assert.equal(q.locked, 2, 'U1 and A1 are locked');
  assert.equal(q.awareNew.length, 1);
  assert.equal(nextCard(q, T0).card.id, 'SAM01.alpha.M1');

  const events = [ev('review', 'SAM01.alpha.M1', { grade: Rating.Good }), ev('review', 'SAM01.alpha.M2', { grade: Rating.Good })];
  const later = T0 + 60000;
  q = buildQueue(cards, replay(events, settings), settings, later);
  assert.ok(q.fresh.some((i) => i.card.id === 'SAM01.alpha.U1'), 'U1 unlocked once both M cards were passed');
  assert.ok(!q.fresh.some((i) => i.card.id === 'SAM01.alpha.A1'), 'A1 still waits for U1');
  assert.equal(q.learnLater.length, 2, 'both cards are in their first-day steps');

  const withMastery = { ...settings, mastery: { SAM: true } };
  q = buildQueue(cards, replay([], withMastery), withMastery, T0);
  assert.ok(q.fresh.some((i) => i.card.id === 'SAM01.beta.M2'));
});

test('newest batch first, captures jump the queue, undo and edits work', () => {
  const cards = setup();
  const captured = { id: 'CAP.1.M1', type: 'M-FACT', status: 'active', c: 'Capture', q: 'q?', a: 'a', x: '', s: '', tags: [], depth: 'standard', order: 0, added: 5000, course: 'CAP', lesson: '', slug: '1', level: 'M', n: 1 };
  const all = [...cards, captured];
  const settings = { ...DEFAULT_SETTINGS };
  let events = [ev('bump', 'CAP.1.M1')];
  let q = buildQueue(all, replay(events, settings), settings, T0 + 60000);
  assert.equal(nextCard(q, T0 + 60000).card.id, 'CAP.1.M1');

  q = buildQueue(all, replay([], settings), settings, T0);
  assert.equal(q.fresh[0].card.id, 'CAP.1.M1', 'most recently added batch leads');
  const oldest = { ...settings, newOrder: 'oldest' };
  q = buildQueue(all, replay([], oldest), oldest, T0);
  assert.equal(q.fresh[0].card.id, 'SAM01.alpha.M1');

  const r = ev('review', 'SAM01.alpha.M1', { grade: Rating.Again });
  events = [r, ev('undo', null, { ref: r.id })];
  assert.equal(stateOf(replay(events, settings), 'SAM01.alpha.M1').reps, 0);

  events = [ev('edit', 'SAM01.alpha.M1', { fields: { q: 'new wording?' } }), ev('fill', 'SAM01.alpha.M3', { a: 'mine' })];
  const states = replay(events, settings);
  assert.equal(effective(cards[0], stateOf(states, 'SAM01.alpha.M1')).q, 'new wording?');
  q = buildQueue(cards, states, settings, T0);
  assert.ok(q.fresh.some((i) => i.card.id === 'SAM01.alpha.M3'), 'a filled-in personal card becomes schedulable');

  const limited = { ...settings, newPerDay: 1 };
  events = [ev('review', 'SAM01.alpha.M1', { grade: Rating.Easy, t: T0 })];
  q = buildQueue(cards, replay(events, limited), limited, T0 + 1000);
  assert.equal(q.newLeft, 0);
  assert.equal(q.counts.fresh, 0);
});

test('reviews come due and a failed card returns the same day', () => {
  const cards = setup();
  const settings = { ...DEFAULT_SETTINGS };
  const events = [ev('review', 'SAM01.alpha.M1', { grade: Rating.Easy, t: T0 })];
  let states = replay(events, settings);
  const st = stateOf(states, 'SAM01.alpha.M1');
  const due = new Date(st.fs.due).getTime();
  assert.ok(due - T0 > 86400000, 'easy on a new card schedules it days out');
  let q = buildQueue(cards, states, settings, due + 1000);
  assert.equal(q.review[0].card.id, 'SAM01.alpha.M1');
  events.push(ev('review', 'SAM01.alpha.M1', { grade: Rating.Again, t: due + 2000 }));
  states = replay(events, settings);
  q = buildQueue(cards, states, settings, due + 3000);
  assert.equal(q.learnLater.length + q.learnDue.length, 1);
  assert.equal(stateOf(states, 'SAM01.alpha.M1').lapses, 1);
});
