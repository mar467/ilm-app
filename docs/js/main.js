import { html, render, useState, useEffect, useRef, useMemo } from '../vendor/preact-htm.js';
import * as store from './store.js';
import { parseAny, validateCards, countByLevel, cardKind } from './parser.js';
import { toHtml, plain, humanInterval, humanDue } from './render.js';
import {
  DEFAULT_SETTINGS, Rating, replay, applyOne, makeScheduler, stateOf, effective, kindOf,
  buildQueue, nextCard, previewGrades, describeState, conceptKey, dueTime,
} from './engine.js';

// ---------------------------------------------------------------- app state

const app = {
  ready: false, cards: [], byId: new Map(), events: [], states: new Map(),
  settings: { ...DEFAULT_SETTINGS }, device: '', seq: 0, sched: null, version: 0, error: '',
};
const listeners = new Set();
const emit = () => { app.version += 1; listeners.forEach((fn) => fn(app.version)); };

function useApp() {
  const [, set] = useState(0);
  useEffect(() => { listeners.add(set); return () => listeners.delete(set); }, []);
  return app;
}

function setCards(cards) {
  app.cards = cards.slice().sort((a, b) => (a.added || 0) - (b.added || 0) || (a.order || 0) - (b.order || 0));
  app.byId = new Map(app.cards.map((c) => [c.id, c]));
}

function rebuild() {
  app.sched = makeScheduler(app.settings);
  app.states = replay(app.events, app.settings);
}

async function load() {
  const [cards, events, settings, device] = await Promise.all([
    store.getCards(), store.getEvents(), store.getMeta('settings'), store.getMeta('device'),
  ]);
  app.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  app.device = device || 'd' + Math.random().toString(36).slice(2, 8);
  if (!device) await store.setMeta('device', app.device);
  app.events = events;
  app.seq = events.reduce((m, e) => Math.max(m, e.seq || 0), 0);
  setCards(cards);
  rebuild();
  app.ready = true;
  store.requestPersistence();
  emit();
}

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

async function log(type, fields = {}) {
  const ev = { id: newId(), seq: ++app.seq, device: app.device, t: Date.now(), type, ...fields };
  app.events.push(ev);
  if (type === 'undo' || type === 'reset') rebuild(); else applyOne(app.states, ev, app.sched);
  emit();
  try { await store.addEvents([ev]); } catch (e) { app.error = 'Could not save to this device: ' + e.message; emit(); }
  return ev;
}

async function saveSettings(patch) {
  app.settings = { ...app.settings, ...patch };
  await store.setMeta('settings', app.settings);
  rebuild();
  emit();
}

function planImport(parsed) {
  const incoming = new Map(parsed.cards.map((c) => [c.id, c]));
  const plan = { fresh: [], changed: [], same: 0, retiring: [], editedKept: 0 };
  for (const c of parsed.cards) {
    const old = app.byId.get(c.id);
    if (!old) plan.fresh.push(c);
    else if (old.hash !== c.hash || old.retired) {
      plan.changed.push(c);
      if (stateOf(app.states, c.id).edit) plan.editedKept += 1;
    } else plan.same += 1;
  }
  for (const old of app.cards) {
    if (old.file === parsed.title && !old.retired && !incoming.has(old.id)) plan.retiring.push(old);
  }
  return plan;
}

async function runImport(parsed, plan, restartChanged) {
  const now = Date.now();
  const out = parsed.cards.map((c) => {
    const old = app.byId.get(c.id);
    return { ...c, file: parsed.title, added: old ? old.added : now, retired: false };
  });
  const retired = plan.retiring.map((c) => ({ ...c, retired: true }));
  await store.putCards([...out, ...retired]);
  const merged = new Map(app.byId);
  [...out, ...retired].forEach((c) => merged.set(c.id, c));
  setCards([...merged.values()]);
  await log('import', { file: parsed.title, fresh: plan.fresh.length, changed: plan.changed.length, retired: retired.length });
  if (restartChanged) for (const c of plan.changed) await log('reset', { card: c.id });
  emit();
}

