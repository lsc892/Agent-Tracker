export type Provider = 'claude' | 'codex';
export interface SourceRoot { provider: Provider; path: string; dataHome?: string }
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
  includeCosts?: boolean;
  groupBy?: 'day' | 'month' | 'project' | 'session' | 'all' | 'turn';
  timezone?: string;
  fromMs?: number;
  toMs?: number;
  provider?: Provider;
  providers?: Provider[];
  projectKey?: string;
  sessionId?: string;
  projectName?: string;
  sessionName?: string;
  limit?: number;
  offset?: number;
  afterId?: number;
  chartMetric?: import('./db/types').ChartMetric;
  cumulativeBy?: 'provider' | 'model';
  cumulativeOffset?: number;
}
export interface NameQuery {
  kind: 'project' | 'session';
  provider?: Provider;
  providers?: Provider[];
  projectKey?: string;
  limit?: number;
  offset?: number;
}
export interface NameOption {
  project_key: string;
  project_name: string;
  provider: Provider | null;
  session_id: string | null;
  session_name: string | null;
  session_started_at_ms: number | null;
}
export interface NameResult { rows: NameOption[]; total: number }
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
  billing?: import('./db/types').BillingMode;
  rows: import('./db/types').UsageRow[] | import('./db/types').TurnSummaryRow[];
  total: number;
  coverage: import('./db/types').DiagnosticsPage['counts'];
  chart?: import('./db/types').UsageChart;
  cumulative?: { rows: import('./db/types').CumulativeRow[]; total: number; by: 'provider' | 'model' };
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
  sessionName?: string;
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
  /** Aborted outcomes exist only in staging and never become persisted request summaries. */
  status?: 'completed' | 'in_progress' | 'failed' | 'aborted';
  statusAt?: number | null;
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
  model?: string;
  billingMode?: import('./db/types').BillingMode;
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
