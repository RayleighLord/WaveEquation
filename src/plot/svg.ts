const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tagName: K,
  className?: string
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, tagName);
  if (className) {
    element.setAttribute("class", className);
  }
  return element;
}

export function setSvgAttributes(
  element: Element,
  attributes: Record<string, string | number | boolean | null | undefined>
): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) {
      element.removeAttribute(name);
      continue;
    }
    element.setAttribute(name, value === true ? "" : String(value));
  }
}

export function compactNumber(value: number, precision = 1000): string {
  const rounded = Math.round(value * precision) / precision;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function formatAxisValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (Math.abs(value) < 1e-12) {
    return "0";
  }
  const magnitude = Math.abs(value);
  if (magnitude >= 10_000 || magnitude < 0.001) {
    return value.toExponential(1).replace(/\.0e/, "e");
  }
  return Number(value.toPrecision(3)).toString();
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
