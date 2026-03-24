import type { SessionRecord } from "./types.ts";

export function computeShortestUniquePrefixes(ids: string[], minimumLength = 8): Map<string, string> {
  const uniqueIds = [...new Set(ids)];
  const prefixes = new Map<string, string>();

  for (const id of uniqueIds) {
    let length = Math.min(minimumLength, id.length);
    while (length <= id.length) {
      const prefix = id.slice(0, length);
      const matches = uniqueIds.filter((candidate) => candidate.startsWith(prefix));
      if (matches.length === 1) {
        prefixes.set(id, prefix);
        break;
      }
      length += 1;
    }

    if (!prefixes.has(id)) {
      prefixes.set(id, id);
    }
  }

  return prefixes;
}

export function resolveSessionSelector(sessions: SessionRecord[], selector: string): SessionRecord {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("Empty selector");
  }

  const exact = sessions.find((session) => session.id === trimmed);
  if (exact) {
    return exact;
  }

  const byDisplayId = sessions.filter((session) => session.displayId === trimmed);
  if (byDisplayId.length === 1) {
    return byDisplayId[0];
  }

  const byPrefix = sessions.filter((session) => session.id.startsWith(trimmed));
  if (byPrefix.length === 1) {
    return byPrefix[0];
  }

  if (byPrefix.length > 1) {
    throw new Error(`Selector "${trimmed}" is ambiguous`);
  }

  throw new Error(`No session matches selector "${trimmed}"`);
}

export function resolveSessionSelectors(sessions: SessionRecord[], selectors: string[]): SessionRecord[] {
  const resolved = new Map<string, SessionRecord>();
  for (const selector of selectors) {
    const session = resolveSessionSelector(sessions, selector);
    resolved.set(session.id, session);
  }
  return [...resolved.values()];
}

export function resolveUniquePrefix(prefix: string, ids: string[]): string {
  const trimmed = prefix.trim();
  if (!trimmed) {
    throw new Error("Empty prefix");
  }

  const exact = ids.find((id) => id === trimmed);
  if (exact) {
    return exact;
  }

  const matches = ids.filter((id) => id.startsWith(trimmed));
  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    throw new Error(`Prefix "${trimmed}" is ambiguous`);
  }

  throw new Error(`No id matches prefix "${trimmed}"`);
}
