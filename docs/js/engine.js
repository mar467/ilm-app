// Scheduling engine. Pure module: state is worked out by replaying the event history.
// Nothing here stores anything; see store.js for that.

import { fsrs, generatorParameters, createEmptyCard, Rating, State } from '../vendor/ts-fsrs.js';
import { cardKind } from './parser.js';

export { Rating, State };

export const DEFAULT_SETTINGS = {
  newPerDay: 20,
  newOrder: 'newest', // 'newest' = most recently added batch first; 'oldest' = in the order added
  gating: true,       // level 2 and 3 cards wait until the concept's level 1 cards have been answered
  mastery: {},        // course -> true to include mastery-depth cards
  retention: 0.9,
  awarePerDay: 2,
  dayStartHour: 4,
};

const AWARE_STEPS_DAYS = [3, 10, 30, 90, 180, 365];
const LEARN_AHEAD_MS = 20 * 60 * 1000;
const DAY = 86400000;

export function makeScheduler(settings = DEFAULT_SETTINGS) {
  return fsrs(generatorParameters({
    request_retention: settings.retention || 0.9,
    enable_fuzz: true,
    enable_short_term: true,
  }));
}

export function dayStart(t, hour = 4) {
  const d = new Date(t);
  d.setHours(d.getHours() - hour);
  d.setHours(0, 0, 0, 0);
  d.setHours(hour);
  return d.getTime();
}

export function conceptKey(card) {
  return card.course + ':' + card.slug;
}

function blank() {
  return {
    fs: null, firstReview: 0, lastReview: 0, reps: 0, lapses: 0, passed: false,
    suspended: false, edit: null, filled: null, bump: 0, acks: 0, ackLast: 0, history: [],
  };
}

function applyEvent(states, ev, sched) {
  const id = ev.card;
  if (!id) return;
  let st = states.get(id);
  if (!st) { st = blank(); states.set(id, st); }
  switch (ev.type) {
    case 'review': {
      const when = new Date(ev.t);
      const base = st.fs || createEmptyCard(when);
      const next = sched.next(base, when, ev.grade);
      st.fs = next.card;
      if (!st.firstReview) st.firstReview = ev.t;
      st.lastReview = ev.t;
      st.reps += 1;
      if (ev.grade === Rating.Again) st.lapses += st.reps > 1 ? 1 : 0;
      else st.passed = true;
      st.history.push({ t: ev.t, grade: ev.grade, id: ev.id });
      break;
    }
    case 'ack':
      st.acks += 1;
      st.ackLast = ev.t;
      st.lastReview = ev.t;
      if (!st.firstReview) st.firstReview = ev.t;
      st.history.push({ t: ev.t, grade: 0, id: ev.id });
      break;
    case 'edit':
      st.edit = ev.fields ? { ...ev.fields } : null;
      break;
    case 'fill':
      st.filled = { a: ev.a || '', x: ev.x || '' };
      break;
    case 'suspend':
      st.suspended = !!ev.on;
      break;
    case 'bump':
      st.bump = ev.t;
      break;
    case 'reset':
      st.fs = null; st.firstReview = 0; st.lastReview = 0; st.reps = 0; st.lapses = 0;
      st.passed = false; st.acks = 0; st.ackLast = 0;
      break;
    default:
  }
}

export function applyOne(states, ev, sched) {
  applyEvent(states, ev, sched);
}

export function replay(events, settings = DEFAULT_SETTINGS) {
  const sched = makeScheduler(settings);
  const undone = new Set(events.filter((e) => e.type === 'undo').map((e) => e.ref));
  const ordered = events.filter((e) => !undone.has(e.id) && e.type !== 'undo')
    .slice().sort((a, b) => a.t - b.t || (a.seq || 0) - (b.seq || 0));
  const states = new Map();
  for (const ev of ordered) applyEvent(states, ev, sched);
  return states;
}

export function stateOf(states, id) {
  return states.get(id) || blank();
}

// The card as the learner sees it: source text, plus their own edits and filled-in answers.
export function effective(card, st) {
  let out = card;
  if (st && st.filled) out = { ...out, a: st.filled.a || out.a, x: st.filled.x || out.x, filled: true };
  if (st && st.edit) out = { ...out, ...st.edit, edited: true };
  return out;
}

export function kindOf(card, st) {
  const k = cardKind(card);
  if (k === 'needs-you' && st && st.filled) return 'recall';
  return k;
}

function awareDue(st, now) {
  if (!st.acks) return 0;
  const step = AWARE_STEPS_DAYS[Math.min(st.acks - 1, AWARE_STEPS_DAYS.length - 1)];
  return st.ackLast + step * DAY;
}

export function dueTime(card, st) {
  const k = kindOf(card, st);
  if (k === 'aware') return st.acks ? awareDue(st) : 0;
  return st.fs ? new Date(st.fs.due).getTime() : 0;
}

