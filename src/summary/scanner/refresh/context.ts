// 갱신 단계들이 한 번 생성한 실행 환경과 스캔 상태를 참조하는 계약을 정의한다.
import type { SummaryDatabase } from '../../db';
import type { ScanStage, StageProfiler, StorageStage } from '../../profiling';
import type { RefreshResult, SourceRoot } from '../../types';
import type { SourceReaderPool } from '../sourcePool';
import type { ScanState } from './state';

export interface RefreshContext {
  readonly database: SummaryDatabase;
  readonly result: RefreshResult;
  readonly scan: StageProfiler<ScanStage>;
  readonly storage: StageProfiler<StorageStage>;
  readonly state: ScanState;
  readonly sourcePool: SourceReaderPool;
  readonly roots: readonly SourceRoot[];
  readonly collect: boolean;
  readonly retain: boolean;
  readonly cancelled: () => boolean;
  readonly check: () => void;
  readonly report: (force?: boolean) => void;
}
