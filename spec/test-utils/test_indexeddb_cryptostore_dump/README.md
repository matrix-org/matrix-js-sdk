## Dump of libolm indexeddb cryptostore

This directory contains a dump of a real indexeddb store from a session using
libolm crypto.

The corresponding pickle key is `+1k2Ppd7HIisUY824v7JtV3/oEE4yX0TqtmNPyhaD7o`.

It was created by pasting the following into the browser console:

```javascript
async function exportIndexedDb(name) {
    const db = await new Promise((resolve, reject) => {
        const dbReq = indexedDB.open(name);
        dbReq.onerror = reject;
        dbReq.onsuccess = () => resolve(dbReq.result);
    });

    const storeNames = db.objectStoreNames;
    const exports = {};
    for (const store of storeNames) {
        exports[store] = [];
        const txn = db.transaction(store, "readonly");
        const objectStore = txn.objectStore(store);
        await new Promise((resolve, reject) => {
            const cursorReq = objectStore.openCursor();
            cursorReq.onerror = reject;
            cursorReq.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const entry = { value: cursor.value };
                    if (!objectStore.keyPath) {
                        entry.key = cursor.key;
                    }
                    exports[store].push(entry);
                    cursor.continue();
                } else {
                    resolve();
                }
            };
        });
    }
    return exports;
}

window.saveAs(
    new Blob([JSON.stringify(await exportIndexedDb("matrix-js-sdk:crypto"), null, 2)], {
        type: "application/json;charset=utf-8",
    }),
    "dump.json",
);
```

The pickle key is extracted via `mxMatrixClientPeg.get().crypto.olmDevice.pickleKey`.
