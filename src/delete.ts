import path from "node:path";
import { promises as fs } from "node:fs";
import { fileExists, openDatabase, removeEmptyDirectories, tableExists } from "./util.ts";
import type { DeletePlan, DeleteResult, DeletionTarget, ScanResult, SessionRecord } from "./types.ts";

export async function planDeletion(
  scan: ScanResult,
  targets: SessionRecord[],
  activeThreadId = process.env.CODEX_THREAD_ID,
): Promise<DeletePlan> {
  if (activeThreadId && targets.some((target) => target.id === activeThreadId)) {
    throw new Error(`Refusing to delete the active thread ${activeThreadId}`);
  }

  const details = await collectDeletionTargets(scan, targets);
  return {
    root: scan.paths.root,
    targets: details,
    activeThreadId,
  };
}

async function collectDeletionTargets(scan: ScanResult, targets: SessionRecord[]): Promise<DeletionTarget[]> {
  const stateInfo = await collectStateDeletionDetails(scan.paths.stateDbPath, targets.map((target) => target.id));
  const logsInfo = await collectLogsDeletionDetails(scan.paths.logsDbPath, targets.map((target) => target.id));

  return targets.map((session) => {
    const state = stateInfo.get(session.id);
    return {
      session,
      rolloutExists: session.presence.rollout,
      indexRows: session.indexEntries.length,
      threadRowCount: state?.threadRowCount ?? 0,
      threadDynamicToolsCount: state?.threadDynamicToolsCount ?? 0,
      stage1OutputsCount: state?.stage1OutputsCount ?? 0,
      stateLogsCount: state?.stateLogsCount ?? 0,
      logsCount: logsInfo.get(session.id) ?? 0,
      snapshotPaths: [...session.snapshotPaths],
    };
  });
}

async function collectStateDeletionDetails(
  dbPath: string,
  ids: string[],
): Promise<Map<string, { threadRowCount: number; threadDynamicToolsCount: number; stage1OutputsCount: number; stateLogsCount: number }>> {
  const details = new Map<string, { threadRowCount: number; threadDynamicToolsCount: number; stage1OutputsCount: number; stateLogsCount: number }>();
  if (!(await fileExists(dbPath))) {
    return details;
  }
  const db = openDatabase(dbPath);
  try {
    const hasThreads = tableExists(db, "threads");
    const hasDynamicTools = tableExists(db, "thread_dynamic_tools");
    const hasStage1Outputs = tableExists(db, "stage1_outputs");
    const hasLogs = tableExists(db, "logs");

    for (const id of ids) {
      details.set(id, {
        threadRowCount: hasThreads ? countRows(db, "threads", "id", id) : 0,
        threadDynamicToolsCount: hasDynamicTools ? countRows(db, "thread_dynamic_tools", "thread_id", id) : 0,
        stage1OutputsCount: hasStage1Outputs ? countRows(db, "stage1_outputs", "thread_id", id) : 0,
        stateLogsCount: hasLogs ? countRows(db, "logs", "thread_id", id) : 0,
      });
    }
  } finally {
    db.close();
  }

  return details;
}

async function collectLogsDeletionDetails(dbPath: string, ids: string[]): Promise<Map<string, number>> {
  const details = new Map<string, number>();
  if (!(await fileExists(dbPath))) {
    return details;
  }
  const db = openDatabase(dbPath);
  try {
    const hasLogs = tableExists(db, "logs");
    for (const id of ids) {
      details.set(id, hasLogs ? countRows(db, "logs", "thread_id", id) : 0);
    }
  } finally {
    db.close();
  }
  return details;
}

