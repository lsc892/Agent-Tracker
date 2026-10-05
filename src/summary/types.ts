export type Provider = 'claude' | 'codex';
export interface SourceRoot { provider: Provider; path: string }
export interface SummaryOptions {
  dbPath: string;
  roots: SourceRoot[];
  timezone?: string;
  workerPath?: string;
  batchSize?: number;
  metadataBytes?: number;
  maxLineBytes?: number;
  cancellation?: SharedArrayBuffer;
}
export interface UsageQuery {
  groupBy?: 'day' | 'month' | 'project' | 'session' | 'all' | 'turn';
  timezone?: string;
  fromMs?: number;
  toMs?: number;
  provider?: Provider;
  providers?: Provider[];
  projectKey?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
  afterId?: number;
}
export interface RefreshResult {
  scanId: string;
  discovered: number;
  parsed: number;
  reused: number;
  failed: number;
  bodyBytes: number;
  interrupted: boolean;
  completedAt: string;
  error?: string;
}
export interface SummaryProgress {
  phase: 'scanning' | 'parsing' | 'committing' | 'complete';
  discovered: number;
  parsed: number;
  failed: number;
  bodyBytes: number;
}
export interface UsageResult {
  rows: import('./db/types').UsageRow[] | import('./db/types').TurnSummaryRow[];
  total: number;
  coverage: import('./db/types').DiagnosticsPage['counts'];
}
export type DiagnosticsResult = import('./db/types').DiagnosticsPage & { lastRefresh?: RefreshResult };
export interface TokenVector {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}
export interface FileContext {
  provider: Provider;
  path: string;
  sourceRoot: string;
  fileId: number;
}
export interface ParsedIdentity {
  sessionId: string;
  threadId: string;
  parentThreadId: string | null;
  projectKey: string;
  projectName: string;
  isMain: boolean;
  forkedFromId?: string | null;
  standaloneSubagent?: boolean;
}
export interface TurnEvent {
  kind: 'turn';
  rootId: string;
  isMain: boolean;
  startedAt?: number | null;
  completedAt?: number | null;
  lastAssistantAt?: number | null;
  duration?: number | null;
  durationQuality?: 'exact' | 'derived' | 'approximate' | 'missing';
  completed?: boolean;
  flags?: string[];
  offset: number;
}
export interface UsageEvent {
  kind: 'usage';
  rootId: string;
  responseId: string;
  requestId: string | null;
  threadId: string;
  turnId: string;
  tokens: TokenVector;
  schema?: 'current' | 'legacy';
  flags?: string[];
  offset: number;
}
export interface CheckEvent {
  kind: 'check'; rootId: string; threadId: string; turnId: string;
  tokens: TokenVector; offset: number;
}
export type ParseEvent = TurnEvent | UsageEvent | CheckEvent;
export interface ParseSink {
  identity(identity: ParsedIdentity): void;
  event(event: ParseEvent): void;
}