async function addCapture({ c, q, a, x }) {
  const stamp = Date.now();
  const id = `CAP.${stamp.toString(36)}.M1`;
  const card = {
    id, type: 'M-FACT', status: 'active', c: c.trim(), q: q.trim(), a: a.trim(), x: (x || '').trim(), s: 'captured in the app',
    tags: ['capture'], depth: 'standard', section: '', order: 0, file: 'Captured cards', added: stamp, origin: 'capture',
    course: 'CAP', lesson: '', slug: stamp.toString(36), level: 'M', n: 1, hash: '',
  };
  await store.putCards([card]);
  setCards([...app.cards, card]);
  await log('capture', { card: id, content: { c: card.c, q: card.q, a: card.a, x: card.x } });
  await log('bump', { card: id });
  return card;
}

function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportBackup() {
  const data = { app: 'ilm', version: 1, exported: new Date().toISOString(), device: app.device, settings: app.settings, cards: app.cards, events: app.events };
  download(`ilm-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data));
}

async function restoreBackup(text) {
  const data = JSON.parse(text);
  if (data.app !== 'ilm' || !Array.isArray(data.cards) || !Array.isArray(data.events)) throw new Error('this is not an Ilm backup file');
  await store.replaceAll({ cards: data.cards, events: data.events, settings: data.settings });
  await load();
}

function exportAnki() {
  const cell = (s) => (s || '').replace(/\t/g, ' ');
  const fmt = (s) => {
    const lines = (s || '').split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, (m, t) => `<b>${t.toUpperCase()}</b>`));
    return lines.length > 1 ? '<ul>' + lines.map((l) => `<li>${l.replace(/^(\d+\)|-)\s+/, '')}</li>`).join('') + '</ul>' : lines[0];
  };
  const rows = [];
  for (const card of app.cards) {
    if (card.retired) continue;
    const c = effective(card, stateOf(app.states, card.id));
    const front = (c.c ? `<small>${fmt(c.c)}</small><br>` : '') + fmt(c.q);
    const back = fmt(c.a) + (c.x ? '<hr>' + fmt(c.x) : '');
    rows.push([front, back, c.s, (c.tags || []).join(' '), c.id].map(cell).join('\t'));
  }
  download('ilm-anki-export.txt', rows.join('\n'), 'text/plain');
}

// ---------------------------------------------------------------- small pieces

const go = (hash) => { location.hash = hash; };
const Rich = ({ text, cls }) => html`<div class=${cls || ''} dangerouslySetInnerHTML=${{ __html: toHtml(text) }} />`;

function useRoute() {
  const [route, setRoute] = useState(location.hash.slice(1));
  useEffect(() => {
    const on = () => { setRoute(location.hash.slice(1)); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    setRoute(location.hash.slice(1)); // in case the address changed before this listener was attached
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

const TYPE_HINT = { M: 'recall', U: 'understand', A: 'apply', X: 'reference' };

function Shell({ title, back, children, actions }) {
  return html`
    <header class="bar">
      ${back !== undefined ? html`<button class="icon" aria-label="Back" onClick=${() => go(back)}>‹</button>` : html`<span class="brand">Ilm</span>`}
      <h1>${title}</h1>
      <span class="grow"></span>
      ${actions}
    </header>
    <main>${children}</main>`;
}

function Nav({ route }) {
  const tab = (hash, label) => html`<a href=${'#' + hash} class=${route === hash ? 'on' : ''}>${label}</a>`;
  return html`<nav class="tabs">${tab('', 'Today')}${tab('browse', 'Cards')}${tab('add', 'Add')}${tab('import', 'Import')}${tab('settings', 'Settings')}</nav>`;
}

// ---------------------------------------------------------------- home

function Home() {
  useApp();
  const now = Date.now();
  const q = useMemo(() => buildQueue(app.cards, app.states, app.settings, now), [app.version]);
  const needs = app.cards.filter((c) => !c.retired && cardKind(c) === 'needs-you' && !stateOf(app.states, c.id).filled
    && (c.depth !== 'mastery' || app.settings.mastery[c.course]));
  const files = useMemo(() => {
    const map = new Map();
    for (const card of app.cards) {
      if (card.retired) continue;
      const key = card.file || 'Other';
      if (!map.has(key)) map.set(key, { name: key, course: card.course, total: 0, fresh: 0, learning: 0, known: 0, hasMastery: false });
      const f = map.get(key);
      if (card.depth === 'mastery') { f.hasMastery = true; if (!app.settings.mastery[card.course]) continue; }
      const state = describeState(card, stateOf(app.states, card.id), now);
      if (['reference', 'needs you', 'suspended'].includes(state)) continue;
      f.total += 1;
      if (state === 'new') f.fresh += 1; else if (state === 'learning') f.learning += 1; else f.known += 1;
    }
    return [...map.values()];
  }, [app.version]);

  if (!app.cards.length) {
    return html`<${Shell} title="Today">
      <section class="empty">
        <h2>No cards yet</h2>
        <p>Bring in a card file to start. Card files made by the flashcard SOP import directly.</p>
        <button class="primary" onClick=${() => go('import')}>Import cards</button>
      </section>
    <//>`;
  }
  const c = q.counts;
  const later = !c.total && q.learnLater.length ? new Date(q.learnLater[0].st.fs.due).getTime() : 0;
  return html`<${Shell} title="Today">
    <section class="today">
      <div class="stats">
        <div><b>${c.learning}</b><span>learning</span></div>
        <div><b>${c.review}</b><span>to review</span></div>
        <div><b>${c.fresh}</b><span>new</span></div>
      </div>
      ${c.total
        ? html`<button class="primary big" onClick=${() => go('review')}>Start · ${c.total} ${c.total === 1 ? 'card' : 'cards'}</button>`
        : html`<p class="done-note">${later ? `Nothing due right now. Next card ${humanDue(later, now)}.` : 'Done for today.'}</p>
            ${later ? html`<button class="primary big" onClick=${() => go('review')}>Continue anyway</button>` : null}`}
      ${q.locked ? html`<p class="hint">${q.locked} higher-level ${q.locked === 1 ? 'card is' : 'cards are'} waiting until the level 1 cards for their concept have been answered.</p>` : null}
    </section>
    ${needs.length ? html`<a class="row link" href="#needs"><span>Needs you</span><span class="muted">${needs.length} personal ${needs.length === 1 ? 'card' : 'cards'} to fill in ›</span></a>` : null}
    <h2 class="label">Decks</h2>
    ${files.map((f) => html`
      <div class="row deck">
        <div class="deck-name">${f.name.replace(/\s+—\s+cards$/, '')}</div>
        <div class="deck-meta">
          <span>${f.fresh} new</span><span>${f.learning} learning</span><span>${f.known} known</span><span class="muted">${f.total} in rotation</span>
        </div>
        ${f.hasMastery ? html`<label class="check"><input type="checkbox" checked=${!!app.settings.mastery[f.course]}
            onChange=${(e) => saveSettings({ mastery: { ...app.settings.mastery, [f.course]: e.target.checked } })} /> include mastery-depth cards</label>` : null}
      </div>`)}
  <//>`;
}

