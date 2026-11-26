// 일반·Zstd JSONL 로그를 메모리 상한과 이미지 본문 제거 정책에 맞춰 읽는다.
import { open } from 'node:fs/promises';
import { zstdChunks, ZstdError } from './zstd';
import { SummaryError } from './errors';
import { JsonlLine } from './line';
import { projectJson, type FixedJsonShape, type JsonShape } from './projection';
import { StreamingFixedProjection } from './streamProjection';

export { SummaryError } from './errors';

const imagePrefix = Buffer.from('data:image');

/** Find the next literal marker so each chunk is searched once, including mixed ASCII case. */
function nextImageMarker(chunk: Buffer, start: number): number {
  for (let slash = chunk.indexOf(47, start + imagePrefix.length); slash >= 0; slash = chunk.indexOf(47, slash + 1)) {
    const candidate = slash - imagePrefix.length;
    let index = 0;
    while (index < imagePrefix.length && (chunk[candidate + index] | 32) === imagePrefix[index]) index++;
    if (index === imagePrefix.length) return candidate;
  }
  return chunk.length;
}

/** JSON 문법 오류와 지원하지 않는 최상위 형식을 원본 행 위치로 구분한다. */
function parseJsonlObject(text: string, offset: number, shape: JsonShape | undefined): Record<string, unknown> {
  let row: unknown;
  try { row = shape ? projectJson(text, shape) : JSON.parse(text); }
  catch { throw new SummaryError('parse-error', offset); }
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SummaryError('unsupported-schema', offset);
  return row as Record<string, unknown>;
}

/**
 * 책임: 관측한 크기까지만 로그를 읽고 행과 원본 위치를 전달한다.
 * 64KiB 이하 단위로 파일을 읽고 LF마다 한 행을 전달한다.
 * 고정 필드는 원본 바이트에서 고른 뒤 선택 결과만 UTF-8로 디코딩한다.
 */
export async function readJsonl(
  path: string,
  size: number,
  onRow: (row: Record<string, unknown>, offset: number) => void | boolean,
  options: { maxLineBytes?: number; signal?: AbortSignal; isCancelled?: () => boolean; onBytes?: (bytes: number) => void;
    shape?: JsonShape; fixedShape?: FixedJsonShape;
    /** Raw file bytes, before image filtering or decompression; valid only during the callback. */
    onChunk?: (chunk: Buffer) => void;
    /** Synchronous processing of at most one chunk; file reads stay outside the callback. */
    processBatch?: (parseRows: () => void) => void } = {},
): Promise<{ partialLine: boolean; bytes: number; rows: number }> {
  // [메모리 정책] 행 예산은 기본 4MiB로 두고 읽기 버퍼는 관측 크기와 64KiB 중 작은 값에 맞춘다.
  const maxLine = options.maxLineBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxLine) || maxLine < 1) throw new RangeError('maxLineBytes must be a positive integer');
  const compressed = path.toLowerCase().endsWith('.jsonl.zst');
  const file = await open(path, 'r');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  const projection = options.fixedShape && new StreamingFixedProjection(options.fixedShape);
  const appendProjected = projection?.append.bind(projection);
  let line: JsonlLine | undefined;
  let read = 0;
  let lineOffset = 0;
  let rows = 0;

  // [파싱 정책] 스캔에서 관측한 크기까지만 최대 64KiB씩 읽고 압축 해제 전 바이트를 전달한다.
  const chunks = async function* (): AsyncGenerator<Buffer> {
    while (read < size) {
      if (options.signal?.aborted || options.isCancelled?.()) throw new SummaryError('interrupted', read);
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - read), read);
      if (!bytesRead) throw new SummaryError('file-truncated-during-read', read);
      read += bytesRead;
      const bytes = buffer.subarray(0, bytesRead);
      options.onChunk?.(bytes);
      options.onBytes?.(bytesRead);
      // The decoder can prefetch; it must not see a buffer overwritten by the next file read.
      yield compressed ? Buffer.from(bytes) : bytes;
    }
  };

  // [파싱 정책] LF로 행을 나누고 이미지가 없는 고정 필드 행은 원본 바이트에서 바로 선택한다.
  function parseChunk(chunk: Buffer): boolean {
    let index = 0;
    let image = -1;
    while (index < chunk.length) {
      const newline = chunk.indexOf(10, index);
      const end = newline < 0 ? chunk.length : newline;
      let text: string | undefined;
      let needsLine = !!line || newline < 0 || end - index > maxLine;
      if (!line) projection?.reset(lineOffset);
      if (!needsLine) {
        if (projection) {
          if (image < index) image = nextImageMarker(chunk, index);
          needsLine = image < end;
          if (!needsLine) projection.append(chunk, index, end);
        } else {
          const candidate = chunk.toString('utf8', index, end).trim();
          needsLine = /data:image\//i.test(candidate);
          if (!needsLine) text = candidate;
        }
      }

      // [파싱 정책] 청크를 넘기거나 이미지가 든 행은 상태를 이어받아 읽고, 고정 스키마가 있으면 필요한 필드만 누적한다.
      if (needsLine) {
        line ??= new JsonlLine(maxLine, lineOffset, appendProjected);
        line.append(chunk, index, end);
        if (newline < 0) break;
        if (!projection) text = line.text();
      }

      // [파싱 정책] LF에서 완성된 객체를 행 시작 오프셋과 함께 전달하고 다음 행의 상태를 초기화한다.
      const row = projection ? projection.finish() : text ? parseJsonlObject(text, lineOffset, options.shape) : undefined;
      if (row) {
        rows++;
        if (onRow(row, lineOffset) === false) return true;
      }
      lineOffset += (line?.bytes ?? end - index) + 1;
      line = undefined;
      index = end + 1;
    }
    return false;
  }

  // [파싱 정책] Zstd는 읽는 중에 풀고, 끝에 LF가 없는 행은 보류로 표시하며 파일은 항상 닫는다.
  try {
    for await (const chunk of compressed ? zstdChunks(chunks()) : chunks()) {
      if (options.signal?.aborted || options.isCancelled?.()) throw new SummaryError('interrupted', read);
      let stopped: boolean;
      if (options.processBatch) {
        stopped = false;
        options.processBatch(() => { stopped = parseChunk(chunk) || stopped; });
      } else {
        stopped = parseChunk(chunk);
      }
      if (stopped) return { partialLine: false, bytes: read, rows };
    }
    return { partialLine: (line?.bytes ?? 0) > 0, bytes: read, rows };
  } catch (error) {
    if (error instanceof ZstdError) throw new SummaryError('decompression-error', lineOffset);
    throw error;
  } finally { await file.close(); }
}
