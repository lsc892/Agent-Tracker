// Validates JSONL bytes across chunks and decodes a compact row at LF.
import { SummaryError } from './errors';
import type { FixedJsonShape } from './projection';

const enum Byte {
  Tab = 9, Cr = 13, Space = 32, Quote = 34, Plus = 43, Comma = 44, Minus = 45, Dot = 46, Slash = 47,
  Zero = 48, Nine = 57, Colon = 58, CapitalE = 69, OpenArray = 91, Backslash = 92, CloseArray = 93,
  A = 97, B = 98, E = 101, F = 102, N = 110, R = 114, T = 116, U = 117, OpenObject = 123, CloseObject = 125,
}

type Position = 'first' | 'key' | 'colon' | 'value' | 'after';
type ContainerEnd = Byte.CloseObject | Byte.CloseArray;

interface Container {
  end: ContainerEnd;
  position: Position;
  shape?: FixedJsonShape;
  member?: FixedJsonShape;
  selected: boolean;
  nonempty: boolean;
}

interface JsonString {
  target: 'key' | 'output' | 'discard';
  escape: number;
  prefix: string;
  keyLimit: number;
}

const keyLimits = new WeakMap<FixedJsonShape, number>();

function keyLimit(shape: FixedJsonShape): number {
  let limit = keyLimits.get(shape);
  if (limit === undefined) {
    // Each UTF-16 code unit can appear as a six-byte JSON escape.
    limit = Object.keys(shape.fields ?? {}).reduce((longest, key) => Math.max(longest, key.length * 6), 0);
    keyLimits.set(shape, limit);
  }
  return limit;
}

function invalidJson(): never { throw new SyntaxError('Invalid JSON'); }
const isDigit = (byte: number): boolean => byte >= Byte.Zero && byte <= Byte.Nine;
const isHex = (byte: number): boolean => isDigit(byte) || (byte | 32) >= Byte.A && (byte | 32) <= Byte.F;

function hasZeroByte(word: number): boolean {
  return ((word - 0x01010101) & ~word & 0x80808080) !== 0;
}

function stringBoundary(bytes: Buffer, index: number, end: number): number {
  // Skip four bytes at a time until an ASCII control, quote or backslash needs inspection.
  for (; index + 4 <= end; index += 4) {
    const word = bytes[index] | bytes[index + 1] << 8 | bytes[index + 2] << 16 | bytes[index + 3] << 24;
    if (hasZeroByte(word & 0xe0e0e0e0) || hasZeroByte(word ^ 0x22222222) || hasZeroByte(word ^ 0x5c5c5c5c)) break;
  }
  while (index < end) {
    const byte = bytes[index];
    if (byte < Byte.Space || byte === Byte.Quote || byte === Byte.Backslash) break;
    index++;
  }
  return index;
}

const enum NumberState { Start, Sign, Zero, Integer, Dot, Fraction, Exponent, ExponentSign, ExponentDigits }

function nextNumber(state: NumberState, byte: number): NumberState | undefined {
  if (state === NumberState.Start && byte === Byte.Minus) return NumberState.Sign;
  if (state === NumberState.Exponent && (byte === Byte.Plus || byte === Byte.Minus)) return NumberState.ExponentSign;
  switch (state) {
    case NumberState.Start:
    case NumberState.Sign: return byte === Byte.Zero ? NumberState.Zero : isDigit(byte) ? NumberState.Integer : undefined;
    case NumberState.Zero:
    case NumberState.Integer:
      if (byte === Byte.Dot) return NumberState.Dot;
      if (state === NumberState.Integer && isDigit(byte)) return NumberState.Integer;
      break;
    case NumberState.Dot:
    case NumberState.Fraction:
      if (isDigit(byte)) return NumberState.Fraction;
      break;
    case NumberState.Exponent:
    case NumberState.ExponentSign:
    case NumberState.ExponentDigits: return isDigit(byte) ? NumberState.ExponentDigits : undefined;
  }
  if ((byte === Byte.E || byte === Byte.CapitalE) && endsNumber(state))
    return NumberState.Exponent;
  return undefined;
}

function endsNumber(state: NumberState): boolean {
  return state === NumberState.Zero || state === NumberState.Integer || state === NumberState.Fraction || state === NumberState.ExponentDigits;
}

/** Retains only bytes needed by the final JSON.parse, with amortized linear growth. */
class CompactRow {
  private buffer = Buffer.allocUnsafe(128);
  private length = 0;

  private reserve(size: number): Buffer {
    const end = this.length + size;
    if (end > this.buffer.length) {
      const next = Buffer.allocUnsafe(Math.max(end, this.buffer.length * 2));
      this.buffer.copy(next, 0, 0, this.length);
      this.buffer = next;
    }
    return this.buffer;
  }