// ---------------------------------------------------------------- review

function Review() {
  useApp();
  const [cur, setCur] = useState(null);       // { id }
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(0);
  const [editing, setEditing] = useState(false);
  const session = useRef({ turn: 0, last: '', stack: [] });

  const pick = () => {
    const now = Date.now();
    const q = buildQueue(app.cards, app.states, app.settings, now);
    const item = nextCard(q, now, session.current.turn, session.current.last);
    setCur(item ? { id: item.card.id } : { id: null, q });
    setShown(false);
  };
  useEffect(pick, []);

  const card = cur && cur.id ? app.byId.get(cur.id) : null;
  const st = card ? stateOf(app.states, card.id) : null;
  const view = card ? effective(card, st) : null;
  const kind = card ? kindOf(card, st) : '';

  const answer = async (grade) => {
    if (!card) return;
    const ev = kind === 'aware' ? await log('ack', { card: card.id }) : await log('review', { card: card.id, grade });
    session.current.stack.push({ ev: ev.id, card: card.id });
    session.current.turn += 1;
    session.current.last = conceptKey(card);
    setDone((n) => n + 1);
    pick();
  };
  const undo = async () => {
    const last = session.current.stack.pop();
    if (!last) return;
    await log('undo', { ref: last.ev });
    session.current.turn = Math.max(0, session.current.turn - 1);
    setDone((n) => Math.max(0, n - 1));
    setCur({ id: last.card });
    setShown(false);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (editing || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      if (!card) return;
      if (e.key === 'u') { undo(); return; }
      if (e.key === 'e') { setEditing(true); return; }
      if (kind === 'aware') { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); answer(Rating.Good); } return; }
      if (kind === 'do') {
        if (e.key === '1') answer(Rating.Again);
        if (e.key === '3' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); answer(Rating.Good); }
        return;
      }
      if (!shown) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setShown(true); } return; }
      if (['1', '2', '3', '4'].includes(e.key)) answer(Number(e.key));
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); answer(Rating.Good); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const now = Date.now();
  const counts = buildQueue(app.cards, app.states, app.settings, now).counts;
  const bar = html`
    <header class="bar">
      <button class="icon" aria-label="Close" onClick=${() => go('')}>✕</button>
      <span class="counts"><i class="c-learn">${counts.learning}</i><i class="c-rev">${counts.review}</i><i class="c-new">${counts.fresh}</i></span>
      <span class="grow"></span>
      <button class="text" disabled=${!session.current.stack.length} onClick=${undo}>Undo</button>
      ${card ? html`<button class="text" onClick=${() => setEditing(true)}>Edit</button>` : null}
    </header>`;

  if (!cur) return html`${bar}<main />`;
  if (!card) {
    const later = cur.q && cur.q.learnLater.length ? new Date(cur.q.learnLater[0].st.fs.due).getTime() : 0;
    return html`${bar}<main><section class="empty">
      <h2>${done ? 'Session finished' : 'Nothing due'}</h2>
      <p>${done ? `${done} ${done === 1 ? 'card' : 'cards'} answered.` : ''} ${later ? `The next card comes back ${humanDue(later, now)}.` : 'Nothing else is due today.'}</p>
      ${later ? html`<button onClick=${pick}>Check again</button>` : null}
      <button class="primary" onClick=${() => go('')}>Back to today</button>
    </section></main>`;
  }

  const preview = kind === 'aware' ? null : previewGrades(st, now, app.sched);
  const gradeBtn = (grade, label, cls) => html`
    <button class=${'grade ' + cls} onClick=${() => answer(grade)}>
      <span>${label}</span><small>${humanInterval(preview[grade])}</small>
    </button>`;
  const isNew = !st.fs && !st.acks;

  return html`${bar}
    <main class="review">
      <article class="card" onClick=${() => { if (kind === 'recall' && !shown) setShown(true); }}>
        <div class="context">
          <span>${view.c || ' '}</span>
          <span class="chip">${isNew ? 'new · ' : ''}${kind === 'aware' ? 'awareness' : TYPE_HINT[card.level] || ''}</span>
        </div>
        <${Rich} cls="question" text=${view.q} />
        ${kind === 'recall' && shown ? html`
          <hr />
          <${Rich} cls="answer" text=${view.a} />
          ${view.x ? html`<${Rich} cls="extra" text=${view.x} />` : null}
          ${view.s ? html`<div class="source">${view.s} · ${card.id}</div>` : null}` : null}
        ${kind === 'do' && view.x ? html`<${Rich} cls="extra" text=${view.x} />` : null}
        ${kind === 'aware' ? html`<p class="hint">Just a reminder that this exists. Nothing to recall.</p>` : null}
      </article>
    </main>
    <footer class="actions">
      ${kind === 'aware' ? html`<button class="primary big" onClick=${() => answer(Rating.Good)}>Seen</button>` : null}
      ${kind === 'do' ? html`<div class="grades two">${gradeBtn(Rating.Again, 'Repeat', 'again')}${gradeBtn(Rating.Good, 'Smooth', 'good')}</div>` : null}
      ${kind === 'recall' && !shown ? html`<button class="primary big" onClick=${() => setShown(true)}>Show answer</button>` : null}
      ${kind === 'recall' && shown ? html`<div class="grades">
        ${gradeBtn(Rating.Again, 'Again', 'again')}${gradeBtn(Rating.Hard, 'Hard', 'hard')}${gradeBtn(Rating.Good, 'Good', 'good')}${gradeBtn(Rating.Easy, 'Easy', 'easy')}
      </div>` : null}
    </footer>
    ${editing ? html`<${EditCard} card=${card} onClose=${() => setEditing(false)} />` : null}`;
}

