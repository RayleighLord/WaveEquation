import type { ExpressionNode } from "../types";

export interface ExpressionFeature {
  /** A localized feature, such as the centre of a Gaussian. */
  center?: number;
  /** Gaussian scale or oscillation wavelength, in the expression's variable. */
  width: number;
}

type Polynomial = [number, number, number];

/**
 * Recognize useful scales directly from the safe AST. This is deliberately a
 * diagnostic, not a claim that arbitrary expressions can be fully resolved by
 * a finite collection of probes.
 */
export function expressionFeatures(ast: ExpressionNode): ExpressionFeature[] {
  const features: ExpressionFeature[] = [];
  visit(ast, (node) => {
    if (node.type !== "function" || node.arguments.length !== 1) return;
    const argument = polynomial(node.arguments[0] as ExpressionNode);
    if (!argument) return;
    if (node.name === "exp" && argument[2] < 0) {
      const center = -argument[1] / (2 * argument[2]);
      const width = 1 / Math.sqrt(-argument[2]);
      if (Number.isFinite(center) && Number.isFinite(width) && width > 0) {
        features.push({ center, width });
      }
    } else if (
      (node.name === "sin" || node.name === "cos" || node.name === "tan") &&
      argument[2] === 0 && argument[1] !== 0
    ) {
      const width = 2 * Math.PI / Math.abs(argument[1]);
      if (Number.isFinite(width) && width > 0) features.push({ width });
    }
  });
  return features;
}

/** Resolve known localized integrands even when the ordinary probes miss them. */
export function expressionIntegrationBreakpoints(ast: ExpressionNode): number[] {
  const points = expressionFeatures(ast).flatMap((feature) =>
    feature.center === undefined ? [] :
      [-8, -4, -2, -1, 0, 1, 2, 4, 8].map(
        (offset) => (feature.center as number) + offset * feature.width
      )
  );
  visit(ast, (node) => {
    if (node.type !== "function" || !["sign", "abs"].includes(node.name)) return;
    const argument = node.arguments[0] && polynomial(node.arguments[0]);
    if (argument && argument[2] === 0 && argument[1] !== 0) {
      points.push(-argument[0] / argument[1]);
    }
  });
  return [...new Set(points.filter(Number.isFinite))].sort((a, b) => a - b);
}

/** Conservative hint only; the accepted grid supplies the final jump test. */
export function expressionMayJump(ast: ExpressionNode): boolean {
  let jump = false;
  visit(ast, (node) => {
    if (
      node.type === "function" &&
      ["sign", "floor", "ceil", "round"].includes(node.name) &&
      node.arguments.some(containsVariable)
    ) jump = true;
  });
  return jump;
}

/** Exact, cheap proof for the common literal-zero initial/boundary data. */
export function expressionIsZero(ast: ExpressionNode): boolean {
  return ast.type === "number" ? ast.value === 0 :
    ast.type === "unary" && expressionIsZero(ast.argument);
}

function containsVariable(ast: ExpressionNode): boolean {
  let found = false;
  visit(ast, (node) => { if (node.type === "variable") found = true; });
  return found;
}

function visit(ast: ExpressionNode, callback: (node: ExpressionNode) => void): void {
  callback(ast);
  if (ast.type === "unary") visit(ast.argument, callback);
  else if (ast.type === "binary") {
    visit(ast.left, callback);
    visit(ast.right, callback);
  } else if (ast.type === "function") ast.arguments.forEach((node) => visit(node, callback));
}

function polynomial(ast: ExpressionNode): Polynomial | null {
  if (ast.type === "number" || ast.type === "constant") return [ast.value, 0, 0];
  if (ast.type === "variable") return [0, 1, 0];
  if (ast.type === "unary") {
    const value = polynomial(ast.argument);
    return value && (ast.operator === "-" ? value.map((v) => -v) as Polynomial : value);
  }
  if (ast.type !== "binary") return null;
  const left = polynomial(ast.left);
  const right = polynomial(ast.right);
  if (!left || !right) return null;
  let result: Polynomial | null = null;
  if (ast.operator === "+" || ast.operator === "-") {
    const sign = ast.operator === "+" ? 1 : -1;
    result = left.map((value, index) => value + sign * (right[index] as number)) as Polynomial;
  } else if (ast.operator === "*") result = multiply(left, right);
  else if (ast.operator === "/" && right[1] === 0 && right[2] === 0 && right[0] !== 0) {
    result = left.map((value) => value / right[0]) as Polynomial;
  } else if (ast.operator === "^" && right[1] === 0 && right[2] === 0) {
    if (right[0] === 0) result = [1, 0, 0];
    else if (right[0] === 1) result = left;
    else if (right[0] === 2) result = multiply(left, left);
  }
  return result?.every(Number.isFinite) ? result : null;
}

function multiply(left: Polynomial, right: Polynomial): Polynomial | null {
  if (left[2] * right[2] !== 0 || left[1] * right[2] + left[2] * right[1] !== 0) return null;
  return [
    left[0] * right[0],
    left[0] * right[1] + left[1] * right[0],
    left[0] * right[2] + left[1] * right[1] + left[2] * right[0]
  ];
}
