/**
 * IndexedDB storage for captured text documents.
 * Shared by the service worker and the dashboard page (same extension origin).
 */

const DB_NAME = 'wordcloud-analyzer';
const DB_VERSION = 1;
const STORE_DOCS = 'docs';
const STORE_META = 'meta';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        const docs = db.createObjectStore(STORE_DOCS, { keyPath: 'id', autoIncrement: true });
        docs.createIndex('ts', 'ts');
        docs.createIndex('host', 'host');
        docs.createIndex('key', 'key', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function store(db, name, mode) {
  return db.transaction(name, mode).objectStore(name);
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Insert documents, skipping ones whose (host, hash) pair was already stored.
 * This is what makes repeated scrolls and page refreshes only count new content.
 * @param {Array<{hash:string,text:string,ts:number,host:string,url:string,lang:string}>} items
 * @returns {Promise<{added:number, duplicates:number}>}
 */
export async function addDocs(items) {
  if (!items.length) return { added: 0, duplicates: 0, addedItems: [] };
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_DOCS, 'readwrite');
    const docs = transaction.objectStore(STORE_DOCS);
    const keyIndex = docs.index('key');
    const seenInBatch = new Set();
    const addedItems = [];
    let added = 0;
    let duplicates = 0;

    for (const item of items) {
      const key = `${item.host}|${item.hash}`;
      if (seenInBatch.has(key)) {
        duplicates += 1;
        continue;
      }
      seenInBatch.add(key);
      const lookup = keyIndex.getKey(key);
      lookup.onsuccess = () => {
        if (lookup.result !== undefined) {
          duplicates += 1;
          return;
        }
        docs.add({ ...item, key });
        addedItems.push(item);
        added += 1;
      };
    }

    transaction.oncomplete = () => resolve({ added, duplicates, addedItems });
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/**
 * Fetch documents captured inside [fromTs, toTs].
 * @param {number} fromTs
 * @param {number} toTs
 * @param {{host?:string}} [opts]
 */
export async function getDocsInRange(fromTs, toTs, opts = {}) {
  const db = await openDb();
  const docs = store(db, STORE_DOCS, 'readonly');
  const results = [];
  await new Promise((resolve, reject) => {
    const cursorReq = docs.index('ts').openCursor(IDBKeyRange.bound(fromTs, toTs));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      if (!opts.host || cursor.value.host === opts.host) results.push(cursor.value);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  return results;
}

/** Distinct hosts present in the database, with document counts. */
export async function listHosts() {
  const db = await openDb();
  const docs = store(db, STORE_DOCS, 'readonly');
  const counts = new Map();
  await new Promise((resolve, reject) => {
    const cursorReq = docs.index('host').openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      counts.set(cursor.value.host, (counts.get(cursor.value.host) || 0) + 1);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  return [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count);
}

/** Delete documents older than the cutoff. Returns the number removed. */
export async function pruneOlderThan(cutoffTs) {
  const db = await openDb();
  const docs = store(db, STORE_DOCS, 'readwrite');
  let removed = 0;
  await new Promise((resolve, reject) => {
    const cursorReq = docs.index('ts').openCursor(IDBKeyRange.upperBound(cutoffTs, true));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      cursor.delete();
      removed += 1;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  return removed;
}

/** Wipe every stored block and all bookkeeping (announced words, timestamps). */
export async function clearAll() {
  const db = await openDb();
  await promisify(store(db, STORE_DOCS, 'readwrite').clear());
  await promisify(store(db, STORE_META, 'readwrite').clear());
}

export async function getStats() {
  const db = await openDb();
  const total = await promisify(store(db, STORE_DOCS, 'readonly').count());
  const edge = (direction) =>
    new Promise((resolve, reject) => {
      const req = store(db, STORE_DOCS, 'readonly').index('ts').openCursor(null, direction);
      req.onsuccess = () => resolve(req.result ? req.result.value.ts : null);
      req.onerror = () => reject(req.error);
    });
  const oldest = await edge('next');
  const newest = await edge('prev');
  return { total, oldest, newest };
}

export async function setMeta(k, v) {
  const db = await openDb();
  await promisify(store(db, STORE_META, 'readwrite').put({ k, v }));
}

export async function getMeta(k, fallback = null) {
  const db = await openDb();
  const row = await promisify(store(db, STORE_META, 'readonly').get(k));
  return row ? row.v : fallback;
}
