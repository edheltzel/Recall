export type JsonObject = Record<string, unknown>;
export type JsoncProperty = { key: string; keyStart: number; value: JsoncNode };
export type JsoncNode = {
  start: number;
  end: number;
  value: unknown;
  properties?: JsoncProperty[];
  contentEnd?: number;
  trailingComma?: boolean;
};

class JsoncParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): JsoncNode {
    this.skipSpaceAndComments();
    const root = this.value();
    this.skipSpaceAndComments();
    if (this.index !== this.text.length) throw new Error('trailing content');
    return root;
  }

  private value(): JsoncNode {
    this.skipSpaceAndComments();
    const start = this.index;
    const char = this.text[this.index];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();

    const match = this.text.slice(this.index).match(/^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new Error(`expected value at ${this.index}`);
    this.index += match[0].length;
    return { start, end: this.index, value: JSON.parse(match[0]) };
  }

  private string(): JsoncNode {
    const start = this.index;
    this.index++;
    let escaped = false;
    while (this.index < this.text.length) {
      const char = this.text[this.index++];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        const raw = this.text.slice(start, this.index);
        return { start, end: this.index, value: JSON.parse(raw) };
      }
    }
    throw new Error('unterminated string');
  }

  private object(): JsoncNode {
    const start = this.index++;
    const properties: JsoncProperty[] = [];
    const value: JsonObject = {};
    let contentEnd = this.index;
    let trailingComma = false;
    this.skipSpaceAndComments();
    while (this.text[this.index] !== '}') {
      const keyNode = this.string();
      this.skipSpaceAndComments();
      if (this.text[this.index++] !== ':') throw new Error(`expected colon at ${this.index}`);
      const child = this.value();
      properties.push({ key: keyNode.value as string, keyStart: keyNode.start, value: child });
      value[keyNode.value as string] = child.value;
      contentEnd = child.end;
      trailingComma = false;
      this.skipSpaceAndComments();
      if (this.text[this.index] === ',') {
        this.index++;
        contentEnd = this.index;
        trailingComma = true;
        this.skipSpaceAndComments();
        continue;
      }
      if (this.text[this.index] !== '}') throw new Error(`expected comma at ${this.index}`);
    }
    this.index++;
    return { start, end: this.index, value, properties, contentEnd, trailingComma };
  }

  private array(): JsoncNode {
    const start = this.index++;
    const value: unknown[] = [];
    this.skipSpaceAndComments();
    while (this.text[this.index] !== ']') {
      value.push(this.value().value);
      this.skipSpaceAndComments();
      if (this.text[this.index] === ',') {
        this.index++;
        this.skipSpaceAndComments();
        continue;
      }
      if (this.text[this.index] !== ']') throw new Error(`expected comma at ${this.index}`);
    }
    this.index++;
    return { start, end: this.index, value };
  }

  private skipSpaceAndComments(): void {
    while (this.index < this.text.length) {
      if (/\s/.test(this.text[this.index])) {
        this.index++;
        continue;
      }
      if (this.text.startsWith('//', this.index)) {
        const end = this.text.indexOf('\n', this.index + 2);
        this.index = end < 0 ? this.text.length : end + 1;
        continue;
      }
      if (this.text.startsWith('/*', this.index)) {
        const end = this.text.indexOf('*/', this.index + 2);
        if (end < 0) throw new Error('unterminated comment');
        this.index = end + 2;
        continue;
      }
      return;
    }
  }
}

export function parseJsonc(text: string): JsoncNode {
  return new JsoncParser(text).parse();
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
