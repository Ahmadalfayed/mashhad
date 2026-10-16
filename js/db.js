const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('mashhad', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
        if (!db.objectStoreNames.contains('project')) db.createObjectStore('project');
      };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async put(store, key, val) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  async get(store, key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  async del(store, key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  async keys(store) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAllKeys();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
};
