export type TreeMode = "date" | "fork";
export type MetadataMode = "compact" | "none";

export interface CodexPaths {
  root: string;
  sessionsDir: string;
  sessionIndexPath: string;
  stateDbPath: string;
  logsDbPath: string;
  snapshotsDir: string;
}

export interface RolloutInfo {
  id: string;
  path: string;
  sessionTimestamp?: string;
  sessionTimestampMs?: number;
  cwd?: string;
  originator?: string;
  sourceLabel?: string;
  modelProvider?: string;
  cliVersion?: string;
  agentNickname?: string;
  agentRole?: string;
  parentThreadId?: string;
  depth?: number;
  year?: string;
  month?: string;
  day?: string;
}

export interface SessionIndexEntry {
  id: string;
  threadName?: string;
  updatedAt?: string;
  updatedAtMs?: number;
}

export interface ThreadStateRow {
  id: string;
  rolloutPath?: string;
  createdAt?: number;
  updatedAt?: number;
  source?: string;
  modelProvider?: string;
  cwd?: string;
  title?: string;
  sandboxPolicy?: string;
  approvalMode?: string;
  tokensUsed?: number;
  hasUserEvent?: boolean;
  archived?: boolean;
  archivedAt?: number;
  gitSha?: string;
  gitBranch?: string;
  gitOriginUrl?: string;
  cliVersion?: string;
  firstUserMessage?: string;
  agentNickname?: string;
  agentRole?: string;
  memoryMode?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface SessionPresence {
  rollout: boolean;
  index: boolean;
  state: boolean;
  stateLogs: boolean;
  logs: boolean;
  snapshots: boolean;
}

export interface SessionRecord {
  id: string;
  displayId: string;
  displayIndex: number;
  title: string;
  updatedAtMs?: number;
  createdAtMs?: number;
  updatedAtLabel: string;
  createdAtLabel?: string;
  cwd?: string;
  cwdBase?: string;
  sourceLabel?: string;
  originator?: string;
  modelProvider?: string;
  cliVersion?: string;
  archived: boolean;
  parentThreadId?: string;
  depth?: number;
  rolloutPath?: string;
  snapshotPaths: string[];
  indexEntries: SessionIndexEntry[];
  stateRow?: ThreadStateRow;
  presence: SessionPresence;
  storeCounts: {
    stateLogs: number;
    logs: number;
  };
  issues: string[];
  rollout?: RolloutInfo;
}

export interface ScanResult {
  paths: CodexPaths;
  sessions: SessionRecord[];
  byId: Map<string, SessionRecord>;
}

export interface RenderOptions {
  treeMode: TreeMode;
  metadataMode: MetadataMode;
  includeStale: boolean;
  width?: number;
}

export interface RenderResult {
  text: string;
  orderedSessions: SessionRecord[];
}

export interface DeletionTarget {
  session: SessionRecord;
  rolloutExists: boolean;
  indexRows: number;
  threadRowCount: number;
  threadDynamicToolsCount: number;
  stage1OutputsCount: number;
  stateLogsCount: number;
  logsCount: number;
  snapshotPaths: string[];
}

export interface DeletePlan {
  root: string;
  targets: DeletionTarget[];
  activeThreadId?: string;
}

export interface DeleteResult {
  removedRolloutFiles: number;
  removedIndexRows: number;
  removedThreadRows: number;
  removedThreadDynamicToolsRows: number;
  removedStage1OutputsRows: number;
  removedStateLogRows: number;
  removedLogsRows: number;
  removedSnapshots: number;
}