  appendByte(byte: number): void {
    this.reserve(1)[this.length++] = byte;
  }

  append(bytes: Buffer, start: number, end: number): void {
    const size = end - start;
    if (!size) return;
    bytes.copy(this.reserve(size), this.length, start, end);
    this.length += size;
  }

  appendLatin1(value: string): void {
    this.reserve(value.length).write(value, this.length, 'latin1');
    this.length += value.length;
  }

  reset(): void {
    this.length = 0;
    if (this.buffer.length > 64 * 1024) this.buffer = Buffer.allocUnsafe(128);
  }

  text(): string { return this.buffer.toString('utf8', 0, this.length); }
}

export class StreamingFixedProjection {
  private readonly containers: Container[] = [];
  private readonly compact = new CompactRow();
  private string?: JsonString;
  private number?: NumberState;
  private literal = '';
  private scalarSelected = false;
  private rootByte?: number;
  private invalid = false;
  private edgeSpace = 0;
  private offset = 0;

  constructor(private readonly shape: FixedJsonShape) {}

  reset(offset: number): void {
    // A new row starts only after a successful finish has emptied the grammar state.
    this.offset = offset;
    this.rootByte = undefined;
    this.compact.reset();
  }

  append(chunk: Buffer, start: number, end: number): void {
    if (this.invalid) return;
    try {
      let index = start;
      while (index < end) {
        if (this.string) index = this.readString(chunk, index, end, this.string);
        else if (this.number !== undefined || this.literal) index = this.readScalar(chunk, index, end);
        else this.readStructure(chunk[index++]);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Record errors at LF so unfinished rows keep their original handling.
      this.invalid = true;
    }
  }

  finish(): Record<string, unknown> | undefined {
    if (this.invalid || this.string || this.literal || this.containers.length || this.edgeSpace
      || this.number !== undefined && !endsNumber(this.number)) throw new SummaryError('parse-error', this.offset);
    if (this.rootByte === undefined) return undefined;
    if (this.rootByte !== Byte.OpenObject) throw new SummaryError('unsupported-schema', this.offset);
    try { return JSON.parse(this.compact.text()) as Record<string, unknown>; }
    catch { throw new SummaryError('parse-error', this.offset); }
  }

  private readStructure(byte: number): void {
    const frame = this.containers[this.containers.length - 1];
    if (!frame) {
      if (this.readEdgeSpace(byte)) return;
      if (this.rootByte !== undefined) invalidJson();
      this.rootByte = byte;
      this.startValue(byte, byte === Byte.OpenObject ? this.shape : undefined);
      return;
    }
    if (byte === Byte.Space || byte === Byte.Tab || byte === Byte.Cr) return;
    if (frame.position === 'after') {
      if (byte === frame.end) this.endContainer(frame);
      else if (byte === Byte.Comma) frame.position = frame.end === Byte.CloseObject ? 'key' : 'value';
      else invalidJson();
      return;
    }
    if (frame.position === 'first' && byte === frame.end) {
      this.endContainer(frame);
      return;
    }
    if (frame.position === 'colon') {
      if (byte !== Byte.Colon) invalidJson();
      frame.position = 'value';
      return;
    }
    if (frame.end === Byte.CloseObject && frame.position !== 'value') {
      if (byte !== Byte.Quote) invalidJson();
      frame.nonempty = true;
      frame.position = 'colon';
      frame.member = undefined;
      if (frame.shape?.fields) this.startString('key', keyLimit(frame.shape));
      else this.startString('discard');
      return;
    }
    frame.position = 'after';
    this.startValue(byte, frame.member);
  }

  /** Match String.trim whitespace at the row's edges, including a split UTF-8 BOM. */
  private readEdgeSpace(byte: number): boolean {
    const prefix = this.edgeSpace;
    if (!prefix) {
      if (byte === Byte.Space || byte >= Byte.Tab && byte <= Byte.Cr) return true;
      if (byte !== 0xc2 && byte !== 0xef && (byte < 0xe1 || byte > 0xe3)) return false;
      this.edgeSpace = byte;
    } else if (prefix >= 0xe1 && prefix <= 0xef) {
      this.edgeSpace = (prefix << 8) | byte;
    } else {
      this.edgeSpace = 0;
      const space = prefix === 0xc2 && byte === 0xa0
        || prefix === 0xe19a && byte === 0x80
        || prefix === 0xe280 && (byte >= 0x80 && byte <= 0x8a || byte === 0xa8 || byte === 0xa9 || byte === 0xaf)
        || prefix === 0xe281 && byte === 0x9f
        || prefix === 0xe380 && byte === 0x80
        || prefix === 0xefbb && byte === 0xbf;
      if (!space) invalidJson();
    }
    return true;
  }

  private startValue(byte: number, shape: FixedJsonShape | undefined): void {
    if (byte === Byte.OpenObject || byte === Byte.OpenArray) {
      const end = byte === Byte.OpenObject ? Byte.CloseObject : Byte.CloseArray;
      const project = byte === Byte.OpenObject && (!this.containers.length || shape?.fields) ? shape : undefined;
      if (shape) {
        this.compact.appendByte(byte);
        if (!project) this.compact.appendByte(end);
      }
      this.containers.push({ end, position: 'first', shape: project, selected: false, nonempty: false });
      return;
    }
    if (byte === Byte.Quote) {
      this.startString(shape ? 'output' : 'discard');
      return;
    }
    this.scalarSelected = !!shape;
    if (byte === Byte.N) this.literal = 'ull';
    else if (byte === Byte.T) this.literal = 'rue';
    else if (byte === Byte.F) this.literal = 'alse';
    else this.number = nextNumber(NumberState.Start, byte) ?? invalidJson();
    if (shape) this.compact.appendByte(byte);
  }

  private endContainer(frame: Container): void {
    this.containers.pop();
    if (!frame.shape) return;
    if (frame.shape.keepNonempty && frame.nonempty && !frame.selected) this.compact.appendLatin1('"":true');
    this.compact.appendByte(frame.end);
  }

  private readScalar(bytes: Buffer, index: number, end: number): number {
    const start = index;
    if (this.number !== undefined) {
      let state = this.number;
      while (index < end) {
        const next = nextNumber(state, bytes[index]);
        if (next === undefined) {
          if (!endsNumber(state)) invalidJson();
          this.number = undefined;
          break;
        }
        state = next;
        index++;
      }
      if (this.number !== undefined) this.number = state;
    } else {
      let consumed = 0;
      while (index < end && consumed < this.literal.length) {
        if (bytes[index++] !== this.literal.charCodeAt(consumed++)) invalidJson();
      }
      this.literal = this.literal.slice(consumed);
    }
    if (this.scalarSelected) this.compact.append(bytes, start, index);
    return index;
  }

  private startString(target: JsonString['target'], limit = 0): void {
    this.string = { target, prefix: '', keyLimit: limit, escape: 0 };
    if (target === 'output') this.compact.appendByte(Byte.Quote);
  }

  private readString(bytes: Buffer, index: number, end: number, token: JsonString): number {
    const start = index;
    while (index < end) {
      if (!token.escape) index = stringBoundary(bytes, index, end);
      if (index === end) break;
      const byte = bytes[index++];
      if (token.escape > 0) {
        if (!isHex(byte)) invalidJson();
        token.escape--;
      } else if (token.escape === -1) {
        if (byte === Byte.U) token.escape = 4;
        else if (byte === Byte.Quote || byte === Byte.Backslash || byte === Byte.Slash || byte === Byte.B
          || byte === Byte.F || byte === Byte.N || byte === Byte.R || byte === Byte.T) token.escape = 0;
        else invalidJson();
      } else if (byte === Byte.Quote) {
        if (token.target === 'output') this.compact.append(bytes, start, index);
        else if (token.target === 'key') this.endKey(token, bytes, start, index - 1);
        this.string = undefined;
        return index;
      } else if (byte === Byte.Backslash) {
        token.escape = -1;
      } else {
        invalidJson();
      }
    }
    if (token.target === 'output') this.compact.append(bytes, start, index);
    else if (token.target === 'key') {
      if (token.prefix.length + index - start <= token.keyLimit) token.prefix += bytes.toString('latin1', start, index);
      else token.target = 'discard';
    }
    return index;
  }

  private endKey(token: JsonString, bytes: Buffer, start: number, end: number): void {
    const frame = this.containers[this.containers.length - 1];
    if (!frame?.shape?.fields || token.prefix.length + end - start > token.keyLimit) return;
    const literal = token.prefix ? Buffer.from(token.prefix + bytes.toString('latin1', start, end), 'latin1').toString('utf8')
      : bytes.toString('utf8', start, end);
    const name = literal.includes('\\') ? JSON.parse('"' + literal + '"') as string : literal;
    if (!Object.hasOwn(frame.shape.fields, name)) return;
    frame.member = frame.shape.fields[name];
    if (frame.selected) this.compact.appendByte(Byte.Comma);
    frame.selected = true;
    this.compact.appendByte(Byte.Quote);
    if (token.prefix) this.compact.appendLatin1(token.prefix);
    this.compact.append(bytes, start, end);
    this.compact.appendByte(Byte.Quote);
    this.compact.appendByte(Byte.Colon);
  }
}
