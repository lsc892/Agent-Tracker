// Validates filtered JSONL bytes across chunks and decodes a compact row at LF.
import { SummaryError } from './errors';
import type { FixedJsonShape } from './projection';

type Position = 'first' | 'key' | 'colon' | 'value' | 'after';

interface Container {
  end: '}' | ']';
  position: Position;
  shape?: FixedJsonShape;
  member?: FixedJsonShape;
  selected: boolean;
  nonempty: boolean;
}

interface JsonString {
  target: 'key' | 'output' | 'discard';
  escape: number;
  key: string;
  keyLimit: number;
}

const stringRun = /[^"\\\x00-\x1f]+/y;
const hexDigit = /^[0-9a-f]$/i;
const keyLimits = new WeakMap<FixedJsonShape, number>();

function keyLimit(shape: FixedJsonShape): number {
  let limit = keyLimits.get(shape);
  if (limit === undefined) {
    // Each UTF-16 code unit can appear as a six-byte JSON escape.
    limit = Object.keys(shape.fields ?? {}).reduce((longest, key) => Math.max(longest, key.length * 6 + 2), 0);
    keyLimits.set(shape, limit);
  }
  return limit;
}

function invalidJson(): never { throw new SyntaxError('Invalid JSON'); }
const isDigit = (char: string): boolean => char >= '0' && char <= '9';

type NumberState = 'start' | 'sign' | 'zero' | 'integer' | 'dot' | 'fraction' | 'exponent' | 'exponentSign' | 'exponentDigits';

function nextNumber(state: NumberState, char: string): NumberState | undefined {
  if (state === 'start' && char === '-') return 'sign';
  if (state === 'exponent' && (char === '+' || char === '-')) return 'exponentSign';
  switch (state) {
    case 'start':
    case 'sign': return char === '0' ? 'zero' : isDigit(char) ? 'integer' : undefined;
    case 'zero':
    case 'integer':
      if (char === '.') return 'dot';
      if (state === 'integer' && isDigit(char)) return 'integer';
      break;
    case 'dot':
    case 'fraction':
      if (isDigit(char)) return 'fraction';
      break;
    case 'exponent':
    case 'exponentSign':
    case 'exponentDigits': return isDigit(char) ? 'exponentDigits' : undefined;
  }
  if (state !== 'dot' && (char === 'e' || char === 'E')) return 'exponent';
  return undefined;
}

function endsNumber(state: NumberState): boolean {
  return state === 'zero' || state === 'integer' || state === 'fraction' || state === 'exponentDigits';
}

/** Retains only bytes needed by the final JSON.parse, with amortized linear growth. */
class CompactRow {
  private buffer?: Buffer;
  private length = 0;

  append(value: string): void {
    if (!value) return;
    const end = this.length + value.length;
    if (!this.buffer || end > this.buffer.length) {
      const next = Buffer.allocUnsafe(Math.max(end, (this.buffer?.length ?? 128) * 2));
      this.buffer?.copy(next, 0, 0, this.length);
      this.buffer = next;
    }
    if (value.length === 1) this.buffer[this.length] = value.charCodeAt(0);
    else this.buffer.write(value, this.length, 'latin1');
    this.length = end;
  }

  text(): string { return this.buffer?.toString('utf8', 0, this.length) ?? ''; }
}

export class StreamingFixedProjection {
  private readonly containers: Container[] = [];
  private readonly compact = new CompactRow();
  private string?: JsonString;
  private number?: NumberState;
  private literal = '';
  private scalarSelected = false;
  private seenRoot = false;
  private objectRoot = false;
  private invalid = false;
  private edgeSpace = '';

  constructor(private readonly shape: FixedJsonShape, private readonly offset: number) {}

  append(chunk: Buffer, start: number, end: number): void {
    if (this.invalid) return;
    // Latin-1 is a bounded byte view in the lexer. UTF-8 decoding happens only for selected data and lookup keys.
    const bytes = chunk.toString('latin1', start, end);
    try {
      let index = 0;
      while (index < bytes.length) {
        if (this.string) index = this.readString(bytes, index, this.string);
        else if (this.number || this.literal) index = this.readScalar(bytes, index);
        else {
          this.readStructure(bytes[index]);
          index++;
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A trailing row without LF is deferred, including ordinary JSON syntax errors.
      this.invalid = true;
    }
  }

  finish(): Record<string, unknown> | undefined {
    if (this.invalid || this.string || this.literal || this.containers.length || this.edgeSpace
      || this.number && !endsNumber(this.number)) throw new SummaryError('parse-error', this.offset);
    if (!this.seenRoot) return undefined;
    if (!this.objectRoot) throw new SummaryError('unsupported-schema', this.offset);
    try { return JSON.parse(this.compact.text()) as Record<string, unknown>; }
    catch { throw new SummaryError('parse-error', this.offset); }
  }

  private readStructure(char: string): void {
    const frame = this.containers.at(-1);
    if (!frame) {
      if (this.readEdgeSpace(char)) return;
      if (this.seenRoot) invalidJson();
      this.seenRoot = true;
      this.objectRoot = char === '{';
      this.startValue(char, this.objectRoot ? this.shape : undefined, true);
      return;
    }
    if (char === ' ' || char === '\t' || char === '\r') return;
    if (frame.position === 'after') {
      if (char === frame.end) this.endContainer(frame);
      else if (char === ',') frame.position = frame.end === '}' ? 'key' : 'value';
      else invalidJson();
      return;
    }
    if (frame.position === 'first' && char === frame.end) {
      this.endContainer(frame);
      return;
    }
    if (frame.position === 'colon') {
      if (char !== ':') invalidJson();
      frame.position = 'value';
      return;
    }
    if (frame.end === '}' && frame.position !== 'value') {
      if (char !== '"') invalidJson();
      frame.nonempty = true;
      frame.position = 'colon';
      this.startKey(frame);
      return;
    }
    frame.position = 'after';
    this.startValue(char, frame.member);
  }

  /** Preserve String.trim's outer Unicode whitespace without decoding complete rows. */
  private readEdgeSpace(char: string): boolean {
    if (!this.edgeSpace) {
      if (char === ' ' || char === '\t' || char === '\r' || char === '\v' || char === '\f') return true;
      if (!/^[\xc2\xe1-\xe3\xef]$/.test(char)) return false;
    }
    this.edgeSpace += char;
    const size = this.edgeSpace[0] === '\xc2' ? 2 : 3;
    if (this.edgeSpace.length === size) {
      if (Buffer.from(this.edgeSpace, 'latin1').toString('utf8').trim()) invalidJson();
      this.edgeSpace = '';
    }
    return true;
  }

  private startKey(frame: Container): void {
    frame.member = undefined;
    if (frame.shape?.fields) this.startString('key', keyLimit(frame.shape));
    else this.startString('discard');
  }

  private startValue(char: string, shape: FixedJsonShape | undefined, root = false): void {
    // [필드 선택 정책] 모든 컨테이너는 검증하되 지정한 객체만 하위 선택표로 펼친다.
    if (char === '{' || char === '[') {
      const end = char === '{' ? '}' : ']';
      const project = char === '{' && (root || shape?.fields) ? shape : undefined;
      if (project) this.compact.append(char);
      else if (shape) this.compact.append(char + end);
      this.containers.push({ end, position: 'first', shape: project, selected: false, nonempty: false });
      return;
    }
    if (char === '"') {
      this.startString(shape ? 'output' : 'discard');
      return;
    }
    this.scalarSelected = !!shape;
    if (char === 'n') this.literal = 'ull';
    else if (char === 't') this.literal = 'rue';
    else if (char === 'f') this.literal = 'alse';
    else this.number = nextNumber('start', char) ?? invalidJson();
    if (shape) this.compact.append(char);
  }

  private endContainer(frame: Container): void {
    this.containers.pop();
    if (!frame.shape) return;
    if (frame.shape.keepNonempty && frame.nonempty && !frame.selected) this.compact.append('"":true');
    this.compact.append(frame.end);
  }

  private readScalar(bytes: string, index: number): number {
    const start = index;
    if (this.number) {
      let state = this.number;
      while (index < bytes.length) {
        const next = nextNumber(state, bytes[index]);
        if (!next) {
          if (!endsNumber(state)) invalidJson();
          this.number = undefined;
          break;
        }
        state = next;
        index++;
      }
      if (this.number) this.number = state;
    } else {
      const part = this.literal.slice(0, bytes.length - index);
      if (!bytes.startsWith(part, index)) invalidJson();
      this.literal = this.literal.slice(part.length);
      index += part.length;
    }
    if (this.scalarSelected) this.compact.append(bytes.slice(start, index));
    return index;
  }

  private startString(target: JsonString['target'], limit = 0): void {
    this.string = { target, key: '"', keyLimit: limit, escape: 0 };
    if (target === 'output') this.compact.append('"');
  }

  private readString(bytes: string, index: number, token: JsonString): number {
    const start = index;
    while (index < bytes.length) {
      if (!token.escape) {
        stringRun.lastIndex = index;
        if (stringRun.test(bytes)) {
          index = stringRun.lastIndex;
          continue;
        }
      }
      const char = bytes[index++];
      if (token.escape > 0) {
        if (!hexDigit.test(char)) invalidJson();
        token.escape--;
      } else if (token.escape === -1) {
        if (char === 'u') token.escape = 4;
        else if ('"\\/bfnrt'.includes(char)) token.escape = 0;
        else invalidJson();
      } else if (char === '"') {
        this.saveString(token, bytes, start, index);
        this.endString(token);
        this.string = undefined;
        return index;
      } else if (char === '\\') {
        token.escape = -1;
      } else {
        invalidJson();
      }
    }
    this.saveString(token, bytes, start, index);
    return index;
  }

  private saveString(token: JsonString, bytes: string, start: number, end: number): void {
    if (token.target === 'output') this.compact.append(bytes.slice(start, end));
    else if (token.target === 'key') {
      if (token.key.length + end - start <= token.keyLimit) token.key += bytes.slice(start, end);
      else token.target = 'discard';
    }
  }

  private endString(token: JsonString): void {
    const frame = this.containers.at(-1);
    if (frame?.position !== 'colon' || token.target !== 'key' || !frame.shape?.fields) return;
    const literal = Buffer.from(token.key, 'latin1').toString('utf8');
    const name = literal.includes('\\') ? JSON.parse(literal) as string : literal.slice(1, -1);
    if (!Object.hasOwn(frame.shape.fields, name)) return;
    frame.member = frame.shape.fields[name];
    if (frame.selected) this.compact.append(',');
    frame.selected = true;
    this.compact.append(token.key);
    this.compact.append(':');
  }
}
