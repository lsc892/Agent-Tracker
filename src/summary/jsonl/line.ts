// JSONL 한 행의 이미지 제거와 문자열 문법·바이트 예산 상태를 관리한다.
import { SummaryError } from './errors';

/** 이미지 Base64 본문을 제외한 JSON 한 행을 메모리 상한 안에서 구성한다. */
export class JsonlLine {
  private readonly blocks: Buffer[] = [];
  private block: Buffer;
  private used = 0;
  private length = 0;
  private inString = false;
  private escaped = false;
  private unicode = 0;
  private probe: string | undefined;
  private image = false;
  bytes = 0;

  constructor(private readonly maxBytes: number, private readonly offset: number) {
    this.block = Buffer.allocUnsafe(Math.min(1024, maxBytes));
  }

  /**
   * 책임: 행의 일반 구간을 빠르게 복사하고 문자열 경계를 추적한다.
   * 알고리즘: 다음 따옴표·역슬래시 위치를 재사용해 구간 단위로 이동하고, 이미지 탐지·이스케이프 구간만 바이트 단위로 처리한다.
   */
  append(chunk: Buffer, start: number, end: number): void {
    this.bytes += end - start;
    // Cache the next delimiter: searching the entire remaining chunk for an absent
    // backslash again for every string would make quote-heavy input quadratic.
    const search = chunk.subarray(0, end);
    const find = (byte: number, from: number): number => {
      const found = search.indexOf(byte, from);
      return found < 0 ? end : found;
    };
    let quote = find(34, start);
    let escape = find(92, start);
    let index = start;
    while (index < end) {
      if (this.probe !== undefined || this.escaped || this.unicode) {
        this.appendByte(chunk[index++]);
        continue;
      }
      if (quote < index) quote = find(34, index);
      if (escape < index) escape = find(92, index);
      const boundary = this.inString ? Math.min(quote, escape) : quote;
      if (boundary <= index) {
        this.appendByte(chunk[index++]);
        continue;
      }
      if (this.image) {
        // Discard without retaining Base64; JSON.parse cannot check these bytes.
        if (/[\x00-\x1f]/.test(chunk.toString('latin1', index, boundary))) throw new SummaryError('parse-error', this.offset);
      } else this.retain(chunk, index, boundary);
      index = boundary;
    }
  }

  private retain(chunk: Buffer, start: number, end: number): void {
    if (end - start > this.maxBytes - this.length) throw new SummaryError('line-byte-budget-exceeded', this.offset);
    while (start < end) {
      if (this.used === this.block.length) this.nextBlock();
      const count = Math.min(end - start, this.block.length - this.used);
      chunk.copy(this.block, this.used, start, start + count);
      start += count;
      this.used += count;
      this.length += count;
    }
  }

  private nextBlock(): void {
    this.blocks.push(this.block);
    this.block = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxBytes - this.length));
    this.used = 0;
  }

  /**
   * 책임: 버리는 이미지 문자열까지 JSON 문자열 문법을 검증한다.
   * 알고리즘: 문자열·escape·유니코드 잔여 길이를 상태로 갱신하고, 이미지 본문은 제어 문자와 잘못된 escape를 거부하며 저장을 생략한다.
   */
  private appendByte(byte: number): void {
    if (!this.trackStringByte(byte)) return;
    if (this.length >= this.maxBytes) throw new SummaryError('line-byte-budget-exceeded', this.offset);
    if (this.used === this.block.length) this.nextBlock();
    this.block[this.used++] = byte;
    this.length++;
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
    // JSON.parse cannot validate discarded bytes. Preserve its string escape/control checks here.
    // 제어 문자 → 이전 Unicode/escape 완성 → 새 escape·종료 따옴표 순서로 해석한다.
    // 순서를 바꾸면 이스케이프된 따옴표가 이미지 문자열을 일찍 닫을 수 있다.
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
    const tail = this.block.subarray(0, this.used);
    return (this.blocks.length ? Buffer.concat([...this.blocks, tail], this.length) : tail).toString('utf8').trim();
  }
}
