import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installChromeStorageStub } from "./helpers/chromeStorageStub.js";
import { installDownloadFileSpy } from "./helpers/downloadFileSpy.js";
import { SettingsManager } from "../lib/util.js";

// Feature: named-log-export, Property 2: Filename construction
// Validates: Requirements 2.1, 2.2, 2.3
//
// Hydrate the real panel DOM into jsdom, install Chrome storage + downloadFile
// stubs, then dynamically import `panel.js` so its top-level click handler is
// wired against the loaded `#exportLogs` button. Then drive the click handler
// across a generator that covers the empty-after-trim, non-empty-trimmed, and
// padded-string branches and assert the filename rule.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let chromeStub;
let spy;
let exportButton;
let logExportNameInput;

beforeAll(async () => {
    // 1) Load panel.html into the test document so panel.js's top-level
    //    `getElementById` calls resolve. We extract the inside of <html>
    //    and assign it to documentElement.innerHTML; jsdom does not auto-
    //    execute the embedded <script type="module"> when set this way,
    //    which is exactly what we want — we'll dynamically import panel.js
    //    ourselves below.
    const htmlPath = path.resolve(__dirname, "..", "panel", "panel.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    const inner = html.match(/<html[^>]*>([\s\S]*)<\/html>/i)[1];
    document.documentElement.innerHTML = inner;

    // 2) Install the in-memory chrome.storage.{sync,local} stub. The click
    //    handler awaits chrome.storage.local.get(null); seeding an empty
    //    dictionary makes that resolve to `{}` so the handler can proceed
    //    to construct the filename.
    chromeStub = installChromeStorageStub();
    chromeStub.local.seed({});

    // 3) panel.js touches a few chrome.* surfaces at module load that our
    //    storage-only stub does not provide. Augment with no-op shims so
    //    the dynamic import below does not throw.
    globalThis.chrome.storage.onChanged = { addListener: () => {} };
    globalThis.chrome.runtime = {
        sendMessage: (_message, _callback) => {
            // No-op. Some panel.js call sites pass a callback; not invoking
            // it is fine because no test path depends on its result.
        },
    };

    // 4) Install the spy on SettingsManager.downloadFile *before* importing
    //    panel.js. The click handler resolves `SettingsManager.downloadFile`
    //    at call time, so this ordering is not strictly required, but it
    //    keeps the setup self-contained.
    spy = installDownloadFileSpy(SettingsManager);

    // 5) Dynamically import panel.js. This runs its module top-level code,
    //    which attaches a click listener to #exportLogs against the live
    //    DOM we loaded in step 1.
    await import("../panel/panel.js");

    exportButton = document.getElementById("exportLogs");
    logExportNameInput = document.getElementById("log-export-name");
});

afterAll(() => {
    spy?.uninstall();
    chromeStub?.uninstall();
});

describe("export filename construction", () => {
    it("filename matches the trim-then-format rule (P2 — empty/non-empty/padded)", async () => {
        // Whitespace-only (or empty) — trim() yields "", filename should be "logs.json".
        // This covers Requirement 2.1's empty-after-trim branch.
        const whitespaceString = fc.stringMatching(/^\s*$/);

        // Non-empty and already trimmed — the value equals its own trim and is
        // not empty. Covers Requirement 2.2's non-empty branch with a literal
        // substitution between the parentheses.
        const nonEmptyTrimmedString = fc
            .string({ minLength: 1, maxLength: 50 })
            .filter((s) => s.length > 0 && s === s.trim());

        // Non-empty trimmed core wrapped in arbitrary leading/trailing
        // whitespace. Exercises Requirement 2.3's "trim exactly once" rule:
        // the filename embeds the trimmed core, not the padded original.
        const paddedString = fc
            .tuple(whitespaceString, nonEmptyTrimmedString, whitespaceString)
            .map(([lead, core, trail]) => lead + core + trail);

        await fc.assert(
            fc.asyncProperty(
                fc.oneof(whitespaceString, nonEmptyTrimmedString, paddedString),
                async (rawName) => {
                    // Reset the spy each iteration so `lastCall()` reflects
                    // exactly the click we are about to dispatch.
                    spy.reset();

                    // Drive the input via the DOM contract panel.js uses.
                    logExportNameInput.value = rawName;

                    // Dispatch a bubbling click — same shape as a user click.
                    exportButton.dispatchEvent(new Event("click", { bubbles: true }));

                    // The click handler is async (awaits chrome.storage.local.get).
                    // A single setTimeout(0) flushes pending microtasks so the
                    // handler's `SettingsManager.downloadFile(...)` has run by
                    // the time we read the spy.
                    await new Promise((resolve) => setTimeout(resolve, 0));

                    const trimmed = rawName.trim();
                    const expected = trimmed === ""
                        ? "logs.json"
                        : `logs (${trimmed}).json`;

                    const last = spy.lastCall();
                    expect(last).toBeDefined();
                    expect(last.filename).toBe(expected);
                }
            ),
            { numRuns: 100 }
        );
    });
});
