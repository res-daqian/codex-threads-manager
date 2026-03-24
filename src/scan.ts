import path from "node:path";
import {
  basenameOrFallback,
  ensureDirectoryExists,
  expandHome,
  fileExists,
  formatTimestamp,
  listFilesRecursively,
  openDatabase,
  parseTimestamp,
  readLines,
  sortSessionsByUpdatedAtDesc,
  tableExists,
} from "./util.ts";
import { computeShortestUniquePrefixes } from "./ids.ts";
import type {
  CodexPaths,
  RolloutInfo,
  ScanResult,
  SessionIndexEntry,
  SessionPresence,
  SessionRecord,
  ThreadStateRow,
} from "./types.ts";

interface ScanMaps {
  rollouts: Map<string, RolloutInfo>;
  indexEntries: Map<string, SessionIndexEntry[]>;
  stateRows: Map<string, ThreadStateRow>;
  stateLogCounts: Map<string, number>;
  logsCounts: Map<string, number>;
  snapshotPaths: Map<string, string[]>;
}

export function buildCodexPaths(rootInput = "~/.codex"): CodexPaths {
  const root = path.resolve(expandHome(rootInput));
  return {
    root,
    sessionsDir: path.join(root, "sessions"),
    sessionIndexPath: path.join(root, "session_index.jsonl"),
    stateDbPath: path.join(root, "state_5.sqlite"),
    logsDbPath: path.join(root, "logs_1.sqlite"),
    snapshotsDir: path.join(root, "shell_snapshots"),
  };
}

export async function scanCodexRoot(rootInput = "~/.codex"): Promise<ScanResult> {
  const paths = buildCodexPaths(rootInput);
  const maps = await collectScanMaps(paths);

  const allIds = new Set<string>([
    ...maps.rollouts.keys(),
    ...maps.indexEntries.keys(),
    ...maps.stateRows.keys(),
    ...maps.stateLogCounts.keys(),
    ...maps.logsCounts.keys(),
    ...maps.snapshotPaths.keys(),
  ]);

  const prefixMap = computeShortestUniquePrefixes([...allIds]);

  const sessions = sortSessionsByUpdatedAtDesc(
    [...allIds].map((id) => buildSessionRecord(id, maps, prefixMap)),
  ).map((session, index) => ({
    ...session,
    displayIndex: index + 1,
  }));

  return {
    paths,
    sessions,
    byId: new Map(sessions.map((session) => [session.id, session])),
  };
}

export const scan = scanCodexRoot;

async function collectScanMaps(paths: CodexPaths): Promise<ScanMaps> {
  const [rollouts, indexEntries, stateRows, stateLogCounts, logsCounts, snapshotPaths] = await Promise.all([
    scanRollouts(paths.sessionsDir),
    scanSessionIndex(paths.sessionIndexPath),
    scanStateRows(paths.stateDbPath),
    scanLogCounts(paths.stateDbPath, "logs"),
    scanLogCounts(paths.logsDbPath, "logs"),
    scanSnapshots(paths.snapshotsDir),
  ]);

  return { rollouts, indexEntries, stateRows, stateLogCounts, logsCounts, snapshotPaths };
}

async function scanRollouts(sessionsDir: string): Promise<Map<string, RolloutInfo>> {
  const results = new Map<string, RolloutInfo>();
  if (!(await ensureDirectoryExists(sessionsDir))) {
    return results;
  }

  const files = (await listFilesRecursively(sessionsDir))
    .filter((filePath) => filePath.endsWith(".jsonl"))
    .sort();

  for (const filePath of files) {
    const lines = await readLines(filePath);
    const firstLine = lines.find((line) => line.trim() !== "");
    if (!firstLine) {
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      continue;
    }

    const payload = parsed?.payload ?? {};
    const source = payload.source;
    const sourceLabel = typeof source === "string"
      ? source
      : (source && typeof source === "object" ? Object.keys(source)[0] : undefined);

    const parentThreadId = typeof source?.subagent?.thread_spawn?.parent_thread_id === "string"
      ? source.subagent.thread_spawn.parent_thread_id
      : undefined;
    const depth = Number.isInteger(source?.subagent?.thread_spawn?.depth)
      ? source.subagent.thread_spawn.depth
      : undefined;

    const relative = path.relative(sessionsDir, filePath).split(path.sep);
    const [year, month, day] = relative;
    const id = typeof payload.id === "string"
      ? payload.id
      : extractIdFromRolloutPath(filePath);

    if (!id) {
      continue;
    }

    results.set(id, {
      id,
      path: filePath,
      sessionTimestamp: typeof payload.timestamp === "string" ? payload.timestamp : undefined,
      sessionTimestampMs: parseTimestamp(payload.timestamp),
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      originator: typeof payload.originator === "string" ? payload.originator : undefined,
      sourceLabel,
      modelProvider: typeof payload.model_provider === "string" ? payload.model_provider : undefined,
      cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
      agentNickname: typeof payload.agent_nickname === "string" ? payload.agent_nickname : undefined,
      agentRole: typeof payload.agent_role === "string" ? payload.agent_role : undefined,
      parentThreadId,
      depth,
      year,
      month,
      day,
    });
  }

  return results;
}

