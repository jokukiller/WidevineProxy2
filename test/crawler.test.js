import { describe, it, expect } from "vitest";
import {
  PWCrawler,
  OTT_ENDPOINTS,
  CRAWLER_STATES,
  pick,
  buildWatchUrl,
  parseBody,
  unwrap,
  classifyItem,
  collectItems,
  flattenLectures,
  classifyCaptureUrl,
} from "../crawler.js";

// ─── Synthetic captures shaped like real PW Pi traffic ──────────────────────

const CAT_ID = "64f0aaaaaaaaaaaaaaaaaaaa";
const WIDGET_ID = "64f0bbbbbbbbbbbbbbbbbbbb";
const PLAYLIST_ID = "64f0cccccccccccccccccccc";

// A "nav" capture (unknown shell endpoint) that carries the category/widget tree.
const navCapture = {
  url: `https://api.penpencil.co/v1/pages/pi-home?categoryId=${CAT_ID}&landingPage=HOME`,
  method: "GET",
  statusCode: 200,
  responseBody: {
    success: true,
    data: [
      {
        _id: WIDGET_ID,
        title: "Latest Lectures",
        widgetType: "CONTENT",
        data: [
          { childId: "child-1", title: "Lec 1", contentType: "VIDEO" },
          { childId: "child-2", title: "Lec 2", contentType: "VIDEO" },
          { playlistId: PLAYLIST_ID, title: "Playlist A", contentType: "PLAYLIST" },
        ],
      },
    ],
  },
};

// A confirmed playlist capture — lets us absorb children without any request.
const playlistCapture = {
  url: `https://api.penpencil.co/ott/v1/ott/playlist/${PLAYLIST_ID}`,
  method: "GET",
  statusCode: 200,
  responseBody: {
    success: true,
    data: [
      { childId: "pl-child-1", title: "Part 1" },
      { childId: "pl-child-2", title: "Part 2" },
    ],
  },
};

describe("pure helpers", () => {
  it("pick returns the first defined key", () => {
    expect(pick({ a: "", b: "x" }, ["a", "b"])).toBe("x");
    expect(pick({}, ["a"], "fallback")).toBe("fallback");
  });

  it("builds confirmed single + playlist watch URLs", () => {
    const single = buildWatchUrl({ categoryId: "c", widgetId: "w", childId: "ch" });
    expect(single).toContain("categoryId=c");
    expect(single).toContain("childId=ch");
    expect(single).not.toContain("playlistId");

    const pl = buildWatchUrl({ categoryId: "c", widgetId: "w", playlistId: "p", childId: "ch" });
    expect(pl).toContain("playlistId=p");
    expect(pl).toContain("default_enabled_feature=PLAYLIST");
  });

  it("parseBody + unwrap handle the PW envelope and JSON strings", () => {
    expect(unwrap({ success: true, data: [1, 2] })).toEqual([1, 2]);
    expect(unwrap(JSON.stringify({ data: { x: 1 } }))).toEqual({ x: 1 });
    expect(parseBody("not json")).toBeNull();
  });

  it("classifyItem distinguishes playlists from single videos", () => {
    expect(classifyItem({ playlistId: "p", title: "X" }).itemType).toBe("playlist");
    expect(classifyItem({ contentType: "PLAYLIST", _id: "p2" }).itemType).toBe("playlist");
    const v = classifyItem({ childId: "ch", title: "Y" });
    expect(v.itemType).toBe("video");
    expect(v.childId).toBe("ch");
    expect(classifyItem({ nothing: true })).toBeNull();
  });

  it("collectItems harvests items from arbitrary nested payloads", () => {
    const items = collectItems(navCapture.responseBody.data, { categoryId: CAT_ID, widgetId: WIDGET_ID });
    expect(items).toHaveLength(3);
    expect(items.filter(i => i.itemType === "video")).toHaveLength(2);
    expect(items.filter(i => i.itemType === "playlist")).toHaveLength(1);
  });

  it("classifyCaptureUrl recognizes confirmed OTT paths vs nav", () => {
    expect(classifyCaptureUrl(playlistCapture.url)).toBe("playlist");
    expect(classifyCaptureUrl(`${OTT_ENDPOINTS.apiBase}/ott/v1/ott/video/details/x`)).toBe("video-details");
    expect(classifyCaptureUrl(navCapture.url)).toBe("nav");
    expect(classifyCaptureUrl("https://www.googletagmanager.com/gtm.js")).toBe("unknown");
  });
});

