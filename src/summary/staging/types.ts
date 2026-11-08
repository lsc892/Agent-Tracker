// SQL staging의 원본 행과 준비된 요청 행을 공유하는 타입이다.
import type { FileMetadata, TurnSummaryInput } from '../db/types';
import type { Provider } from '../types';

export interface StagedFile extends FileMetadata {
  id: number;
  old_session: string | null;
  changed: number;
  parsed: number;
  removed: number;
  failed: number;
  project_key: string | null;
  project_name: string | null;
  session_name: string | null;
  thread_id: string | null;
  parent_thread_id: string | null;
  is_main: number;
  forked_from_id: string | null;
}

export interface PreparedTurn {
  cursor: number;
  provider: Provider;
  session_id: string;
  root_id: string;
  started: number | null;
  completed_at: number | null;
  last_assistant: number | null;
  completed: number;
  explicit_duration: number | null;
  lifecycle: number;
  file_id: number;
  byte_offset: number;
  has_main: number;
  latest_status: TurnSummaryInput['status'] | null;
  latest_status_at: number | null;
  latest_status_quality: TurnSummaryInput['duration_quality'] | null;
  project_key: string;
  project_name: string;
  input_tokens: number;
  output_tokens: number;
  billing: import('../db/types').BillingMode;
  cache_read_input_tokens: number;
  cache_write_input_tokens: number;
  flags: string | null;
  request_title: string | null;
}
