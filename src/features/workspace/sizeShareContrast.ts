export type RgbColor = { r: number; g: number; b: number; a: number };

function channel(value: string) {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.min(255, parsed)) : null;
}

export function parseCssColor(value: string | undefined): RgbColor | null {
  const input = value?.trim().toLowerCase();
  if (!input) return null;
  const hex = input.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i);
  if (hex) {
    const raw = hex[1];
    const expanded = raw.length <= 4 ? [...raw].map((part) => part + part).join("") : raw;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1
    };
  }
  const rgb = input.match(/^rgba?\(([^)]+)\)$/);
  if (!rgb) return null;
  const parts = rgb[1].split(",");
  const r = channel(parts[0]); const g = channel(parts[1]); const b = channel(parts[2]);
  if (r === null || g === null || b === null) return null;
  const a = parts[3] == null ? 1 : Math.max(0, Math.min(1, Number(parts[3].trim())));
  return Number.isFinite(a) ? { r, g, b, a } : null;
}

export function mixRgb(low: RgbColor, high: RgbColor, share: number): RgbColor {
  const amount = Math.max(0, Math.min(1, share));
  return {
    r: low.r + (high.r - low.r) * amount,
    g: low.g + (high.g - low.g) * amount,
    b: low.b + (high.b - low.b) * amount,
    a: low.a + (high.a - low.a) * amount
  };
}

export function compositeOverWhite(color: RgbColor): RgbColor {
  return { r: color.r * color.a + 255 * (1 - color.a), g: color.g * color.a + 255 * (1 - color.a), b: color.b * color.a + 255 * (1 - color.a), a: 1 };
}

export function relativeLuminance(color: RgbColor) {
  const linear = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

export function contrastRatio(first: RgbColor, second: RgbColor) {
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

export function chooseSizeShareTextColor(fill: RgbColor | null): "light" | "dark" {
  if (!fill) return "dark";
  const composited = compositeOverWhite(fill);
  return contrastRatio(composited, { r: 255, g: 255, b: 255, a: 1 }) >=
    contrastRatio(composited, { r: 31, g: 31, b: 31, a: 1 }) ? "light" : "dark";
}

export function sizeShareTextTone(low: string | undefined, high: string | undefined, share: number) {
  const lowColor = parseCssColor(low) ?? parseCssColor("#dceaf7")!;
  const highColor = parseCssColor(high) ?? parseCssColor("#3979b7")!;
  return chooseSizeShareTextColor(mixRgb(lowColor, highColor, share));
}
