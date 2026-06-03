// Spy for `SettingsManager.downloadFile`.
//
// The real implementation in `lib/util.js` builds a Blob, creates an object
// URL, and clicks a synthetic `<a download>` element. That is awkward to run
// under jsdom and irrelevant to the assertions in our property tests, which
// only care about the `(content, filename)` arguments passed to the method.
//
// This helper monkey-patches `SettingsManager.downloadFile` with a recorder
// and exposes utilities to inspect calls and restore the original method.
//
// Usage:
//
//   import { installDownloadFileSpy } from "./helpers/downloadFileSpy.js";
//   import { SettingsManager } from "../../lib/util.js";
//
//   let spy;
//   beforeEach(() => { spy = installDownloadFileSpy(SettingsManager); });
//   afterEach(()  => { spy.uninstall(); });
//
//   // ...trigger code that calls SettingsManager.downloadFile(content, filename)...
//
//   expect(spy.calls.length).toBe(1);
//   expect(spy.lastCall().filename).toBe("logs.json");
//   spy.reset(); // clear recorded calls without uninstalling

/**
 * Install a recording spy on `SettingsManager.downloadFile`.
 *
 * The original method is preserved on the spy as `_original` so it can be
 * restored after teardown via `uninstall()`. The replacement records each
 * call's arguments and returns `undefined` (matching the original's contract:
 * `downloadFile` is a fire-and-forget side effect with no return value).
 *
 * @param {{ downloadFile: (content: any, filename: string) => any }} SettingsManager
 *   The class (or any object) whose `downloadFile` method should be spied on.
 *   Pass the real `SettingsManager` import in tests.
 * @returns {{
 *   calls: Array<{ content: any, filename: string, args: any[] }>,
 *   lastCall(): { content: any, filename: string, args: any[] } | undefined,
 *   reset(): void,
 *   uninstall(): void,
 *   _original: Function,
 * }}
 */
export function installDownloadFileSpy(SettingsManager) {
    const original = SettingsManager.downloadFile;

    const calls = [];

    function spy(content, filename, ...rest) {
        calls.push({
            content,
            filename,
            args: [content, filename, ...rest],
        });
        // Do not invoke the original - we are replacing the side effect, not
        // observing it. Returns `undefined` like the original.
    }

    // Preserve the original on the replacement so callers (and the
    // `uninstall()` helper below) can find it without keeping a closure.
    spy._original = original;

    SettingsManager.downloadFile = spy;

    return {
        calls,
        lastCall() {
            return calls.length === 0 ? undefined : calls[calls.length - 1];
        },
        reset() {
            calls.length = 0;
        },
        uninstall() {
            SettingsManager.downloadFile = original;
        },
        _original: original,
    };
}
