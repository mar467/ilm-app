// Local storage on the device (IndexedDB). Three stores:
//   cards  - the parsed cards, keyed by id
//   events - everything the learner does, one record per action (append-only)
//   meta   - settings and the device id

const DB_NAME = 'ilm';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(storeNames, mode, work) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('storage transaction aborted'));
    result = work(t);
  }));
}

function all(store) {
  return open().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const getCards = () => all('cards');
export const getEvents = () => all('events');

export function putCards(cards) {
  return tx('cards', 'readwrite', (t) => { const s = t.objectStore('cards'); cards.forEach((c) => s.put(c)); });
}

export function addEvents(events) {
  return tx('events', 'readwrite', (t) => { const s = t.objectStore('events'); events.forEach((e) => s.put(e)); });
}

export function getMeta(key) {
  return open().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction('meta', 'readonly').objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function setMeta(key, value) {
  return tx('meta', 'readwrite', (t) => { t.objectStore('meta').put(value, key); });
}

export function replaceAll({ cards, events, settings }) {
  return tx(['cards', 'events', 'meta'], 'readwrite', (t) => {
    t.objectStore('cards').clear();
    t.objectStore('events').clear();
    cards.forEach((c) => t.objectStore('cards').put(c));
    events.forEach((e) => t.objectStore('events').put(e));
    if (settings) t.objectStore('meta').put(settings, 'settings');
  });
}

export function eraseAll() {
  return tx(['cards', 'events', 'meta'], 'readwrite', (t) => {
    t.objectStore('cards').clear();
    t.objectStore('events').clear();
    t.objectStore('meta').clear();
  });
}

// Ask the browser not to evict this site's data when storage runs low.
export function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().catch(() => false);
  return Promise.resolve(false);
}