function countRows(db: ReturnType<typeof openDatabase>, tableName: string, columnName: string, value: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${columnName} = ?`).get(value) as { count?: number };
  return row.count ?? 0;
}

export async function executeDeletion(plan: DeletePlan): Promise<DeleteResult> {
  const targetIds = plan.targets.map((target) => target.session.id);
  const result: DeleteResult = {
    removedRolloutFiles: 0,
    removedIndexRows: 0,
    removedThreadRows: 0,
    removedThreadDynamicToolsRows: 0,
    removedStage1OutputsRows: 0,
    removedStateLogRows: 0,
    removedLogsRows: 0,
    removedSnapshots: 0,
  };

  await deleteRolloutFiles(plan, result);
  result.removedIndexRows = await rewriteSessionIndex(plan, new Set(targetIds));
  await deleteStateRows(plan, result);
  await deleteLogsRows(plan, result);
  await deleteSnapshots(plan, result);

  return result;
}

async function deleteRolloutFiles(plan: DeletePlan, result: DeleteResult): Promise<void> {
  for (const target of plan.targets) {
    const rolloutPath = target.session.rolloutPath;
    if (!rolloutPath || !target.rolloutExists) {
      continue;
    }

    await fs.rm(rolloutPath, { force: true });
    result.removedRolloutFiles += 1;
    await removeEmptyDirectories(path.dirname(rolloutPath), path.join(plan.root, "sessions"));
  }
}

async function rewriteSessionIndex(plan: DeletePlan, targetIds: Set<string>): Promise<number> {
  const sessionIndexPath = path.join(plan.root, "session_index.jsonl");
  let content: string;
  try {
    content = await fs.readFile(sessionIndexPath, "utf8");
  } catch {
    return 0;
  }

  let removed = 0;
  const keptLines = content
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) {
        return false;
      }

      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.id === "string" && targetIds.has(parsed.id)) {
          removed += 1;
          return false;
        }
      } catch {
        return true;
      }

      return true;
    });

  const nextContent = keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "";
  await fs.writeFile(sessionIndexPath, nextContent, "utf8");
  return removed;
}

async function deleteStateRows(plan: DeletePlan, result: DeleteResult): Promise<void> {
  const stateDbPath = path.join(plan.root, "state_5.sqlite");
  if (!(await fileExists(stateDbPath))) {
    return;
  }
  const db = openDatabase(stateDbPath);
  try {
    const hasThreads = tableExists(db, "threads");
    const hasDynamicTools = tableExists(db, "thread_dynamic_tools");
    const hasStage1Outputs = tableExists(db, "stage1_outputs");
    const hasLogs = tableExists(db, "logs");

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const target of plan.targets) {
        const id = target.session.id;
        if (hasDynamicTools) {
          const changes = db.prepare("DELETE FROM thread_dynamic_tools WHERE thread_id = ?").run(id) as { changes?: number };
          result.removedThreadDynamicToolsRows += changes.changes ?? 0;
        }
        if (hasStage1Outputs) {
          const changes = db.prepare("DELETE FROM stage1_outputs WHERE thread_id = ?").run(id) as { changes?: number };
          result.removedStage1OutputsRows += changes.changes ?? 0;
        }
        if (hasLogs) {
          const changes = db.prepare("DELETE FROM logs WHERE thread_id = ?").run(id) as { changes?: number };
          result.removedStateLogRows += changes.changes ?? 0;
        }
        if (hasThreads) {
          const changes = db.prepare("DELETE FROM threads WHERE id = ?").run(id) as { changes?: number };
          result.removedThreadRows += changes.changes ?? 0;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

async function deleteLogsRows(plan: DeletePlan, result: DeleteResult): Promise<void> {
  const logsDbPath = path.join(plan.root, "logs_1.sqlite");
  if (!(await fileExists(logsDbPath))) {
    return;
  }
  const db = openDatabase(logsDbPath);
  try {
    if (!tableExists(db, "logs")) {
      return;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const target of plan.targets) {
        const changes = db.prepare("DELETE FROM logs WHERE thread_id = ?").run(target.session.id) as { changes?: number };
        result.removedLogsRows += changes.changes ?? 0;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

async function deleteSnapshots(plan: DeletePlan, result: DeleteResult): Promise<void> {
  for (const target of plan.targets) {
    for (const snapshotPath of target.snapshotPaths) {
      await fs.rm(snapshotPath, { force: true });
      result.removedSnapshots += 1;
    }
  }
}

export function parseSelectionInput(input: string, visibleSessions: SessionRecord[]): SessionRecord[] {
  const byIndex = new Map(visibleSessions.map((session) => [String(session.displayIndex), session]));
  const selected = new Map<string, SessionRecord>();

  for (const rawToken of input.split(",")) {
    const token = rawToken.trim();
    if (!token) {
      continue;
    }

    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      const [from, to] = start <= end ? [start, end] : [end, start];
      for (let value = from; value <= to; value += 1) {
        const session = byIndex.get(String(value));
        if (!session) {
          throw new Error(`No session at index ${value}`);
        }
        selected.set(session.id, session);
      }
      continue;
    }

    const bySingleIndex = byIndex.get(token);
    if (bySingleIndex) {
      selected.set(bySingleIndex.id, bySingleIndex);
      continue;
    }

    const byPrefix = visibleSessions.filter(
      (session) => session.displayId === token || session.id === token || session.id.startsWith(token),
    );
    if (byPrefix.length === 1) {
      selected.set(byPrefix[0].id, byPrefix[0]);
      continue;
    }

    if (byPrefix.length > 1) {
      throw new Error(`Selector "${token}" is ambiguous`);
    }

    throw new Error(`Unknown selection "${token}"`);
  }

  return [...selected.values()];
}

export function renderDeletePlan(plan: DeletePlan): string {
  const lines: string[] = ["Delete preview"];
  for (const target of plan.targets) {
    const session = target.session;
    lines.push(`- ${session.displayId} ${session.title}`);
    lines.push(`  rollout: ${session.rolloutPath ?? "none"}`);
    lines.push(`  session_index rows: ${target.indexRows}`);
    lines.push(`  state threads: ${target.threadRowCount}`);
    lines.push(`  state dynamic tools: ${target.threadDynamicToolsCount}`);
    lines.push(`  state stage1 outputs: ${target.stage1OutputsCount}`);
    lines.push(`  state logs: ${target.stateLogsCount}`);
    lines.push(`  logs_1 logs: ${target.logsCount}`);
    lines.push(`  shell snapshots: ${target.snapshotPaths.length}`);
  }
  return lines.join("\n");
}

export const planDelete = planDeletion;
export const executeDelete = executeDeletion;
