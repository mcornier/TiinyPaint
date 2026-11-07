// Historique de l'onglet : survit au rechargement, purgé après la fermeture de l'onglet.
// IndexedDB plutôt que sessionStorage, limité à environ 5 Mo alors qu'un rendu en fait plusieurs.
'use strict';

const SESSION_ID_KEY = 'tiinypaint.session';
const SESSION_LOCK_PREFIX = 'tiinypaint.session.';

function idbDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function idbResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

class SessionHistory {
  constructor() {
    this.id = sessionStorage.getItem(SESSION_ID_KEY);
    if (!this.id) {
      this.id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_ID_KEY, this.id);
    }
    this.db = null;
  }

  async _open() {
    if (this.db) return this.db;
    const request = indexedDB.open('tiinypaint', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('history', { keyPath: 'id' });
      store.createIndex('session', 'session');
    };
    this.db = await idbResult(request);
    return this.db;
  }

  // Un verrou partagé, libéré par le navigateur à la fermeture, signale que l'onglet vit encore.
  async _holdLock() {
    if (!navigator.locks) return;
    await new Promise((held) => {
      navigator.locks.request(`${SESSION_LOCK_PREFIX}${this.id}`, { mode: 'shared' }, () => {
        held();
        return new Promise(() => {});
      });
    });
  }

  async _purgeClosedTabs() {
    const alive = new Set([this.id]);
    if (navigator.locks) {
      const { held } = await navigator.locks.query();
      for (const lock of held) {
        if (lock.name.startsWith(SESSION_LOCK_PREFIX)) alive.add(lock.name.slice(SESSION_LOCK_PREFIX.length));
      }
    }
    const tx = this.db.transaction('history', 'readwrite');
    const store = tx.objectStore('history');
    store.index('session').openKeyCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      if (!alive.has(cursor.key)) store.delete(cursor.primaryKey);
      cursor.continue();
    };
    await idbDone(tx);
  }

  // Rendus de cet onglet, du plus récent au plus ancien.
  async load() {
    await this._holdLock();
    await this._open();
    await this._purgeClosedTabs();
    const store = this.db.transaction('history').objectStore('history');
    const items = await idbResult(store.index('session').getAll(this.id));
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  async add(item) {
    await this._open();
    const tx = this.db.transaction('history', 'readwrite');
    tx.objectStore('history').put({ ...item, session: this.id });
    await idbDone(tx);
  }

  async clear() {
    await this._open();
    const tx = this.db.transaction('history', 'readwrite');
    const store = tx.objectStore('history');
    store.index('session').openKeyCursor(IDBKeyRange.only(this.id)).onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    await idbDone(tx);
  }
}