function extractIdFromRolloutPath(filePath: string): string | undefined {
  const base = path.basename(filePath);
  const match = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(base);
  return match?.[1];
}

async function scanSessionIndex(sessionIndexPath: string): Promise<Map<string, SessionIndexEntry[]>> {
  const results = new Map<string, SessionIndexEntry[]>();
  if (!(await fileExists(sessionIndexPath))) {
    return results;
  }

  const lines = await readLines(sessionIndexPath);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof parsed.id !== "string") {
      continue;
    }

    const entry: SessionIndexEntry = {
      id: parsed.id,
      threadName: typeof parsed.thread_name === "string" ? parsed.thread_name : undefined,
      updatedAt: typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
      updatedAtMs: parseTimestamp(parsed.updated_at),
    };

    const bucket = results.get(parsed.id) ?? [];
    bucket.push(entry);
    results.set(parsed.id, bucket);
  }

  return results;
}

async function scanStateRows(stateDbPath: string): Promise<Map<string, ThreadStateRow>> {
  const results = new Map<string, ThreadStateRow>();
  if (!(await fileExists(stateDbPath))) {
    return results;
  }

  const db = openDatabase(stateDbPath);
  try {
    if (!tableExists(db, "threads")) {
      return results;
    }

    const rows = db.prepare(`
      SELECT
        id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        sandbox_policy,
        approval_mode,
        tokens_used,
        has_user_event,
        archived,
        archived_at,
        git_sha,
        git_branch,
        git_origin_url,
        cli_version,
        first_user_message,
        agent_nickname,
        agent_role,
        memory_mode,
        model,
        reasoning_effort
      FROM threads
    `).all() as Array<Record<string, any>>;

    for (const row of rows) {
      results.set(row.id, {
        id: row.id,
        rolloutPath: row.rollout_path ?? undefined,
        createdAt: typeof row.created_at === "number" ? row.created_at : undefined,
        updatedAt: typeof row.updated_at === "number" ? row.updated_at : undefined,
        source: row.source ?? undefined,
        modelProvider: row.model_provider ?? undefined,
        cwd: row.cwd ?? undefined,
        title: row.title ?? undefined,
        sandboxPolicy: row.sandbox_policy ?? undefined,
        approvalMode: row.approval_mode ?? undefined,
        tokensUsed: row.tokens_used ?? undefined,
        hasUserEvent: Boolean(row.has_user_event),
        archived: Boolean(row.archived),
        archivedAt: row.archived_at ?? undefined,
        gitSha: row.git_sha ?? undefined,
        gitBranch: row.git_branch ?? undefined,
        gitOriginUrl: row.git_origin_url ?? undefined,
        cliVersion: row.cli_version ?? undefined,
        firstUserMessage: row.first_user_message ?? undefined,
        agentNickname: row.agent_nickname ?? undefined,
        agentRole: row.agent_role ?? undefined,
        memoryMode: row.memory_mode ?? undefined,
        model: row.model ?? undefined,
        reasoningEffort: row.reasoning_effort ?? undefined,
      });
    }
  } finally {
    db.close();
  }

  return results;
}

async function scanLogCounts(dbPath: string, tableName: string): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  if (!(await fileExists(dbPath))) {
    return results;
  }

  const db = openDatabase(dbPath);
  try {
    if (!tableExists(db, tableName)) {
      return results;
    }

    const rows = db
      .prepare(`SELECT thread_id, COUNT(*) AS count FROM ${tableName} WHERE thread_id IS NOT NULL GROUP BY thread_id`)
      .all() as Array<{ thread_id?: string; count?: number }>;

    for (const row of rows) {
      if (typeof row.thread_id === "string") {
        results.set(row.thread_id, row.count ?? 0);
      }
    }
  } finally {
    db.close();
  }

  return results;
}