describe("PWCrawler — harvest-first (no active requests)", () => {
  it("reconstructs category → widget → item from captures and absorbs playlists", async () => {
    const crawler = new PWCrawler({ captures: [navCapture, playlistCapture], delayMs: 0 });
    const results = await crawler.crawlPiTree("harvest");

    expect(results.status).toBe("completed");
    expect(results.model).toBe("category>widget>item");
    expect(results.categories).toHaveLength(1);

    const cat = results.categories[0];
    expect(cat.categoryId).toBe(CAT_ID);
    const widget = cat.widgets[0];
    expect(widget.widgetName).toBe("Latest Lectures");
    expect(widget.items).toHaveLength(3); // 2 videos + 1 playlist

    const playlist = widget.items.find(i => i.itemType === "playlist");
    expect(playlist.lectures).toHaveLength(2); // absorbed from playlistCapture

    // flat lecture list: child-1, child-2, pl-child-1, pl-child-2 = 4
    const flat = flattenLectures(results);
    expect(flat).toHaveLength(4);
    expect(flat.every(l => l.watchUrl.startsWith("https://www.pw.live/watch/"))).toBe(true);
    const plLecture = flat.find(l => l.playlistId === PLAYLIST_ID);
    expect(plLecture.watchUrl).toContain("default_enabled_feature=PLAYLIST");
  });

  it("errors helpfully when there is nothing to harvest", async () => {
    const crawler = new PWCrawler({ captures: [], delayMs: 0 });
    const results = await crawler.crawlPiTree("harvest");
    expect(results.status).toBe("error");
    expect(crawler.getProgress().errors.some(e => /No captured PW API traffic/.test(e.message))).toBe(true);
  });
});

describe("PWCrawler — active full crawl (category → widget → content → playlist)", () => {
  // Mock transport emulating the confirmed OTT endpoints.
  function makeTransport(calls) {
    return async ({ path, params }) => {
      calls.push(path);
      if (path === "ott/v1/ott/category") {
        return { success: true, data: [{ _id: CAT_ID, name: "NEET" }] };
      }
      if (path === "ott/v1/ott/widget") {
        expect(params.categoryId).toBe(CAT_ID);
        return { success: true, data: [{ _id: WIDGET_ID, title: "Top 10 this Week", type: "Top X Content" }] };
      }
      if (path === `ott/v1/ott/widget/${WIDGET_ID}/content`) {
        // single page, then stop via totalPending=0
        return {
          success: true,
          paginate: { totalPending: 0 },
          data: [
            { _id: "child-1", title: "Lec 1", type: "Video", duration: 100 },
            { _id: "child-2", title: "Lec 2", type: "Video", duration: 200 },
            { _id: PLAYLIST_ID, title: "Playlist A", type: "Playlist" },
          ],
        };
      }
      if (path === `ott/v1/ott/playlist/${PLAYLIST_ID}`) {
        return { success: true, data: [{ _id: "pl-1", title: "P1" }, { _id: "pl-2", title: "P2" }] };
      }
      throw new Error("unexpected path " + path);
    };
  }

  it("enumerates categories, widgets, paginated content and expands playlists", async () => {
    const calls = [];
    const crawler = new PWCrawler({ transport: makeTransport(calls), delayMs: 0 });
    const results = await crawler.crawlPiTree("full");

    expect(results.status).toBe("completed");
    expect(calls).toContain("ott/v1/ott/category");
    expect(calls).toContain("ott/v1/ott/widget");
    expect(calls).toContain(`ott/v1/ott/widget/${WIDGET_ID}/content`);
    expect(calls).toContain(`ott/v1/ott/playlist/${PLAYLIST_ID}`);

    const widget = results.categories[0].widgets[0];
    expect(widget.items).toHaveLength(3); // 2 videos + 1 playlist
    const playlist = widget.items.find(i => i.itemType === "playlist");
    expect(playlist.lectures).toHaveLength(2);

    const flat = flattenLectures(results);
    expect(flat).toHaveLength(4); // child-1, child-2, pl-1, pl-2
    expect(flat.every(l => l.watchUrl.startsWith("https://www.pw.live/watch/"))).toBe(true);
    expect(flat.find(l => l.playlistId === PLAYLIST_ID).watchUrl).toContain("default_enabled_feature=PLAYLIST");
  });

  it("surfaces a 401 from the transport as a crawl error", async () => {
    const transport = async () => { const e = new Error("401"); e.statusCode = 401; throw e; };
    const crawler = new PWCrawler({ transport, delayMs: 0 });
    const results = await crawler.crawlPiTree("full");
    expect(results.status).toBe("error");
    expect(crawler.getProgress().errors.some(e => e.statusCode === 401)).toBe(true);
  });

  it("paginates widget content until totalPending reaches 0", async () => {
    const pages = [];
    const transport = async ({ path, params }) => {
      if (path === "ott/v1/ott/category") return { data: [{ _id: CAT_ID, name: "C" }] };
      if (path === "ott/v1/ott/widget") return { data: [{ _id: WIDGET_ID, title: "W" }] };
      if (path === `ott/v1/ott/widget/${WIDGET_ID}/content`) {
        pages.push(params.page);
        if (params.page === 1) return { data: [{ _id: "a", type: "Video" }], paginate: { totalPending: 1 } };
        return { data: [{ _id: "b", type: "Video" }], paginate: { totalPending: 0 } };
      }
      throw new Error("unexpected " + path);
    };
    const crawler = new PWCrawler({ transport, delayMs: 0 });
    const results = await crawler.crawlPiTree("full");
    expect(pages).toEqual([1, 2]);
    expect(flattenLectures(results)).toHaveLength(2);
  });

  it("supports the harvest-only depth from captures", async () => {
    const crawler = new PWCrawler({ captures: [navCapture, playlistCapture], delayMs: 0 });
    const results = await crawler.crawlPiTree("harvest");
    expect(results.status).toBe("completed");
    expect(flattenLectures(results).length).toBeGreaterThan(0);
  });
});
