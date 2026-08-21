const DB_NAME = "superscreenshot";
const DB_VERSION = 1;
const STORE = "captures";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, executor) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = executor(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req ? req.result : undefined);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

export function saveCapture(id, data) {
  return run("readwrite", (store) => store.put(data, id));
}

export function getCapture(id) {
  return run("readonly", (store) => store.get(id)).then((value) => value ?? null);
}

export function deleteCapture(id) {
  return run("readwrite", (store) => store.delete(id));
}

export function listCaptureIds() {
  return run("readonly", (store) => store.getAllKeys());
}
