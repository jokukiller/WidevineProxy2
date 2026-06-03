import { describe, it, expect } from "vitest";

describe("test harness sanity", () => {
    it("runs under vitest", () => {
        expect(1 + 1).toBe(2);
    });

    it("provides a jsdom environment", () => {
        const div = document.createElement("div");
        div.id = "sanity";
        document.body.appendChild(div);
        expect(document.getElementById("sanity")).toBe(div);
    });
});
