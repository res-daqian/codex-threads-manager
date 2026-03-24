import assert from "node:assert/strict";
import { test } from "node:test";

import { renderSessionTree } from "../src/tree.ts";
import type { SessionRecord } from "../src/types.ts";

function makeSession(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: overrides.id ?? "019d0000-0000-7000-a000-000000000000",
    displayId: overrides.displayId ?? "019d0000",
    displayIndex: overrides.displayIndex ?? 1,
    title: overrides.title ?? "Session title",
    updatedAtMs: overrides.updatedAtMs ?? Date.parse("2026-03-24T12:00:00.000Z"),
    createdAtMs: overrides.createdAtMs,
    updatedAtLabel: overrides.updatedAtLabel ?? "2026-03-24 20:00",
    createdAtLabel: overrides.createdAtLabel,
    cwd: overrides.cwd ?? "/tmp/project",
    cwdBase: overrides.cwdBase ?? "project",
    sourceLabel: overrides.sourceLabel ?? "cli",
    originator: overrides.originator,
    modelProvider: overrides.modelProvider,
    cliVersion: overrides.cliVersion,
    archived: overrides.archived ?? false,
    parentThreadId: overrides.parentThreadId,
    depth: overrides.depth,
    rolloutPath: overrides.rolloutPath ?? "/tmp/rollout.jsonl",
    snapshotPaths: overrides.snapshotPaths ?? [],
    indexEntries: overrides.indexEntries ?? [],
    stateRow: overrides.stateRow,
    presence: overrides.presence ?? {
      rollout: true,
      index: true,
      state: true,
      stateLogs: false,
      logs: false,
      snapshots: false,
    },
    storeCounts: overrides.storeCounts ?? { stateLogs: 0, logs: 0 },
    issues: overrides.issues ?? [],
    rollout: overrides.rollout ?? {
      id: overrides.id ?? "019d0000-0000-7000-a000-000000000000",
      path: overrides.rolloutPath ?? "/tmp/rollout.jsonl",
      year: "2026",
      month: "03",
      day: "24",
    },
  };
}

test("tree rendering truncates long metadata and keeps lines within width", () => {
  const sessions = [
    makeSession({
      id: "019d1111-1111-7111-a111-111111111111",
      displayId: "019d1111",
      title: "This is a deliberately long session title that must be truncated to keep the date tree readable in a narrow terminal",
    }),
    makeSession({
      id: "019d2222-2222-7222-a222-222222222222",
      displayId: "019d2222",
      displayIndex: 2,
      title: "Short title",
      parentThreadId: "019d1111-1111-7111-a111-111111111111",
    }),
  ];

  const rendered = renderSessionTree(sessions, {
    treeMode: "fork",
    metadataMode: "compact",
    includeStale: false,
    width: 64,
  });

  const lines = rendered.text.split(/\r?\n/).filter(Boolean);
  assert.ok(rendered.text.includes("Short title"));
  assert.ok(rendered.text.includes("..."));
  assert.ok(!rendered.text.includes("must be truncated to keep the date tree readable in a narrow terminal"));
  assert.ok(lines.every((line) => line.length <= 64));
  assert.deepEqual(
    rendered.orderedSessions.map((session) => session.id),
    [
      "019d1111-1111-7111-a111-111111111111",
      "019d2222-2222-7222-a222-222222222222",
    ],
  );
});

test("tree rendering adds inconsistent records when requested", () => {
  const sessions = [
    makeSession({
      id: "019d1111-1111-7111-a111-111111111111",
      displayId: "019d1111",
      title: "Rollout session",
    }),
    makeSession({
      id: "019d9999-9999-7999-a999-999999999999",
      displayId: "019d9999",
      displayIndex: 2,
      title: "Stale record",
      presence: {
        rollout: false,
        index: true,
        state: true,
        stateLogs: false,
        logs: true,
        snapshots: false,
      },
      rolloutPath: undefined,
      rollout: undefined,
      issues: ["missing rollout file"],
    }),
  ];

  const rendered = renderSessionTree(sessions, {
    treeMode: "date",
    metadataMode: "compact",
    includeStale: true,
    width: 100,
  });

  assert.ok(rendered.text.includes("inconsistent records"));
  assert.ok(rendered.text.includes("Stale record"));
});