// ---------------------------------------------------------------- edit

function EditCard({ card, onClose }) {
  const st = stateOf(app.states, card.id);
  const view = effective(card, st);
  const [f, setF] = useState({ c: view.c, q: view.q, a: view.a, x: view.x });
  const field = (key, label, rows) => html`
    <label class="field"><span>${label}</span>
      <textarea rows=${rows} dir="auto" value=${f[key]} onInput=${(e) => setF({ ...f, [key]: e.target.value })} />
    </label>`;
  const save = async () => {
    const fields = {};
    for (const k of ['c', 'q', 'a', 'x']) if (f[k].trim() !== (card[k] || '')) fields[k] = f[k].trim();
    await log('edit', { card: card.id, fields: Object.keys(fields).length ? fields : null });
    onClose();
  };
  return html`<div class="sheet-wrap" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="sheet" role="dialog" aria-label="Edit card">
      <h2>Edit card <small class="muted">${card.id}</small></h2>
      ${field('c', 'Context', 1)}${field('q', 'Question', 3)}${field('a', 'Answer', 3)}${field('x', 'Extra (shown under the answer)', 2)}
      <p class="hint">Use **two asterisks** around the key term. Your wording is kept on this device and stays if the card file is imported again.</p>
      <div class="buttons">
        ${st.edit ? html`<button onClick=${async () => { await log('edit', { card: card.id, fields: null }); onClose(); }}>Use original</button>` : null}
        <span class="grow"></span>
        <button onClick=${onClose}>Cancel</button>
        <button class="primary" onClick=${save}>Save</button>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- browse

function Browse() {
  useApp();
  const [text, setText] = useState('');
  const [level, setLevel] = useState('');
  const [state, setState] = useState('');
  const [file, setFile] = useState('');
  const now = Date.now();
  const files = [...new Set(app.cards.map((c) => c.file))];
  const needle = text.trim().toLowerCase();
  const matches = app.cards.filter((card) => {
    if (level && card.level !== level) return false;
    if (file && card.file !== file) return false;
    const st = stateOf(app.states, card.id);
    if (state) {
      const d = describeState(card, st, now);
      if (state === 'edited' ? !st.edit : d !== state) return false;
    } else if (card.retired) return false;
    if (!needle) return true;
    const v = effective(card, st);
    return (v.q + ' ' + v.a + ' ' + v.c + ' ' + card.id + ' ' + v.x).toLowerCase().includes(needle);
  });
  const shown = matches.slice(0, 200);
  const opt = (v, label) => html`<option value=${v}>${label}</option>`;
  return html`<${Shell} title="Cards">
    <div class="filters">
      <input type="search" placeholder="Search questions, answers, IDs" value=${text} onInput=${(e) => setText(e.target.value)} />
      <div class="selects">
        <select value=${level} onChange=${(e) => setLevel(e.target.value)}>${opt('', 'All levels')}${opt('M', 'Level 1 · recall')}${opt('U', 'Level 2 · understand')}${opt('A', 'Level 3 · apply')}${opt('X', 'Reference')}</select>
        <select value=${state} onChange=${(e) => setState(e.target.value)}>
          ${opt('', 'Any state')}${['new', 'learning', 'due', 'review', 'needs you', 'reference', 'suspended', 'edited', 'retired'].map((s) => opt(s, s))}
        </select>
        ${files.length > 1 ? html`<select value=${file} onChange=${(e) => setFile(e.target.value)}>${opt('', 'All decks')}${files.map((f) => opt(f, f.replace(/\s+—\s+cards$/, '')))}</select>` : null}
      </div>
    </div>
    <p class="muted count">${matches.length} ${matches.length === 1 ? 'card' : 'cards'}${matches.length > shown.length ? `, showing the first ${shown.length}` : ''}</p>
    ${shown.map((card) => {
      const st = stateOf(app.states, card.id);
      const v = effective(card, st);
      return html`<a class="row item" href=${'#card/' + encodeURIComponent(card.id)}>
        <div class="item-ctx">${v.c}</div>
        <${Rich} cls="item-q" text=${v.q.split('\n')[0]} />
        <div class="item-meta"><span>${card.type}</span><span>${describeState(card, st, now)}</span>${st.edit ? html`<span>edited</span>` : null}</div>
      </a>`;
    })}
  <//>`;
}

