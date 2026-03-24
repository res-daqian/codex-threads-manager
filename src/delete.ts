import path from "node:path";
import { promises as fs } from "node:fs";
import { fileExists, removeEmptyDirectories, sqliteExec, sqliteQuery, tableExists } from "./util.ts";
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

  try {
    const hasThreads = tableExists(dbPath, "threads");
    const hasDynamicTools = tableExists(dbPath, "thread_dynamic_tools");
    const hasStage1Outputs = tableExists(dbPath, "stage1_outputs");
    const hasLogs = tableExists(dbPath, "logs");

    for (const id of ids) {
      details.set(id, {
        threadRowCount: hasThreads ? countRows(dbPath, "threads", "id", id) : 0,
        threadDynamicToolsCount: hasDynamicTools ? countRows(dbPath, "thread_dynamic_tools", "thread_id", id) : 0,
        stage1OutputsCount: hasStage1Outputs ? countRows(dbPath, "stage1_outputs", "thread_id", id) : 0,
        stateLogsCount: hasLogs ? countRows(dbPath, "logs", "thread_id", id) : 0,
      });
    }
  } catch {
    for (const id of ids) {
      details.set(id, {
        threadRowCount: 0,
        threadDynamicToolsCount: 0,
        stage1OutputsCount: 0,
        stateLogsCount: 0,
      });
    }
  }

  return details;
}

async function collectLogsDeletionDetails(dbPath: string, ids: string[]): Promise<Map<string, number>> {
  const details = new Map<string, number>();
  if (!(await fileExists(dbPath))) {
    return details;
  }

  try {
    const hasLogs = tableExists(dbPath, "logs");
    for (const id of ids) {
      details.set(id, hasLogs ? countRows(dbPath, "logs", "thread_id", id) : 0);
    }
  } catch {
    for (const id of ids) {
      details.set(id, 0);
    }
  }
  return details;
}

function countRows(dbPath: string, tableName: string, columnName: string, value: string): number {
  const escapedValue = value.replaceAll("'", "''");
  const row = sqliteQuery<{ count?: number }>(
    dbPath,
    `SELECT COUNT(*) AS count FROM ${tableName} WHERE ${columnName} = '${escapedValue}'`,
  )[0];
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
  const hasThreads = tableExists(stateDbPath, "threads");
  const hasDynamicTools = tableExists(stateDbPath, "thread_dynamic_tools");
  const hasStage1Outputs = tableExists(stateDbPath, "stage1_outputs");
  const hasLogs = tableExists(stateDbPath, "logs");

  const statements = ["PRAGMA foreign_keys = ON;", "BEGIN IMMEDIATE;"];
  for (const target of plan.targets) {
    const escapedId = target.session.id.replaceAll("'", "''");
    if (hasDynamicTools) {
      statements.push(`DELETE FROM thread_dynamic_tools WHERE thread_id = '${escapedId}';`);
      result.removedThreadDynamicToolsRows += target.threadDynamicToolsCount;
    }
    if (hasStage1Outputs) {
      statements.push(`DELETE FROM stage1_outputs WHERE thread_id = '${escapedId}';`);
      result.removedStage1OutputsRows += target.stage1OutputsCount;
    }
    if (hasLogs) {
      statements.push(`DELETE FROM logs WHERE thread_id = '${escapedId}';`);
      result.removedStateLogRows += target.stateLogsCount;
    }
    if (hasThreads) {
      statements.push(`DELETE FROM threads WHERE id = '${escapedId}';`);
      result.removedThreadRows += target.threadRowCount;
    }
  }
  statements.push("COMMIT;");
  sqliteExec(stateDbPath, statements);
}

async function deleteLogsRows(plan: DeletePlan, result: DeleteResult): Promise<void> {
  const logsDbPath = path.join(plan.root, "logs_1.sqlite");
  if (!(await fileExists(logsDbPath))) {
    return;
  }
  if (!tableExists(logsDbPath, "logs")) {
    return;
  }

  const statements = ["BEGIN IMMEDIATE;"];
  for (const target of plan.targets) {
    const escapedId = target.session.id.replaceAll("'", "''");
    statements.push(`DELETE FROM logs WHERE thread_id = '${escapedId}';`);
    result.removedLogsRows += target.logsCount;
  }
  statements.push("COMMIT;");
  sqliteExec(logsDbPath, statements);
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
