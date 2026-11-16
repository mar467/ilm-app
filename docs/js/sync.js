// Sync with the private data repository through the GitHub web API.
//
// What moves where:
//   card files   courses/<course>/cards/*.md        repository -> app   (the app never writes these)
//   own history  state/log/<this device>/<yyyy-mm>.jsonl   app -> repository (only this device writes its file)
//   other devices' history  state/log/<other>/*.jsonl      repository -> app
//
// No DOM and no storage in here: the caller passes in what it has and gets back what changed,
// so the same code runs in the tests against a fake GitHub.

const API = 'https://api.github.com';
const CARD_PATH = /^courses\/[^/]+\/cards\/[^/]+\.md$/;
const LOG_PATH = /^state\/log\/([^/]+)\/(\d{4}-\d{2})\.jsonl$/;

export class SyncError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function monthOf(t) {
  const d = new Date(t);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

export function serializeLog(events) {
  return events.slice().sort((a, b) => a.t - b.t || (a.seq || 0) - (b.seq || 0)).map((e) => JSON.stringify(e)).join('\n') + '\n';
}

export function parseLog(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const ev = JSON.parse(line); if (ev && ev.id && ev.type) out.push(ev); } catch (e) { /* skip a damaged line */ }
  }
  return out;
}

function client(token, fetchImpl) {
  return async function call(method, path, { body, raw } = {}) {
    let res;
    try {
      res = await fetchImpl(API + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (e) {
      throw new SyncError('offline', 'No connection. Your reviews are saved on this device and will sync later.');
    }
    if (res.status === 401) throw new SyncError('auth', 'GitHub did not accept the token. It may have expired or been mistyped.');
    if (res.status === 403) throw new SyncError('denied', 'GitHub refused the request. The token may lack "Contents: read and write" for this repository.');
    if (res.status === 404) throw new SyncError('missing', 'Repository not found. Check its name, and that the token is allowed to reach it.');
    if (res.status === 409 || res.status === 422) throw new SyncError('conflict', 'The file changed on GitHub while saving.');
    if (!res.ok) throw new SyncError('server', `GitHub answered with an error (${res.status}).`);
    return raw ? res.text() : res.json();
  };
}

export async function checkAccess({ token, repo, fetchImpl = fetch }) {
  const call = client(token, fetchImpl);
  const info = await call('GET', `/repos/${repo}`);
  return { branch: info.default_branch, canWrite: !info.permissions || !!info.permissions.push, isPrivate: !!info.private };
}

// ctx: { token, repo, device, shas, pushed, events, importCardFile(path, text), addForeignEvents(events), fetchImpl }
// Returns { shas, pushed, report }. `shas` remembers which version of each file has been taken in;
// `pushed` remembers how many of this device's events each month's file already holds.
export async function runSync(ctx) {
  const call = client(ctx.token, ctx.fetchImpl || fetch);
  const shas = { ...(ctx.shas || {}) };
  const pushed = { ...(ctx.pushed || {}) };
  const report = { cardFiles: 0, notes: [], pulled: 0, sent: 0 };

  const info = await call('GET', `/repos/${ctx.repo}`);
  const branch = info.default_branch;
  let entries = [];
  try {
    const tree = await call('GET', `/repos/${ctx.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    entries = (tree.tree || []).filter((e) => e.type === 'blob');
  } catch (e) {
    if (!(e instanceof SyncError) || (e.kind !== 'conflict' && e.kind !== 'missing')) throw e; // an empty repository has no tree yet
  }
  const read = (path) => call('GET', `/repos/${ctx.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`, { raw: true });

  for (const entry of entries) {
    if (!CARD_PATH.test(entry.path) || shas[entry.path] === entry.sha) continue;
    const result = await ctx.importCardFile(entry.path, await read(entry.path));
    if (result.note) report.notes.push(result.note);
    if (result.ok) { shas[entry.path] = entry.sha; report.cardFiles += 1; }
  }

  for (const entry of entries) {
    const m = LOG_PATH.exec(entry.path);
    if (!m || m[1] === ctx.device || shas[entry.path] === entry.sha) continue;
    report.pulled += await ctx.addForeignEvents(parseLog(await read(entry.path)));
    shas[entry.path] = entry.sha;
  }

  const mine = new Map();
  for (const ev of ctx.events) {
    if (ev.device !== ctx.device) continue;
    const month = monthOf(ev.t);
    if (!mine.has(month)) mine.set(month, []);
    mine.get(month).push(ev);
  }
  for (const [month, list] of mine) {
    if (pushed[month] === list.length) continue;
    const path = `state/log/${ctx.device}/${month}.jsonl`;
    const existing = entries.find((e) => e.path === path);
    const put = (sha) => call('PUT', `/repos/${ctx.repo}/contents/${encodePath(path)}`, {
      body: { message: `Ilm history: ${ctx.device} ${month}`, content: toBase64(serializeLog(list)), branch, ...(sha ? { sha } : {}) },
    });
    let saved;
    try {
      saved = await put(existing && existing.sha);
    } catch (e) {
      if (!(e instanceof SyncError) || e.kind !== 'conflict') throw e;
      let current = null;
      try { current = await call('GET', `/repos/${ctx.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`); }
      catch (inner) { if (!(inner instanceof SyncError) || inner.kind !== 'missing') throw inner; }
      saved = await put(current && current.sha);
    }
    report.sent += list.length - (pushed[month] || 0);
    pushed[month] = list.length;
    if (saved && saved.content) shas[path] = saved.content.sha;
  }

  return { shas, pushed, report };
}
