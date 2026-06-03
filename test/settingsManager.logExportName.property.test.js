import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { SettingsManager } from "../lib/util.js";
import { installChromeStorageStub } from "./helpers/chromeStorageStub.js";

// Feature: named-log-export, Property 4: Log-name storage round trip
// Validates: Requirements 3.1, 3.2, 3.3
describe("SettingsManager log-name storage round trip", () => {
    let chromeStub;

    beforeEach(() => {
        chromeStub = installChromeStorageStub();
    });

    afterEach(() => {
        chromeStub.uninstall();
    });

    it("saveLogExportName then getLogExportName resolves to the same string (P4 — write/read branch)", async () => {
        await fc.assert(
            fc.asyncProperty(fc.string(), async (s) => {
                // Reset between iterations so each run starts from a fresh
                // chrome.storage.sync — this isolates the round trip from any
                // value persisted by a prior iteration.
                chromeStub.reset();

                await SettingsManager.saveLogExportName(s);
                const result = await SettingsManager.getLogExportName();

                expect(typeof result).toBe("string");
                expect(result).toBe(s);
            }),
            { numRuns: 100 }
        );
    });

    it("getLogExportName resolves to \"\" against fresh storage with no prior save (P4 — unset branch)", async () => {
        // Fresh storage installed by beforeEach; no saveLogExportName called.
        const result = await SettingsManager.getLogExportName();
        expect(typeof result).toBe("string");
        expect(result).toBe("");
    });
});
