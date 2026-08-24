import type {
  ExpressionNode,
  ExpressionVariable,
  Operator
} from "../types";

type TokenKind =
  | "number"
  | "identifier"
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "("
  | ")"
  | ","
  | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  position: number;
  numericValue?: number;
}

interface FunctionDefinition {
  minimumArguments: number;
  maximumArguments: number;
  evaluate: (...values: number[]) => number;
}

export interface ParseExpressionOptions {
  /** The one variable permitted in the expression. Use "none" for constants. */
  variable?: ExpressionVariable | "none";
  /** Compatibility shorthand: false is the same as variable: "none". */
  allowVariable?: boolean;
}

export interface ExpressionVariables {
  x?: number;
  t?: number;
}

export const MAX_EXPRESSION_LENGTH = 8_192;
export const MAX_EXPRESSION_AST_DEPTH = 64;
export const MAX_EXPRESSION_AST_NODES = 4_096;

function unary(evaluate: (value: number) => number): FunctionDefinition {
  return { minimumArguments: 1, maximumArguments: 1, evaluate };
}

function binary(
  evaluate: (left: number, right: number) => number
): FunctionDefinition {
  return { minimumArguments: 2, maximumArguments: 2, evaluate };
}

const FUNCTIONS: Readonly<Record<string, FunctionDefinition>> = Object.freeze({
  sin: unary(Math.sin),
  cos: unary(Math.cos),
  tan: unary(Math.tan),
  sec: unary((value) => 1 / Math.cos(value)),
  csc: unary((value) => 1 / Math.sin(value)),
  cot: unary((value) => 1 / Math.tan(value)),
  asin: unary(Math.asin),
  acos: unary(Math.acos),
  atan: unary(Math.atan),
  sinh: unary(Math.sinh),
  cosh: unary(Math.cosh),
  tanh: unary(Math.tanh),
  asinh: unary(Math.asinh),
  acosh: unary(Math.acosh),
  atanh: unary(Math.atanh),
  exp: unary(Math.exp),
  sqrt: unary(Math.sqrt),
  abs: unary(Math.abs),
  ln: unary(Math.log),
  log: {
    minimumArguments: 1,
    maximumArguments: 2,
    evaluate: (value, base) => {
      if (!(value > 0)) return Number.NaN;
      if (base === undefined) return Math.log(value);
      return base > 0 && base !== 1
        ? Math.log(value) / Math.log(base)
        : Number.NaN;
    }
  },
  log10: unary(Math.log10),
  floor: unary(Math.floor),
  ceil: unary(Math.ceil),
  round: unary(Math.round),
  sign: unary(Math.sign),
  min: binary(Math.min),
  max: binary(Math.max),
  atan2: binary(Math.atan2)
});

export const SUPPORTED_FUNCTIONS = Object.freeze(Object.keys(FUNCTIONS));

