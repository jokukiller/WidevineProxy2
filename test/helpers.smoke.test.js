import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installChromeStorageStub } from "./helpers/chromeStorageStub.js";
import { installDownloadFileSpy } from "./helpers/downloadFileSpy.js";

describe("chromeStorageStub", () => {
    let stub;

    beforeEach(() => {
        stub = installChromeStorageStub();
    });

    afterEach(() => {
        stub.uninstall();
    });

    it("installs chrome.storage.sync and chrome.storage.local on globalThis", () => {
        expect(globalThis.chrome).toBeDefined();
        expect(globalThis.chrome.storage.sync).toBeDefined();
        expect(globalThis.chrome.storage.local).toBeDefined();
    });

    it("supports promise-style set + get round trip on sync", async () => {
        await chrome.storage.sync.set({ log_export_name: "alpha" });
        const result = await chrome.storage.sync.get(["log_export_name"]);
        expect(result).toEqual({ log_export_name: "alpha" });
    });

    it("returns an empty object for an absent key (promise style)", async () => {
        const result = await chrome.storage.sync.get(["never_set"]);
        expect(result).toEqual({});
    });

    it("returns the entire store when keys is null", async () => {
        await chrome.storage.sync.set({ a: 1, b: 2 });
        const result = await chrome.storage.sync.get(null);
        expect(result).toEqual({ a: 1, b: 2 });
    });

    it("honors default values when keys is an object", async () => {
        await chrome.storage.sync.set({ present: "x" });
        const result = await chrome.storage.sync.get({ present: "fallback", absent: "fallback" });
        expect(result).toEqual({ present: "x", absent: "fallback" });
    });

    it("supports a single string key", async () => {
        await chrome.storage.sync.set({ only: "value" });
        const result = await chrome.storage.sync.get("only");
        expect(result).toEqual({ only: "value" });
    });

    it("supports callback-style get", async () => {
        await chrome.storage.sync.set({ k: "v" });
        const result = await new Promise((resolve) => {
            chrome.storage.sync.get(["k"], (r) => resolve(r));
        });
        expect(result).toEqual({ k: "v" });
    });

    it("removes keys (promise style)", async () => {
        await chrome.storage.sync.set({ a: 1, b: 2 });
        await chrome.storage.sync.remove(["a"]);
        const result = await chrome.storage.sync.get(null);
        expect(result).toEqual({ b: 2 });
    });

    it("clears each area independently", async () => {
        await chrome.storage.sync.set({ s: 1 });
        await chrome.storage.local.set({ l: 1 });
        await chrome.storage.sync.clear();
        expect(stub.sync.snapshot()).toEqual({});
        expect(stub.local.snapshot()).toEqual({ l: 1 });
    });

    it("resets both areas via the handle", async () => {
        await chrome.storage.sync.set({ s: 1 });
        await chrome.storage.local.set({ l: 1 });
        stub.reset();
        expect(stub.sync.snapshot()).toEqual({});
        expect(stub.local.snapshot()).toEqual({});
    });

    it("seeding via the handle is observable through the API", async () => {
        stub.local.seed({ pre: "loaded" });
        const result = await chrome.storage.local.get(["pre"]);
        expect(result).toEqual({ pre: "loaded" });
    });

    it("uninstall restores the previous global chrome", () => {
        const inUseChrome = globalThis.chrome;
        stub.uninstall();
        expect(globalThis.chrome).not.toBe(inUseChrome);
        // Re-install for the afterEach uninstall (safe: uninstall is idempotent
        // against a missing previous, and afterEach will run once more).
        stub = installChromeStorageStub();
    });
});

describe("downloadFileSpy", () => {
    // Minimal fake target; we don't need the real SettingsManager to validate
    // the spy's behavior (the spy just monkey-patches a `downloadFile` slot).
    let target;
    let spy;

    beforeEach(() => {
        target = {
            downloadFile(content, filename) {
                // Sentinel so we can detect whether the original was preserved.
                target._lastOriginalCall = { content, filename };
            },
        };
        spy = installDownloadFileSpy(target);
    });

    afterEach(() => {
        spy.uninstall();
    });

    it("records calls without invoking the original", () => {
        target.downloadFile("payload", "file.json");
        expect(spy.calls).toHaveLength(1);
        expect(spy.calls[0]).toMatchObject({ content: "payload", filename: "file.json" });
        expect(target._lastOriginalCall).toBeUndefined();
    });

    it("exposes the original method as _original", () => {
        expect(typeof spy._original).toBe("function");
        // Calling the original directly still works.
        spy._original("p", "f");
        expect(target._lastOriginalCall).toEqual({ content: "p", filename: "f" });
    });

    it("lastCall returns the most recent recorded call", () => {
        target.downloadFile("a", "1.json");
        target.downloadFile("b", "2.json");
        expect(spy.lastCall()).toMatchObject({ content: "b", filename: "2.json" });
    });

    it("reset clears recorded calls but keeps the spy installed", () => {
        target.downloadFile("a", "1.json");
        spy.reset();
        expect(spy.calls).toHaveLength(0);
        target.downloadFile("b", "2.json");
        expect(spy.calls).toHaveLength(1);
    });

    it("uninstall restores the original method", () => {
        spy.uninstall();
        target.downloadFile("after", "restored.json");
        expect(target._lastOriginalCall).toEqual({ content: "after", filename: "restored.json" });
    });
});
