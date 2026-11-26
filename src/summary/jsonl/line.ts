// JSONL 한 행의 이미지 제거와 문자열 문법·바이트 예산 상태를 관리한다.
import { SummaryError } from './errors';

/** 이미지 Base64 본문을 제외한 JSON 한 행을 메모리 상한 안에서 구성한다. */
export class JsonlLine {
  private readonly blocks: Buffer[] = [];
  private block?: Buffer;
  private used = 0;
  private length = 0;
  private inString = false;
  private escaped = false;
  private unicode = 0;
  private probe: string | undefined;
  private image = false;
  bytes = 0;

  constructor(private readonly maxBytes: number, private readonly offset: number,
    private readonly consume?: (chunk: Buffer, start: number, end: number) => void) {}

  /**
   * 책임: 행의 일반 구간을 빠르게 복사하고 문자열 경계를 추적한다.
   * 알고리즘: 다음 따옴표·역슬래시 위치를 재사용해 구간 단위로 이동하고, 이미지 탐지·이스케이프 구간만 바이트 단위로 처리한다.
   */
  append(chunk: Buffer, start: number, end: number): void {
    this.bytes += end - start;
    // [파싱 정책] 따옴표·이스케이프 위치를 재사용하고 문자열 문맥에서만 두 경계를 함께 본다.
    const search = chunk.subarray(0, end);
    const find = (byte: number, from: number): number => {
      const found = search.indexOf(byte, from);
      return found < 0 ? end : found;
    };
    let quote = find(34, start);
    let escape = find(92, start);
    let index = start;
    let retainedStart = start;
    const discard = (from: number, to: number): void => {
      if (retainedStart < from) this.consume?.(chunk, retainedStart, from);
      retainedStart = to;
    };
    while (index < end) {
      if (this.probe !== undefined || this.escaped || this.unicode) {
        if (this.trackStringByte(chunk[index])) this.retain(chunk, index, index + 1);
        else discard(index, index + 1);
        index++;
        continue;
      }
      if (quote < index) quote = find(34, index);
      if (escape < index) escape = find(92, index);
      const boundary = this.inString ? Math.min(quote, escape) : quote;
      if (boundary <= index) {
        if (this.trackStringByte(chunk[index])) this.retain(chunk, index, index + 1);
        else discard(index, index + 1);
        index++;
        continue;
      }
      // [메모리 정책] 이미지 본문은 버리고 버려지는 구간의 제어 문자는 직접 검증한다.
      if (this.image) {
        if (/[\x00-\x1f]/.test(chunk.toString('latin1', index, boundary))) throw new SummaryError('parse-error', this.offset);
        discard(index, boundary);
      } else this.retain(chunk, index, boundary);
      index = boundary;
    }
    if (retainedStart < end) this.consume?.(chunk, retainedStart, end);
  }

  private retain(chunk: Buffer, start: number, end: number): void {
    // [메모리 정책] 보존할 바이트만 예산에 포함하고 소비 콜백이 있으면 중간 버퍼를 만들지 않는다.
    if (end - start > this.maxBytes - this.length) throw new SummaryError('line-byte-budget-exceeded', this.offset);
    if (this.consume) {
      this.length += end - start;
      return;
    }
    // [메모리 정책] 작은 첫 블록으로 시작해 행이 길어지면 64KiB까지 블록을 늘린다.
    while (start < end) {
      if (this.block && this.used === this.block.length) {
        this.blocks.push(this.block);
        this.block = undefined;
        this.used = 0;
      }
      const block = this.block ??= Buffer.allocUnsafe(Math.min(this.blocks.length ? 64 * 1024 : 1024, this.maxBytes - this.length));
      const count = Math.min(end - start, block.length - this.used);
      chunk.copy(block, this.used, start, start + count);
      start += count;
      this.used += count;
      this.length += count;
    }
  }

  /** Advance string state and report whether this byte belongs in the retained JSON. */
  private trackStringByte(byte: number): boolean {
    if (!this.inString) {
      if (byte === 34) { this.inString = true; this.probe = ''; }
      return true;
    }
    if (this.image) return this.trackImageByte(byte);
    if (this.escaped) { this.escaped = false; this.probe = undefined; return true; }
    switch (byte) {
      case 92: this.escaped = true; this.probe = undefined; break;
      case 34: this.inString = false; this.probe = undefined; break;
      default: if (this.probe !== undefined) this.probeImage(byte, this.probe);
    }
    return true;
  }

  private probeImage(byte: number, probe: string): void {
    // [파싱 정책] 문자열 앞부분만 검사하고 확인한 Base64 이미지 헤더 뒤에서 본문 제거를 시작한다.
    const next = probe + String.fromCharCode(byte);
    this.probe = next;
    const prefix = 'data:image/';
    if ((next.length <= prefix.length && !prefix.startsWith(next.toLowerCase())) || next.length > 256) {
      this.probe = undefined;
      return;
    }
    if (byte !== 44) return;
    this.image = /^data:image\/[^,]+;base64,$/i.test(next);
    this.probe = undefined;
  }

  private trackImageByte(byte: number): boolean {
    // [파싱 정책] 버릴 이미지 문자열도 제어 문자와 이전 이스케이프를 먼저 검사한 뒤 종료 따옴표를 판별한다.
    if (byte < 32) throw new SummaryError('parse-error', this.offset);
    if (this.unicode) {
      if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102))) {
        throw new SummaryError('parse-error', this.offset);
      }
      this.unicode--;
      return false;
    }
    if (this.escaped) {
      if (byte === 117) this.unicode = 4;
      else if (![34, 47, 92, 98, 102, 110, 114, 116].includes(byte)) throw new SummaryError('parse-error', this.offset);
      this.escaped = false;
      return false;
    }
    switch (byte) {
      case 92: this.escaped = true; return false;
      case 34: this.inString = false; this.image = false; return true;
      default: return false;
    }
  }

  text(): string {
    // [DTO 정책] 사용한 블록과 마지막 일부만 합쳐 UTF-8로 변환한다.
    if (!this.block) return '';
    const tail = this.block.subarray(0, this.used);
    return (this.blocks.length ? Buffer.concat([...this.blocks, tail], this.length) : tail).toString('utf8').trim();
  }
}
