import { describe, expect, it } from "vitest";
import {
  assertExpressionAstResources,
  evaluateFiniteConstantExpression,
  evaluateExpression,
  ExpressionSyntaxError,
  parseExpression,
  renderExpressionLatex
} from "../math/expression";
import type { ExpressionNode } from "../types";

describe("safe expression parser", () => {
  it("uses mathematical precedence and right-associative powers", () => {
    expect(evaluateExpression(parseExpression("-2^2"))).toBe(-4);
    expect(evaluateExpression(parseExpression("2^3^2"))).toBe(512);
    expect(evaluateExpression(parseExpression("2 / 3 * 6"))).toBe(4);
  });

  it("accepts only the variable selected for the field", () => {
    const initial = parseExpression("exp(-x^2)", { variable: "x" });
    const boundary = parseExpression("sin(pi * t)", { variable: "t" });
    expect(evaluateExpression(initial, { x: 2 })).toBeCloseTo(Math.exp(-4));
    expect(evaluateExpression(boundary, { t: 0.5 })).toBeCloseTo(1);
    expect(() => parseExpression("x + t", { variable: "x" })).toThrow(
      /Only the variable x/
    );
    expect(() => parseExpression("x", { variable: "none" })).toThrow(
      ExpressionSyntaxError
    );
  });

  it("evaluates finite constant-only expressions for editable coordinates", () => {
    expect(evaluateFiniteConstantExpression("pi / 2")).toBeCloseTo(Math.PI / 2);
    expect(evaluateFiniteConstantExpression("π / 2")).toBeCloseTo(Math.PI / 2);
    expect(evaluateFiniteConstantExpression("log(2)")).toBeCloseTo(Math.log(2));
    expect(evaluateFiniteConstantExpression("log(8, 2)")).toBe(3);
    expect(evaluateFiniteConstantExpression("sqrt(9)")).toBe(3);
    expect(evaluateFiniteConstantExpression("−pi")).toBeCloseTo(-Math.PI);
  });

  it.each(["x", "t", "sqrt(-1)", "log(-1)", "1 / 0"])(
    "rejects invalid finite constant input %s",
    (source) => {
      expect(() => evaluateFiniteConstantExpression(source)).toThrow();
    }
  );

  it("rejects implicit multiplication and executable JavaScript syntax", () => {
    expect(() => parseExpression("2x")).toThrow(/Implicit multiplication/);
    expect(() => parseExpression("globalThis.alert(1)")).toThrow(
      ExpressionSyntaxError
    );
    expect(() => parseExpression("x; throw 1")).toThrow(ExpressionSyntaxError);
  });

  it("renders expressions without evaluating source code", () => {
    const ast = parseExpression("sqrt(1 - x^2) / 2");
    expect(renderExpressionLatex(ast)).toContain("\\frac");
    expect(renderExpressionLatex(ast)).toContain("\\sqrt");
  });

  it("rejects forged and cyclic trees at the evaluator boundary", () => {
    const forged = {
      type: "function",
      name: "constructor",
      arguments: []
    } as unknown as ExpressionNode;
    expect(() => assertExpressionAstResources(forged)).toThrow(
      /Unsupported function/
    );

    const cyclic = {
      type: "unary",
      operator: "+"
    } as unknown as Extract<ExpressionNode, { type: "unary" }>;
    cyclic.argument = cyclic;
    expect(() => assertExpressionAstResources(cyclic)).toThrow(/cycles/);
  });
});
