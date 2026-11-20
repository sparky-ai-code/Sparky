import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  LAST_SEEN_STORAGE_KEY,
  REACTION_EMOJIS,
  SUGGESTED_TEAM_PROMPTS,
  countUnread,
  formatRelativeTime,
  mergeById,
  pickDefaultTeam,
  readLastSeenMap,
  teamsViewMode,
  threadTitleFromBody,
  writeLastSeen,
} from "./teamsLogic";

const NOW = new Date("2026-11-20T12:00:00.000Z");

function makeMemoryStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("constants", () => {
  it("exposes six suggested prompts and six reaction emojis", () => {
    expect(SUGGESTED_TEAM_PROMPTS).toHaveLength(6);
    expect(REACTION_EMOJIS).toEqual(["👍", "❤️", "🎉", "👀", "🚀", "😂"]);
  });
});

describe("threadTitleFromBody", () => {
  it("uses the first non-empty trimmed line", () => {
    expect(threadTitleFromBody("\n   \n  Fix the login bug  \nmore details")).toBe(
      "Fix the login bug",
    );
  });

  it("returns the untitled placeholder for empty or whitespace-only bodies", () => {
    expect(threadTitleFromBody("")).toBe("Untitled thread");
    expect(threadTitleFromBody("   \n\t\n")).toBe("Untitled thread");
  });

  it("keeps titles of exactly 120 characters unchanged", () => {
    const title = "a".repeat(120);
    expect(threadTitleFromBody(title)).toBe(title);
  });

  it("truncates longer titles to 120 characters ending with an ellipsis", () => {
    const title = threadTitleFromBody("b".repeat(200));
    expect(Array.from(title)).toHaveLength(120);
    expect(title.endsWith("…")).toBe(true);
    expect(title).toBe(`${"b".repeat(119)}…`);
  });

  it("does not split emoji when truncating", () => {
    const title = threadTitleFromBody("🚀".repeat(200));
    expect(Array.from(title)).toHaveLength(120);
    expect(title).toBe(`${"🚀".repeat(119)}…`);
  });
});

describe("mergeById", () => {
  type Item = { id: string; body: string; reactions: { emoji: string; count: number }[] };

  it("returns the same array reference when nothing changed", () => {
    const previous: Item[] = [
      { id: "1", body: "hi", reactions: [{ emoji: "👍", count: 1 }] },
      { id: "2", body: "there", reactions: [] },
    ];
    const incoming: Item[] = [
      { id: "1", body: "hi", reactions: [{ emoji: "👍", count: 1 }] },
      { id: "2", body: "there", reactions: [] },
    ];

    const merged = mergeById(previous, incoming);
    expect(merged).toBe(previous);
  });

  it("keeps previous object references for shallow-equal items", () => {
    const previous: Item[] = [
      { id: "1", body: "old", reactions: [] },
      { id: "2", body: "same", reactions: [] },
    ];
    const incoming: Item[] = [
      { id: "2", body: "same", reactions: [] },
      { id: "1", body: "changed", reactions: [] },
    ];

    const merged = mergeById(previous, incoming);
    expect(merged).not.toBe(previous);
    expect(merged.map((item) => item.id)).toEqual(["2", "1"]);
    expect(merged[0]).toBe(previous[1]);
    expect(merged[1]).toEqual({ id: "1", body: "changed", reactions: [] });
    expect(merged[1]).toBe(incoming[1]);
  });

  it("returns a new array when a changed item is present", () => {
    const previous: Item[] = [{ id: "1", body: "hi", reactions: [] }];
    const incoming: Item[] = [{ id: "1", body: "hi", reactions: [{ emoji: "🎉", count: 2 }] }];

    const merged = mergeById(previous, incoming);
    expect(merged).not.toBe(previous);
    expect(merged[0]?.reactions).toEqual([{ emoji: "🎉", count: 2 }]);
  });

  it("returns a new array when items are added or removed", () => {
    const previous: Item[] = [{ id: "1", body: "a", reactions: [] }];
    expect(
      mergeById(previous, [
        { id: "1", body: "a", reactions: [] },
        { id: "2", body: "b", reactions: [] },
      ]),
    ).toHaveLength(2);
    expect(mergeById(previous, [])).toEqual([]);
  });

  it("returns a new array when only the order changes", () => {
    const previous: Item[] = [
      { id: "1", body: "a", reactions: [] },
      { id: "2", body: "b", reactions: [] },
    ];
    const incoming = [previous[1], previous[0]] as Item[];
    const merged = mergeById(previous, incoming);
    expect(merged).not.toBe(previous);
    expect(merged.map((item) => item.id)).toEqual(["2", "1"]);
  });

  it("handles an empty previous list", () => {
    const merged = mergeById<Item>([], [{ id: "1", body: "a", reactions: [] }]);
    expect(merged).toHaveLength(1);
  });
});

