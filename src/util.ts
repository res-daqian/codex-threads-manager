import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

export function basenameOrFallback(inputPath?: string): string | undefined {
  if (!inputPath) {
    return undefined;
  }

  const base = path.basename(inputPath);
  return base || inputPath;
}

export function parseTimestamp(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "number") {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  const numeric = Number(value);
  if (!Number.isNaN(numeric) && value.trim() !== "") {
    return parseTimestamp(numeric);
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function formatTimestamp(timestampMs: number | undefined): string {
  if (!timestampMs) {
    return "unknown";
  }

  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function visibleLength(value: string): number {
  return Array.from(value).length;
}

export function truncateText(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }

  if (visibleLength(value) <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return ".".repeat(maxLength);
  }

  let truncated = "";
  for (const char of Array.from(value)) {
    if (visibleLength(truncated) + 1 > maxLength - 3) {
      break;
    }
    truncated += char;
  }

  return `${truncated}...`;
}

export function sortSessionsByUpdatedAtDesc<T extends { updatedAtMs?: number; id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const delta = (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0);
    if (delta !== 0) {
      return delta;
    }
    return left.id.localeCompare(right.id);
  });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectoryExists(directoryPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(directoryPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursively(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

export async function readLines(filePath: string): Promise<string[]> {
  const content = await fs.readFile(filePath, "utf8");
  return content.split(/\r?\n/);
}

export async function removeEmptyDirectories(startDirectory: string, stopDirectory: string): Promise<void> {
  let current = startDirectory;
  const normalizedStop = path.resolve(stopDirectory);

  while (path.resolve(current).startsWith(normalizedStop) && path.resolve(current) !== normalizedStop) {
    let entries: string[];
    try {
      entries = await fs.readdir(current);
    } catch {
      return;
    }

    if (entries.length > 0) {
      return;
    }

    await fs.rmdir(current);
    current = path.dirname(current);
  }
}

export function sqliteQuery<T extends Record<string, unknown>>(
  dbPath: string,
  sql: string,
  options: { readonly?: boolean } = {},
): T[] {
  const args = [];
  if (options.readonly ?? true) {
    args.push("-readonly");
  }
  args.push("-json", dbPath, sql);

  const result = spawnSync("sqlite3", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `sqlite3 query failed for ${dbPath}`);
  }

  const output = result.stdout.trim();
  if (!output) {
    return [];
  }

  return JSON.parse(output) as T[];
}

export function sqliteExec(
  dbPath: string,
  statements: string[],
  options: { readonly?: boolean } = {},
): void {
  const args = [];
  if (options.readonly ?? false) {
    args.push("-readonly");
  }
  args.push(dbPath);

  const result = spawnSync("sqlite3", args, {
    encoding: "utf8",
    input: `${statements.join("\n")}\n`,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `sqlite3 exec failed for ${dbPath}`);
  }
}

export function tableExists(dbPath: string, tableName: string): boolean {
  const rows = sqliteQuery<{ present?: number }>(
    dbPath,
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '${tableName.replaceAll("'", "''")}'`,
  );
  return rows[0]?.present === 1;
}
