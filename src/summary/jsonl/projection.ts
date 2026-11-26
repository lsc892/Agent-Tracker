// Validates JSON while materializing only the values selected by a log reader.
export type JsonFields = Readonly<Record<string, true | JsonShape>>;

export interface JsonShape {
  fields?: JsonFields;
  items?: JsonShape;
  variant?: (type: unknown) => JsonFields | undefined;
  deferred?: boolean;
  keepNonempty?: boolean;
  objectOnly?: boolean;
}

export interface FixedJsonShape {
  fields?: Readonly<Record<string, FixedJsonShape>>;
  keepNonempty?: boolean;
}

const nonempty = Symbol('nonempty JSON object');
const whitespace = /[\x09\x0a\x0d\x20]+/y;
const plainString = /[^"\\\x00-\x1f]*"/y;
const escapedString = /[^"\\\x00-\x1f]*(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})[^"\\\x00-\x1f]*)*"/y;
const stringPart = /[^"\\\x00-\x1f]+|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y;
const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const keyEscapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

export function hasJsonFields(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, nonempty) || Object.keys(value).length > 0;
}

export function projectJson(text: string, shape: JsonShape): unknown {
  return new JsonProjection(text).parse(shape);
}

export function projectFixedJson(text: string, shape: FixedJsonShape): unknown {
  return new JsonProjection(text).parseFixed(shape);
}

function field<T>(fields: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  return fields && Object.hasOwn(fields, name) ? fields[name] : undefined;
}

function invalidJson(): never { throw new SyntaxError('Invalid JSON'); }

class JsonProjection {
  private containerEndings?: string[];

  constructor(private readonly text: string, private offset = 0) {}

  parse(shape: JsonShape): unknown {
    const result = this.value(shape);
    this.space();
    if (this.offset !== this.text.length) invalidJson();
    return result;
  }

  /** Validate the input once and decode the compact row in one native JSON.parse call. */
  parseFixed(shape: FixedJsonShape): unknown {
    // [파싱 정책] 입력 문법은 모두 확인하고 선택한 조각을 합쳐 한 번만 JSON.parse에 넘긴다.
    const pieces: string[] = [];
    this.space();
    if (this.text[this.offset] === '{') this.fixedObject(shape, pieces);
    else this.skipValue();
    this.space();
    if (this.offset !== this.text.length) invalidJson();
    return pieces.length ? JSON.parse(pieces.join('')) : null;
  }

