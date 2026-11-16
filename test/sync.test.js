import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync, checkAccess, serializeLog, parseLog, monthOf, toBase64, SyncError } from '../docs/js/sync.js';

// A small stand-in for the four GitHub endpoints the app uses.
function fakeGitHub(files = {}) {
  const store = new Map();
  let n = 0;
  const put = (path, text) => { const sha = 'sha' + (++n); store.set(path, { text, sha }); return sha; };
  Object.entries(files).forEach(([p, t]) => put(p, t));
  const calls = [];
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    calls.push(opts.method + ' ' + decodeURIComponent(u.pathname));
    if (opts.headers.Authorization !== 'Bearer good') return json(401, {});
    const path = decodeURIComponent(u.pathname);
    if (path === '/repos/o/r') return json(200, { default_branch: 'main', private: true, permissions: { push: true } });
    if (path === '/repos/o/r/git/trees/main') return json(200, { tree: [...store].map(([p, f]) => ({ path: p, type: 'blob', sha: f.sha })) });
    const m = /^\/repos\/o\/r\/contents\/(.+)$/.exec(path);
    if (m && opts.method === 'GET') {
      const f = store.get(m[1]);
      if (!f) return json(404, {});
      return opts.headers.Accept.includes('raw') ? json(200, f.text) : json(200, { sha: f.sha });
    }
    if (m && opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      const f = store.get(m[1]);
      if ((f && body.sha !== f.sha) || (!f && body.sha)) return json(409, {});
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      return json(200, { content: { sha: put(m[1], text) } });
    }
    return json(500, {});
  };
  return { fetchImpl, store, calls, put };
}

function device(name, gh) {
  const d = { name, events: [], shas: {}, pushed: {}, cardFiles: [], seq: 0 };
  d.act = (type, t, extra = {}) => d.events.push({ id: `${name}-${++d.seq}`, seq: d.seq, device: name, t, type, ...extra });
  d.sync = async () => {
    const out = await runSync({
      token: 'good', repo: 'o/r', device: name, shas: d.shas, pushed: d.pushed, events: d.events, fetchImpl: gh.fetchImpl,
      importCardFile: async (path, text) => { d.cardFiles.push(path); return text.includes('BROKEN') ? { ok: false, note: path + ': has errors' } : { ok: true }; },
      addForeignEvents: async (evs) => { const have = new Set(d.events.map((e) => e.id)); const fresh = evs.filter((e) => !have.has(e.id)); d.events.push(...fresh); return fresh.length; },
    });
    d.shas = out.shas; d.pushed = out.pushed;
    return out.report;
  };
  return d;
}

const NOV = Date.UTC(2026, 10, 16, 12);
const DEC = Date.UTC(2026, 11, 2, 12);

test('log files round-trip, including Arabic', () => {
  const events = [{ id: 'b', seq: 2, t: 5, type: 'edit', fields: { q: 'ما هو العقل؟' } }, { id: 'a', seq: 1, t: 5, type: 'review' }];
  const text = serializeLog(events);
  assert.deepEqual(parseLog(text).map((e) => e.id), ['a', 'b']);
  assert.equal(parseLog(text + 'not json\n').length, 2);
  assert.equal(Buffer.from(toBase64(text), 'base64').toString('utf8'), text);
  assert.equal(monthOf(NOV), '2026-11');
});

test('two devices end up with the same history; card files arrive once', async () => {
  const gh = fakeGitHub({ 'courses/lon/cards/01 One - cards.md': 'cards v1', 'README.md': 'x', 'courses/lon/notes/01.md': 'note' });
  const phone = device('phone', gh);
  const laptop = device('laptop', gh);

  phone.act('review', NOV, { card: 'c1', grade: 3 });
  phone.act('review', NOV + 1000, { card: 'c2', grade: 1 });
  let r = await phone.sync();
  assert.deepEqual(phone.cardFiles, ['courses/lon/cards/01 One - cards.md']);
  assert.equal(r.sent, 2);
  assert.ok(gh.store.has('state/log/phone/2026-11.jsonl'));

  r = await laptop.sync();
  assert.equal(r.pulled, 2);
  assert.equal(r.cardFiles, 1);
  laptop.act('review', NOV + 5000, { card: 'c1', grade: 3 });
  laptop.act('capture', DEC, { card: 'CAP.x.M1', content: { q: 'q', a: 'a' } });
  r = await laptop.sync();
  assert.equal(r.sent, 2);
  assert.ok(gh.store.has('state/log/laptop/2026-11.jsonl') && gh.store.has('state/log/laptop/2026-12.jsonl'));
  assert.ok(!gh.store.has('state/log/phone/2026-12.jsonl'), 'a device only writes its own files');

  r = await phone.sync();
  assert.equal(r.pulled, 2);
  assert.equal(r.cardFiles, 0, 'an unchanged card file is not fetched again');
  const ids = (d) => d.events.map((e) => e.id).sort();
  assert.deepEqual(ids(phone), ids(laptop));

  const before = gh.calls.length;
  r = await phone.sync();
  assert.deepEqual([r.sent, r.pulled, r.cardFiles], [0, 0, 0]);
  assert.equal(gh.calls.length - before, 2, 'a sync with nothing to do makes two requests');

  gh.put('courses/lon/cards/01 One - cards.md', 'cards v2');
  r = await laptop.sync();
  assert.equal(r.cardFiles, 1, 'a changed card file is picked up');
});

test('a card file with errors is reported and retried next time', async () => {
  const gh = fakeGitHub({ 'courses/lon/cards/02 Two - cards.md': 'BROKEN' });
  const d = device('phone', gh);
  let r = await d.sync();
  assert.deepEqual(r.notes, ['courses/lon/cards/02 Two - cards.md: has errors']);
  gh.put('courses/lon/cards/02 Two - cards.md', 'fixed');
  r = await d.sync();
  assert.equal(r.cardFiles, 1);
});

test('a history file that changed underneath is saved on the second try', async () => {
  const gh = fakeGitHub();
  const d = device('phone', gh);
  d.act('review', NOV, { card: 'c1', grade: 3 });
  await d.sync();
  d.act('review', NOV + 1, { card: 'c1', grade: 3 });
  const real = gh.fetchImpl;
  let tampered = false;
  gh.fetchImpl = async (url, opts) => {
    if (!tampered && opts.method === 'PUT') { tampered = true; gh.put('state/log/phone/2026-11.jsonl', 'someone else'); }
    return real(url, opts);
  };
  const r = await d.sync();
  assert.equal(r.sent, 1);
  assert.equal(parseLog(gh.store.get('state/log/phone/2026-11.jsonl').text).length, 2);
});

test('bad token and no connection give clear errors', async () => {
  const gh = fakeGitHub();
  await assert.rejects(checkAccess({ token: 'bad', repo: 'o/r', fetchImpl: gh.fetchImpl }), (e) => e instanceof SyncError && e.kind === 'auth');
  await assert.rejects(checkAccess({ token: 'good', repo: 'o/r', fetchImpl: async () => { throw new TypeError('failed to fetch'); } }), (e) => e.kind === 'offline');
  assert.deepEqual(await checkAccess({ token: 'good', repo: 'o/r', fetchImpl: gh.fetchImpl }), { branch: 'main', canWrite: true, isPrivate: true });
});