async function scanSnapshots(snapshotsDir: string): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();
  if (!(await ensureDirectoryExists(snapshotsDir))) {
    return results;
  }

  const files = (await listFilesRecursively(snapshotsDir)).sort();
  for (const filePath of files) {
    const base = path.basename(filePath);
    const match = /^([0-9a-f]{8}-[0-9a-f-]{27})\./i.exec(base);
    if (!match) {
      continue;
    }

    const bucket = results.get(match[1]) ?? [];
    bucket.push(filePath);
    results.set(match[1], bucket);
  }

  return results;
}

function buildSessionRecord(
  id: string,
  maps: ScanMaps,
  prefixMap: Map<string, string>,
): SessionRecord {
  const rollout = maps.rollouts.get(id);
  const indexEntries = sortIndexEntries(maps.indexEntries.get(id) ?? []);
  const latestIndex = indexEntries[0];
  const stateRow = maps.stateRows.get(id);
  const snapshotPaths = [...(maps.snapshotPaths.get(id) ?? [])];
  const updatedAtMs = pickFirstNumber(
    stateRow?.updatedAt ? stateRow.updatedAt * 1000 : undefined,
    latestIndex?.updatedAtMs,
    rollout?.sessionTimestampMs,
  );
  const createdAtMs = pickFirstNumber(
    stateRow?.createdAt ? stateRow.createdAt * 1000 : undefined,
    rollout?.sessionTimestampMs,
  );
  const title = pickFirstString(
    latestIndex?.threadName,
    stateRow?.title,
    stateRow?.firstUserMessage,
    basenameOrFallback(rollout?.cwd),
    basenameOrFallback(rollout?.path),
    "Untitled session",
  );
  const sourceLabel = pickFirstString(stateRow?.source, rollout?.sourceLabel, rollout?.originator);
  const cwd = pickFirstString(stateRow?.cwd, rollout?.cwd);
  const presence: SessionPresence = {
    rollout: Boolean(rollout),
    index: indexEntries.length > 0,
    state: Boolean(stateRow),
    stateLogs: (maps.stateLogCounts.get(id) ?? 0) > 0,
    logs: (maps.logsCounts.get(id) ?? 0) > 0,
    snapshots: snapshotPaths.length > 0,
  };

  const issues: string[] = [];
  if (!presence.rollout && (presence.index || presence.state || presence.logs || presence.snapshots || presence.stateLogs)) {
    issues.push("missing rollout file");
  }
  if (!presence.state && presence.rollout) {
    issues.push("missing state row");
  }
  if (!presence.index && presence.rollout) {
    issues.push("missing session_index row");
  }
  if (indexEntries.length > 1) {
    issues.push(`duplicate session_index rows (${indexEntries.length})`);
  }
  if (rollout?.parentThreadId && !maps.rollouts.has(rollout.parentThreadId) && !maps.stateRows.has(rollout.parentThreadId)) {
    issues.push(`missing parent ${rollout.parentThreadId}`);
  }

  return {
    id,
    displayId: prefixMap.get(id) ?? id,
    displayIndex: 0,
    title,
    updatedAtMs,
    createdAtMs,
    updatedAtLabel: formatTimestamp(updatedAtMs),
    createdAtLabel: createdAtMs ? formatTimestamp(createdAtMs) : undefined,
    cwd,
    cwdBase: basenameOrFallback(cwd),
    sourceLabel,
    originator: rollout?.originator,
    modelProvider: pickFirstString(stateRow?.modelProvider, rollout?.modelProvider),
    cliVersion: pickFirstString(stateRow?.cliVersion, rollout?.cliVersion),
    archived: Boolean(stateRow?.archived),
    parentThreadId: rollout?.parentThreadId,
    depth: rollout?.depth,
    rolloutPath: pickFirstString(rollout?.path, stateRow?.rolloutPath),
    snapshotPaths,
    indexEntries,
    stateRow,
    presence,
    storeCounts: {
      stateLogs: maps.stateLogCounts.get(id) ?? 0,
      logs: maps.logsCounts.get(id) ?? 0,
    },
    issues,
    rollout,
  };
}

function pickFirstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim() !== "");
}

function pickFirstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => typeof value === "number" && !Number.isNaN(value));
}

function sortIndexEntries(entries: SessionIndexEntry[]): SessionIndexEntry[] {
  return [...entries].sort((left, right) => {
    const delta = (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0);
    if (delta !== 0) {
      return delta;
    }
    return (left.threadName ?? "").localeCompare(right.threadName ?? "");
  });
}
