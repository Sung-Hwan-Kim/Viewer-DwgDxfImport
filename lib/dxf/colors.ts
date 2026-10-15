/**
 * AutoCAD Color Index (ACI) 256색 팔레트.
 *
 * 팔레트 구성 규칙(1~9 고정색, 10~249의 24색상 × 10단계, 250~255 그레이스케일)은
 * CADCraft `crates/color` (MIT OR Apache-2.0, storytold/cadcraft)의 공개 구현과
 * 동일한 공개 사양을 따른다.
 */

export type Rgb = readonly [number, number, number];

const BASE: Rgb[] = [
  [0, 0, 0], // 0 = ByBlock 자리표시자
  [255, 0, 0],
  [255, 255, 0],
  [0, 255, 0],
  [0, 255, 255],
  [0, 0, 255],
  [255, 0, 255],
  [255, 255, 255],
  [128, 128, 128],
  [192, 192, 192],
];

/** 색상 단계 0~24 (적 → 황 → 녹 → 청 → 남 → 자 → 적)의 채널 비율. */
function hueFractions(h: number): [number, number, number] {
  const seg = Math.floor(h / 4);
  const t = (h % 4) / 4;
  switch (seg) {
    case 0: return [1, t, 0];
    case 1: return [1 - t, 1, 0];
    case 2: return [0, 1, t];
    case 3: return [0, 1 - t, 1];
    case 4: return [t, 0, 1];
    default: return [1, 0, 1 - t];
  }
}

function buildPalette(): Rgb[] {
  const p: Rgb[] = new Array(256).fill([0, 0, 0] as Rgb);
  for (let i = 0; i < BASE.length; i++) p[i] = BASE[i];

  const values = [255, 165, 127, 76, 38];
  for (let i = 10; i < 250; i++) {
    const hue = Math.floor((i - 10) / 10); // 0..23, 15도 간격
    const sub = i % 10;
    const v = values[Math.floor(sub / 2)] ?? 255;
    const half = sub % 2 === 1;
    const [r, g, b] = hueFractions(hue);
    const ch = (f: number) => {
      const scaled = half ? 0.5 + 0.5 * f : f;
      return Math.min(255, Math.max(0, Math.floor(v * scaled)));
    };
    p[i] = [ch(r), ch(g), ch(b)];
  }

  const greys = [51, 91, 132, 173, 214, 255];
  for (let k = 0; k < greys.length; k++) p[250 + k] = [greys[k], greys[k], greys[k]];
  return p;
}

export const ACI_PALETTE: readonly Rgb[] = buildPalette();

export function aciToRgb(index: number): Rgb {
  return ACI_PALETTE[index] ?? ([255, 255, 255] as Rgb);
}

/** 0xRRGGBB 정수로. */
export function aciToHex(index: number): number {
  const [r, g, b] = aciToRgb(index);
  return (r << 16) | (g << 8) | b;
}

/**
 * ACI 7(흰/검)은 배경에 따라 뒤집는다 — CAD 프로그램이 그리는 방식.
 * 그 외의 색은 지정된 RGB 그대로 쓴다.
 */
export function displayHex(index: number, darkBackground: boolean): number {
  if (index === 7 || index === 0) return darkBackground ? 0xffffff : 0x000000;
  return aciToHex(index);
}
