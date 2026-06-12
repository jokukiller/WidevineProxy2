// Feature: named-log-export, Property 3: Logs payload normalization
//
// For any chrome.storage.local state S (a map of arbitrary keys to arbitrary
// values, where some entries have a truthy `pssh_data` field and others do
// not), when the #exportLogs click handler fires against S, the first
// argument passed to SettingsManager.downloadFile equals the filtered logs
// with export-only title normalization applied. The payload is independent
// of the log-name input.
//
// Validates: Requirements 2.4

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { installChromeStorageStub } from "./helpers/chromeStorageStub.js";
import { installDownloadFileSpy } from "./helpers/downloadFileSpy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = fs.readFileSync(
    path.resolve(__dirname, "../panel/panel.html"),
    "utf8",
);

// ----- Generators ---------------------------------------------------------

// `__proto__` (and a couple of related names) reach prototype slots when
// assigned via plain `obj[k] = v`, which would corrupt the in-memory storage
// stub's bookkeeping. They are not interesting for this property and would
// only produce spurious failures, so we filter them out.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const safeKey = fc.string().filter((k) => !FORBIDDEN_KEYS.has(k));

// A log entry with a guaranteed-truthy `pssh_data` plus arbitrary JSON-safe
// other fields. We intentionally restrict to `fc.jsonValue()` so the
// generated structures survive JSON.stringify byte-identically (no
// functions, undefineds inside arrays, or circular refs).
const logEntryWithPssh = fc
    .tuple(
        fc.string({ minLength: 1 }),
        fc.dictionary(safeKey, fc.jsonValue()),
    )
    .map(([pssh_data, others]) => {
        // Spread first so the explicit `pssh_data` always wins over any
        // homonymous (potentially falsy) field that fc.jsonValue() may have
        // produced inside `others`.
        return { ...others, pssh_data };
    });

// Anything that does NOT carry a truthy `pssh_data`. fc.jsonValue() can
// produce objects, primitives, and null; we filter out the rare object
// whose `pssh_data` happens to be truthy.
const arbitraryNoPssh = fc.oneof(
    fc.jsonValue().filter((v) => !(v && typeof v === "object" && v.pssh_data)),
    fc.constant(null),
);

// ----- Test setup ---------------------------------------------------------

describe("Property 3: Logs payload normalization", () => {
    let chromeStub;
    let spy;

    beforeAll(async () => {
        // Drop panel.js's <script> tag so jsdom does not attempt to resolve
        // the relative URL; we import the module manually below.
        const sanitizedHtml = PANEL_HTML.replace(
            /<script[^>]*\bsrc=["']panel\.js["'][^>]*>\s*<\/script>/i,
            "",
        );
        const bodyMatch = sanitizedHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        document.body.innerHTML = bodyMatch ? bodyMatch[1] : sanitizedHtml;

        chromeStub = installChromeStorageStub();
        // panel.js calls `chrome.storage.onChanged.addListener` at module
        // top level; provide a no-op shim so the import doesn't throw.
        globalThis.chrome.storage.onChanged = { addListener: () => {} };
        // panel.js's DOMContentLoaded handler uses chrome.runtime.sendMessage,
        // but the export click handler does not. We still install a benign
        // shim to keep any incidental call from throwing.
        globalThis.chrome.runtime = {
            sendMessage: (_msg, cb) => {
                if (typeof cb === "function") queueMicrotask(() => cb());
            },
        };

        // Spy on SettingsManager.downloadFile BEFORE importing panel.js so
        // the click handler resolves to the patched method (modules are
        // cached, so panel.js sees the same class instance).
        const utilModule = await import("../lib/util.js");
        spy = installDownloadFileSpy(utilModule.SettingsManager);

        await import("../panel/panel.js");
    });

    afterAll(() => {
        spy?.uninstall();
        chromeStub?.uninstall();
    });

    it("downloadFile content equals JSON.stringify(filtered normalized logs, null, 2)", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.dictionary(
                    safeKey,
                    fc.oneof(logEntryWithPssh, arbitraryNoPssh),
                ),
                fc.string(),
                async (S, name) => {
                    // Reset state between iterations.
                    chromeStub.local.clear();
                    chromeStub.local.seed(S);
                    spy.reset();

                    // The filename must NOT influence the payload, so we
                    // still vary it across iterations to harden that claim.
                    document.getElementById("log-export-name").value = name;

                    // Fire the export click. The handler is async; allow its
                    // microtask chain (await chrome.storage.local.get + the
                    // synchronous downloadFile call that follows) to settle.
                    document.getElementById("exportLogs").click();
                    await new Promise((resolve) => setTimeout(resolve, 0));

                    const expectedLogs = Object.values(S)
                        .filter((v) => v?.pssh_data)
                        .map((log) => {
                            const exportedLog = { ...log };

                            if (exportedLog.class_title === "AI Guru" && exportedLog.video_title) {
                                exportedLog.class_title = exportedLog.video_title;
                            }

                            if (exportedLog.video_title == null && exportedLog.class_title) {
                                exportedLog.video_title = exportedLog.class_title;
                            }

                            return exportedLog;
                        });
                    const expected = JSON.stringify(expectedLogs, null, 2);

                    expect(spy.calls).toHaveLength(1);
                    expect(spy.calls[0].content).toBe(expected);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("normalizes AI Guru class titles and null video titles on export", async () => {
        chromeStub.local.clear();
        chromeStub.local.seed({
            aiGuru: {
                pssh_data: "pssh-1",
                class_title: "AI Guru",
                video_title: "Real lecture title",
            },
            nullVideo: {
                pssh_data: "pssh-2",
                class_title: "Real class title",
                video_title: null,
            },
        });
        spy.reset();

        document.getElementById("log-export-name").value = "";
        document.getElementById("exportLogs").click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(JSON.parse(spy.calls[0].content)).toEqual([
            {
                pssh_data: "pssh-1",
                class_title: "Real lecture title",
                video_title: "Real lecture title",
            },
            {
                pssh_data: "pssh-2",
                class_title: "Real class title",
                video_title: "Real class title",
            },
        ]);
    });
});
