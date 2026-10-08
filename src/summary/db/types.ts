export type Provider = 'claude' | 'codex';
export type ProcessingStatus = 'processing' | 'done' | 'error' | 'interrupted';
export type DurationQuality = 'exact' | 'derived' | 'approximate' | 'missing';
export type BillingMode = 'subscription' | 'api' | 'unknown';
export type CapabilityCategory = 'skill' | 'subagent' | 'plugin' | 'model';
export interface CapabilityUsageInput { category: CapabilityCategory; name: string; usage_count: number }
export interface CapabilityRow extends CapabilityUsageInput { provider: Provider; percentage: number }
export interface CapabilityPage { rows: CapabilityRow[]; chartRows: CapabilityRow[]; total: number; totalUses: number }
export interface CostFields {
  cost_usd?: number | null;
  unknown_costs?: number;
  billing_mode?: BillingMode;
}

export interface FileMetadata {
  provider: Provider;
  source_root: string;
  path: string;
  session_id: string | null;
  size_bytes: number;
  mtime_ms: number;
  dev: string | null;
  inode: string | null;
  parser_version: number;
  /** 0 when Skill counts were skipped; re-enable rebuilds these sources. */
  capabilities_collected?: 0 | 1;
}

export interface ManifestRow extends FileMetadata {
  id: number;
  last_seen_scan_id: string | null;
  processing_status: ProcessingStatus;
  processing_position: string | null;
  recorded_at: string;
  last_error: string | null;
}

export interface TurnSummaryInput {
  provider: Provider;
  project_key: string;
  project_name: string;
  session_id: string;
  /** Ingestion metadata; names are stored only in projects/sessions. */
  session_name?: string | null;
  root_turn_id: string;
  /** A bounded display title, never the full request body. */
  request_title?: string | null;
  turn_index: number;
  started_at_ms?: number | null;
  completed_at_ms?: number | null;
  duration_ms?: number | null;
  duration_quality: DurationQuality;
  input_tokens: number;
  output_tokens: number;
  /** Input components; null means an older summary needs to be rebuilt. */
  cache_write_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  total_tokens: number;
  status: 'completed' | 'in_progress' | 'failed';
  quality_flags?: string | null;
  diagnostic_file_id?: number | null;
  diagnostic_offset?: number | null;
  last_error?: string | null;
  updated_at?: string;
  /** Ingestion only; persisted separately after response deduplication. */
  model_usage?: Iterable<ModelUsageInput>;
  capability_usage?: Iterable<CapabilityUsageInput>;
  billing?: BillingMode;
}

export interface ModelUsageInput {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

export interface CumulativeRow extends Omit<ModelUsageInput, 'model'>, CostFields {
  /** null identifies a request without model metadata or recorded token usage. */
  model: string | null;
  provider: Provider;
  total_tokens: number;
}

export interface TurnSummaryRow extends Required<Omit<TurnSummaryInput, 'model_usage' | 'capability_usage' | 'billing'>>, CostFields {
  id: number;
  /** Eligibility for chart display, without removing a row from its table page. */
  has_recorded_usage?: number;
  /** null means no recorded usage; an empty string means usage with an unknown model. */
  model?: string | null;
  other_models?: number;
}

export interface SessionRef {
  provider: Provider;
  session_id: string;
}

export interface SessionReplacement {
  preserveCapabilities?: boolean;
  sessions: Iterable<SessionRef>;
  summaries: Iterable<TurnSummaryInput>;
  files: Iterable<FileMetadata & { id: number }>;
  removedFileIds?: Iterable<number>;
}

export interface SummaryFilter {
  excludeEmptyUsage?: boolean;
  includeCosts?: boolean;
  provider?: Provider;
  providers?: Provider[];
  projectKey?: string;
  sessionId?: string;
  projectName?: string;
  sessionName?: string;
  fromMs?: number;
  toMs?: number;
  /** Calendar groups include a separate unknown-period row by default, even with a date range. */
  unknownTime?: 'only' | 'include' | 'exclude';
}

export interface KeysetPage {
  afterId?: number;
  limit?: number;
}

export interface OffsetPage {
  offset?: number;
  limit?: number;
}

export type UsageGrouping = 'total' | 'project' | 'session' | 'day' | 'month';
export type ChartMetric = 'tokens' | 'requests' | 'averageTokens' | 'averageDuration';
export interface UsageChart {
  by?: 'provider' | 'model';
  rows: UsageRow[] | TurnSummaryRow[];
  mode: 'calendar' | 'ranking' | 'turn' | 'total';
  metric: ChartMetric;
  total: number;
}

export interface UsageRow extends CostFields {
  /** null means no recorded usage; an empty string means usage with an unknown model. */
  model?: string | null;
  other_models?: number;
  provider: Provider;
  project_key: string | null;
  project_name: string | null;
  session_id: string | null;
  session_name: string | null;
  session_started_at_ms: number | null;
  /** YYYY-MM-DD, YYYY-MM, or null for an unknown timestamp / non-calendar group. */
  period: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_write_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_tokens: number;
  turn_count: number;
  completed_turns: number;
  /** Counts used by charts when empty usage is excluded after selecting the page. */
  recorded_turns?: number;
  recorded_completed_turns?: number;
  avg_tokens_per_turn: number | null;
  avg_duration_ms: number | null;
  turns_with_duration: number;
  exact_duration_turns: number;
  derived_duration_turns: number;
  approximate_duration_turns: number;
  missing_duration_turns: number;
  unknown_time_turns: number;
  stale_turns: number;
  last_successful_update: string | null;
}

export interface DiagnosticsPage {
  files: ManifestRow[];
  summaries: TurnSummaryRow[];
  counts: {
    files: number;
    processing: number;
    done: number;
    error: number;
    interrupted: number;
    stale_summaries: number;
  };
  nextFileId: number | null;
  nextSummaryId: number | null;
}
