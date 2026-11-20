/**
 * Minimal GraphQL selection parser (#576).
 *
 * This is intentionally not a full GraphQL implementation: the endpoint
 * only ever executes allowlisted persisted queries, so the parser only
 * needs the constructs those queries use — named operations, variable
 * definitions/references, literal arguments (string/int/boolean), aliases,
 * and nested selection sets. Anything else (fragments, directives,
 * subscriptions, mutations) is rejected, which is itself a security
 * property: an allowlisted query that grew a fragment would fail loudly
 * instead of executing.
 */
export interface FieldNode {
  name: string;
  alias?: string;
  args: Record<string, unknown>;
  selections?: FieldNode[];
}

export interface ParsedQuery {
  operationName?: string;
  /** variable name -> declared type string, e.g. "ID!" */
  variableDefs: Record<string, string>;
  selections: FieldNode[];
}

type Token =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "punct"; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if ("{}():,$!=".includes(ch)) {
      tokens.push({ kind: "punct", value: ch });
      i++;
      continue;
    }
    if (ch === "." && input.slice(i, i + 3) === "...") {
      throw new Error("fragments are not supported in persisted queries");
    }
    if (ch === "@") {
      throw new Error("directives are not supported in persisted queries");
    }
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      while (j < input.length && input[j] !== '"') {
        if (input[j] === "\\" && j + 1 < input.length) {
          value += input[j + 1];
          j += 2;
        } else {
          value += input[j];
          j++;
        }
      }
      if (j >= input.length) throw new Error("unterminated string in query");
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const m = /^-?\d+/.exec(input.slice(i));
      if (!m) throw new Error(`unexpected character ${ch}`);
      tokens.push({ kind: "number", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i));
      if (!m) throw new Error(`unexpected character ${ch}`);
      tokens.push({ kind: "ident", value: m[0] });
      i += m[0].length;
      continue;
    }
    throw new Error(`unexpected character ${ch} in query`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error("unexpected end of query");
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== "punct" || t.value !== value) {
      throw new Error(`expected '${value}' but got ${t.kind === "punct" ? t.value : t.value}`);
    }
  }
  private isPunct(value: string): boolean {
    const t = this.peek();
    return t?.kind === "punct" && t.value === value;
  }

  parseQuery(): ParsedQuery {
    // Optional `query Name($var: Type) { ... }` header.
    let operationName: string | undefined;
    const variableDefs: Record<string, string> = {};
    const first = this.peek();
    if (first?.kind === "ident" && first.value === "query") {
      this.next();
      const name = this.peek();
      if (name?.kind === "ident") {
        operationName = name.value;
        this.next();
      }
      if (this.isPunct("(")) {
        this.next();
        while (!this.isPunct(")")) {
          this.expectPunct("$");
          const varName = this.next();
          if (varName.kind !== "ident") throw new Error("expected variable name");
          this.expectPunct(":");
          let type = "";
          while (true) {
            const t = this.next();
            if (t.kind === "ident") type += t.value;
            else if (t.kind === "punct" && (t.value === "!" || t.value === "[" || t.value === "]")) type += t.value;
            else throw new Error("expected variable type");
            const nxt = this.peek();
            if (nxt?.kind === "punct" && (nxt.value === "," || nxt.value === ")")) break;
            if (nxt?.kind === "ident" || (nxt?.kind === "punct" && (nxt.value === "!" || nxt.value === "[" || nxt.value === "]"))) continue;
            break;
          }
          variableDefs[varName.value] = type;
          if (this.isPunct(",")) this.next();
        }
        this.expectPunct(")");
      }
    } else if (first?.kind === "ident" && (first.value === "mutation" || first.value === "subscription")) {
      throw new Error("only query operations are supported");
    }
    const selections = this.parseSelectionSet();
    if (this.pos < this.tokens.length) throw new Error("trailing tokens after query");
    return { operationName, variableDefs, selections };
  }

  parseSelectionSet(): FieldNode[] {
    this.expectPunct("{");
    const fields: FieldNode[] = [];
    while (!this.isPunct("}")) {
      if (!this.peek()) throw new Error("unterminated selection set");
      fields.push(this.parseField());
    }
    this.expectPunct("}");
    return fields;
  }

  private parseField(): FieldNode {
    const first = this.next();
    if (first.kind !== "ident") throw new Error("expected field name");
    let name = first.value;
    let alias: string | undefined;
    if (this.isPunct(":")) {
      // alias: field
      this.next();
      alias = name;
      const real = this.next();
      if (real.kind !== "ident") throw new Error("expected field name after alias");
      name = real.value;
    }
    const args: Record<string, unknown> = {};
    if (this.isPunct("(")) {
      this.next();
      while (!this.isPunct(")")) {
        const argName = this.next();
        if (argName.kind !== "ident") throw new Error("expected argument name");
        this.expectPunct(":");
        args[argName.value] = this.parseValue();
        if (this.isPunct(",")) this.next();
      }
      this.expectPunct(")");
    }
    let selections: FieldNode[] | undefined;
    if (this.isPunct("{")) selections = this.parseSelectionSet();
    return { name, alias, args, selections };
  }

  private parseValue(): unknown {
    const t = this.next();
    if (t.kind === "string" || t.kind === "number") return t.value;
    if (t.kind === "ident") {
      if (t.value === "true") return true;
      if (t.value === "false") return false;
      if (t.value === "null") return null;
      return { __enum: t.value };
    }
    if (t.kind === "punct" && t.value === "$") {
      const name = this.next();
      if (name.kind !== "ident") throw new Error("expected variable name");
      return { __variable: name.value };
    }
    throw new Error(`unexpected argument value ${t.value}`);
  }
}

export function parseGraphQLQuery(text: string): ParsedQuery {
  return new Parser(tokenize(text)).parseQuery();
}

/** Resolve argument values: variable references are looked up, literals pass through. */
export function resolveArgs(
  args: Record<string, unknown>,
  variables: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== null && typeof value === "object" && "__variable" in (value as Record<string, unknown>)) {
      out[key] = variables[(value as { __variable: string }).__variable];
    } else if (value !== null && typeof value === "object" && "__enum" in (value as Record<string, unknown>)) {
      out[key] = (value as { __enum: string }).__enum;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Deepest selection nesting (root fields are depth 1). */
export function queryDepth(selections: FieldNode[]): number {
  let max = 0;
  for (const field of selections) {
    const child = field.selections ? queryDepth(field.selections) : 0;
    max = Math.max(max, 1 + child);
  }
  return max;
}

/**
 * Static cost estimate: scalars cost 1, object fields cost 2 plus their
 * children, connections cost 5 plus their children (they fan out to many
 * rows). This is the number the rate budget charges per request.
 */
export function queryComplexity(selections: FieldNode[]): number {
  let total = 0;
  for (const field of selections) {
    if (!field.selections) {
      total += 1;
    } else if (field.name.endsWith("Connection") || field.name === "streams" || field.name === "events" || field.name === "streamHistory" || field.name === "streamEvents" || field.name === "streamsByRecipient" || field.name === "streamsByAddress") {
      total += 5 + queryComplexity(field.selections);
    } else {
      total += 2 + queryComplexity(field.selections);
    }
  }
  return total;
}
