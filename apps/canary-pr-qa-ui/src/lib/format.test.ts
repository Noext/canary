import { describe, expect, it } from "vitest";
import {
  formatDate,
  githubCommentUrl,
  githubPullUrl,
  shortSha,
} from "./format";

describe("formatDate", () => {
  it("renders a French date whatever the runtime locale is", () => {
    // Noon local time, so the assertion holds in every timezone.
    const value = new Date(2026, 9, 13, 12, 30, 0).toISOString();
    // Day before month, 24-hour clock: an `en-US` container must not leak its
    // format into a French-only interface.
    expect(formatDate(value)).toMatch(/^13\/10\/2026/);
    expect(formatDate(value)).not.toMatch(/AM|PM/);
  });

  it("keeps an absent date empty rather than Invalid Date", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
  });
});

describe("shortSha", () => {
  it("shortens a commit to twelve characters and tolerates a missing one", () => {
    expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe(
      "0123456789ab"
    );
    expect(shortSha(null)).toBe("");
  });
});

describe("githubPullUrl", () => {
  it("only builds a link for a real owner/name repository", () => {
    expect(githubPullUrl("owner/name", 12)).toBe(
      "https://github.com/owner/name/pull/12"
    );
    // A webhook payload is not trusted to shape a URL.
    expect(githubPullUrl("owner/name/../../evil", 12)).toBeUndefined();
    expect(githubPullUrl("owner/name", 0)).toBeUndefined();
    expect(githubPullUrl("", 12)).toBeUndefined();
  });
});

describe("githubCommentUrl", () => {
  it("only accepts a github.com URL", () => {
    const comment = "https://github.com/owner/name/pull/12#issuecomment-1";
    expect(githubCommentUrl(comment)).toBe(comment);
    expect(githubCommentUrl("https://evil.example/owner/name")).toBeUndefined();
    expect(githubCommentUrl(null)).toBeUndefined();
    expect(githubCommentUrl("not a url")).toBeUndefined();
  });
});