describe("countUnread", () => {
  const messages = [
    { id: "m1", author: "alice" },
    { id: "m2", author: "bob" },
    { id: "m3", author: "viewer" },
    { id: "m4", author: "carol" },
  ];

  it("returns 0 when the thread was never read", () => {
    expect(countUnread(messages, null, "viewer")).toBe(0);
  });

  it("counts messages after lastReadId", () => {
    expect(countUnread(messages, "m1", "nobody")).toBe(3);
    expect(countUnread(messages, "m3", "nobody")).toBe(1);
  });

  it("returns 0 when lastReadId is the last message", () => {
    expect(countUnread(messages, "m4", "viewer")).toBe(0);
  });

  it("excludes the viewer's own messages", () => {
    expect(countUnread(messages, "m1", "viewer")).toBe(2);
    expect(countUnread(messages, "m1", "carol")).toBe(2);
  });

  it("counts messages not written by the viewer when lastReadId is missing", () => {
    expect(countUnread(messages, "gone", "viewer")).toBe(3);
    expect(countUnread([], "gone", "viewer")).toBe(0);
  });

  it("counts every message when the viewer is unknown", () => {
    expect(countUnread(messages, "m2", null)).toBe(2);
  });
});

describe("pickDefaultTeam", () => {
  it("returns the first team", () => {
    expect(pickDefaultTeam([{ id: "a" }, { id: "b" }])).toEqual({ id: "a" });
  });

  it("returns null when there are no teams", () => {
    expect(pickDefaultTeam([])).toBeNull();
  });
});

describe("teamsViewMode", () => {
  it("maps team counts to view modes", () => {
    expect(teamsViewMode(0)).toBe("empty");
    expect(teamsViewMode(1)).toBe("single");
    expect(teamsViewMode(2)).toBe("list");
    expect(teamsViewMode(12)).toBe("list");
  });
});

describe("last seen storage", () => {
  it("reads an empty map when nothing is stored", () => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    expect(readLastSeenMap()).toEqual({});
  });

  it("survives an invalid JSON value", () => {
    vi.stubGlobal("localStorage", makeMemoryStorage({ [LAST_SEEN_STORAGE_KEY]: "{not json" }));
    expect(readLastSeenMap()).toEqual({});
  });

  it("rejects values that are not a plain object of strings", () => {
    vi.stubGlobal("localStorage", makeMemoryStorage({ [LAST_SEEN_STORAGE_KEY]: "[1,2]" }));
    expect(readLastSeenMap()).toEqual({});

    vi.stubGlobal("localStorage", makeMemoryStorage({ [LAST_SEEN_STORAGE_KEY]: '"text"' }));
    expect(readLastSeenMap()).toEqual({});

    vi.stubGlobal("localStorage", makeMemoryStorage({ [LAST_SEEN_STORAGE_KEY]: '{"a": 1}' }));
    expect(readLastSeenMap()).toEqual({});
  });

  it("returns {} when localStorage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readLastSeenMap()).toEqual({});
  });

  it("merges writes into the stored map", () => {
    const storage = makeMemoryStorage({
      [LAST_SEEN_STORAGE_KEY]: JSON.stringify({ "proj#t1": "m1" }),
    });
    vi.stubGlobal("localStorage", storage);

    writeLastSeen("proj#t2", "m9");

    expect(JSON.parse(storage.getItem(LAST_SEEN_STORAGE_KEY) ?? "{}")).toEqual({
      "proj#t1": "m1",
      "proj#t2": "m9",
    });
    expect(readLastSeenMap()).toEqual({ "proj#t1": "m1", "proj#t2": "m9" });
  });

  it("does not throw when writing fails", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(() => writeLastSeen("proj#t1", "m1")).not.toThrow();
  });
});

describe("formatRelativeTime", () => {
  it("returns 'just now' under a minute", () => {
    expect(formatRelativeTime("2026-11-20T11:59:30.000Z", NOW)).toBe("just now");
    expect(formatRelativeTime("2026-11-20T12:00:00.000Z", NOW)).toBe("just now");
  });

  it("returns minutes under an hour", () => {
    expect(formatRelativeTime("2026-11-20T11:55:00.000Z", NOW)).toBe("5m ago");
    expect(formatRelativeTime("2026-11-20T11:01:00.000Z", NOW)).toBe("59m ago");
  });

  it("returns hours under a day", () => {
    expect(formatRelativeTime("2026-11-20T09:00:00.000Z", NOW)).toBe("3h ago");
  });

  it("returns days under a week", () => {
    expect(formatRelativeTime("2026-11-18T12:00:00.000Z", NOW)).toBe("2d ago");
  });

  it("returns a locale date for older timestamps", () => {
    const iso = "2026-11-01T12:00:00.000Z";
    expect(formatRelativeTime(iso, NOW)).toBe(new Date(iso).toLocaleDateString());
  });

  it("returns the raw string for invalid input", () => {
    expect(formatRelativeTime("not a date", NOW)).toBe("not a date");
  });
});
