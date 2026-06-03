import { describe, it, expect, beforeEach, vi } from "vitest";

async function loadContentScriptAt(url) {
    vi.resetModules();
    document.body.innerHTML = "";
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.stubGlobal("location", { href: url });
    delete globalThis.__widevineProxy2ContentScriptLoaded;
    delete globalThis.__wvp2PwMetadataInternals;
    delete globalThis.__wvp2WatchedOverlayInternals;

    await import("../content_script.js");
    await new Promise((resolve) => setTimeout(resolve, 0));

    return globalThis.__wvp2PwMetadataInternals;
}

describe("PW metadata routing", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("detects the active JEE playlist title without using the AI Guru icon", async () => {
        const internals = await loadContentScriptAt(
            "https://www.pw.live/watch/?categoryId=68d4e93b86ee9a5dd9eaed68&childId=jee-child",
        );

        document.body.innerHTML = `
            <div id="ott-ask-ai">
                <button aria-label="Ask AI Assistant">
                    <img alt="AI Guru" src="AiGuruIcon.svg">
                </button>
            </div>
            <div class="playlist-item">
                <div class="relative flex-shrink-0">
                    <div class="w-[132px] h-[74px] rounded overflow-hidden">
                        <img alt="Determinants &amp; Matrices" src="lecture.webp">
                        <div class="absolute bottom-2 right-2 bg-[#1b2124] flex items-center justify-center">
                            <div></div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        expect(internals.getPwRouteKind()).toBe("watch");
        expect(internals.getActiveVideoTitle()).toBe("Determinants & Matrices");
        expect(internals.getActiveVideoTitle()).not.toBe("AI Guru");
        expect(internals.getPageMetadata().class_title).toBeNull();
    });

    it("rejects AI Guru and player controls as title candidates", async () => {
        const internals = await loadContentScriptAt(
            "https://www.pw.live/watch/?categoryId=68d4e93b86ee9a5dd9eaed68&childId=jee-child",
        );

        document.body.innerHTML = `
            <div id="ott-ask-ai">
                <button aria-label="Ask AI Assistant">
                    <img id="ai-guru-icon" alt="AI Guru" src="AiGuruIcon.svg">
                    <div class="absolute bottom-2 right-2 bg-[#1b2124] flex items-center justify-center"></div>
                </button>
            </div>
        `;

        const icon = document.getElementById("ai-guru-icon");
        expect(internals.isUsableLectureTitle("AI Guru")).toBe(false);
        expect(internals.getElementTitle(icon)).toBeNull();
        expect(internals.getActiveVideoTitle()).toBeNull();
    });

    it("does not run class-card selection on the watch route", async () => {
        const internals = await loadContentScriptAt(
            "https://www.pw.live/watch/?categoryId=68d4e93b86ee9a5dd9eaed68&childId=jee-child",
        );

        document.body.innerHTML = `
            <div id="fake-card">
                <img alt="AI Guru" src="AiGuruIcon.svg">
                <h3 title="AI Guru">AI Guru</h3>
            </div>
        `;

        const event = new MouseEvent("click", { bubbles: true });
        Object.defineProperty(event, "target", {
            value: document.getElementById("fake-card"),
        });

        expect(internals.getClassSelectionFromEvent(event)).toEqual({
            rejected: true,
            reason: "not_study_page",
        });
    });

    it("runs class-card selection on the study route", async () => {
        const internals = await loadContentScriptAt(
            "https://www.pw.live/study-v2/pi?source=nav_bar&categoryId=68d4e93b86ee9a5dd9eaed68",
        );

        document.body.innerHTML = `
            <div id="study-card">
                <img alt="Determinants &amp; Matrices" src="lecture.webp">
                <h3 title="Determinants &amp; Matrices">Determinants &amp; Matrices</h3>
            </div>
        `;

        const event = new MouseEvent("click", { bubbles: true });
        Object.defineProperty(event, "target", {
            value: document.querySelector("#study-card h3"),
        });

        expect(internals.getClassSelectionFromEvent(event)).toMatchObject({
            title: "Determinants & Matrices",
            source: "h3",
        });
    });

    it("keeps class context only when the categoryId matches", async () => {
        const internals = await loadContentScriptAt(
            "https://www.pw.live/study-v2/pi?source=nav_bar&categoryId=69b2baca19f1d6cb35a257cb",
        );

        internals.setStoredClassTitle("GATE Class");

        vi.stubGlobal("location", {
            href: "https://www.pw.live/watch/?categoryId=69b2baca19f1d6cb35a257cb&childId=gate-child",
        });
        expect(internals.getStoredClassTitle()).toBe("GATE Class");

        vi.stubGlobal("location", {
            href: "https://www.pw.live/watch/?categoryId=68d4e93b86ee9a5dd9eaed68&childId=jee-child",
        });
        expect(internals.getStoredClassTitle()).toBeNull();
    });
});
