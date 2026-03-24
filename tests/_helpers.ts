import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-thread-manager-"));
  try {
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function ensureDir(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

export async function writeText(filePath: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, contents, "utf8");
}

export async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await writeText(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

export async function readJsonl(filePath: string): Promise<any[]> {
  const contents = await readFile(filePath, "utf8");
  return contents
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

export function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function runSqlite(dbPath: string, statements: string[]): void {
  const result = spawnSync("sqlite3", [dbPath], {
    encoding: "utf8",
    input: `${statements.join("\n")}\n`,
  });

  assert.equal(
    result.status,
    0,
    `sqlite3 failed for ${dbPath}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
}

export function createStateDb(
  dbPath: string,
  options: {
    threads?: Array<{
      id: string;
      rolloutPath: string;
      createdAt: number;
      updatedAt: number;
      source?: string;
      modelProvider?: string;
      cwd?: string;
      title?: string;
      cliVersion?: string;
    }>;
    logs?: Array<{ threadId: string; count: number }>;
    dynamicTools?: Array<{ threadId: string; count: number }>;
    stage1Outputs?: Array<{ threadId: string; count: number }>;
  } = {},
): void {
  const statements = [
    "PRAGMA journal_mode=DELETE;",
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL DEFAULT 'workspace-write',
      approval_mode TEXT NOT NULL DEFAULT 'on-request',
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled',
      model TEXT,
      reasoning_effort TEXT
    );`,
    "CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, message TEXT);",
    "CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, input_schema TEXT NOT NULL, defer_loading INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(thread_id, position));",
    "CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, source_updated_at INTEGER NOT NULL, raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, generated_at INTEGER NOT NULL);",
  ];

  for (const thread of options.threads ?? []) {
    statements.push(
      `INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, cli_version
      ) VALUES (
        ${sqlQuote(thread.id)},
        ${sqlQuote(thread.rolloutPath)},
        ${thread.createdAt},
        ${thread.updatedAt},
        ${sqlQuote(thread.source ?? "cli")},
        ${sqlQuote(thread.modelProvider ?? "openai")},
        ${sqlQuote(thread.cwd ?? "/tmp")},
        ${sqlQuote(thread.title ?? "")},
        ${sqlQuote(thread.cliVersion ?? "0.116.0")}
      );`,
    );
  }

  for (const log of options.logs ?? []) {
    for (let index = 0; index < log.count; index += 1) {
      statements.push(
        `INSERT INTO logs (thread_id, message) VALUES (${sqlQuote(log.threadId)}, ${sqlQuote(`log-${index}`)});`,
      );
    }
  }

  for (const tool of options.dynamicTools ?? []) {
    for (let index = 0; index < tool.count; index += 1) {
      statements.push(
        `INSERT INTO thread_dynamic_tools (thread_id, position, name, description, input_schema) VALUES (${sqlQuote(tool.threadId)}, ${index}, ${sqlQuote(`tool-${index}`)}, ${sqlQuote("desc")}, ${sqlQuote("{}")});`,
      );
    }
  }

  for (const output of options.stage1Outputs ?? []) {
    statements.push(
      `INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, generated_at) VALUES (${sqlQuote(output.threadId)}, 1, ${sqlQuote("raw")}, ${sqlQuote("summary")}, 1);`,
    );
  }

  runSqlite(dbPath, statements);
}

export function createLogsDb(dbPath: string, logs: Array<{ threadId: string; count: number }>): void {
  const statements = [
    "PRAGMA journal_mode=DELETE;",
    "CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, feedback_log_body TEXT);",
  ];

  for (const log of logs) {
    for (let index = 0; index < log.count; index += 1) {
      statements.push(
        `INSERT INTO logs (thread_id, feedback_log_body) VALUES (${sqlQuote(log.threadId)}, ${sqlQuote(`feedback-${index}`)});`,
      );
    }
  }

  runSqlite(dbPath, statements);
}

export async function createRollout(
  codexRoot: string,
  options: {
    id: string;
    year: string;
    month: string;
    day: string;
    timestamp: string;
    cwd: string;
    source?: string | Record<string, unknown>;
    originator?: string;
    modelProvider?: string;
    cliVersion?: string;
  },
): Promise<string> {
  const rolloutPath = path.join(
    codexRoot,
    "sessions",
    options.year,
    options.month,
    options.day,
    `rollout-${options.timestamp.replaceAll(":", "-")}-${options.id}.jsonl`,
  );

  await writeJsonl(rolloutPath, [
    {
      timestamp: options.timestamp,
      type: "session_meta",
      payload: {
        id: options.id,
        timestamp: options.timestamp,
        cwd: options.cwd,
        originator: options.originator ?? "codex_cli_rs",
        cli_version: options.cliVersion ?? "0.116.0",
        source: options.source ?? "cli",
        model_provider: options.modelProvider ?? "openai",
      },
    },
  ]);

  return rolloutPath;
}
