/** Viewport + GUI shared part palette (must stay in sync). */
export const PART_COLORS = [
  0x6aa9ff,
  0xff8f6a,
  0x7ddea2,
  0xd4a5ff,
  0xffd166,
  0x4ecdc4,
  0xff6b9d,
  0xa8dadc,
] as const;

export function partColorHex(index: number): number {
  return PART_COLORS[index % PART_COLORS.length];
}

export function partColorCss(index: number): string {
  return `#${partColorHex(index).toString(16).padStart(6, '0')}`;
}