  private fixedObject(shape: FixedJsonShape, pieces: string[]): void {
    // [필드 선택 정책] 키 이스케이프를 해석해 선택표에서 찾고 선택 밖의 값은 문법만 검사한다.
    this.offset++;
    if (this.take('}')) { pieces.push('{}'); return; }
    pieces.push('{');
    let selected = false;
    do {
      this.space();
      const keyStart = this.offset;
      const escaped = this.skipString(), keyEnd = this.offset;
      const literal = this.text.slice(keyStart + 1, keyEnd - 1);
      const name = escaped ? literal.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, code: string) =>
        code.length === 5 ? String.fromCharCode(Number.parseInt(code.slice(1), 16)) : keyEscapes[code] ?? code) : literal;
      this.expect(':');
      const member = field(shape.fields, name);
      if (!member) { this.skipValue(); continue; }
      if (selected) pieces.push(',');
      selected = true;
      pieces.push(this.text.slice(keyStart, keyEnd), ':');
      this.fixedValue(member, pieces);
    } while (this.next('}'));
    // Distinguish an empty usage object from a malformed, populated one after selection.
    if (!selected && shape.keepNonempty) pieces.push('"":true');
    pieces.push('}');
  }

  private fixedValue(shape: FixedJsonShape, pieces: string[]): void {
    // [필드 선택 정책] 하위 필드 정의가 있는 객체만 펼치고 나머지 컨테이너는 형태만 보존한다.
    this.space();
    const start = this.offset, char = this.text[start];
    if (char === '{' && shape.fields) {
      this.fixedObject(shape, pieces);
      return;
    }
    this.skipValue();
    if (char === '{') pieces.push('{}');
    else if (char === '[') pieces.push('[]');
    else pieces.push(this.text.slice(start, this.offset));
  }

  private space(): void {
    const code = this.text.charCodeAt(this.offset);
    if (code === 32 || code === 9 || code === 10 || code === 13) this.match(whitespace);
  }

  private match(token: RegExp): boolean {
    token.lastIndex = this.offset;
    if (!token.test(this.text)) return false;
    this.offset = token.lastIndex;
    return true;
  }

  private take(char: string): boolean {
    this.space();
    if (this.text[this.offset] !== char) return false;
    this.offset++;
    return true;
  }

  private expect(char: string): void { if (!this.take(char)) invalidJson(); }

  private next(end: string): boolean {
    this.space();
    const char = this.text[this.offset++];
    if (char === ',') return true;
    if (char !== end) invalidJson();
    return false;
  }

  /** Returns whether decoding the contents of the quoted string needs JSON escapes. */
  private skipString(): boolean {
    if (this.text[this.offset++] !== '"') invalidJson();
    if (this.match(plainString)) return false;
    // The bounded reader also accepts escape-heavy strings that exceed the regex engine's backtracking stack.
    if (this.text.length - this.offset < 64 * 1024 && this.match(escapedString)) return true;
    // [파싱 정책] 전체 정규식으로 끝나지 않는 문자열은 이스케이프와 일반 구간을 나눠 순회한다.
    while (this.text[this.offset] !== '"') {
      if (!this.match(stringPart)) invalidJson();
    }
    this.offset++;
    return true;
  }

  private skipScalar(): void {
    switch (this.text[this.offset]) {
      case '"': this.skipString(); return;
      case 't': if (this.text.startsWith('true', this.offset)) { this.offset += 4; return; } break;
      case 'f': if (this.text.startsWith('false', this.offset)) { this.offset += 5; return; } break;
      case 'n': if (this.text.startsWith('null', this.offset)) { this.offset += 4; return; } break;
      default: if (this.match(numberToken)) return;
    }
    invalidJson();
  }

  /** Checks discarded containers iteratively so deeply nested ignored values do not use the call stack. */
  private skipValue(): void {
    this.space();
    if (this.text[this.offset] !== '[' && this.text[this.offset] !== '{') { this.skipScalar(); return; }
    // [파싱 정책] 중첩된 컨테이너의 닫는 기호를 스택에서 추적해 값을 만들지 않고 건너뛴다.
    const endings = this.containerEndings ??= [];
    for (;;) {
      this.space();
      const char = this.text[this.offset];
      if (char === '[' || char === '{') {
        this.offset++;
        const end = char === '{' ? '}' : ']';
        if (!this.take(end)) {
          endings.push(end);
          if (end === '}') this.skipMemberName();
          continue;
        }
      } else this.skipScalar();

      while (endings.length) {
        const end = endings[endings.length - 1];
        if (!this.next(end)) { endings.pop(); continue; }
        if (end === '}') this.skipMemberName();
        break;
      }
      if (!endings.length) return;
    }
  }

  private skipMemberName(): void {
    this.space();
    this.skipString();
    this.expect(':');
  }

  private value(shape: true | JsonShape): unknown {
    this.space();
    const start = this.offset;
    const char = this.text[start];
    // [필드 선택 정책] 정의된 객체 필드와 배열 원소만 읽고 객체 전용 필드의 다른 타입은 버린다.
    if (shape !== true) {
      if (char === '{') {
        if (shape.fields || shape.variant || shape.keepNonempty) return this.object(shape);
        this.skipValue();
        return {};
      }
      if (shape.objectOnly) { this.skipValue(); return null; }
      if (char === '[') {
        if (shape.items) return this.array(shape.items);
        this.skipValue();
        return [];
      }
    }
    if (char === '"') {
      // Decode retained strings separately so IDs and names cannot keep the source row alive as slices.
      this.skipString();
      return JSON.parse(this.text.slice(start, this.offset));
    }
    this.skipValue();
    switch (char) {
      case 'n': return null;
      case 't': return true;
      case 'f': return false;
      case '[':
      case '{': return JSON.parse(this.text.slice(start, this.offset));
      default: return Number(this.text.slice(start, this.offset));
    }
  }

  private array(items: JsonShape): unknown[] {
    this.offset++;
    const values: unknown[] = [];
    if (this.take(']')) return values;
    do { values.push(this.value(items)); } while (this.next(']'));
    return values;
  }

  private member(result: Record<string, unknown>, name: string, shape: true | JsonShape): void {
    if (shape === true || !shape.deferred) {
      const value = this.value(shape);
      if (name === '__proto__') Object.defineProperty(result, name, { value, enumerable: true, writable: true, configurable: true });
      else result[name] = value;
      return;
    }
    // [메모리 정책] 문법 검증 후 시작 위치만 남겨 최초 접근 때 값을 해석하고 결과를 재사용한다.
    const text = this.text, start = this.offset;
    this.skipValue();
    Object.defineProperty(result, name, { enumerable: true, configurable: true,
      get() {
        const value = new JsonProjection(text, start).value(shape);
        Object.defineProperty(result, name, { value, enumerable: true, writable: true, configurable: true });
        return value;
      },
    });
  }

  /** Selects fields by the final `type`, including when it follows the selected fields. */
  private object(shape: JsonShape): Record<string, unknown> {
    const start = this.offset++;
    const result: Record<string, unknown> = {};
    if (this.take('}')) return result;
    // [필드 선택 정책] type 이전의 값은 필요한지 아직 모르므로 해석 위치만 기록한다.
    let variant: JsonFields | undefined;
    let typeSeen = false, variantChanged = false, hasSelectedField = false;
    let beforeType: { name: string; offset: number }[] | undefined;
    do {
      this.space();
      const keyStart = this.offset;
      const name = this.skipString() ? JSON.parse(this.text.slice(keyStart, this.offset)) as string
        : this.text.slice(keyStart + 1, this.offset - 1);
      this.expect(':');
      if (shape.variant && name === 'type') {
        const type = this.value(true);
        const next = shape.variant(type);
        variantChanged ||= typeSeen && next !== variant;
        result.type = type;
        variant = next;
        typeSeen = true;
        continue;
      }
      const selected = field(variant, name) ?? field(shape.fields, name);
      if (selected && !variantChanged) {
        this.member(result, name, selected);
        hasSelectedField = true;
      } else {
        if (shape.variant && !typeSeen) (beforeType ??= []).push({ name, offset: this.offset });
        this.skipValue();
      }
    } while (this.next('}'));

    // [필드 선택 정책] 중복 type이 선택표를 바꾸면 마지막 유형으로 다시 읽고 선행 필드는 최신 값부터 복원한다.
    if (variantChanged) {
      this.offset = start;
      return this.object({ ...shape, fields: { ...shape.fields, ...variant, type: true }, variant: undefined });
    }
    if (variant && beforeType) {
      const end = this.offset;
      for (let index = beforeType.length - 1; index >= 0; index--) {
        const { name, offset } = beforeType[index];
        const selected = field(variant, name);
        if (!selected || Object.hasOwn(result, name)) continue;
        this.offset = offset;
        this.member(result, name, selected);
      }
      this.offset = end;
    }
    if (shape.keepNonempty && !hasSelectedField) Object.defineProperty(result, nonempty, { value: true });
    return result;
  }
}
