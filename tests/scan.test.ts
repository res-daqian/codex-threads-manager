import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { scanCodexRoot } from "../src/scan.ts";
import {
  createLogsDb,
  createRollout,
  createStateDb,
  readJsonl,
  withTempDir,
  writeJsonl,
  writeText,
} from "./_helpers.ts";

test("scan normalizes rollout, index, sqlite, logs, and shell snapshots", async () => {
  await withTempDir(async (tempDir) => {
    const codexRoot = path.join(tempDir, ".codex");

    const mergedRolloutPath = await createRollout(codexRoot, {
      id: "019d1111-1111-7111-a111-111111111111",
      year: "2026",
      month: "03",
      day: "24",
      timestamp: "2026-03-24T10:00:00.000Z",
      cwd: "/rollout/merged",
    });
    await createRollout(codexRoot, {
      id: "019d2222-2222-7222-a222-222222222222",
      year: "2026",
      month: "03",
      day: "24",
      timestamp: "2026-03-24T09:00:00.000Z",
      cwd: "/rollout/only",
    });
    await createRollout(codexRoot, {
      id: "019d3333-3333-7333-a333-333333333333",
      year: "2026",
      month: "03",
      day: "24",
      timestamp: "2026-03-24T11:00:00.000Z",
      cwd: "/forked/child",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "019d1111-1111-7111-a111-111111111111",
            depth: 1,
            agent_nickname: "Scout",
            agent_role: "explorer",
          },
        },
      },
    });

    await writeJsonl(path.join(codexRoot, "session_index.jsonl"), [
      {
        id: "019d1111-1111-7111-a111-111111111111",
        thread_name: "Merged friendly name",
        updated_at: "2026-03-24T12:00:00.000Z",
      },
      {
        id: "019d1111-1111-7111-a111-111111111111",
        thread_name: "Merged friendly name v2",
        updated_at: "2026-03-24T12:05:00.000Z",
      },
      {
        id: "019d4444-4444-7444-a444-444444444444",
        thread_name: "Index only stale",
        updated_at: "2026-03-24T08:00:00.000Z",
      },
    ]);

    createStateDb(path.join(codexRoot, "state_5.sqlite"), {
      threads: [
        {
          id: "019d1111-1111-7111-a111-111111111111",
          rolloutPath: mergedRolloutPath,
          createdAt: 1_774_355_800,
          updatedAt: 1_774_363_000,
          cwd: "/state/merged",
          title: "State merged title",
        },
        {
          id: "019d5555-5555-7555-a555-555555555555",
          rolloutPath: "/missing/rollout.jsonl",
          createdAt: 1_774_355_000,
          updatedAt: 1_774_356_000,
          cwd: "/state/only",
          title: "State only stale",
        },
      ],
      logs: [
        { threadId: "019d1111-1111-7111-a111-111111111111", count: 2 },
      ],
    });

    createLogsDb(path.join(codexRoot, "logs_1.sqlite"), [
      { threadId: "019d1111-1111-7111-a111-111111111111", count: 3 },
      { threadId: "019d5555-5555-7555-a555-555555555555", count: 1 },
    ]);

    await writeText(
      path.join(codexRoot, "shell_snapshots", "019d1111-1111-7111-a111-111111111111.1.sh"),
      "echo snapshot\n",
    );

    const scan = await scanCodexRoot(codexRoot);
    const ids = scan.sessions.map((session) => session.id).sort();

    assert.deepEqual(ids, [
      "019d1111-1111-7111-a111-111111111111",
      "019d2222-2222-7222-a222-222222222222",
      "019d3333-3333-7333-a333-333333333333",
      "019d4444-4444-7444-a444-444444444444",
      "019d5555-5555-7555-a555-555555555555",
    ]);

    const merged = scan.byId.get("019d1111-1111-7111-a111-111111111111");
    assert.ok(merged);
    assert.equal(merged.title, "Merged friendly name v2");
    assert.equal(merged.cwd, "/state/merged");
    assert.equal(merged.parentThreadId, undefined);
    assert.equal(merged.storeCounts.stateLogs, 2);
    assert.equal(merged.storeCounts.logs, 3);
    assert.equal(merged.snapshotPaths.length, 1);
    assert.ok(merged.issues.includes("duplicate session_index rows (2)"));

    const rolloutOnly = scan.byId.get("019d2222-2222-7222-a222-222222222222");
    assert.ok(rolloutOnly);
    assert.ok(rolloutOnly.issues.includes("missing state row"));
    assert.ok(rolloutOnly.issues.includes("missing session_index row"));

    const child = scan.byId.get("019d3333-3333-7333-a333-333333333333");
    assert.ok(child);
    assert.equal(child.parentThreadId, "019d1111-1111-7111-a111-111111111111");
    assert.equal(child.depth, 1);

    const indexOnly = scan.byId.get("019d4444-4444-7444-a444-444444444444");
    assert.ok(indexOnly);
    assert.equal(indexOnly.presence.rollout, false);
    assert.ok(indexOnly.issues.includes("missing rollout file"));

    const stateOnly = scan.byId.get("019d5555-5555-7555-a555-555555555555");
    assert.ok(stateOnly);
    assert.equal(stateOnly.presence.state, true);
    assert.equal(stateOnly.presence.rollout, false);
    assert.equal(stateOnly.storeCounts.logs, 1);

    const indexRows = await readJsonl(path.join(codexRoot, "session_index.jsonl"));
    assert.equal(indexRows.length, 3);
  });
});