function CardPage({ id }) {
  useApp();
  const [editing, setEditing] = useState(false);
  const card = app.byId.get(id);
  if (!card) return html`<${Shell} title="Card" back="browse"><p class="empty">This card is not on this device.</p><//>`;
  const st = stateOf(app.states, id);
  const v = effective(card, st);
  const now = Date.now();
  const kind = kindOf(card, st);
  const due = dueTime(card, st);
  const gradeName = ['seen', 'again', 'hard', 'good', 'easy'];
  return html`<${Shell} title="Card" back="browse">
    <article class="card flat">
      <div class="context"><span>${v.c}</span><span class="chip">${card.type}</span></div>
      <${Rich} cls="question" text=${v.q} />
      <hr />
      <${Rich} cls="answer" text=${v.a || '—'} />
      ${v.x ? html`<${Rich} cls="extra" text=${v.x} />` : null}
      <div class="source">${v.s ? v.s + ' · ' : ''}${card.id}</div>
    </article>
    <dl class="facts">
      <dt>State</dt><dd>${describeState(card, st, now)}${st.edit ? ' · your wording' : ''}${card.depth === 'mastery' ? ' · mastery depth' : ''}</dd>
      ${due ? html`<dt>Next</dt><dd>${humanDue(due, now)}</dd>` : null}
      <dt>Answered</dt><dd>${st.reps} ${st.reps === 1 ? 'time' : 'times'}${st.lapses ? `, forgotten ${st.lapses}` : ''}</dd>
      <dt>Deck</dt><dd>${(card.file || '').replace(/\s+—\s+cards$/, '')}${card.section ? ' · ' + card.section : ''}</dd>
    </dl>
    <div class="buttons wrap">
      <button onClick=${() => setEditing(true)}>Edit</button>
      ${kind === 'recall' || kind === 'do' ? html`<button onClick=${async () => { await log('bump', { card: id }); go('review'); }}>Study now</button>` : null}
      ${kind !== 'ref' ? html`<button onClick=${() => log('suspend', { card: id, on: !st.suspended })}>${st.suspended ? 'Resume' : 'Suspend'}</button>` : null}
      ${st.reps ? html`<button onClick=${() => log('reset', { card: id })}>Restart schedule</button>` : null}
    </div>
    ${st.history.length ? html`<h2 class="label">History</h2>
      <ul class="history">${st.history.slice().reverse().map((h) => html`<li><span>${new Date(h.t).toLocaleString()}</span><span>${gradeName[h.grade]}</span></li>`)}</ul>` : null}
    ${editing ? html`<${EditCard} card=${card} onClose=${() => setEditing(false)} />` : null}
  <//>`;
}

