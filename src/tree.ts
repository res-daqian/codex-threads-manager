import { truncateText, visibleLength } from "./util.ts";
import { sortSessionsByUpdatedAtDesc } from "./util.ts";
import type { RenderOptions, RenderResult, SessionRecord } from "./types.ts";

interface TreeNode {
  label: string;
  session?: SessionRecord;
  children: TreeNode[];
}

export function renderSessionTree(sessions: SessionRecord[], options: RenderOptions): RenderResult {
  const visibleSessions = sessions.filter((session) => session.presence.rollout);
  const staleSessions = sessions.filter((session) => !session.presence.rollout);
  const orderedSessions = collectRenderedOrder(visibleSessions, staleSessions, options);
  const indexMap = new Map(orderedSessions.map((session, index) => [session.id, index + 1]));

  let text = "";
  if (options.treeMode === "fork") {
    const root = buildForkTree(visibleSessions);
    text += renderRootNode(root, orderedSessions, options, indexMap);
  } else {
    const root = buildDateTree(visibleSessions);
    text += renderRootNode(root, orderedSessions, options, indexMap);
  }

  if (options.includeStale && staleSessions.length > 0) {
    if (text) {
      text += "\n";
    }
    const staleRoot = buildStaleTree(staleSessions);
    text += renderRootNode(staleRoot, [], options, indexMap);
  }

  return {
    text: text.trimEnd(),
    orderedSessions,
  };
}

function buildDateTree(sessions: SessionRecord[]): TreeNode {
  const root: TreeNode = { label: "sessions", children: [] };
  const byYear = new Map<string, Map<string, Map<string, SessionRecord[]>>>();

  for (const session of sessions) {
    const year = session.rollout?.year ?? "unknown";
    const month = session.rollout?.month ?? "unknown";
    const day = session.rollout?.day ?? "unknown";
    const months = byYear.get(year) ?? new Map<string, Map<string, SessionRecord[]>>();
    const days = months.get(month) ?? new Map<string, SessionRecord[]>();
    const bucket = days.get(day) ?? [];
    bucket.push(session);
    days.set(day, bucket);
    months.set(month, days);
    byYear.set(year, months);
  }

  for (const year of sortNumericLike([...byYear.keys()])) {
    const yearNode: TreeNode = { label: year, children: [] };
    const months = byYear.get(year)!;
    for (const month of sortNumericLike([...months.keys()])) {
      const monthNode: TreeNode = { label: month, children: [] };
      const days = months.get(month)!;
      for (const day of sortNumericLike([...days.keys()])) {
        const dayNode: TreeNode = { label: day, children: [] };
        for (const session of sortSessionsByUpdatedAtDesc(days.get(day)!)) {
          dayNode.children.push({ label: "", session, children: [] });
        }
        monthNode.children.push(dayNode);
      }
      yearNode.children.push(monthNode);
    }
    root.children.push(yearNode);
  }

  return root;
}

function buildForkTree(sessions: SessionRecord[]): TreeNode {
  const root: TreeNode = { label: "sessions", children: [] };
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const childrenByParent = new Map<string, SessionRecord[]>();
  const unlinked: SessionRecord[] = [];
  const roots: SessionRecord[] = [];

  for (const session of sessions) {
    if (!session.parentThreadId) {
      roots.push(session);
      continue;
    }

    if (!byId.has(session.parentThreadId)) {
      unlinked.push(session);
      continue;
    }

    const bucket = childrenByParent.get(session.parentThreadId) ?? [];
    bucket.push(session);
    childrenByParent.set(session.parentThreadId, bucket);
  }

  for (const session of sortSessionsByUpdatedAtDesc(roots)) {
    root.children.push(buildForkSessionNode(session, childrenByParent));
  }

  if (unlinked.length > 0) {
    const unlinkedNode: TreeNode = { label: "unlinked", children: [] };
    for (const session of sortSessionsByUpdatedAtDesc(unlinked)) {
      unlinkedNode.children.push({ label: "", session, children: [] });
    }
    root.children.push(unlinkedNode);
  }

  return root;
}

function buildForkSessionNode(session: SessionRecord, childrenByParent: Map<string, SessionRecord[]>): TreeNode {
  const node: TreeNode = { label: "", session, children: [] };
  for (const child of sortSessionsByUpdatedAtDesc(childrenByParent.get(session.id) ?? [])) {
    node.children.push(buildForkSessionNode(child, childrenByParent));
  }
  return node;
}

function buildStaleTree(sessions: SessionRecord[]): TreeNode {
  const root: TreeNode = { label: "inconsistent records", children: [] };
  for (const session of sortSessionsByUpdatedAtDesc(sessions)) {
    root.children.push({ label: "", session, children: [] });
  }
  return root;
}

function renderRootNode(
  node: TreeNode,
  orderedSessions: SessionRecord[],
  options: RenderOptions,
  indexMap: Map<string, number>,
): string {
  let text = `${node.label}\n`;
  node.children.forEach((child, index) => {
    text += renderTreeNode(child, "", index === node.children.length - 1, orderedSessions, options, indexMap);
  });
  return text;
}

function renderTreeNode(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  orderedSessions: SessionRecord[],
  options: RenderOptions,
  indexMap: Map<string, number>,
): string {
  const connector = isLast ? "└── " : "├── ";
  const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
  const label = node.session
    ? formatSessionLine(node.session, options, indexMap, visibleLength(prefix) + visibleLength(connector))
    : node.label;
  let text = `${prefix}${connector}${label}\n`;

  if (node.session) {
    if (!orderedSessions.some((session) => session.id === node.session?.id)) {
      orderedSessions.push(node.session);
    }
  }

  node.children.forEach((child, index) => {
    text += renderTreeNode(child, childPrefix, index === node.children.length - 1, orderedSessions, options, indexMap);
  });

  return text;
}

function formatSessionLine(
  session: SessionRecord,
  options: RenderOptions,
  indexMap: Map<string, number>,
  treePrefixLength: number,
): string {
  const indicator = `[${String(indexMap.get(session.id) ?? session.displayIndex).padStart(2, "0")}]`;
  const idPart = session.displayId;
  if (options.metadataMode === "none") {
    return `${indicator} ${idPart} ${session.title}`;
  }

  const source = session.sourceLabel ?? "-";
  const cwd = session.cwdBase ?? "-";
  const archived = session.archived ? " archived" : "";
  const issues = session.issues.length > 0 ? ` !${session.issues.length}` : "";
  const prefix = `${indicator} ${idPart} ${session.updatedAtLabel} ${source} ${cwd}${archived}${issues}`;

  const width = Math.max(40, options.width ?? 120);
  const availableForTitle = Math.max(16, width - treePrefixLength - visibleLength(prefix) - 3);
  const title = truncateText(session.title, availableForTitle);
  return `${prefix} ${title}`;
}

function sortNumericLike(values: string[]): string[] {
  return [...values].sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
}

function collectRenderedOrder(
  visibleSessions: SessionRecord[],
  staleSessions: SessionRecord[],
  options: RenderOptions,
): SessionRecord[] {
  const ordered: SessionRecord[] = [];
  const walk = (node: TreeNode) => {
    if (node.session) {
      ordered.push(node.session);
    }
    for (const child of node.children) {
      walk(child);
    }
  };

  walk(options.treeMode === "fork" ? buildForkTree(visibleSessions) : buildDateTree(visibleSessions));
  if (options.includeStale && staleSessions.length > 0) {
    walk(buildStaleTree(staleSessions));
  }

  return ordered;
}

export const renderTree = renderSessionTree;
