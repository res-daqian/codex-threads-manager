import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { executeDeletion, parseSelectionInput, planDeletion, renderDeletePlan } from "../src/delete.ts";
import { scanCodexRoot } from "../src/scan.ts";
import {
  createLogsDb,
  createRollout,
  createStateDb,
  readJsonl,
  runSqlite,
  withTempDir,
  writeJsonl,
  writeText,
} from "./_helpers.ts";

test("delete planning and execution remove one session while preserving others", async () => {
  await withTempDir(async (tempDir) => {
    const codexRoot = path.join(tempDir, ".codex");

    const oldRolloutPath = await createRollout(codexRoot, {
      id: "019d1111-1111-7111-a111-111111111111",
      year: "2026",
      month: "03",
      day: "23",
      timestamp: "2026-03-23T10:00:00.000Z",
      cwd: "/old/session",
    });
    const activeRolloutPath = await createRollout(codexRoot, {
      id: "019d2222-2222-7222-a222-222222222222",
      year: "2026",
      month: "03",
      day: "24",
      timestamp: "2026-03-24T11:00:00.000Z",
      cwd: "/active/session",
    });

    await writeJsonl(path.join(codexRoot, "session_index.jsonl"), [
      {
        id: "019d1111-1111-7111-a111-111111111111",
        thread_name: "Old thread",
        updated_at: "2026-03-23T10:05:00.000Z",
      },
      {
        id: "019d1111-1111-7111-a111-111111111111",
        thread_name: "Old thread duplicate",
        updated_at: "2026-03-23T10:06:00.000Z",
      },
      {
        id: "019d2222-2222-7222-a222-222222222222",
        thread_name: "Active thread",
        updated_at: "2026-03-24T11:05:00.000Z",
      },
    ]);

    createStateDb(path.join(codexRoot, "state_5.sqlite"), {
      threads: [
        {
          id: "019d1111-1111-7111-a111-111111111111",
          rolloutPath: oldRolloutPath,
          createdAt: 1_774_355_000,
          updatedAt: 1_774_356_000,
          cwd: "/old/session",
          title: "Old thread title",
        },
        {
          id: "019d2222-2222-7222-a222-222222222222",
          rolloutPath: activeRolloutPath,
          createdAt: 1_774_360_000,
          updatedAt: 1_774_361_000,
          cwd: "/active/session",
          title: "Active thread title",
        },
      ],
      logs: [
        { threadId: "019d1111-1111-7111-a111-111111111111", count: 2 },
        { threadId: "019d2222-2222-7222-a222-222222222222", count: 1 },
      ],
      dynamicTools: [
        { threadId: "019d1111-1111-7111-a111-111111111111", count: 2 },
      ],
      stage1Outputs: [
        { threadId: "019d1111-1111-7111-a111-111111111111", count: 1 },
      ],
    });

    createLogsDb(path.join(codexRoot, "logs_1.sqlite"), [
      { threadId: "019d1111-1111-7111-a111-111111111111", count: 3 },
      { threadId: "019d2222-2222-7222-a222-222222222222", count: 1 },
    ]);

    await writeText(
      path.join(codexRoot, "shell_snapshots", "019d1111-1111-7111-a111-111111111111.1.sh"),
      "echo old\n",
    );
    await writeText(
      path.join(codexRoot, "shell_snapshots", "019d2222-2222-7222-a222-222222222222.1.sh"),
      "echo active\n",
    );

    const scan = await scanCodexRoot(codexRoot);
    const oldSession = scan.byId.get("019d1111-1111-7111-a111-111111111111");
    const activeSession = scan.byId.get("019d2222-2222-7222-a222-222222222222");
    assert.ok(oldSession);
    assert.ok(activeSession);

    const plan = await planDeletion(scan, [oldSession], activeSession.id);
    const preview = renderDeletePlan(plan);
    assert.ok(preview.includes("Old thread"));
    assert.ok(preview.includes("session_index rows: 2"));
    assert.ok(preview.includes("logs_1 logs: 3"));

    const result = await executeDeletion(plan);
    assert.equal(result.removedRolloutFiles, 1);
    assert.equal(result.removedIndexRows, 2);
    assert.equal(result.removedThreadRows, 1);
    assert.equal(result.removedThreadDynamicToolsRows, 2);
    assert.equal(result.removedStage1OutputsRows, 1);
    assert.equal(result.removedStateLogRows, 2);
    assert.equal(result.removedLogsRows, 3);
    assert.equal(result.removedSnapshots, 1);

    const indexRows = await readJsonl(path.join(codexRoot, "session_index.jsonl"));
    assert.deepEqual(indexRows.map((row) => row.id), ["019d2222-2222-7222-a222-222222222222"]);

    runSqlite(path.join(codexRoot, "state_5.sqlite"), [
      ".mode list",
      "SELECT COUNT(*) FROM threads WHERE id = '019d1111-1111-7111-a111-111111111111';",
      "SELECT COUNT(*) FROM threads WHERE id = '019d2222-2222-7222-a222-222222222222';",
      "SELECT COUNT(*) FROM logs WHERE thread_id = '019d1111-1111-7111-a111-111111111111';",
    ]);

    const rescan = await scanCodexRoot(codexRoot);
    assert.equal(rescan.byId.has("019d1111-1111-7111-a111-111111111111"), false);
    assert.equal(rescan.byId.has("019d2222-2222-7222-a222-222222222222"), true);
  });
});