// ---------------------------------------------------------------- needs you

function Needs() {
  useApp();
  const list = app.cards.filter((c) => !c.retired && cardKind(c) === 'needs-you');
  return html`<${Shell} title="Needs you" back="">
    <p class="hint pad">These cards ask for something from your own life. Claude never fills them in. Once you save an answer the card joins your reviews.</p>
    ${list.map((card) => html`<${NeedsItem} key=${card.id} card=${card} />`)}
    ${!list.length ? html`<p class="empty">No personal cards right now.</p>` : null}
  <//>`;
}

function NeedsItem({ card }) {
  const st = stateOf(app.states, card.id);
  const [a, setA] = useState(st.filled ? st.filled.a : '');
  const [x, setX] = useState(st.filled ? st.filled.x : '');
  const [saved, setSaved] = useState(false);
  return html`<div class="row needs">
    <div class="item-ctx">${card.c}</div>
    <${Rich} cls="item-q" text=${card.q} />
    <label class="field"><span>Your answer, a few keywords · ${plain(card.a)}</span>
      <textarea rows="2" dir="auto" value=${a} onInput=${(e) => { setA(e.target.value); setSaved(false); }} /></label>
    <label class="field"><span>The full story (optional, shown under the answer)</span>
      <textarea rows="2" dir="auto" value=${x} onInput=${(e) => { setX(e.target.value); setSaved(false); }} /></label>
    <div class="buttons"><span class="muted">${st.filled ? (saved ? 'Saved' : 'In your reviews') : ''}</span><span class="grow"></span>
      <button class="primary" disabled=${!a.trim()} onClick=${async () => { await log('fill', { card: card.id, a: a.trim(), x: x.trim() }); setSaved(true); }}>Save</button></div>
  </div>`;
}

// ---------------------------------------------------------------- add