export class ExpressionSyntaxError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} at character ${position + 1}`);
    this.name = "ExpressionSyntaxError";
    this.position = position;
  }
}

class Lexer {
  private position = 0;

  constructor(private readonly source: string) {}

  next(): Token {
    while (
      this.position < this.source.length &&
      /\s/.test(this.source.charAt(this.position))
    ) {
      this.position += 1;
    }
    const start = this.position;
    if (start >= this.source.length) {
      return { kind: "eof", text: "", position: start };
    }

    const character = this.source.charAt(start);
    if (character === "π") {
      this.position += 1;
      return { kind: "identifier", text: "pi", position: start };
    }

    const numberMatch = this.source
      .slice(start)
      .match(/^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      const text = numberMatch[0] as string;
      const numericValue = Number(text);
      this.position += text.length;
      if (!Number.isFinite(numericValue)) {
        throw new ExpressionSyntaxError(
          "Number is outside the supported range",
          start
        );
      }
      return { kind: "number", text, position: start, numericValue };
    }

    if (/[A-Za-z_]/.test(character)) {
      this.position += 1;
      while (
        this.position < this.source.length &&
        /[A-Za-z0-9_]/.test(this.source.charAt(this.position))
      ) {
        this.position += 1;
      }
      return {
        kind: "identifier",
        text: this.source.slice(start, this.position),
        position: start
      };
    }

    if ("+-*/^(),".includes(character)) {
      this.position += 1;
      return {
        kind: character as TokenKind,
        text: character,
        position: start
      };
    }
    throw new ExpressionSyntaxError(
      `Unexpected character "${character}"`,
      start
    );
  }
}

class Parser {
  private current: Token;
  private nodeCount = 0;
  private readonly lexer: Lexer;

  constructor(
    private readonly source: string,
    private readonly variable: ExpressionVariable | "none"
  ) {
    if (source.length > MAX_EXPRESSION_LENGTH) {
      throw new ExpressionSyntaxError(
        `Expression is too long; use at most ${MAX_EXPRESSION_LENGTH} characters`,
        MAX_EXPRESSION_LENGTH
      );
    }
    this.lexer = new Lexer(source);
    this.current = this.lexer.next();
  }

  parse(): ExpressionNode {
    if (this.isCurrent("eof")) {
      throw new ExpressionSyntaxError("Enter an expression", 0);
    }
    const result = this.parseWithBindingPower(0, 0);
    if (!this.isCurrent("eof")) {
      if (
        this.current.kind === "number" ||
        this.current.kind === "identifier" ||
        this.current.kind === "("
      ) {
        throw new ExpressionSyntaxError(
          "Implicit multiplication is not supported; insert *",
          this.current.position
        );
      }
      throw new ExpressionSyntaxError(
        `Unexpected token "${this.current.text}"`,
        this.current.position
      );
    }
    assertExpressionAstResourcesWithFactory(result, (message) =>
      new ExpressionSyntaxError(message, this.source.length)
    );
    return result;
  }

  private parseWithBindingPower(
    minimum: number,
    depth: number
  ): ExpressionNode {
    this.assertDepth(depth);
    let left = this.parsePrefix(depth);
    while (isOperator(this.current.kind)) {
      const token = this.current;
      const operator = token.kind as Operator;
      const [leftPower, rightPower] = bindingPower(operator);
      if (leftPower < minimum) break;
      this.advance();
      const right = this.parseWithBindingPower(rightPower, depth + 1);
      this.recordNode(token.position);
      left = { type: "binary", operator, left, right };
    }
    return left;
  }

  private parsePrefix(depth: number): ExpressionNode {
    const token = this.current;
    if (token.kind === "number") {
      this.advance();
      this.recordNode(token.position);
      return {
        type: "number",
        value: token.numericValue as number,
        lexeme: token.text
      };
    }
    if (token.kind === "identifier") return this.parseIdentifier(depth);
    if (token.kind === "+" || token.kind === "-") {
      this.advance();
      const argument = this.parseWithBindingPower(30, depth + 1);
      this.recordNode(token.position);
      return { type: "unary", operator: token.kind, argument };
    }
    if (token.kind === "(") {
      this.advance();
      const result = this.parseWithBindingPower(0, depth + 1);
      this.expect(")");
      return result;
    }
    throw new ExpressionSyntaxError(
      token.kind === "eof"
        ? "Expected an expression"
        : `Unexpected token "${token.text}"`,
      token.position
    );
  }

  private parseIdentifier(depth: number): ExpressionNode {
    const token = this.current;
    const name = token.text;
    this.advance();
    if (name === "x" || name === "t") {
      if (this.variable === "none") {
        throw new ExpressionSyntaxError(
          "This expression must be constant",
          token.position
        );
      }
      if (name !== this.variable) {
        throw new ExpressionSyntaxError(
          `Only the variable ${this.variable} is allowed here`,
          token.position
        );
      }
      this.recordNode(token.position);
      return { type: "variable", name };
    }
    if (name === "pi" || name === "e") {
      this.recordNode(token.position);
      return {
        type: "constant",
        name,
        value: name === "pi" ? Math.PI : Math.E
      };
    }

    const definition = ownFunction(name);
    if (!definition) {
      throw new ExpressionSyntaxError(
        `Unknown identifier "${name}"`,
        token.position
      );
    }
    if (!this.isCurrent("(")) {
      throw new ExpressionSyntaxError(
        `Function "${name}" must be followed by parentheses`,
        this.current.position
      );
    }
    this.advance();
    const arguments_: ExpressionNode[] = [];
    if (!this.isCurrent(")")) {
      while (true) {
        arguments_.push(this.parseWithBindingPower(0, depth + 1));
        if (!this.isCurrent(",")) break;
        this.advance();
      }
    }
    this.expect(")");
    if (
      arguments_.length < definition.minimumArguments ||
      arguments_.length > definition.maximumArguments
    ) {
      const count =
        definition.minimumArguments === definition.maximumArguments
          ? String(definition.minimumArguments)
          : `${definition.minimumArguments} or ${definition.maximumArguments}`;
      throw new ExpressionSyntaxError(
        `Function "${name}" expects ${count} argument${
          definition.maximumArguments === 1 ? "" : "s"
        }`,
        token.position
      );
    }
    this.recordNode(token.position);
    return { type: "function", name, arguments: arguments_ };
  }

  private expect(kind: TokenKind): void {
    if (this.current.kind !== kind) {
      throw new ExpressionSyntaxError(
        `Expected "${kind}"`,
        this.current.position
      );
    }
    this.advance();
  }

  private advance(): void {
    this.current = this.lexer.next();
  }

  private isCurrent(kind: TokenKind): boolean {
    return this.current.kind === kind;
  }

  private assertDepth(depth: number): void {
    if (depth > MAX_EXPRESSION_AST_DEPTH) {
      throw new ExpressionSyntaxError(
        `Expression is nested too deeply; use at most ${MAX_EXPRESSION_AST_DEPTH} levels`,
        this.current.position
      );
    }
  }

  private recordNode(position: number): void {
    this.nodeCount += 1;
    if (this.nodeCount > MAX_EXPRESSION_AST_NODES) {
      throw new ExpressionSyntaxError(
        `Expression is too large; use at most ${MAX_EXPRESSION_AST_NODES} operations and values`,
        position
      );
    }
  }
}

function isOperator(kind: TokenKind): kind is Operator {
  return (
    kind === "+" ||
    kind === "-" ||
    kind === "*" ||
    kind === "/" ||
    kind === "^"
  );
}

function bindingPower(operator: Operator): readonly [number, number] {
  switch (operator) {
    case "+":
    case "-":
      return [10, 11];
    case "*":
    case "/":
      return [20, 21];
    case "^":
      return [40, 40];
  }
}

export function parseExpression(
  source: string,
  options: ParseExpressionOptions = {}
): ExpressionNode {
  const variable =
    options.variable ?? (options.allowVariable === false ? "none" : "x");
  return new Parser(source, variable).parse();
}

export function evaluateExpression(
  ast: ExpressionNode,
  variables: number | ExpressionVariables = {}
): number {
  assertExpressionAstResources(ast);
  const environment =
    typeof variables === "number" ? { x: variables, t: variables } : variables;
  return evaluateNode(ast, environment);
}

/**
 * Safely evaluate an editable scalar that must not contain variables.
 *
 * This is the shared entry point for coordinate and bound fields: it uses the
 * whitelisted expression AST, accepts a typographic minus copied from a math
 * label, and rejects undefined or non-finite real values.
 */
export function evaluateFiniteConstantExpression(source: string): number {
  const normalized = source.trim().replace(/−/g, "-");
  const value = evaluateExpression(
    parseExpression(normalized, { variable: "none" })
  );
  if (!Number.isFinite(value)) {
    throw new Error("The constant expression must evaluate to a finite real number.");
  }
  return value;
}

function evaluateNode(
  ast: ExpressionNode,
  variables: ExpressionVariables
): number {
  switch (ast.type) {
    case "number":
    case "constant":
      return ast.value;
    case "variable": {
      const value = variables[ast.name];
      if (value === undefined) {
        throw new Error(`No value was supplied for ${ast.name}.`);
      }
      return value;
    }
    case "unary": {
      const value = evaluateNode(ast.argument, variables);
      return ast.operator === "-" ? -value : value;
    }
    case "binary": {
      const left = evaluateNode(ast.left, variables);
      const right = evaluateNode(ast.right, variables);
      switch (ast.operator) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "^":
          return left ** right;
      }
    }
    case "function": {
      const definition = ownFunction(ast.name);
      if (!definition) throw new Error(`Unsupported function "${ast.name}"`);
      if (
        ast.arguments.length < definition.minimumArguments ||
        ast.arguments.length > definition.maximumArguments
      ) {
        throw new Error(`Invalid argument count for function "${ast.name}"`);
      }
      return definition.evaluate(
        ...ast.arguments.map((item) => evaluateNode(item, variables))
      );
    }
  }
}

export type CompiledExpression = (value: number) => number;

export function compileExpression(
  value: string | ExpressionNode,
  variable: ExpressionVariable = "x"
): CompiledExpression {
  const ast =
    typeof value === "string" ? parseExpression(value, { variable }) : value;
  assertExpressionAstResources(ast);
  return (input: number) => evaluateNode(ast, { [variable]: input });
}

export function renderExpressionLatex(ast: ExpressionNode): string {
  assertExpressionAstResources(ast);
  return renderNode(ast, 0);
}

function renderNode(ast: ExpressionNode, parentPrecedence: number): string {
  switch (ast.type) {
    case "number":
      return renderNumber(ast.lexeme);
    case "variable":
      return ast.name;
    case "constant":
      return ast.name === "pi" ? "\\pi" : "e";
    case "unary": {
      const precedence = 30;
      const text = `${ast.operator}${renderNode(ast.argument, precedence)}`;
      return precedence < parentPrecedence ? latexParentheses(text) : text;
    }
    case "binary": {
      const precedence = operatorPrecedence(ast.operator);
      let text: string;
      if (ast.operator === "/") {
        text = `\\frac{${renderNode(ast.left, 0)}}{${renderNode(
          ast.right,
          0
        )}}`;
      } else if (ast.operator === "^") {
        text = `{${renderNode(ast.left, precedence + 1)}}^{${renderNode(
          ast.right,
          0
        )}}`;
      } else {
        const separator = ast.operator === "*" ? " \\cdot " : ` ${ast.operator} `;
        text = `${renderNode(ast.left, precedence)}${separator}${renderNode(
          ast.right,
          precedence + (ast.operator === "-" ? 1 : 0)
        )}`;
      }
      return precedence < parentPrecedence ? latexParentheses(text) : text;
    }
    case "function": {
      const values = ast.arguments.map((item) => renderNode(item, 0));
      if (ast.name === "sqrt") return `\\sqrt{${values[0]}}`;
      if (ast.name === "abs") return `\\left|${values[0]}\\right|`;
      if (ast.name === "floor") {
        return `\\left\\lfloor ${values[0]} \\right\\rfloor`;
      }
      if (ast.name === "ceil") {
        return `\\left\\lceil ${values[0]} \\right\\rceil`;
      }
      if (ast.name === "log" && values.length === 2) {
        return `\\log_{${values[1]}}\\left(${values[0]}\\right)`;
      }
      const name =
        ast.name === "ln" || ast.name === "log"
          ? `\\${ast.name}`
          : `\\operatorname{${ast.name}}`;
      return `${name}\\left(${values.join(", ")}\\right)`;
    }
  }
}

function renderNumber(lexeme: string): string {
  const match = lexeme.match(
    /^((?:(?:\d+(?:\.\d*)?)|(?:\.\d+)))[eE]([+-]?\d+)$/
  );
  return match
    ? `${match[1]} \\times 10^{${Number(match[2])}}`
    : lexeme;
}

function latexParentheses(value: string): string {
  return `\\left(${value}\\right)`;
}

function operatorPrecedence(operator: Operator): number {
  return operator === "+" || operator === "-"
    ? 10
    : operator === "*" || operator === "/"
      ? 20
      : 40;
}

export function serializeExpressionAst(ast: ExpressionNode): string {
  assertExpressionAstResources(ast);
  switch (ast.type) {
    case "number":
      return `n:${Object.is(ast.value, -0) ? "0" : String(ast.value)}`;
    case "variable":
      return `v:${ast.name}`;
    case "constant":
      return `c:${ast.name}`;
    case "unary":
      return `u:${ast.operator}(${serializeExpressionAst(ast.argument)})`;
    case "binary":
      return `b:${ast.operator}(${serializeExpressionAst(
        ast.left
      )},${serializeExpressionAst(ast.right)})`;
    case "function":
      return `f:${ast.name}(${ast.arguments
        .map(serializeExpressionAst)
        .join(",")})`;
  }
}

/** Reject forged, cyclic, oversized, or unsupported ASTs received by workers. */
export function assertExpressionAstResources(ast: ExpressionNode): void {
  assertExpressionAstResourcesWithFactory(ast, (message) => new Error(message));
}

function assertExpressionAstResourcesWithFactory(
  ast: ExpressionNode,
  makeError: (message: string) => Error
): void {
  const active = new Set<object>();
  const stack: Array<{ node: unknown; depth: number; leaving: boolean }> = [
    { node: ast, depth: 1, leaving: false }
  ];
  let nodeCount = 0;
  while (stack.length > 0) {
    const entry = stack.pop() as {
      node: unknown;
      depth: number;
      leaving: boolean;
    };
    if (typeof entry.node !== "object" || entry.node === null) {
      throw makeError("Malformed expression tree.");
    }
    if (entry.leaving) {
      active.delete(entry.node);
      continue;
    }
    if (active.has(entry.node)) {
      throw makeError("Expression tree cannot contain cycles.");
    }
    if (entry.depth > MAX_EXPRESSION_AST_DEPTH) {
      throw makeError(
        `Expression is nested too deeply; use at most ${MAX_EXPRESSION_AST_DEPTH} levels.`
      );
    }
    nodeCount += 1;
    if (nodeCount > MAX_EXPRESSION_AST_NODES) {
      throw makeError(
        `Expression is too large; use at most ${MAX_EXPRESSION_AST_NODES} operations and values.`
      );
    }
    active.add(entry.node);
    stack.push({ ...entry, leaving: true });
    const node = entry.node as Partial<ExpressionNode>;
    switch (node.type) {
      case "number":
        if (!Number.isFinite(node.value)) {
          throw makeError("Number nodes must be finite.");
        }
        if (typeof node.lexeme !== "string") {
          throw makeError("Malformed number node.");
        }
        break;
      case "variable":
        if (node.name !== "x" && node.name !== "t") {
          throw makeError("Only the variables x and t are supported.");
        }
        break;
      case "constant":
        if (
          (node.name !== "pi" && node.name !== "e") ||
          node.value !== (node.name === "pi" ? Math.PI : Math.E)
        ) {
          throw makeError("Unsupported expression constant.");
        }
        break;
      case "unary":
        if (node.operator !== "+" && node.operator !== "-") {
          throw makeError("Unsupported unary operator.");
        }
        stack.push({
          node: node.argument,
          depth: entry.depth + 1,
          leaving: false
        });
        break;
      case "binary":
        if (!["+", "-", "*", "/", "^"].includes(node.operator as string)) {
          throw makeError("Unsupported binary operator.");
        }
        stack.push({
          node: node.right,
          depth: entry.depth + 1,
          leaving: false
        });
        stack.push({
          node: node.left,
          depth: entry.depth + 1,
          leaving: false
        });
        break;
      case "function": {
        const definition =
          typeof node.name === "string" ? ownFunction(node.name) : undefined;
        if (!definition || !Array.isArray(node.arguments)) {
          throw makeError("Unsupported function node.");
        }
        if (
          node.arguments.length < definition.minimumArguments ||
          node.arguments.length > definition.maximumArguments
        ) {
          throw makeError(`Invalid argument count for function "${node.name}".`);
        }
        for (let index = node.arguments.length - 1; index >= 0; index -= 1) {
          stack.push({
            node: node.arguments[index],
            depth: entry.depth + 1,
            leaving: false
          });
        }
        break;
      }
      default:
        throw makeError("Unknown expression node type.");
    }
  }
}

function ownFunction(name: string): FunctionDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(FUNCTIONS, name)
    ? FUNCTIONS[name]
    : undefined;
}