test("CLI accepts --dry-run and delete --all removes all sessions under a temp root", async () => {
  await withTempDir(async (tempDir) => {
    const codexRoot = path.join(tempDir, ".codex");
    await createRollout(codexRoot, {
      id: "019d1111-1111-7111-a111-111111111111",
      year: "2026",
      month: "03",
      day: "24",
      timestamp: "2026-03-24T10:00:00.000Z",
      cwd: "/first",
    });
    await createRollout(codexRoot, {
      id: "019d2222-2222-7222-a222-222222222222",
      year: "2026",
      month: "03",
      day: "24",
      timestamp: "2026-03-24T11:00:00.000Z",
      cwd: "/second",
    });
    await writeJsonl(path.join(codexRoot, "session_index.jsonl"), [
      {
        id: "019d1111-1111-7111-a111-111111111111",
        thread_name: "First",
        updated_at: "2026-03-24T10:05:00.000Z",
      },
      {
        id: "019d2222-2222-7222-a222-222222222222",
        thread_name: "Second",
        updated_at: "2026-03-24T11:05:00.000Z",
      },
    ]);
    createStateDb(path.join(codexRoot, "state_5.sqlite"), {
      threads: [
        {
          id: "019d1111-1111-7111-a111-111111111111",
          rolloutPath: path.join(codexRoot, "sessions", "2026", "03", "24", "first.jsonl"),
          createdAt: 1_774_355_000,
          updatedAt: 1_774_356_000,
          cwd: "/first",
          title: "First",
        },
        {
          id: "019d2222-2222-7222-a222-222222222222",
          rolloutPath: path.join(codexRoot, "sessions", "2026", "03", "24", "second.jsonl"),
          createdAt: 1_774_357_000,
          updatedAt: 1_774_358_000,
          cwd: "/second",
          title: "Second",
        },
      ],
    });
    createLogsDb(path.join(codexRoot, "logs_1.sqlite"), []);

    const cliPath = path.join(process.cwd(), "bin", "codex-thread-manager");
    const dryRun = spawnSync(
      cliPath,
      ["delete", "--dry-run", "--root", codexRoot, "019d1111"],
      { encoding: "utf8" },
    );
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /Delete preview/);

    const deleteAll = spawnSync(
      cliPath,
      ["delete", "--all", "--yes", "--root", codexRoot],
      { encoding: "utf8" },
    );
    assert.equal(deleteAll.status, 0, deleteAll.stderr);
    assert.match(deleteAll.stdout, /Deleted successfully/);

    const rescan = await scanCodexRoot(codexRoot);
    assert.equal(rescan.sessions.length, 0);
  });
});

test("delete planning refuses the active thread and selection parsing handles ranges", async () => {
  await withTempDir(async (tempDir) => {
    const codexRoot = path.join(tempDir, ".codex");
    await createRollout(codexRoot, {
      id: "019d1111-1111-7111-a111-111111111111",
      year: "2026",
      month: "03",
      day: "24",
      timestamp: "2026-03-24T10:00:00.000Z",
      cwd: "/active",
    });
    await createRollout(codexRoot, {
      id: "019d2222-2222-7222-a222-222222222222",
      year: "2026",
      month: "03",
      day: "24",
      timestamp: "2026-03-24T09:00:00.000Z",
      cwd: "/other",
    });

    await writeJsonl(path.join(codexRoot, "session_index.jsonl"), []);
    createStateDb(path.join(codexRoot, "state_5.sqlite"));
    createLogsDb(path.join(codexRoot, "logs_1.sqlite"), []);

    const scan = await scanCodexRoot(codexRoot);
    const ordered = scan.sessions;
    const picked = parseSelectionInput("1-2", ordered);
    assert.equal(picked.length, 2);

    const activeSession = scan.byId.get("019d1111-1111-7111-a111-111111111111");
    assert.ok(activeSession);

    await assert.rejects(
      async () => {
        await planDeletion(scan, [activeSession], activeSession.id);
      },
      /active thread/i,
    );
  });
});