function Add() {
  useApp();
  const last = useRef(localStorage.getItem('ilm-last-context') || '');
  const [f, setF] = useState({ c: last.current, q: '', a: '', x: '' });
  const [note, setNote] = useState('');
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setNote(''); };
  const ok = f.q.trim() && f.a.trim();
  const save = async (thenReview) => {
    await addCapture(f);
    try { localStorage.setItem('ilm-last-context', f.c); } catch (e) { /* private mode */ }
    if (thenReview) { go('review'); return; }
    setF({ c: f.c, q: '', a: '', x: '' });
    setNote('Added. It is first in your next session.');
  };
  return html`<${Shell} title="Add a card">
    <div class="form">
      <label class="field"><span>Context (broad › narrow)</span><input dir="auto" value=${f.c} onInput=${set('c')} placeholder="Epistemology › Knowledge" /></label>
      <label class="field"><span>Question</span><textarea rows="3" dir="auto" value=${f.q} onInput=${set('q')} /></label>
      <label class="field"><span>Answer</span><textarea rows="3" dir="auto" value=${f.a} onInput=${set('a')} /></label>
      <label class="field"><span>Extra (optional)</span><textarea rows="2" dir="auto" value=${f.x} onInput=${set('x')} /></label>
      <p class="hint">A captured card goes to the front of your queue. Keep it to one question and a short answer; **two asterisks** make the key term bold.</p>
      <div class="buttons"><span class="muted">${note}</span><span class="grow"></span>
        <button disabled=${!ok} onClick=${() => save(false)}>Save and add another</button>
        <button class="primary" disabled=${!ok} onClick=${() => save(true)}>Save and study</button></div>
    </div>
  <//>`;
}

// ---------------------------------------------------------------- import

function Import() {
  useApp();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState(null);
  const [restart, setRestart] = useState(false);
  const [done, setDone] = useState('');
  const check = (source, fileName) => {
    const parsed = parseAny(source, (fileName || '').replace(/\.(md|txt|tsv)$/i, ''));
    const checks = validateCards(parsed.cards);
    setResult({ parsed, checks, plan: planImport(parsed), problems: parsed.problems });
    setDone('');
  };
  const onFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const body = await file.text();
    setText(body); setName(file.name); check(body, file.name);
  };
  const run = async () => {
    const { parsed, plan } = result;
    await runImport(parsed, plan, restart);
    setDone(`Imported: ${plan.fresh.length} new, ${plan.changed.length} updated${plan.retiring.length ? `, ${plan.retiring.length} retired` : ''}.`);
    setResult(null); setText(''); setName('');
  };
  const r = result;
  const blocked = r && (r.checks.errors.length || r.problems.length || !r.parsed.cards.length);
  const levels = r ? countByLevel(r.parsed.cards) : null;
  return html`<${Shell} title="Import cards">
    <div class="form">
      ${done ? html`<p class="notice ok">${done} <a href="#">Go to today ›</a></p>` : null}
      <label class="field"><span>Choose a card file (.md from the flashcard SOP, or a tab-separated .txt)</span>
        <input type="file" accept=".md,.txt,.tsv,text/plain,text/markdown" onChange=${onFile} /></label>
      <label class="field"><span>Or paste the cards here</span>
        <textarea rows="8" dir="auto" spellcheck=${false} value=${text} onInput=${(e) => { setText(e.target.value); setResult(null); }} /></label>
      <div class="buttons"><span class="grow"></span><button disabled=${!text.trim()} onClick=${() => check(text, name)}>Check</button></div>
      ${r ? html`<div class="preview">
        <h2>${r.parsed.title || 'Untitled'}</h2>
        <p>${r.parsed.cards.length} cards: ${levels.M} level 1, ${levels.U} level 2, ${levels.A} level 3, ${levels.X} reference.</p>
        <p><b>${r.plan.fresh.length}</b> new · <b>${r.plan.changed.length}</b> changed · ${r.plan.same} unchanged${r.plan.retiring.length ? html` · <b>${r.plan.retiring.length}</b> no longer in the file (will be retired, history kept)` : ''}</p>
        ${r.plan.editedKept ? html`<p class="hint">${r.plan.editedKept} changed ${r.plan.editedKept === 1 ? 'card has' : 'cards have'} your own wording, which is kept.</p>` : null}
        ${r.plan.changed.length ? html`<label class="check"><input type="checkbox" checked=${restart} onChange=${(e) => setRestart(e.target.checked)} /> restart the schedule of changed cards</label>` : null}
        ${[...r.problems, ...r.checks.errors].length ? html`<div class="notice bad"><b>Must be fixed before importing</b>
          <ul>${[...r.problems, ...r.checks.errors].slice(0, 50).map((p) => html`<li><code>${p.id}</code> ${p.msg}</li>`)}</ul></div>` : null}
        ${r.checks.warnings.length ? html`<details class="notice warn"><summary>${r.checks.warnings.length} ${r.checks.warnings.length === 1 ? 'card' : 'cards'} to look at (import is still allowed)</summary>
          <ul>${r.checks.warnings.slice(0, 100).map((p) => html`<li><code>${p.id}</code> ${p.msg}</li>`)}</ul></details>` : null}
        <div class="buttons"><span class="grow"></span>
          <button class="primary" disabled=${blocked} onClick=${run}>Import ${r.plan.fresh.length + r.plan.changed.length} ${r.plan.fresh.length + r.plan.changed.length === 1 ? 'card' : 'cards'}</button></div>
      </div>` : null}
    </div>
  <//>`;
}

