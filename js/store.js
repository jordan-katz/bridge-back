// IndexedDB autosave. Everything stays in this browser. Every call tolerates storage being unavailable.

const DB = 'bridgeback';
const STORE = 'docs';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    } catch (e) {
      reject(e);
    }
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const put = (rec) => run('readwrite', (s) => s.put(rec));
export const get = (id) => run('readonly', (s) => s.get(id));
export const del = (id) => run('readwrite', (s) => s.delete(id));
export const all = () => run('readonly', (s) => s.getAll()).then((l) => (l || []).sort((a, b) => b.updated - a.updated));

export async function prune(keep = 8) {
  const list = await all();
  for (const rec of list.slice(keep)) await del(rec.id);
}

export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('bb.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('bb.' + key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};
