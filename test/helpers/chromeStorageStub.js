// In-memory stub for `chrome.storage.sync` and `chrome.storage.local`.
//
// Supports both calling conventions used by the Chrome extension storage API:
//   - Promise style (Manifest V3):  await chrome.storage.sync.get(keys)
//   - Callback style:               chrome.storage.sync.get(keys, (result) => ...)
//
// The codebase (lib/util.js -> AsyncSyncStorage / AsyncLocalStorage) currently
// uses the promise style; the callback path is provided for forward
// compatibility with any helper that still uses callbacks.
//
// Usage:
//
//   import { installChromeStorageStub } from "./helpers/chromeStorageStub.js";
//
//   let chromeStub;
//   beforeEach(() => { chromeStub = installChromeStorageStub(); });
//   afterEach(()  => { chromeStub.uninstall(); });
//
//   chromeStub.sync.set("key", "value");           // seed state
//   chromeStub.local.snapshot();                    // inspect state
//   chromeStub.reset();                             // wipe both areas
//
// The handle returned by `installChromeStorageStub()` exposes:
//   - sync, local: { snapshot(), set(key, value), seed(obj), clear() }
//   - reset(): clears both areas without uninstalling
//   - uninstall(): restores the previous `globalThis.chrome`

/**
 * Normalize the `keys` argument accepted by chrome.storage.*.get into an
 * object whose entries describe `(key, defaultValue)` pairs. Mirrors the
 * Chrome extension API contract:
 *   - null / undefined -> return everything from the store
 *   - string           -> single key, no default
 *   - string[]         -> multiple keys, no defaults
 *   - object           -> keys with default values when missing
 */
function readMatchingEntries(store, keys) {
    if (keys === null || keys === undefined) {
        // Return a shallow copy of the entire store.
        return { ...store };
    }

    if (typeof keys === "string") {
        const result = {};
        if (Object.prototype.hasOwnProperty.call(store, keys)) {
            result[keys] = store[keys];
        }
        return result;
    }

    if (Array.isArray(keys)) {
        const result = {};
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(store, key)) {
                result[key] = store[key];
            }
        }
        return result;
    }

    if (typeof keys === "object") {
        const result = {};
        for (const key of Object.keys(keys)) {
            result[key] = Object.prototype.hasOwnProperty.call(store, key)
                ? store[key]
                : keys[key];
        }
        return result;
    }

    return {};
}

/**
 * Normalize the `keys` argument accepted by chrome.storage.*.remove into an
 * array of string keys (string or string[]).
 */
function normalizeRemoveKeys(keys) {
    if (typeof keys === "string") return [keys];
    if (Array.isArray(keys)) return keys.slice();
    return [];
}

/**
 * Build a single storage-area stub backed by an in-memory `store` object.
 * Each method supports both the callback and promise calling conventions.
 */
function createStorageArea() {
    const store = {};

    const area = {
        get(keys, callback) {
            const result = readMatchingEntries(store, keys);
            if (typeof callback === "function") {
                // Mimic Chrome's async callback dispatch.
                queueMicrotask(() => callback(result));
                return undefined;
            }
            return Promise.resolve(result);
        },

        set(items, callback) {
            if (items && typeof items === "object") {
                for (const key of Object.keys(items)) {
                    store[key] = items[key];
                }
            }
            if (typeof callback === "function") {
                queueMicrotask(() => callback());
                return undefined;
            }
            return Promise.resolve();
        },

        remove(keys, callback) {
            for (const key of normalizeRemoveKeys(keys)) {
                delete store[key];
            }
            if (typeof callback === "function") {
                queueMicrotask(() => callback());
                return undefined;
            }
            return Promise.resolve();
        },

        clear(callback) {
            for (const key of Object.keys(store)) {
                delete store[key];
            }
            if (typeof callback === "function") {
                queueMicrotask(() => callback());
                return undefined;
            }
            return Promise.resolve();
        },
    };

    // Inspection / seeding helpers exposed on the handle, not on `area`
    // itself (the area object should only carry the Chrome API surface).
    const handle = {
        area,
        snapshot() {
            return { ...store };
        },
        seed(obj) {
            if (obj && typeof obj === "object") {
                for (const key of Object.keys(obj)) {
                    store[key] = obj[key];
                }
            }
        },
        set(key, value) {
            store[key] = value;
        },
        clear() {
            for (const key of Object.keys(store)) {
                delete store[key];
            }
        },
    };

    return handle;
}

/**
 * Install in-memory `chrome.storage.sync` and `chrome.storage.local`
 * implementations on `globalThis.chrome`. Returns a handle to inspect and
 * reset state, plus an `uninstall()` to restore the previous global.
 *
 * @returns {{
 *   chrome: object,
 *   sync:   { snapshot(): object, set(k: string, v: any): void, seed(obj: object): void, clear(): void },
 *   local:  { snapshot(): object, set(k: string, v: any): void, seed(obj: object): void, clear(): void },
 *   reset(): void,
 *   uninstall(): void,
 * }}
 */
export function installChromeStorageStub() {
    const previousChrome = globalThis.chrome;

    const sync = createStorageArea();
    const local = createStorageArea();

    const chromeStub = {
        storage: {
            sync: sync.area,
            local: local.area,
        },
    };

    globalThis.chrome = chromeStub;

    return {
        chrome: chromeStub,
        sync: {
            snapshot: () => sync.snapshot(),
            set: (k, v) => sync.set(k, v),
            seed: (obj) => sync.seed(obj),
            clear: () => sync.clear(),
        },
        local: {
            snapshot: () => local.snapshot(),
            set: (k, v) => local.set(k, v),
            seed: (obj) => local.seed(obj),
            clear: () => local.clear(),
        },
        reset() {
            sync.clear();
            local.clear();
        },
        uninstall() {
            if (previousChrome === undefined) {
                delete globalThis.chrome;
            } else {
                globalThis.chrome = previousChrome;
            }
        },
    };
}
