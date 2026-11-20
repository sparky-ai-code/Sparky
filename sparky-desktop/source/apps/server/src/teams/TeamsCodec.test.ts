import { describe, expect, it } from "vite-plus/test";

import {
  aggregateReactions,
  deriveThreadTitle,
  encodeMarker,
  encodeMessageBody,
  encodeReactionBody,
  findOwnReactionCommentId,
  parseMarker,
} from "./TeamsCodec.ts";

describe("TeamsCodec", () => {
  describe("encodeMarker / parseMarker", () => {
    it("round-trips a message marker with a reply target", () => {
      const body = encodeMessageBody("12345", "hello there");
      expect(
        body.startsWith('<!-- sparky-team:{"v":1,"kind":"message","replyTo":"12345"} -->\n'),
      ).toBe(true);
      expect(parseMarker(body)).toEqual({ kind: "message", replyTo: "12345", text: "hello there" });
    });

    it("round-trips a root message with a null replyTo", () => {
      expect(parseMarker(encodeMessageBody(null, "root"))).toEqual({
        kind: "message",
        replyTo: null,
        text: "root",
      });
    });

    it("keeps multi-line text intact", () => {
      const text = "line one\n\nline three";
      expect(parseMarker(encodeMessageBody(null, text))?.text).toBe(text);
    });

    it("round-trips a reaction marker", () => {
      const body = encodeReactionBody("999", "👍");
      expect(parseMarker(body)).toEqual({
        kind: "reaction",
        target: "999",
        emoji: "👍",
        text: "reacted 👍",
      });
    });

    it("escapes a literal --> inside marker fields so the comment cannot close early", () => {
      const marker = encodeMarker("reaction", { target: "1", emoji: "a-->b" });
      expect(marker.indexOf("-->")).toBe(marker.length - 3);
      expect(parseMarker(`${marker}\nreacted`)).toEqual({
        kind: "reaction",
        target: "1",
        emoji: "a-->b",
        text: "reacted",
      });
    });

    it("returns null for a plain human comment without a marker", () => {
      expect(parseMarker("just a note from github.com")).toBeNull();
    });

    it("returns null for a malformed or unknown marker", () => {
      expect(parseMarker("<!-- sparky-team:{not json} -->\nx")).toBeNull();
      expect(
        parseMarker('<!-- sparky-team:{"v":2,"kind":"message","replyTo":null} -->\nx'),
      ).toBeNull();
      expect(parseMarker('<!-- sparky-team:{"v":1,"kind":"other"} -->\nx')).toBeNull();
      expect(
        parseMarker('<!-- sparky-team:{"v":1,"kind":"reaction","target":"1"} -->\nx'),
      ).toBeNull();
      expect(
        parseMarker('<!-- sparky-team:{"v":1,"kind":"message","replyTo":""} -->\nx'),
      ).toBeNull();
    });

    it("treats a missing replyTo as a root message", () => {
      expect(parseMarker('<!-- sparky-team:{"v":1,"kind":"message"} -->\nhi')).toEqual({
        kind: "message",
        replyTo: null,
        text: "hi",
      });
    });
  });

  describe("deriveThreadTitle", () => {
    it("uses the first non-empty trimmed line", () => {
      expect(deriveThreadTitle("\n\n   Ship the thing  \nsecond line")).toBe("Ship the thing");
    });

    it("returns the line unchanged when it is exactly 120 characters", () => {
      const line = "a".repeat(120);
      expect(deriveThreadTitle(line)).toBe(line);
    });

    it("truncates longer lines to 120 characters including the ellipsis", () => {
      const title = deriveThreadTitle("b".repeat(200));
      expect(Array.from(title)).toHaveLength(120);
      expect(title.endsWith("…")).toBe(true);
    });

    it("counts code points so emoji are not split", () => {
      const title = deriveThreadTitle("🎉".repeat(150));
      expect(Array.from(title)).toHaveLength(120);
      expect(title.endsWith("…")).toBe(true);
    });

    it("falls back to a placeholder for a whitespace-only body", () => {
      expect(deriveThreadTitle("   \n  \n")).toBe("Untitled thread");
    });
  });

  describe("aggregateReactions", () => {
    const reaction = (author: string, target: string, emoji: string) => ({
      author,
      body: encodeReactionBody(target, emoji),
    });

    it("counts distinct authors per emoji and flags the viewer", () => {
      const result = aggregateReactions(
        [
          reaction("alice", "10", "👍"),
          reaction("bob", "10", "👍"),
          reaction("Carol", "10", "🎉"),
          reaction("ALICE", "10", "👍"),
          reaction("bob", "20", "👍"),
        ],
        "alice",
      );

      expect(result.get("10")).toEqual([
        { emoji: "👍", count: 2, reactedByViewer: true },
        { emoji: "🎉", count: 1, reactedByViewer: false },
      ]);
      expect(result.get("20")).toEqual([{ emoji: "👍", count: 1, reactedByViewer: false }]);
    });

    it("ignores message comments and plain comments", () => {
      const result = aggregateReactions(
        [
          { author: "alice", body: encodeMessageBody(null, "hi") },
          { author: "bob", body: "human comment" },
        ],
        null,
      );
      expect(result.size).toBe(0);
    });

    it("never flags reactedByViewer when the viewer is unknown", () => {
      const result = aggregateReactions([reaction("alice", "10", "👍")], null);
      expect(result.get("10")).toEqual([{ emoji: "👍", count: 1, reactedByViewer: false }]);
    });
  });

  describe("findOwnReactionCommentId", () => {
    it("returns the viewer's reaction comment id for matching target and emoji", () => {
      const comments = [
        { id: "1", author: "bob", body: encodeReactionBody("10", "👍") },
        { id: "2", author: "Alice", body: encodeReactionBody("10", "👍") },
        { id: "3", author: "alice", body: encodeReactionBody("10", "🎉") },
      ];
      expect(findOwnReactionCommentId(comments, "alice", "10", "👍")).toBe("2");
      expect(findOwnReactionCommentId(comments, "alice", "10", "🚀")).toBeNull();
      expect(findOwnReactionCommentId(comments, "carol", "10", "👍")).toBeNull();
    });
  });
});