// ---------------------------------------------------------------- settings

function Settings() {
  useApp();
  const s = app.settings;
  const [msg, setMsg] = useState('');
  const [erase, setErase] = useState('');
  const onRestore = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { await restoreBackup(await file.text()); setMsg(`Restored ${app.cards.length} cards and ${app.events.length} history records.`); }
    catch (err) { setMsg('Could not restore: ' + err.message); }
    e.target.value = '';
  };
  return html`<${Shell} title="Settings">
    <div class="form">
      <h2 class="label">Reviews</h2>
      <label class="field inline"><span>New cards a day</span>
        <input type="number" min="0" max="500" value=${s.newPerDay} onChange=${(e) => saveSettings({ newPerDay: Math.max(0, Number(e.target.value) || 0) })} /></label>
      <label class="field inline"><span>Order of new cards</span>
        <select value=${s.newOrder} onChange=${(e) => saveSettings({ newOrder: e.target.value })}>
          <option value="newest">Most recently added first</option><option value="oldest">Oldest first</option></select></label>
      <label class="check"><input type="checkbox" checked=${s.gating} onChange=${(e) => saveSettings({ gating: e.target.checked })} />
        Levels in order: hold back a concept's level 2 and 3 cards until its level 1 cards have been answered</label>
      <label class="field inline"><span>Target recall when a card comes back</span>
        <select value=${String(s.retention)} onChange=${(e) => saveSettings({ retention: Number(e.target.value) })}>
          <option value="0.85">85% (fewer reviews)</option><option value="0.9">90%</option><option value="0.95">95% (more reviews)</option></select></label>

      <h2 class="label">Backup</h2>
      <p class="hint">Everything is stored on this device only for now. Download a backup regularly until sync is switched on.</p>
      <div class="buttons wrap">
        <button onClick=${exportBackup}>Download backup</button>
        <label class="button">Restore from backup<input type="file" accept="application/json,.json" hidden onChange=${onRestore} /></label>
        <button onClick=${exportAnki}>Export for Anki</button>
      </div>
      ${msg ? html`<p class="notice ok">${msg}</p>` : null}

      <h2 class="label">This device</h2>
      <p class="muted">${app.cards.length} cards · ${app.events.length} history records · device ${app.device}</p>
      <label class="field"><span>To erase everything on this device, type <b>erase</b></span>
        <input value=${erase} onInput=${(e) => setErase(e.target.value)} /></label>
      <div class="buttons"><span class="grow"></span>
        <button class="danger" disabled=${erase.trim().toLowerCase() !== 'erase'} onClick=${async () => { await store.eraseAll(); setErase(''); await load(); setMsg('Erased.'); }}>Erase</button></div>
    </div>
  <//>`;
}

// ---------------------------------------------------------------- root

function Root() {
  useApp();
  const route = useRoute();
  if (!app.ready) return html`<main class="empty"><p>${app.error || 'Loading…'}</p></main>`;
  let page;
  if (route === 'review') return html`<div class="screen review-screen"><${Review} /></div>`;
  if (route === 'browse') page = html`<${Browse} />`;
  else if (route.startsWith('card/')) page = html`<${CardPage} id=${decodeURIComponent(route.slice(5))} />`;
  else if (route === 'needs') page = html`<${Needs} />`;
  else if (route === 'add') page = html`<${Add} />`;
  else if (route === 'import') page = html`<${Import} />`;
  else if (route === 'settings') page = html`<${Settings} />`;
  else page = html`<${Home} />`;
  return html`<div class="screen">${app.error ? html`<p class="notice bad">${app.error}</p>` : null}${page}<${Nav} route=${route.startsWith('card/') ? 'browse' : route === 'needs' ? '' : route} /></div>`;
}

load().catch((e) => { app.error = 'This browser could not open local storage: ' + e.message; emit(); });
render(html`<${Root} />`, document.getElementById('app'));