// Sorts every schedulable card into the bucket it belongs to right now.
export function buildQueue(cards, states, settings, now) {
  const today = dayStart(now, settings.dayStartHour);
  const tomorrow = today + DAY;
  const q = { learnDue: [], learnLater: [], bumped: [], review: [], fresh: [], awareDue: [], awareNew: [], locked: 0 };
  let introducedToday = 0;
  let awareToday = 0;

  const usable = [];
  const byConcept = new Map();
  for (const card of cards) {
    if (card.retired) continue;
    if (card.depth === 'mastery' && !settings.mastery[card.course]) continue;
    const st = stateOf(states, card.id);
    const kind = kindOf(card, st);
    if (kind === 'ref' || kind === 'needs-you') continue;
    usable.push({ card, st, kind });
    if (kind !== 'aware' && !st.suspended) {
      const key = conceptKey(card);
      if (!byConcept.has(key)) byConcept.set(key, { M: [], U: [] });
      const group = byConcept.get(key);
      if (card.level === 'M' || card.level === 'U') group[card.level].push(st);
    }
  }

  const unlocked = (card) => {
    if (!settings.gating || card.level === 'M' || card.level === 'X') return true;
    const group = byConcept.get(conceptKey(card));
    if (!group) return true;
    if (!group.M.every((s) => s.passed)) return false;
    if (card.level === 'A' && !group.U.every((s) => s.passed)) return false;
    return true;
  };

  for (const item of usable) {
    const { card, st, kind } = item;
    if (kind === 'aware') {
      if (st.firstReview >= today && st.acks === 1) awareToday += 1;
      if (st.suspended) continue;
      if (!st.acks) q.awareNew.push(item);
      else if (awareDue(st) <= now) q.awareDue.push(item);
      continue;
    }
    if (st.firstReview >= today) introducedToday += 1;
    if (st.suspended) continue;
    const bumped = st.bump && st.bump > st.lastReview;
    if (!st.fs) {
      if (bumped) q.bumped.push(item);
      else if (unlocked(card)) q.fresh.push(item);
      else q.locked += 1;
      continue;
    }
    const due = new Date(st.fs.due).getTime();
    if (st.fs.state === State.Learning || st.fs.state === State.Relearning) {
      if (due <= now) q.learnDue.push(item); else q.learnLater.push(item);
    } else if (bumped) q.bumped.push(item);
    else if (due < tomorrow) q.review.push(item);
  }

  const byDue = (a, b) => new Date(a.st.fs.due) - new Date(b.st.fs.due);
  q.learnDue.sort(byDue);
  q.learnLater.sort(byDue);
  q.review.sort(byDue);
  q.bumped.sort((a, b) => b.st.bump - a.st.bump);
  const dir = settings.newOrder === 'oldest' ? 1 : -1;
  const inBatch = (a, b) => (a.card.order || 0) - (b.card.order || 0);
  q.fresh.sort((a, b) => dir * ((a.card.added || 0) - (b.card.added || 0)) || inBatch(a, b));
  q.awareNew.sort((a, b) => dir * ((a.card.added || 0) - (b.card.added || 0)) || inBatch(a, b));

  q.newLeft = Math.max(0, settings.newPerDay - introducedToday);
  q.awareLeft = Math.max(0, settings.awarePerDay - awareToday);
  q.counts = {
    learning: q.learnDue.length + q.learnLater.length,
    review: q.review.length + q.bumped.filter((i) => i.st.fs).length,
    fresh: Math.min(q.newLeft, q.fresh.length) + q.bumped.filter((i) => !i.st.fs).length,
    aware: q.awareDue.length + Math.min(q.awareLeft, q.awareNew.length),
  };
  q.counts.total = q.counts.learning + q.counts.review + q.counts.fresh + q.counts.aware;
  return q;
}

// Picks the next card to show. `turn` counts cards shown this session; `lastConcept` avoids
// showing two reviews of the same concept back to back.
export function nextCard(q, now, turn = 0, lastConcept = '') {
  if (q.learnDue.length) return q.learnDue[0];
  if (q.bumped.length) return q.bumped[0];
  const fresh = q.newLeft > 0 ? q.fresh : [];
  const pickReview = () => q.review.find((i) => conceptKey(i.card) !== lastConcept) || q.review[0];
  if (q.review.length && fresh.length) {
    const freshCount = Math.min(q.newLeft, fresh.length);
    const every = Math.max(2, Math.round((q.review.length + freshCount) / freshCount));
    return turn % every === every - 1 ? fresh[0] : pickReview();
  }
  if (q.review.length) return pickReview();
  if (fresh.length) return fresh[0];
  if (q.awareDue.length) return q.awareDue[0];
  if (q.awareLeft > 0 && q.awareNew.length) return q.awareNew[0];
  if (q.learnLater.length && new Date(q.learnLater[0].st.fs.due).getTime() - now <= LEARN_AHEAD_MS) return q.learnLater[0];
  return null;
}

// What each grade would do to this card, for the labels on the buttons.
export function previewGrades(st, now, sched) {
  const when = new Date(now);
  const base = st.fs || createEmptyCard(when);
  const all = sched.repeat(base, when);
  const out = {};
  for (const g of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
    out[g] = new Date(all[g].card.due).getTime() - now;
  }
  return out;
}

export function describeState(card, st, now) {
  const kind = kindOf(card, st);
  if (card.retired) return 'retired';
  if (kind === 'ref') return 'reference';
  if (kind === 'needs-you') return 'needs you';
  if (st.suspended) return 'suspended';
  if (kind === 'aware') return st.acks ? 'awareness' : 'new';
  if (!st.fs) return 'new';
  if (st.fs.state === State.Learning || st.fs.state === State.Relearning) return 'learning';
  return new Date(st.fs.due).getTime() <= now ? 'due' : 'review';
}
