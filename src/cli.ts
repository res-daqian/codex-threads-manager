#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { resolveSessionSelectors } from "./ids.ts";
import { scanCodexRoot } from "./scan.ts";
import { executeDeletion, parseSelectionInput, planDeletion, renderDeletePlan } from "./delete.ts";
import { renderSessionTree } from "./tree.ts";
import type { MetadataMode, TreeMode } from "./types.ts";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "list":
      await runList(rest);
      return;
    case "show":
      await runShow(rest);
      return;
    case "delete":
      await runDelete(rest);
      return;
    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

async function runList(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      root: { type: "string", default: "~/.codex" },
      tree: { type: "string", default: "date" },
      metadata: { type: "string", default: "compact" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printListHelp();
    return;
  }

  const treeMode = assertTreeMode(values.tree);
  const metadataMode = assertMetadataMode(values.metadata);
  const scan = await scanCodexRoot(values.root);
  const rendered = renderSessionTree(scan.sessions, {
    treeMode,
    metadataMode,
    includeStale: values.all,
    width: process.stdout.columns,
  });
  console.log(rendered.text);
}

async function runShow(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string", default: "~/.codex" },
      help: { type: "boolean", default: false },
    },
  });

  if (parsed.values.help) {
    printShowHelp();
    return;
  }

  const selector = parsed.positionals[0];
  if (!selector) {
    throw new Error("show requires an id or prefix");
  }

  const scan = await scanCodexRoot(parsed.values.root);
  const [session] = resolveSessionSelectors(scan.sessions, [selector]);
  const output = {
    id: session.id,
    displayId: session.displayId,
    title: session.title,
    updatedAt: session.updatedAtLabel,
    createdAt: session.createdAtLabel ?? "unknown",
    cwd: session.cwd ?? "unknown",
    source: session.sourceLabel ?? "unknown",
    originator: session.originator ?? "unknown",
    modelProvider: session.modelProvider ?? "unknown",
    cliVersion: session.cliVersion ?? "unknown",
    archived: session.archived,
    parentThreadId: session.parentThreadId ?? null,
    rolloutPath: session.rolloutPath ?? null,
    snapshotPaths: session.snapshotPaths,
    presence: session.presence,
    storeCounts: session.storeCounts,
    issues: session.issues,
    indexEntries: session.indexEntries,
    stateRow: session.stateRow ?? null,
  };
  console.log(JSON.stringify(output, null, 2));
}

async function runDelete(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      dryRun: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      root: { type: "string", default: "~/.codex" },
      tree: { type: "string", default: "date" },
      help: { type: "boolean", default: false },
    },
  });

  if (parsed.values.help) {
    printDeleteHelp();
    return;
  }

  const treeMode = assertTreeMode(parsed.values.tree);
  const scan = await scanCodexRoot(parsed.values.root);
  const targets = parsed.positionals.length > 0
    ? resolveSessionSelectors(scan.sessions, parsed.positionals)
    : await selectSessionsInteractively(scan.sessions, treeMode, parsed.values.all);

  if (targets.length === 0) {
    throw new Error("No sessions selected");
  }

  const plan = await planDeletion(scan, targets, process.env.CODEX_THREAD_ID);
  const preview = renderDeletePlan(plan);
  console.log(preview);

  if (parsed.values.dryRun) {
    return;
  }

  if (!parsed.values.yes) {
    const confirmed = await confirmDeletion(plan.targets.length);
    if (!confirmed) {
      console.log("Deletion cancelled.");
      return;
    }
  }

  const result = await executeDeletion(plan);
  console.log("");
  console.log("Deleted successfully.");
  console.log(JSON.stringify(result, null, 2));
}

async function selectSessionsInteractively(
  sessions: Awaited<ReturnType<typeof scanCodexRoot>>["sessions"],
  treeMode: TreeMode,
  includeStale: boolean,
) {
  const rendered = renderSessionTree(sessions, {
    treeMode,
    metadataMode: "compact",
    includeStale,
    width: process.stdout.columns,
  });
  console.log(rendered.text);
  console.log("");
  console.log("Enter indexes, prefixes, or ranges separated by commas. Example: 1-3,7,019d1f8c");

  const input = await prompt("Select sessions to delete: ");
  return parseSelectionInput(input, rendered.orderedSessions);
}

async function confirmDeletion(count: number): Promise<boolean> {
  const answer = await prompt(`Type "delete" to permanently remove ${count} session(s): `);
  return answer.trim().toLowerCase() === "delete";
}

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY. Pass ids explicitly or use --yes.");
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function assertTreeMode(value: string): TreeMode {
  if (value === "date" || value === "fork") {
    return value;
  }
  throw new Error(`Invalid --tree value "${value}"`);
}

function assertMetadataMode(value: string): MetadataMode {
  if (value === "compact" || value === "none") {
    return value;
  }
  throw new Error(`Invalid --metadata value "${value}"`);
}

function printHelp(): void {
  console.log(`codex-thread-manager

Usage:
  codex-thread-manager list [--tree date|fork] [--all] [--metadata compact|none] [--root <path>]
  codex-thread-manager show <id-or-prefix> [--root <path>]
  codex-thread-manager delete [<id-or-prefix>...] [--all] [--tree date|fork] [--dry-run] [--yes] [--root <path>]
`);
}

function printListHelp(): void {
  console.log("Usage: codex-thread-manager list [--tree date|fork] [--all] [--metadata compact|none] [--root <path>]");
}

function printShowHelp(): void {
  console.log("Usage: codex-thread-manager show <id-or-prefix> [--root <path>]");
}

function printDeleteHelp(): void {
  console.log("Usage: codex-thread-manager delete [<id-or-prefix>...] [--all] [--tree date|fork] [--dry-run] [--yes] [--root <path>]");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
