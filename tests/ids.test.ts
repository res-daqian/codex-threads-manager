import assert from "node:assert/strict";
import { test } from "node:test";

import { computeShortestUniquePrefixes, resolveUniquePrefix } from "../src/ids.ts";

test("shortest unique prefixes expand only when needed", () => {
  const prefixes = computeShortestUniquePrefixes([
    "abc12345",
    "abc67890",
    "xyz00000",
  ], 3);

  assert.equal(prefixes.get("xyz00000"), "xyz");
  assert.equal(prefixes.get("abc12345"), "abc1");
  assert.equal(prefixes.get("abc67890"), "abc6");
});

test("resolveUniquePrefix returns the matching id and rejects ambiguous prefixes", () => {
  assert.equal(resolveUniquePrefix("xyz", ["abc123", "abd999", "xyz000"]), "xyz000");
  assert.equal(resolveUniquePrefix("abc123", ["abc123", "abd999", "xyz000"]), "abc123");

  assert.throws(
    () => resolveUniquePrefix("ab", ["abc123", "abd999", "abf000"]),
    /ambiguous/i,
  );
});
