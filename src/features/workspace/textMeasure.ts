export function getTextMeasureUnits(value: string) {
  return Array.from(value).reduce((sum, char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return sum + (codePoint >= 0x2e80 ? 2 : 1);
  }, 0);
}
