import katex from "katex";

import { formatAxisValue } from "./svg";
import type { AxisValueNotation } from "./ticks";

const PI_RATIONAL_MAXIMUM_DENOMINATOR = 24;
const PI_RATIONAL_TOLERANCE = 1e-9;

/** Convert the plot's compact numeric format into presentation-quality TeX. */
export function axisValueToLatex(
  value: number,
  notation: AxisValueNotation = "decimal"
): string {
  if (notation === "pi") {
    return piValueToLatex(value);
  }
  return decimalValueToLatex(value);
}

/** Format a coordinate as a familiar rational multiple of pi when possible. */
export function piValueToLatex(value: number): string {
  if (!Number.isFinite(value)) {
    return String.raw`\text{—}`;
  }
  const ratio = value / Math.PI;
  if (Math.abs(ratio) < 1e-12) {
    return "0";
  }

  const rational = nearestRational(ratio, PI_RATIONAL_MAXIMUM_DENOMINATOR);
  if (
    Math.abs(ratio - rational.numerator / rational.denominator) <=
    PI_RATIONAL_TOLERANCE * Math.max(1, Math.abs(ratio))
  ) {
    return rationalPiToLatex(rational.numerator, rational.denominator);
  }

  const coefficient = decimalValueToLatex(ratio);
  if (coefficient === "1") return String.raw`\pi`;
  if (coefficient === "-1") return String.raw`-\pi`;
  return String.raw`${coefficient}\pi`;
}

/** Plain-text counterpart used by accessible plot descriptions. */
export function axisValueToText(
  value: number,
  notation: AxisValueNotation = "decimal"
): string {
  if (notation === "decimal") {
    return formatAxisValue(value);
  }
  if (!Number.isFinite(value)) {
    return "—";
  }
  const ratio = value / Math.PI;
  if (Math.abs(ratio) < 1e-12) {
    return "0";
  }
  const rational = nearestRational(ratio, PI_RATIONAL_MAXIMUM_DENOMINATOR);
  if (
    Math.abs(ratio - rational.numerator / rational.denominator) <=
    PI_RATIONAL_TOLERANCE * Math.max(1, Math.abs(ratio))
  ) {
    const sign = rational.numerator < 0 ? "−" : "";
    const magnitude = Math.abs(rational.numerator);
    if (rational.denominator === 1) {
      return magnitude === 1 ? `${sign}π` : `${sign}${magnitude}π`;
    }
    const numerator = magnitude === 1 ? "π" : `${magnitude}π`;
    return `${sign}${numerator}/${rational.denominator}`;
  }
  return `${formatAxisValue(ratio)}π`;
}

/**
 * Format a coordinate as source that the safe constant-expression parser can
 * read back. Presentation labels deliberately use forms such as `−3π/2`;
 * editable fields need explicit ASCII operators, as in `-3 * pi / 2`.
 */
export function axisValueToInputSource(
  value: number,
  notation: AxisValueNotation = "decimal"
): string {
  if (!Number.isFinite(value)) return "";
  if (Object.is(value, -0) || Math.abs(value) < 1e-12) return "0";
  if (notation === "decimal") return String(Number(value.toFixed(10)));

  const ratio = value / Math.PI;
  const rational = nearestRational(ratio, PI_RATIONAL_MAXIMUM_DENOMINATOR);
  if (
    Math.abs(ratio - rational.numerator / rational.denominator) <=
    PI_RATIONAL_TOLERANCE * Math.max(1, Math.abs(ratio))
  ) {
    const sign = rational.numerator < 0 ? "-" : "";
    const magnitude = Math.abs(rational.numerator);
    const numerator = magnitude === 1 ? "pi" : `${magnitude} * pi`;
    return rational.denominator === 1
      ? `${sign}${numerator}`
      : `${sign}${numerator} / ${rational.denominator}`;
  }
  return `${String(Number(ratio.toFixed(10)))} * pi`;
}

function decimalValueToLatex(value: number): string {
  const formatted = formatAxisValue(value);
  const scientific = formatted.match(/^(-?\d+(?:\.\d+)?)e([+-]?\d+)$/i);
  if (!scientific) return formatted === "—" ? String.raw`\text{—}` : formatted;
  const coefficient = scientific[1] ?? "1";
  const exponent = Number(scientific[2] ?? "0");
  if (coefficient === "1") return String.raw`10^{${exponent}}`;
  if (coefficient === "-1") return String.raw`-10^{${exponent}}`;
  return String.raw`${coefficient}\mathbin{\times}10^{${exponent}}`;
}

function nearestRational(
  value: number,
  maximumDenominator: number
): { numerator: number; denominator: number } {
  let bestNumerator = Math.round(value);
  let bestDenominator = 1;
  let bestError = Math.abs(value - bestNumerator);
  for (let denominator = 2; denominator <= maximumDenominator; denominator += 1) {
    const numerator = Math.round(value * denominator);
    const error = Math.abs(value - numerator / denominator);
    if (error < bestError) {
      bestNumerator = numerator;
      bestDenominator = denominator;
      bestError = error;
    }
  }
  const divisor = greatestCommonDivisor(Math.abs(bestNumerator), bestDenominator);
  return {
    numerator: bestNumerator / divisor,
    denominator: bestDenominator / divisor
  };
}

function rationalPiToLatex(numerator: number, denominator: number): string {
  const sign = numerator < 0 ? "-" : "";
  const magnitude = Math.abs(numerator);
  if (denominator === 1) {
    if (magnitude === 1) return String.raw`${sign}\pi`;
    return String.raw`${sign}${magnitude}\pi`;
  }
  const numeratorLatex = magnitude === 1 ? String.raw`\pi` : String.raw`${magnitude}\pi`;
  return String.raw`${sign}\frac{${numeratorLatex}}{${denominator}}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}

/** Retained KaTeX update: rerender only when the TeX source actually changes. */
export function renderLatex(
  element: HTMLElement,
  source: string,
  options: { displayMode?: boolean; ariaHidden?: boolean } = {}
): void {
  if (element.dataset.latexSource === source) return;
  katex.render(source, element, {
    displayMode: options.displayMode ?? false,
    throwOnError: false,
    strict: "ignore",
    output: "htmlAndMathml"
  });
  element.dataset.latexSource = source;
  if (options.ariaHidden) element.setAttribute("aria-hidden", "true");
}
