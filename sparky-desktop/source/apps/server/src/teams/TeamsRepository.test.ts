import { describe, expect, it } from "vite-plus/test";

import { parseRepositoryInput } from "./TeamsRepository.ts";

describe("parseRepositoryInput", () => {
  it.each([
    ["owner/name", { owner: "owner", name: "name" }],
    ["  owner/name  ", { owner: "owner", name: "name" }],
    ["github.com/owner/name", { owner: "owner", name: "name" }],
    ["https://github.com/owner/name", { owner: "owner", name: "name" }],
    ["https://www.github.com/owner/name/", { owner: "owner", name: "name" }],
    ["https://github.com/owner/name.git", { owner: "owner", name: "name" }],
    ["https://github.com/owner/name/tree/main", { owner: "owner", name: "name" }],
    ["https://github.com/owner/name?tab=readme", { owner: "owner", name: "name" }],
    ["git@github.com:owner/name.git", { owner: "owner", name: "name" }],
    ["darkness22s/Fable", { owner: "darkness22s", name: "Fable" }],
  ])("accepts %s", (input, expected) => {
    expect(parseRepositoryInput(input)).toEqual(expected);
  });

  it.each([
    "",
    "   ",
    "Soliman mohammed",
    "just-a-name",
    "owner/name/extra",
    "https://github.com/owner",
    "https://github.com/",
    "https://gitlab.com/owner/name",
    "owner/",
    "/name",
    "owner/na me",
    "https://github.com/owner/.git",
  ])("rejects %j", (input) => {
    expect(parseRepositoryInput(input)).toBeNull();
  });
});
