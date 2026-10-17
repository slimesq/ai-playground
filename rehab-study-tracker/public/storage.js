// IndexedDB transactions serialize writes from every tab before publishing a cache.
// localStorage is only a compatibility cache; it is never the source of a mutation.
export async function openJournalStore({storageKey, initial, validate}) {
  const db = await new Promise((resolve,reject) => {
    // Close v1 clients before introducing import operations into the shared queue.
    // Their existing onversionchange handler closes the old connection safely.
    const request = indexedDB.open(storageKey,2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('journal')) request.result.createObjectStore('journal');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('记录存储正在被其他页面更新，请关闭旧页面后重试。'));
  });
  db.onversionchange = () => db.close();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`${storageKey}.changes`) : null;
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  if (channel) channel.onmessage = notify;
  window.addEventListener('storage',(event) => { if (event.key === storageKey) notify(); });

  function cache(value) {
    try { localStorage.setItem(storageKey,JSON.stringify(value)); } catch { /* The transaction already durably saved this record. */ }
    channel?.postMessage({changed:true});
  }
  async function read() {
    return new Promise((resolve,reject) => {
      const transaction = db.transaction('journal','readonly');
      const request = transaction.objectStore('journal').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function update(expectedKey,reducer) {
    return new Promise((resolve,reject) => {
      const transaction = db.transaction('journal','readwrite');
      const objectStore = transaction.objectStore('journal');
      let next;
      let failure;
      const request = objectStore.get('current');
      request.onsuccess = () => {
        try {
          const current = request.result;
          if (current && expectedKey !== null && current.syncKey !== expectedKey) throw new Error('另一标签页已切换同步码，请刷新后继续。当前备注和选择仍保留。');
          next = reducer(current);
          validate(next);
          objectStore.put(next,'current');
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => { cache(next); resolve(next); };
      transaction.onerror = () => { failure ||= transaction.error; };
      transaction.onabort = () => reject(failure || transaction.error || new Error('浏览器未能保存这次修改。'));
    });
  }
  await update(null,(current) => {
    if (current) return current;
    let legacy;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) legacy = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('本机记录格式异常，请先保留浏览器数据。');
    }
    return legacy || initial();
  });
  function syncLock(syncKey,owner,release = false) {
    return new Promise((resolve,reject) => {
      const transaction = db.transaction('journal','readwrite');
      const objectStore = transaction.objectStore('journal');
      const key = `sync-lock:${syncKey}`;
      const request = objectStore.get(key);
      let acquired = false;
      request.onsuccess = () => {
        const lock = request.result;
        if (release) {
          if (lock?.owner === owner) objectStore.delete(key);
        } else if (!lock || lock.owner === owner || lock.expiresAt < Date.now()) {
          objectStore.put({owner,expiresAt:Date.now() + 45000},key);
          acquired = true;
        }
      };
      transaction.oncomplete = () => resolve(acquired);
      transaction.onabort = () => reject(transaction.error || new Error('同步锁暂时不可用。'));
    });
  }
  return {read,update,syncLock,subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }};
}
