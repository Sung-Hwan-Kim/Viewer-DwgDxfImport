import { displayHex } from './colors';
import { bulgeToPoints } from './parser';
import type {
  DxfAcadTable,
  DxfArc,
  DxfCircle,
  DxfDocument,
  DxfEllipse,
  DxfEntity,
  DxfEntityBase,
  DxfHatch,
  DxfInsert,
  DxfLayout,
  DxfLwPolyline,
  DxfMLeader,
  DxfMText,
  DxfPolyline,
  DxfSolid,
  DxfSpline,
  DxfText,
  DxfViewport,
  Point3,
} from './types';

/**
 * DXF 문서를 "그릴 수 있는 것들"로 평탄화한다.
 *
 * 블록 전개(INSERT), OCS→WCS 변환, 곡선 테셀레이션, 선종류 대시 분해를 모두
 * 여기서 끝내므로, three.js 레이어는 좌표 배열을 버퍼에 넣기만 하면 된다.
 * 순수 함수라 워커에서 돌리고 결과만 메인 스레드로 넘길 수 있다.
 */

// ------------------------------------------------------------------- 결과 타입

/** 한 줄짜리 폴리라인 경로. xyz 가 번갈아 들어간 평면 배열. */
export interface FlatPath {
  coords: number[];
  layer: string;
  color: number;
  entityType: string;
  /**
   * 선굵기, **밀리미터**. DXF 의 370 은 1/100 mm 단위에 음수로 상속 규칙
   * (-1 BYLAYER, -2 BYBLOCK, -3 기본값)을 섞어 쓰는데, 여기서는 그걸 다 풀어
   * 실제 굵기만 남긴다. 0 은 "가장 가는 선"(화면에서 1 px)을 뜻한다.
   */
  weight: number;
}

export interface FlatText {
  text: string;
  x: number;
  y: number;
  z: number;
  height: number;
  /** degree, 반시계 */
  rotation: number;
  widthFactor: number;
  /** 0=left 1=center 2=right */
  hAlign: number;
  /** 0=baseline 1=bottom 2=middle 3=top */
  vAlign: number;
  /** 0 이면 줄바꿈 없음 */
  maxWidth: number;
  layer: string;
  color: number;
  /**
   * 뷰포트 창에 맞춰 잘라 낼 반평면 [nx, ny, nz, d] 목록.
   * nx·x + ny·y + d ≥ 0 인 쪽만 보인다. 배치의 뷰포트 안 문자에만 붙는다.
   * (선·면은 평탄화 단계에서 좌표를 잘라 두지만, 문자는 글리프를 자를 수
   *  없어 렌더러가 GPU 클리핑으로 처리한다.)
   */
  clip?: number[][];
}

/** 채워진 면(SOLID, 솔리드 HATCH). 바깥 루프 + 구멍들. */
export interface FlatFill {
  /** 각 루프는 xy 가 번갈아 들어간 평면 배열 */
  loops: number[][];
  layer: string;
  color: number;
  entityType: string;
}

export interface FlatScene {
  paths: FlatPath[];
  texts: FlatText[];
  fills: FlatFill[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** 레이어명 → 화면에 실제로 등장한 엔티티 수 */
  layerCounts: Record<string, number>;
  stats: {
    entities: number;
    segments: number;
    truncated: boolean;
  };
}

export interface FlattenOptions {
  /** 어두운 배경인가 (ACI 7 의 흑/백 결정) */
  darkBackground: boolean;
  /**
   * 그릴 공간. null 이면 모형 공간, 문자열이면 그 이름의 배치(레이아웃).
   * 배치 이름은 DxfDocument.layouts 의 name 과 대소문자 구분 없이 맞춘다.
   */
  space: string | null;
  /** 배치를 그릴 때 뷰포트 안에 모형 공간 내용까지 그릴지 */
  viewportContents: boolean;
  /** 배치를 그릴 때 용지 테두리(LIMMIN/LIMMAX)를 함께 그릴지 */
  paperBorder: boolean;
  /** 꺼짐/동결 레이어를 건너뛸지 */
  respectLayerState: boolean;
  /** 선종류 대시를 기하로 분해할지 */
  applyLineTypes: boolean;
  /** 전체 원 하나를 몇 조각으로 나눌지 */
  circleSegments: number;
  /** 안전 한계: 이보다 많은 선분이 나오면 중단 */
  maxSegments: number;
}

export const DEFAULT_FLATTEN_OPTIONS: FlattenOptions = {
  darkBackground: true,
  space: null,
  viewportContents: true,
  paperBorder: true,
  respectLayerState: true,
  applyLineTypes: true,
  circleSegments: 96,
  maxSegments: 4_000_000,
};

const MAX_BLOCK_DEPTH = 16;

// --------------------------------------------------------------------- 행렬

/** 3×4 아핀 변환. 행 우선 [m00 m01 m02 tx  m10 ... ]. */
export type Mat34 = Float64Array;

export function identity(): Mat34 {
  const m = new Float64Array(12);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  return m;
}

export function multiply(a: Mat34, b: Mat34): Mat34 {
  const out = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 4 + c] =
        a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
    }
    out[r * 4 + 3] =
      a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
  }
  return out;
}

function apply(m: Mat34, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

/** 회전 없는 균일 스케일 추정 — 대시 길이와 테셀레이션 세분도에 쓴다. */
function scaleOf(m: Mat34): number {
  const sx = Math.hypot(m[0], m[4], m[8]);
  const sy = Math.hypot(m[1], m[5], m[9]);
  return (sx + sy) / 2 || 1;
}

/**
 * 임의 축 알고리즘(Arbitrary Axis Algorithm): 압출 벡터(법선)로 정의된
 * OCS 를 WCS 로 바꾸는 행렬을 만든다.
 */
function ocsMatrix(n: Point3): Mat34 {
  const len = Math.hypot(n.x, n.y, n.z);
  if (len < 1e-12) return identity();
  const nx = n.x / len;
  const ny = n.y / len;
  const nz = n.z / len;
  // 이미 +Z 면 변환이 필요 없다.
  if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) return identity();

  let ax: [number, number, number];
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) {
    // Wy × N
    ax = [1 * nz - 0 * ny, 0 * nx - 0 * nz, 0 * ny - 1 * nx];
  } else {
    // Wz × N
    ax = [0 * nz - 1 * ny, 1 * nx - 0 * nz, 0 * ny - 0 * nx];
  }
  let l = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  ax = [ax[0] / l, ax[1] / l, ax[2] / l];

  // Ay = N × Ax
  let ay: [number, number, number] = [
    ny * ax[2] - nz * ax[1],
    nz * ax[0] - nx * ax[2],
    nx * ax[1] - ny * ax[0],
  ];
  l = Math.hypot(ay[0], ay[1], ay[2]) || 1;
  ay = [ay[0] / l, ay[1] / l, ay[2] / l];

  const m = new Float64Array(12);
  m[0] = ax[0]; m[1] = ay[0]; m[2] = nx; m[3] = 0;
  m[4] = ax[1]; m[5] = ay[1]; m[6] = ny; m[7] = 0;
  m[8] = ax[2]; m[9] = ay[2]; m[10] = nz; m[11] = 0;
  return m;
}

function insertMatrix(e: DxfInsert, colOffset: number, rowOffset: number): Mat34 {
  const a = (e.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const m = new Float64Array(12);
  // 회전(Z) × 스케일
  m[0] = cos * e.scale.x; m[1] = -sin * e.scale.y; m[2] = 0;
  m[4] = sin * e.scale.x; m[5] = cos * e.scale.y; m[6] = 0;
  m[8] = 0; m[9] = 0; m[10] = e.scale.z;
  // 배열 간격은 회전된 좌표계에서 적용된다.
  m[3] = e.position.x + cos * colOffset - sin * rowOffset;
  m[7] = e.position.y + sin * colOffset + cos * rowOffset;
  m[11] = e.position.z;
  return m;
}

function translation(x: number, y: number, z: number): Mat34 {
  const m = identity();
  m[3] = x;
  m[7] = y;
  m[11] = z;
  return m;
}

// ------------------------------------------------------------------ 곡선 분해

function arcPoints(
  cx: number,
  cy: number,
  r: number,
  startRad: number,
  endRad: number,
  segments: number,
): number[] {
  const out: number[] = [];
  let span = endRad - startRad;
  // 끝각이 시작각보다 작으면 반시계로 한 바퀴 돌아간다.
  while (span <= 1e-12) span += Math.PI * 2;
  const steps = Math.max(2, Math.ceil((span / (Math.PI * 2)) * segments));
  for (let i = 0; i <= steps; i++) {
    const a = startRad + (span * i) / steps;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a), 0);
  }
  return out;
}

/** 균일하지 않은 노트 벡터를 쓰는 NURBS 를 de Boor 로 평가한다. */
function evalNurbs(
  degree: number,
  ctrl: Point3[],
  knots: number[],
  weights: number[],
  u: number,
): [number, number, number] {
  const n = ctrl.length - 1;
  const p = degree;

  // u 를 포함하는 노트 구간 찾기
  let k = p;
  while (k < n && knots[k + 1] <= u) k++;

  // 동차 좌표로 복사
  const d: [number, number, number, number][] = [];
  for (let j = 0; j <= p; j++) {
    const idx = k - p + j;
    const c = ctrl[Math.min(Math.max(idx, 0), n)];
    const w = weights.length === ctrl.length ? weights[Math.min(Math.max(idx, 0), n)] : 1;
    d.push([c.x * w, c.y * w, c.z * w, w]);
  }

  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const denom = knots[i + p - r + 1] - knots[i];
      const alpha = denom === 0 ? 0 : (u - knots[i]) / denom;
      for (let t = 0; t < 4; t++) {
        d[j][t] = (1 - alpha) * d[j - 1][t] + alpha * d[j][t];
      }
    }
  }
  const w = d[p][3] || 1;
  return [d[p][0] / w, d[p][1] / w, d[p][2] / w];
}

/** 피팅 점만 있을 때 쓰는 Catmull-Rom 보간. */
function catmullRom(points: Point3[], closed: boolean, perSpan: number): number[] {
  const out: number[] = [];
  const n = points.length;
  if (n < 2) return out;
  const at = (i: number): Point3 => {
    if (closed) return points[((i % n) + n) % n];
    return points[Math.min(Math.max(i, 0), n - 1)];
  };
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < perSpan; s++) {
      const t = s / perSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, dd: number) =>
        0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - dd) * t2 + (-a + 3 * b - 3 * c + dd) * t3);
      out.push(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
    }
  }
  const end = at(last);
  out.push(end.x, end.y, end.z);
  return out;
}

// ------------------------------------------------------------------ 선종류

/**
 * 경로를 선종류 패턴에 따라 대시 조각들로 자른다.
 * 패턴 길이는 도면 단위이므로 결과는 줌과 무관하게 올바르다.
 */
function dashPath(coords: number[], pattern: number[], scale: number): number[][] {
  const dashes: number[] = [];
  for (const d of pattern) {
    const v = Math.abs(d) * scale;
    dashes.push(v < 1e-9 ? scale * 0.01 : v); // 점(0)은 아주 짧은 선으로
  }
  const on = pattern.map((d) => d >= 0);
  const cycle = dashes.reduce((a, b) => a + b, 0);
  if (cycle <= 1e-9) return [coords];

  const out: number[][] = [];
  let seg: number[] = [];
  let di = 0;
  let remaining = dashes[0];
  let drawing = on[0];

  const pushSeg = () => {
    if (seg.length >= 6) out.push(seg);
    seg = [];
  };

  for (let i = 0; i + 5 < coords.length; i += 3) {
    let x1 = coords[i];
    let y1 = coords[i + 1];
    let z1 = coords[i + 2];
    const x2 = coords[i + 3];
    const y2 = coords[i + 4];
    const z2 = coords[i + 5];
    let len = Math.hypot(x2 - x1, y2 - y1, z2 - z1);
    if (len < 1e-12) continue;

    while (len > 1e-12) {
      if (drawing && seg.length === 0) seg.push(x1, y1, z1);
      const step = Math.min(len, remaining);
      const t = step / len;
      const nx = x1 + (x2 - x1) * t;
      const ny = y1 + (y2 - y1) * t;
      const nz = z1 + (z2 - z1) * t;
      if (drawing) seg.push(nx, ny, nz);

      remaining -= step;
      len -= step;
      x1 = nx;
      y1 = ny;
      z1 = nz;

      if (remaining <= 1e-12) {
        if (drawing) pushSeg();
        di = (di + 1) % dashes.length;
        remaining = dashes[di];
        drawing = on[di];
      }
    }
  }
  pushSeg();
  return out;
}

// --------------------------------------------------------------- 해치 패턴

/** 해치 하나가 만들 수 있는 패턴 선 수의 상한 (악성/거대 해치 방어). */
const MAX_HATCH_LINES = 4000;

/**
 * 패턴 정의선 하나로 평행선 다발을 만들고, 경계 루프에 짝–홀 규칙으로 클리핑한다.
 * 루프는 [x,y,x,y,...] 평면 배열이고 결과는 월드 좌표 선분들이다.
 */
function hatchPatternSegments(
  loops: number[][],
  line: { angle: number; baseX: number; baseY: number; offsetX: number; offsetY: number; dashes: number[] },
  budget: { left: number },
): number[][] {
  const out: number[][] = [];
  const perpStep = line.offsetY;
  if (Math.abs(perpStep) < 1e-9) return out;

  const a = (line.angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  // 선 방향 기준 오프셋을 월드 좌표로 회전.
  const ox = line.offsetX * dx - line.offsetY * dy;
  const oy = line.offsetX * dy + line.offsetY * dx;
  // 선에 수직인 단위 벡터.
  const nx = -dy;
  const ny = dx;

  let dMin = Infinity;
  let dMax = -Infinity;
  for (const loop of loops) {
    for (let i = 0; i + 1 < loop.length; i += 2) {
      const d = (loop[i] - line.baseX) * nx + (loop[i + 1] - line.baseY) * ny;
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    }
  }
  if (!Number.isFinite(dMin)) return out;

  const step = Math.abs(perpStep);
  const kStart = Math.floor(dMin / step) - 1;
  const kEnd = Math.ceil(dMax / step) + 1;
  if (kEnd - kStart > MAX_HATCH_LINES) return out;

  const crossings: number[] = [];
  for (let k = kStart; k <= kEnd; k++) {
    if (budget.left <= 0) return out;
    // k 번째 선의 기준점 (수직 간격은 k*step, 선 방향 밀림은 패턴 정의대로).
    const n = perpStep < 0 ? -k : k;
    const px = line.baseX + ox * n;
    const py = line.baseY + oy * n;

    crossings.length = 0;
    for (const loop of loops) {
      const m = loop.length;
      if (m < 6) continue;
      for (let i = 0; i + 1 < m; i += 2) {
        const ax = loop[i];
        const ay = loop[i + 1];
        const j = (i + 2) % m;
        const bx = loop[j];
        const by = loop[j + 1];
        const fa = (ax - px) * nx + (ay - py) * ny;
        const fb = (bx - px) * nx + (by - py) * ny;
        // 한쪽 끝만 포함하는 반열린 규칙 — 꼭짓점 중복 계산을 막는다.
        if ((fa <= 0 && fb > 0) || (fb <= 0 && fa > 0)) {
          const s = fa / (fa - fb);
          const ix = ax + (bx - ax) * s;
          const iy = ay + (by - ay) * s;
          crossings.push((ix - px) * dx + (iy - py) * dy);
        }
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((p, q) => p - q);

    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const t0 = crossings[i];
      const t1 = crossings[i + 1];
      if (t1 - t0 < 1e-9) continue;
      const seg = [px + dx * t0, py + dy * t0, 0, px + dx * t1, py + dy * t1, 0];
      if (line.dashes.length >= 2) {
        for (const piece of dashPath(seg, line.dashes, 1)) out.push(piece);
      } else {
        out.push(seg);
      }
      budget.left--;
      if (budget.left <= 0) return out;
    }
  }
  return out;
}

// -------------------------------------------------------------------- 평탄화

interface Ctx {
  doc: DxfDocument;
  opts: FlattenOptions;
  scene: FlatScene;
  /** 현재까지 쌓인 선분 수 */
  segments: number;
  /** 모형 공간을 그리는 중인가 — 페이퍼 공간 엔티티를 걸러낼지 결정한다. */
  modelOnly: boolean;
  /** 이 뷰포트에서만 동결된 레이어 이름. 뷰포트 밖에서는 null. */
  frozenLayers: ReadonlySet<string> | null;
}

function resolveColor(
  ctx: Ctx,
  e: DxfEntityBase,
  inheritedColor: number,
  inheritedTrueColor: number | undefined,
): number {
  const dark = ctx.opts.darkBackground;
  if (e.trueColor !== undefined) return e.trueColor;

  let aci = e.colorIndex;
  if (aci === 0) {
    // BYBLOCK → 블록을 삽입한 쪽의 색
    if (inheritedTrueColor !== undefined) return inheritedTrueColor;
    aci = inheritedColor;
  }
  if (aci === 256 || aci === undefined) {
    const layer = ctx.doc.layers.get(e.layer);
    if (layer?.trueColor !== undefined) return layer.trueColor;
    aci = layer?.colorIndex ?? 7;
  }
  return displayHex(aci, dark);
}

function layerVisible(ctx: Ctx, name: string): boolean {
  if (!ctx.opts.respectLayerState) return true;
  if (ctx.frozenLayers?.has(name)) return false;
  const layer = ctx.doc.layers.get(name);
  if (!layer) return true;
  return !layer.off && !layer.frozen;
}

/** $LWDEFAULT (1/100 mm). 없으면 AutoCAD 기본값 0.25 mm. */
function defaultLineWeight(ctx: Ctx): number {
  const h = ctx.doc.header.$LWDEFAULT?.[0];
  const v = h ? Number(h.value) : Number.NaN;
  return Number.isFinite(v) && v >= 0 ? v / 100 : 0.25;
}

/**
 * 엔티티의 선굵기를 밀리미터로 푼다.
 *
 * 370 은 1/100 mm 이고 음수는 상속 규칙이다 — -1 BYLAYER, -2 BYBLOCK,
 * -3 기본값($LWDEFAULT). inheritedWeight 는 블록을 삽입한 쪽에서 이미 풀린
 * 굵기(mm)이고, 음수면 "물려받을 것이 없음" 을 뜻한다.
 */
function resolveLineWeight(ctx: Ctx, e: DxfEntityBase, inheritedWeight: number): number {
  const lw = e.lineWeight;
  if (lw >= 0) return lw / 100;
  if (lw === -2) return inheritedWeight >= 0 ? inheritedWeight : defaultLineWeight(ctx);
  if (lw === -1) {
    const layer = ctx.doc.layers.get(e.layer)?.lineWeight ?? -3;
    return layer >= 0 ? layer / 100 : defaultLineWeight(ctx);
  }
  return defaultLineWeight(ctx);
}

function lineTypePattern(ctx: Ctx, e: DxfEntityBase): number[] | null {
  if (!ctx.opts.applyLineTypes) return null;
  let name = e.lineType;
  if (!name || name === 'BYLAYER') {
    name = ctx.doc.layers.get(e.layer)?.lineType ?? 'CONTINUOUS';
  }
  if (!name || name === 'BYBLOCK') return null;
  const up = name.toUpperCase();
  if (up === 'CONTINUOUS' || up === 'BYLAYER') return null;
  const lt = ctx.doc.lineTypes.get(up);
  if (!lt || lt.pattern.length < 2) return null;
  return lt.pattern;
}

function emitPath(
  ctx: Ctx,
  e: DxfEntityBase,
  coords: number[],
  m: Mat34,
  color: number,
  closed: boolean,
  weight: number,
) {
  if (coords.length < 6 && !(closed && coords.length >= 6)) {
    if (coords.length < 6) return;
  }
  // 변환 적용
  const world = new Array<number>(coords.length);
  for (let i = 0; i < coords.length; i += 3) {
    const [x, y, z] = apply(m, coords[i], coords[i + 1], coords[i + 2]);
    world[i] = x;
    world[i + 1] = y;
    world[i + 2] = z;
  }
  if (closed && world.length >= 6) {
    const n = world.length;
    if (
      Math.abs(world[0] - world[n - 3]) > 1e-9 ||
      Math.abs(world[1] - world[n - 2]) > 1e-9 ||
      Math.abs(world[2] - world[n - 1]) > 1e-9
    ) {
      world.push(world[0], world[1], world[2]);
    }
  }
  if (world.length < 6) return;

  const pattern = lineTypePattern(ctx, e);
  const pieces =
    pattern !== null
      ? dashPath(world, pattern, Math.max(1e-9, e.lineTypeScale * scaleOf(m)))
      : [world];

  for (const piece of pieces) {
    if (piece.length < 6) continue;
    ctx.segments += piece.length / 3 - 1;
    if (ctx.segments > ctx.opts.maxSegments) {
      ctx.scene.stats.truncated = true;
      return;
    }
    ctx.scene.paths.push({ coords: piece, layer: e.layer, color, entityType: e.type, weight });
    accumulateBounds(ctx.scene, piece);
  }
  ctx.scene.layerCounts[e.layer] = (ctx.scene.layerCounts[e.layer] ?? 0) + 1;
}

function accumulateBounds(scene: FlatScene, coords: number[]) {
  let b = scene.bounds;
  if (!b) {
    b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    scene.bounds = b;
  }
  for (let i = 0; i < coords.length; i += 3) {
    const x = coords[i];
    const y = coords[i + 1];
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }
}

function polylineCoords(
  vertices: { x: number; y: number; z: number; bulge: number }[],
  closed: boolean,
): number[] {
  const coords: number[] = [];
  const n = vertices.length;
  if (n === 0) return coords;
  for (let i = 0; i < n; i++) {
    const v = vertices[i];
    coords.push(v.x, v.y, v.z);
    const isLast = i === n - 1;
    if (isLast && !closed) break;
    const next = vertices[(i + 1) % n];
    if (v.bulge) {
      for (const p of bulgeToPoints(v.x, v.y, next.x, next.y, v.bulge)) {
        coords.push(p.x, p.y, v.z);
      }
    }
  }
  if (closed && n > 1) {
    coords.push(vertices[0].x, vertices[0].y, vertices[0].z);
  }
  return coords;
}

function flattenEntity(
  ctx: Ctx,
  e: DxfEntity,
  m: Mat34,
  depth: number,
  inheritedColor: number,
  inheritedTrueColor: number | undefined,
  /** 블록을 삽입한 쪽에서 풀린 선굵기(mm). 음수면 물려받을 것이 없다. */
  inheritedWeight = -1,
) {
  if (e.invisible) return;
  if (ctx.modelOnly && e.paperSpace && depth === 0) return;
  if (!layerVisible(ctx, e.layer)) return;
  if (ctx.scene.stats.truncated) return;

  ctx.scene.stats.entities++;
  const color = resolveColor(ctx, e, inheritedColor, inheritedTrueColor);
  const weight = resolveLineWeight(ctx, e, inheritedWeight);
  // 엔티티 자체 좌표계(OCS)를 세계 좌표계로.
  //
  // 주의: 모든 엔티티가 OCS 를 쓰는 건 아니다. LINE·ELLIPSE·SPLINE·3DFACE·
  // 3D 폴리라인은 좌표를 **WCS 로** 저장하고, 압출 벡터는 (있어도) 두께 방향
  // 이나 평면 법선일 뿐이다. 이런 엔티티에 OCS 변환을 걸면 압출이 기울거나
  // 뒤집힌 도형이 엉뚱한 곳으로 날아간다.
  const em = multiply(m, ocsMatrix(e.extrusion));
  const segs = ctx.opts.circleSegments;

  switch (e.type) {
    case 'LINE': {
      const l = e;
      emitPath(ctx, e, [l.start.x, l.start.y, l.start.z, l.end.x, l.end.y, l.end.z], m, color, false, weight);
      break;
    }
    case 'LWPOLYLINE': {
      const p = e as DxfLwPolyline;
      emitPath(ctx, e, polylineCoords(p.vertices, p.closed), em, color, false, weight);
      break;
    }
    case 'POLYLINE': {
      const p = e as DxfPolyline;
      if (p.isMesh) break; // 폴리곤 메시는 스케치 뷰에서 제외
      // 3D 폴리라인의 정점은 WCS 다. 2D 폴리라인만 OCS 를 탄다.
      emitPath(ctx, e, polylineCoords(p.vertices, p.closed), p.is3d ? m : em, color, false, weight);
      break;
    }
    case 'CIRCLE': {
      const c = e as DxfCircle;
      if (c.radius <= 0) break;
      const coords = arcPoints(c.center.x, c.center.y, c.radius, 0, Math.PI * 2, segs);
      for (let i = 2; i < coords.length; i += 3) coords[i] = c.center.z;
      emitPath(ctx, e, coords, em, color, false, weight);
      break;
    }
    case 'ARC': {
      const a = e as DxfArc;
      if (a.radius <= 0) break;
      const coords = arcPoints(
        a.center.x,
        a.center.y,
        a.radius,
        (a.startAngle * Math.PI) / 180,
        (a.endAngle * Math.PI) / 180,
        segs,
      );
      for (let i = 2; i < coords.length; i += 3) coords[i] = a.center.z;
      emitPath(ctx, e, coords, em, color, false, weight);
      break;
    }
    case 'ELLIPSE': {
      const el = e as DxfEllipse;
      const major = Math.hypot(el.majorAxis.x, el.majorAxis.y, el.majorAxis.z);
      if (major <= 0) break;
      const minor = major * el.axisRatio;
      // 중심(10)과 장축 벡터(11)는 WCS 다. 압출 벡터는 타원이 놓인 평면의
      // 법선일 뿐이라, 단축 방향을 N × 장축 으로 잡아 주면 된다 — 법선이 -Z
      // 인(거울 반전된) 타원도 제자리에 그대로 그려진다.
      const ux = el.majorAxis.x / major;
      const uy = el.majorAxis.y / major;
      const uz = el.majorAxis.z / major;
      let nx = el.extrusion.x;
      let ny = el.extrusion.y;
      let nz = el.extrusion.z;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-12) {
        nx = 0; ny = 0; nz = 1;
      } else {
        nx /= nl; ny /= nl; nz /= nl;
      }
      let vx = ny * uz - nz * uy;
      let vy = nz * ux - nx * uz;
      let vz = nx * uy - ny * ux;
      const vl = Math.hypot(vx, vy, vz);
      if (vl < 1e-12) {
        // 법선과 장축이 나란한 퇴화 입력 — 평면 타원으로 되돌린다.
        vx = -uy; vy = ux; vz = 0;
      } else {
        vx /= vl; vy /= vl; vz /= vl;
      }

      let span = el.endParam - el.startParam;
      if (span <= 1e-12) span += Math.PI * 2;
      const steps = Math.max(2, Math.ceil((span / (Math.PI * 2)) * segs));
      const coords: number[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = el.startParam + (span * i) / steps;
        const ca = major * Math.cos(t);
        const sa = minor * Math.sin(t);
        coords.push(
          el.center.x + ca * ux + sa * vx,
          el.center.y + ca * uy + sa * vy,
          el.center.z + ca * uz + sa * vz,
        );
      }
      emitPath(ctx, e, coords, m, color, false, weight);
      break;
    }
    case 'SPLINE': {
      const s = e as DxfSpline;
      let coords: number[] = [];
      const degree = Math.max(1, s.degree);
      if (s.controlPoints.length > degree && s.knots.length >= s.controlPoints.length + degree + 1) {
        const n = s.controlPoints.length - 1;
        const uStart = s.knots[degree];
        const uEnd = s.knots[n + 1];
        const steps = Math.max(16, Math.min(512, s.controlPoints.length * 12));
        for (let i = 0; i <= steps; i++) {
          // 끝점에서 구간 탐색이 벗어나지 않게 아주 살짝 당긴다.
          const u = uStart + ((uEnd - uStart) * i) / steps - (i === steps ? 1e-9 : 0);
          const [x, y, z] = evalNurbs(degree, s.controlPoints, s.knots, s.weights, u);
          coords.push(x, y, z);
        }
      } else if (s.fitPoints.length >= 2) {
        coords = catmullRom(s.fitPoints, s.closed, 12);
      } else if (s.controlPoints.length >= 2) {
        for (const p of s.controlPoints) coords.push(p.x, p.y, p.z);
      }
      // SPLINE 의 제어점·피팅점도 WCS 다.
      emitPath(ctx, e, coords, m, color, s.closed, weight);
      break;
    }
    case 'POINT': {
      // 점은 아주 짧은 십자로 표현 — 길이는 뷰어에서 보정하지 않고 고정.
      break;
    }
    case 'SOLID':
    case '3DFACE': {
      const s = e as DxfSolid;
      const c = s.corners;
      // DXF SOLID 는 꼭짓점 순서가 0-1-3-2 다.
      const order = s.type === 'SOLID' ? [0, 1, 3, 2] : [0, 1, 2, 3];
      // SOLID/TRACE 는 OCS, 3DFACE 는 WCS 다.
      const sm = s.type === '3DFACE' ? m : em;
      const loop: number[] = [];
      const outline: number[] = [];
      for (const i of order) {
        const [x, y, z] = apply(sm, c[i].x, c[i].y, c[i].z);
        loop.push(x, y);
        outline.push(x, y, z);
      }
      outline.push(outline[0], outline[1], outline[2]);
      ctx.scene.fills.push({ loops: [loop], layer: e.layer, color, entityType: s.type });
      ctx.segments += 4;
      accumulateBounds(ctx.scene, outline);
      ctx.scene.layerCounts[e.layer] = (ctx.scene.layerCounts[e.layer] ?? 0) + 1;
      break;
    }
    case 'HATCH': {
      const h = e as DxfHatch;
      // 채움·윤곽선은 변환된 좌표로, 패턴 선은 엔티티 자체 좌표로 만든다
      // (아래 참고). 그래서 경계를 두 벌 들고 있는다.
      const loops2d: number[][] = [];
      const loopsLocal: number[][] = [];
      for (const loop of h.boundary.loops) {
        const coords: number[] = [];
        const local: number[] = [];
        const flat: number[] = [];
        for (const p of loop) {
          const [x, y, z] = apply(em, p.x, p.y, h.elevation);
          coords.push(x, y);
          local.push(p.x, p.y);
          flat.push(x, y, z);
        }
        if (coords.length >= 6) {
          loops2d.push(coords);
          loopsLocal.push(local);
          // 경계선 자체도 그린다 — 스케치에서는 윤곽이 중요하다.
          flat.push(flat[0], flat[1], flat[2]);
          ctx.scene.paths.push({ coords: flat, layer: e.layer, color, entityType: 'HATCH', weight });
          ctx.segments += flat.length / 3 - 1;
          accumulateBounds(ctx.scene, flat);
        }
      }
      if (h.solid && loops2d.length > 0) {
        ctx.scene.fills.push({ loops: loops2d, layer: e.layer, color, entityType: 'HATCH' });
      } else if (loopsLocal.length > 0 && h.patternLines.length > 0) {
        // 패턴 해치: 정의선마다 평행선을 만들어 경계로 자른다.
        //
        // 패턴 정의(각도·간격·대시·기준점)는 엔티티 자체 좌표계의 값이므로,
        // 평행선도 그 좌표계에서 만든 다음 변환해서 내보낸다. 변환된 경계에
        // 원본 패턴을 그대로 쓰면 축척된 블록이나 확대된 뷰포트 안에서 간격이
        // 어긋나고, 회전된 블록 안에서는 방향까지 틀어진다. 여기서 만들면
        // 축척·회전·미러·전단이 전부 저절로 맞는다.
        const budget = { left: MAX_HATCH_LINES };
        for (const pl of h.patternLines) {
          for (const seg of hatchPatternSegments(loopsLocal, pl, budget)) {
            for (let i = 0; i + 2 < seg.length; i += 3) {
              const [x, y, z] = apply(em, seg[i], seg[i + 1], h.elevation);
              seg[i] = x;
              seg[i + 1] = y;
              seg[i + 2] = z;
            }
            ctx.scene.paths.push({
              coords: seg,
              layer: e.layer,
              color,
              entityType: 'HATCH-PATTERN',
              weight,
            });
            ctx.segments += seg.length / 3 - 1;
            accumulateBounds(ctx.scene, seg);
          }
          if (budget.left <= 0) break;
        }
      }
      if (loops2d.length) ctx.scene.layerCounts[e.layer] = (ctx.scene.layerCounts[e.layer] ?? 0) + 1;
      break;
    }
    case 'LEADER': {
      const l = e;
      const coords: number[] = [];
      for (const v of l.vertices) coords.push(v.x, v.y, v.z);
      emitPath(ctx, e, coords, em, color, false, weight);
      break;
    }
    case 'MULTILEADER': {
      flattenMLeader(ctx, e as DxfMLeader, em, depth, color, weight);
      break;
    }
    case 'ACAD_TABLE': {
      flattenAcadTable(ctx, e as DxfAcadTable, em, depth, color, weight);
      break;
    }
    case 'RAY':
    case 'XLINE': {
      // 무한선은 도면 범위를 모르는 단계에서는 그리지 않는다.
      break;
    }
    case 'TEXT': {
      const t = e as DxfText;
      if (!t.text) break;
      emitText(ctx, t, em, color);
      break;
    }
    case 'MTEXT': {
      const t = e as DxfMText;
      if (!t.text) break;
      emitMText(ctx, t, em, color);
      break;
    }
    case 'DIMENSION': {
      // 치수는 익명 블록(*D…)에 실제 기하가 들어 있다.
      const d = e;
      const block = d.blockName ? ctx.doc.blocks.get(d.blockName) : undefined;
      if (block && depth < MAX_BLOCK_DEPTH) {
        for (const child of block.entities) {
          flattenEntity(ctx, child, em, depth + 1, e.colorIndex, e.trueColor, weight);
        }
      }
      break;
    }
    case 'INSERT': {
      const ins = e as DxfInsert;
      if (depth >= MAX_BLOCK_DEPTH) break;
      const block = ctx.doc.blocks.get(ins.blockName);
      if (!block) break;
      const cols = Math.min(Math.max(1, ins.columnCount), 1000);
      const rows = Math.min(Math.max(1, ins.rowCount), 1000);
      // 블록 기준점을 원점으로 옮기는 변환이 먼저 적용된다.
      const toBase = translation(-block.basePoint.x, -block.basePoint.y, -block.basePoint.z);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const im = multiply(em, insertMatrix(ins, c * ins.columnSpacing, r * ins.rowSpacing));
          const full = multiply(im, toBase);
          for (const child of block.entities) {
            flattenEntity(ctx, child, full, depth + 1, e.colorIndex, e.trueColor, weight);
            if (ctx.scene.stats.truncated) return;
          }
        }
      }
      for (const attr of ins.attributes) {
        if (attr.text) flattenEntity(ctx, attr, m, depth + 1, e.colorIndex, e.trueColor, weight);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 화살촉을 채워진 삼각형으로 그린다. coords 의 첫 두 점이 촉 끝과 진행 방향.
 * 화살촉이 리더선 첫 구간보다 길면(비정상적으로 큰 설정) 건너뛴다.
 */
function emitArrowHead(
  ctx: Ctx,
  e: DxfEntityBase,
  coords: number[],
  size: number,
  m: Mat34,
  color: number,
) {
  if (size <= 0 || coords.length < 6) return;
  const tx = coords[0];
  const ty = coords[1];
  const tz = coords[2];
  const dx = coords[3] - tx;
  const dy = coords[4] - ty;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9 || size > len) return;
  const ux = dx / len;
  const uy = dy / len;
  // AutoCAD 기본 닫힌 화살촉은 길이 대비 폭이 약 1/3 이다.
  const half = size / 6;
  const bx = tx + ux * size;
  const by = ty + uy * size;

  const loop: number[] = [];
  const outline: number[] = [];
  const corners: [number, number][] = [
    [tx, ty],
    [bx - uy * half, by + ux * half],
    [bx + uy * half, by - ux * half],
  ];
  for (const [cx, cy] of corners) {
    const [wx, wy, wz] = apply(m, cx, cy, tz);
    loop.push(wx, wy);
    outline.push(wx, wy, wz);
  }
  outline.push(outline[0], outline[1], outline[2]);
  ctx.scene.fills.push({ loops: [loop], layer: e.layer, color, entityType: 'MULTILEADER' });
  ctx.segments += 3;
  accumulateBounds(ctx.scene, outline);
}

/** 블록 콘텐츠 멀티리더의 배치 변환. 47 × 16 이 있으면 그대로 쓴다. */
function mleaderBlockMatrix(ml: DxfMLeader): Mat34 {
  if (ml.blockMatrix.length >= 12) {
    const m = new Float64Array(12);
    for (let i = 0; i < 12; i++) m[i] = ml.blockMatrix[i];
    // 퇴화된 행렬이면 좌표가 전부 한 점으로 뭉개지므로 쓰지 않는다.
    if (Math.hypot(m[0], m[4], m[8]) > 1e-12 && Math.hypot(m[1], m[5], m[9]) > 1e-12) return m;
  }
  const a = ml.blockRotation; // radian
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const m = new Float64Array(12);
  m[0] = cos * ml.blockScale.x; m[1] = -sin * ml.blockScale.y; m[2] = 0; m[3] = ml.blockPosition.x;
  m[4] = sin * ml.blockScale.x; m[5] = cos * ml.blockScale.y; m[6] = 0; m[7] = ml.blockPosition.y;
  m[8] = 0; m[9] = 0; m[10] = ml.blockScale.z || 1; m[11] = ml.blockPosition.z;
  return m;
}

/**
 * MULTILEADER: 리더선 폴리라인 + 랜딩(수평 꼬리) + 화살촉을 그리고,
 * 콘텐츠로 문자(MTEXT)나 블록을 붙인다.
 */
function flattenMLeader(
  ctx: Ctx,
  ml: DxfMLeader,
  m: Mat34,
  depth: number,
  color: number,
  weight: number,
) {
  for (const cluster of ml.leaders) {
    // 같은 다발의 리더선들은 모두 공통 끝점에서 만나 랜딩으로 이어진다.
    const tail: number[] = [];
    if (cluster.hasLanding) {
      tail.push(cluster.landing.x, cluster.landing.y, cluster.landing.z);
      const d = cluster.doglegDirection;
      const dl = Math.hypot(d.x, d.y, d.z);
      if (cluster.doglegLength > 1e-9 && dl > 1e-12) {
        tail.push(
          cluster.landing.x + (d.x / dl) * cluster.doglegLength,
          cluster.landing.y + (d.y / dl) * cluster.doglegLength,
          cluster.landing.z + (d.z / dl) * cluster.doglegLength,
        );
      }
    }

    for (const points of cluster.lines) {
      const coords: number[] = [];
      for (const v of points) coords.push(v.x, v.y, v.z);
      // 리더선 끝점과 랜딩 시작점이 같으면 중복으로 넣지 않는다.
      let from = 0;
      const n = coords.length;
      if (
        n >= 3 &&
        tail.length >= 3 &&
        Math.abs(coords[n - 3] - tail[0]) < 1e-9 &&
        Math.abs(coords[n - 2] - tail[1]) < 1e-9
      ) {
        from = 3;
      }
      for (let i = from; i < tail.length; i++) coords.push(tail[i]);
      emitPath(ctx, ml, coords, m, color, false, weight);
      emitArrowHead(ctx, ml, coords, ml.arrowSize, m, color);
    }
    // 리더선 없이 랜딩만 있는 다발도 꼬리는 그린다.
    if (cluster.lines.length === 0 && tail.length >= 6) {
      emitPath(ctx, ml, tail, m, color, false, weight);
    }
    if (ctx.scene.stats.truncated) return;
  }

  if (ml.text) {
    // 콘텐츠 문자는 MTEXT 와 같은 규칙(부착점 1~9, 서식 코드)을 따른다.
    const mt: DxfMText = {
      ...(ml as DxfEntityBase),
      type: 'MTEXT',
      position: ml.textPosition,
      text: ml.text,
      height: ml.textHeight,
      // 줄바꿈은 본문의 \P 로 이미 들어 있으므로 자동 줄바꿈은 쓰지 않는다.
      width: 0,
      attachmentPoint: ml.textAttachment,
      rotation: ml.textRotation,
      lineSpacing: 1,
      styleName: 'STANDARD',
    };
    emitMText(ctx, mt, m, color);
  }

  if (!ml.blockHandle || depth >= MAX_BLOCK_DEPTH) return;
  const blockName = ctx.doc.blockNamesByHandle.get(ml.blockHandle);
  const block = blockName ? ctx.doc.blocks.get(blockName) : undefined;
  if (!block) return;
  const placed = multiply(m, mleaderBlockMatrix(ml));
  const full = multiply(
    placed,
    translation(-block.basePoint.x, -block.basePoint.y, -block.basePoint.z),
  );
  for (const child of block.entities) {
    flattenEntity(ctx, child, full, depth + 1, ml.colorIndex, ml.trueColor, weight);
    if (ctx.scene.stats.truncated) return;
  }
  // 속성 값은 블록 안 ATTDEF 의 자리에 문자만 바꿔 넣는다.
  for (const a of ml.attributes) {
    if (!a.text) continue;
    const def = block.attdefs.find((d) => d.handle === a.handle);
    if (!def) continue;
    flattenEntity(ctx, { ...def, text: a.text }, full, depth + 1, ml.colorIndex, ml.trueColor, weight);
    if (ctx.scene.stats.truncated) return;
  }
}

/**
 * ACAD_TABLE: AutoCAD 가 만들어 둔 익명 블록(*T…)을 삽입점에 전개한다.
 * 블록이 없으면 행/열 치수와 셀 문자로 격자를 직접 만든다 (셀 병합은 무시).
 */
function flattenAcadTable(
  ctx: Ctx,
  tb: DxfAcadTable,
  m: Mat34,
  depth: number,
  color: number,
  weight: number,
) {
  if (depth >= MAX_BLOCK_DEPTH) return;

  const angle = Math.atan2(tb.direction.y, tb.direction.x);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const place = new Float64Array(12);
  place[0] = cos; place[1] = -sin; place[2] = 0; place[3] = tb.position.x;
  place[4] = sin; place[5] = cos; place[6] = 0; place[7] = tb.position.y;
  place[8] = 0; place[9] = 0; place[10] = 1; place[11] = tb.position.z;
  const at = multiply(m, place);

  const block = tb.blockName ? ctx.doc.blocks.get(tb.blockName) : undefined;
  if (block) {
    const full = multiply(
      at,
      translation(-block.basePoint.x, -block.basePoint.y, -block.basePoint.z),
    );
    for (const child of block.entities) {
      flattenEntity(ctx, child, full, depth + 1, tb.colorIndex, tb.trueColor, weight);
      if (ctx.scene.stats.truncated) return;
    }
    return;
  }

  const rows = tb.rowHeights.length || tb.rowCount;
  const cols = tb.columnWidths.length || tb.columnCount;
  if (rows <= 0 || cols <= 0) return;

  // 표는 삽입점을 좌상단으로 두고 아래로 자란다.
  const xs: number[] = [0];
  for (let c = 0; c < cols; c++) xs.push(xs[c] + (tb.columnWidths[c] ?? 0));
  const ys: number[] = [0];
  for (let r = 0; r < rows; r++) ys.push(ys[r] - (tb.rowHeights[r] ?? 0));
  const width = xs[cols];
  const height = ys[rows];
  if (Math.abs(width) < 1e-9 || Math.abs(height) < 1e-9) return;

  for (const x of xs) emitPath(ctx, tb, [x, 0, 0, x, height, 0], at, color, false, weight);
  for (const y of ys) emitPath(ctx, tb, [0, y, 0, width, y, 0], at, color, false, weight);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = tb.cells[r * cols + c];
      if (!cell || !cell.text) continue;
      const h = Math.abs(ys[r + 1] - ys[r]);
      if (h < 1e-9) continue;
      const margin = h * 0.2;
      const mt: DxfMText = {
        ...(tb as DxfEntityBase),
        type: 'MTEXT',
        position: { x: xs[c] + margin, y: (ys[r] + ys[r + 1]) / 2, z: 0 },
        text: cell.text,
        height: h * 0.6,
        width: 0,
        attachmentPoint: 4, // 좌 · 중앙
        rotation: 0,
        lineSpacing: 1,
        styleName: 'STANDARD',
      };
      emitMText(ctx, mt, at, color);
      if (ctx.scene.stats.truncated) return;
    }
  }
}

function emitText(ctx: Ctx, t: DxfText, m: Mat34, color: number) {
  // 정렬이 지정된 TEXT 는 11/21 이 실제 기준점이다.
  const useAlign = t.hasAlignmentPoint && (t.halign !== 0 || t.valign !== 0);
  const src = useAlign ? t.alignmentPoint : t.position;
  const [x, y, z] = apply(m, src.x, src.y, src.z);
  const s = scaleOf(m);
  const hAlign = t.halign === 1 || t.halign === 4 ? 1 : t.halign === 2 ? 2 : 0;
  const vAlign = t.valign === 1 ? 1 : t.valign === 2 ? 2 : t.valign === 3 ? 3 : 0;
  // 행렬의 회전분을 텍스트 각도에 더한다.
  const baseAngle = (Math.atan2(m[4], m[0]) * 180) / Math.PI;

  ctx.scene.texts.push({
    text: t.text,
    x,
    y,
    z,
    height: Math.max(1e-6, t.height * s),
    rotation: t.rotation + baseAngle,
    widthFactor: t.widthFactor || 1,
    hAlign,
    vAlign: t.halign === 4 ? 2 : vAlign,
    maxWidth: 0,
    layer: t.layer,
    color,
  });
  accumulateBounds(ctx.scene, [x, y, z]);
  ctx.scene.layerCounts[t.layer] = (ctx.scene.layerCounts[t.layer] ?? 0) + 1;
}

/** MTEXT 의 서식 코드를 제거해 평문만 남긴다. */
export function stripMTextFormatting(raw: string): string {
  let s = raw;

  // \P = 줄바꿈, \X = 단락 끊기, \~ = 비분리 공백
  s = s.replace(/\\P/g, '\n').replace(/\\X/g, '\n').replace(/\\~/g, ' ');

  // 스택 분수 \S윗^아랫; → 윗/아랫
  s = s.replace(/\\S([^;\\]*);?/g, (_, body: string) => String(body).replace(/[\^#]/g, '/'));

  // 인수를 갖는 서식 코드: \A1; \C3; \H2.5x; \W0.8; \Q15; \T2; \F…; \pxi…;
  // 반드시 세미콜론으로 끝나는 것만 지운다 — 종결자를 생략한 코드까지 지우려 들면
  // 뒤따르는 본문을 통째로 먹는다.
  s = s.replace(/\\[ACcFfHWQTp][^;\\]*;/g, '');

  // 인수도 종결자도 없는 토글 코드: 밑줄 \L \l, 윗줄 \O \o, 취소선 \K \k
  s = s.replace(/\\[LlOoKk]/g, '');

  // 그룹 중괄호 제거 + 이스케이프 해제를 한 번에 훑는다.
  // (정규식으로 하면 "}}" 처럼 붙어 있는 괄호를 한 번에 못 지운다.)
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const next = s[i + 1];
      if (next === '{' || next === '}' || next === '\\') {
        out += next;
        i++;
        continue;
      }
      out += c; // 알 수 없는 이스케이프는 그대로 남긴다
      continue;
    }
    if (c === '{' || c === '}') continue;
    out += c;
  }
  return out;
}

function emitMText(ctx: Ctx, t: DxfMText, m: Mat34, color: number) {
  const [x, y, z] = apply(m, t.position.x, t.position.y, t.position.z);
  const s = scaleOf(m);
  const ap = t.attachmentPoint;
  const hAlign = ap % 3 === 1 ? 0 : ap % 3 === 2 ? 1 : 2;
  const vAlign = ap <= 3 ? 3 : ap <= 6 ? 2 : 1;
  const baseAngle = (Math.atan2(m[4], m[0]) * 180) / Math.PI;

  ctx.scene.texts.push({
    text: stripMTextFormatting(t.text),
    x,
    y,
    z,
    height: Math.max(1e-6, t.height * s),
    rotation: t.rotation + baseAngle,
    widthFactor: 1,
    hAlign,
    vAlign,
    maxWidth: t.width * s,
    layer: t.layer,
    color,
  });
  accumulateBounds(ctx.scene, [x, y, z]);
  ctx.scene.layerCounts[t.layer] = (ctx.scene.layerCounts[t.layer] ?? 0) + 1;
}

// ------------------------------------------------------------------ 배치/뷰포트

/** 잘라낼 사각형 (배치 좌표계). */
interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 뷰포트 창 모양.
 *
 * 보통은 사각형 하나지만, 90 번의 0x10000 비트가 서 있으면 340 이 가리키는
 * 엔티티가 진짜 경계다. 그 경우 `triangles` 에 삼각형으로 쪼갠 경계를 들고
 * 있다가 조각마다 잘라 붙인다 (오목한 경계도 이렇게 하면 맞는다).
 */
interface ClipShape {
  /** 항상 있는 바깥 사각형 — 1차로 빠르게 거른다. */
  rect: Rect;
  /** 사각형이 아닐 때만. 배치 좌표계 다각형 (xy 번갈아). */
  polygon: number[] | null;
  /** polygon 이 볼록하면 그 반평면 [nx, ny, d] — 면을 한 번에 자른다. */
  convexPlanes: number[][] | null;
  /** polygon 이 오목할 때만. 귀 자르기로 쪼갠 삼각형들 (각각 xy 6개). */
  triangles: number[][] | null;
  /**
   * 문자를 GPU 에서 자르기 위한 반평면 [nx, ny, nz, d].
   * nx·x + ny·y + d ≥ 0 인 쪽만 보인다. 볼록할 때만 경계를 그대로 쓰고,
   * 오목하면 바깥 사각형으로 대신한다.
   */
  halfPlanes: number[][];
}

/** 점이 사각형 안인가 (경계 포함). */
function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

/**
 * Liang-Barsky 로 선분 하나를 사각형에 맞춰 자른다.
 * 남는 부분이 없으면 null.
 */
function clipSegment(
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  r: Rect,
): [number, number, number, number, number, number] | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const ps = [-dx, dx, -dy, dy];
  const qs = [x1 - r.minX, r.maxX - x1, y1 - r.minY, r.maxY - y1];
  for (let i = 0; i < 4; i++) {
    const pv = ps[i];
    const qv = qs[i];
    if (Math.abs(pv) < 1e-12) {
      if (qv < 0) return null; // 경계와 평행한데 바깥쪽
      continue;
    }
    const t = qv / pv;
    if (pv < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  const dz = z2 - z1;
  return [
    x1 + dx * t0, y1 + dy * t0, z1 + dz * t0,
    x1 + dx * t1, y1 + dy * t1, z1 + dz * t1,
  ];
}

/** 폴리라인을 사각형으로 자른다. 중간이 끊기면 여러 조각이 나온다. */
function clipPolyline(coords: number[], r: Rect): number[][] {
  const out: number[][] = [];
  let piece: number[] = [];
  for (let i = 0; i + 5 < coords.length; i += 3) {
    const seg = clipSegment(
      coords[i], coords[i + 1], coords[i + 2],
      coords[i + 3], coords[i + 4], coords[i + 5],
      r,
    );
    if (!seg) {
      if (piece.length >= 6) out.push(piece);
      piece = [];
      continue;
    }
    const n = piece.length;
    const joins =
      n >= 3 &&
      Math.abs(piece[n - 3] - seg[0]) < 1e-9 &&
      Math.abs(piece[n - 2] - seg[1]) < 1e-9;
    if (!joins) {
      if (n >= 6) out.push(piece);
      piece = [seg[0], seg[1], seg[2]];
    }
    piece.push(seg[3], seg[4], seg[5]);
  }
  if (piece.length >= 6) out.push(piece);
  return out;
}

/** 삼각형 [ax,ay,bx,by,cx,cy] 의 안쪽 반평면 3개를 만든다. */
function trianglePlanes(t: number[]): number[][] {
  const planes: number[][] = [];
  // 넓이 부호로 감는 방향을 맞춘다 — 반시계로 두고 왼쪽을 안쪽으로 본다.
  const area =
    (t[2] - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (t[3] - t[1]);
  const ccw = area >= 0;
  for (let i = 0; i < 6; i += 2) {
    const ax = t[i];
    const ay = t[i + 1];
    const bx = t[(i + 2) % 6];
    const by = t[(i + 3) % 6];
    let nx = -(by - ay);
    let ny = bx - ax;
    if (!ccw) {
      nx = -nx;
      ny = -ny;
    }
    const len = Math.hypot(nx, ny);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    planes.push([nx, ny, -(nx * ax + ny * ay)]);
  }
  return planes;
}

/**
 * 폴리라인을 임의 다각형(오목해도 됨)으로 자른다.
 *
 * 선분마다 경계와의 교차 매개변수를 모두 모아 구간으로 쪼갠 뒤, 각 구간의
 * 중점이 안쪽인지 홀짝 규칙으로 본다. 삼각형으로 쪼개 자르는 것보다 조각이
 * 훨씬 적게 나온다 (원형 창에서 선 하나가 96조각으로 갈라지지 않는다).
 */
function clipPolylinePolygon(coords: number[], poly: number[]): number[][] {
  const out: number[][] = [];
  let piece: number[] = [];
  const n = poly.length;
  const ts: number[] = [];

  const flush = () => {
    if (piece.length >= 6) out.push(piece);
    piece = [];
  };

  for (let i = 0; i + 5 < coords.length; i += 3) {
    const x1 = coords[i];
    const y1 = coords[i + 1];
    const z1 = coords[i + 2];
    const dx = coords[i + 3] - x1;
    const dy = coords[i + 4] - y1;
    const dz = coords[i + 5] - z1;

    ts.length = 0;
    ts.push(0, 1);
    for (let j = 0, k = n - 2; j < n; k = j, j += 2) {
      const ax = poly[k];
      const ay = poly[k + 1];
      const ex = poly[j] - ax;
      const ey = poly[j + 1] - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-15) continue;
      const t = ((ax - x1) * ey - (ay - y1) * ex) / den;
      const u = ((ax - x1) * dy - (ay - y1) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
    if (ts.length > 2) ts.sort((a, b) => a - b);

    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 < 1e-12) continue;
      const tm = (t0 + t1) / 2;
      if (!pointInPolygon(x1 + dx * tm, y1 + dy * tm, poly)) {
        flush();
        continue;
      }
      const sx = x1 + dx * t0;
      const sy = y1 + dy * t0;
      const m = piece.length;
      const joins =
        m >= 3 && Math.abs(piece[m - 3] - sx) < 1e-9 && Math.abs(piece[m - 2] - sy) < 1e-9;
      if (!joins) {
        flush();
        piece.push(sx, sy, z1 + dz * t0);
      }
      piece.push(x1 + dx * t1, y1 + dy * t1, z1 + dz * t1);
    }
  }
  flush();
  return out;
}

/** Sutherland-Hodgman — 자를 영역이 볼록한 사각형이라 루프를 한 번에 자른다. */
function clipLoop(loop: number[], r: Rect): number[] {
  return clipLoopPlanes(loop, [
    [1, 0, -r.minX],
    [-1, 0, r.maxX],
    [0, 1, -r.minY],
    [0, -1, r.maxY],
  ]);
}

/** Sutherland-Hodgman 의 반평면 판. 볼록 영역이면 무엇이든 자른다. */
function clipLoopPlanes(loop: number[], planes: number[][]): number[] {
  let poly = loop;
  for (const [nx, ny, d] of planes) {
    if (poly.length < 6) return [];
    const next: number[] = [];
    const n = poly.length;
    for (let i = 0; i < n; i += 2) {
      const ax = poly[i];
      const ay = poly[i + 1];
      const j = (i + 2) % n;
      const bx = poly[j];
      const by = poly[j + 1];
      const fa = nx * ax + ny * ay + d;
      const fb = nx * bx + ny * by + d;
      if (fa >= 0) next.push(ax, ay);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb);
        next.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
    poly = next;
  }
  return poly.length >= 6 ? poly : [];
}

/** 홀짝 규칙 점-다각형 포함 판정. */
function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = poly[i];
    const yi = poly[i + 1];
    const xj = poly[j];
    const yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 단순 다각형을 귀 자르기(ear clipping)로 삼각형들로 쪼갠다.
 * 오목한 클리핑 경계를 볼록 조각으로 나눠 다루려고 쓴다.
 */
function triangulate(poly: number[]): number[][] {
  const n = poly.length / 2;
  if (n < 3) return [];
  if (n > 2048) return []; // 비정상적으로 복잡한 경계는 포기하고 사각형으로

  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += poly[j * 2] * poly[i * 2 + 1] - poly[i * 2] * poly[j * 2 + 1];
  }
  const ccw = area >= 0;

  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);

  const at = (k: number): [number, number] => [poly[idx[k] * 2], poly[idx[k] * 2 + 1]];
  const cross = (
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
  ) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

  const out: number[][] = [];
  let guard = idx.length * idx.length + 16;
  let i = 0;
  while (idx.length > 3 && guard-- > 0) {
    const prev = (i + idx.length - 1) % idx.length;
    const cur = i % idx.length;
    const next = (i + 1) % idx.length;
    const [ax, ay] = at(prev);
    const [bx, by] = at(cur);
    const [cx, cy] = at(next);

    if (cross(ax, ay, bx, by, cx, cy) <= 0) {
      i = next;
      continue; // 볼록하지 않은 꼭짓점
    }
    // 다른 꼭짓점이 삼각형 안에 들어오면 귀가 아니다.
    let ok = true;
    for (let k = 0; k < idx.length; k++) {
      if (k === prev || k === cur || k === next) continue;
      const [px, py] = at(k);
      if (
        cross(ax, ay, bx, by, px, py) >= 0 &&
        cross(bx, by, cx, cy, px, py) >= 0 &&
        cross(cx, cy, ax, ay, px, py) >= 0
      ) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      i = next;
      continue;
    }
    out.push([ax, ay, bx, by, cx, cy]);
    idx.splice(cur, 1);
    i = cur % Math.max(idx.length, 1);
  }
  if (idx.length === 3) {
    const [ax, ay] = at(0);
    const [bx, by] = at(1);
    const [cx, cy] = at(2);
    out.push([ax, ay, bx, by, cx, cy]);
  }
  return out;
}

/** 다각형이 볼록한가 (모든 모퉁이의 외적 부호가 같은가). */
function isConvex(poly: number[]): boolean {
  const n = poly.length / 2;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const bx = poly[((i + 1) % n) * 2];
    const by = poly[((i + 1) % n) * 2 + 1];
    const cx = poly[((i + 2) % n) * 2];
    const cy = poly[((i + 2) % n) * 2 + 1];
    const cr = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cr) < 1e-12) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** 사각형을 문자 클리핑용 반평면 4개로. */
function rectPlanes(r: Rect): number[][] {
  return [
    [1, 0, 0, -r.minX],
    [-1, 0, 0, r.maxX],
    [0, 1, 0, -r.minY],
    [0, -1, 0, r.maxY],
  ];
}

/** 볼록 다각형을 문자 클리핑용 반평면들로. */
function polygonPlanes(poly: number[]): number[][] {
  const n = poly.length / 2;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += poly[j * 2] * poly[i * 2 + 1] - poly[i * 2] * poly[j * 2 + 1];
  }
  const ccw = area >= 0;
  const planes: number[][] = [];
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const bx = poly[((i + 1) % n) * 2];
    const by = poly[((i + 1) % n) * 2 + 1];
    let nx = -(by - ay);
    let ny = bx - ax;
    if (!ccw) {
      nx = -nx;
      ny = -ny;
    }
    const len = Math.hypot(nx, ny);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    planes.push([nx, ny, 0, -(nx * ax + ny * ay)]);
  }
  return planes;
}

/**
 * 모형 → 배치 변환 행렬.
 *
 * 시선 방향으로 만든 뷰 좌표계(DCS)의 x·y 축에 모형 좌표를 투영하므로,
 * 평면도가 아닌 축측도 뷰포트도 그대로 다룬다 (DCS 의 z 는 접는다).
 * 비틀기 부호는 AutoCAD 의 표준 DCS→WCS 행렬이 Rotation(−twist) 를 쓰는
 * 데에서 온다 — 그 역인 WCS→DCS 가 여기 쓰는 +twist 다. ezdxf 의
 * Viewport.get_transformation_matrix() 도 같은 방향으로 돌린다.
 * 뷰 중심(12/22)은 이미 DCS 값이라 돌리지 않는다.
 */
function viewportMatrix(vp: DxfViewport): Mat34 | null {
  const d = vp.viewDirection;
  if (Math.hypot(d.x, d.y, d.z) < 1e-9) return null;
  if (vp.viewHeight <= 1e-12 || vp.width <= 1e-12 || vp.height <= 1e-12) return null;

  // 시선 방향을 법선으로 하는 평면의 축 — OCS 와 같은 임의 축 알고리즘.
  const b = ocsMatrix(d);
  const ax: [number, number, number] = [b[0], b[4], b[8]];
  const ay: [number, number, number] = [b[1], b[5], b[9]];

  const scale = vp.height / vp.viewHeight;
  const t = (vp.twistAngle * Math.PI) / 180;
  const c = Math.cos(t);
  const sn = Math.sin(t);
  // 비틀기까지 반영한 DCS x·y 축.
  const u: [number, number, number] = [
    c * ax[0] - sn * ay[0],
    c * ax[1] - sn * ay[1],
    c * ax[2] - sn * ay[2],
  ];
  const v: [number, number, number] = [
    sn * ax[0] + c * ay[0],
    sn * ax[1] + c * ay[1],
    sn * ax[2] + c * ay[2],
  ];
  const tg = vp.viewTarget;
  const uT = u[0] * tg.x + u[1] * tg.y + u[2] * tg.z;
  const vT = v[0] * tg.x + v[1] * tg.y + v[2] * tg.z;

  const m = new Float64Array(12);
  m[0] = scale * u[0];
  m[1] = scale * u[1];
  m[2] = scale * u[2];
  m[3] = vp.center.x - scale * (vp.viewCenter.x + uT);
  m[4] = scale * v[0];
  m[5] = scale * v[1];
  m[6] = scale * v[2];
  m[7] = vp.center.y - scale * (vp.viewCenter.y + vT);
  // 배치는 평면이므로 DCS 의 z 는 접는다.
  m[8] = 0;
  m[9] = 0;
  m[10] = 0;
  m[11] = 0;
  return m;
}

function emptyScene(): FlatScene {
  return {
    paths: [],
    texts: [],
    fills: [],
    bounds: null,
    layerCounts: {},
    stats: { entities: 0, segments: 0, truncated: false },
  };
}

const NON_RECT_CLIP = 0x10000;
const VIEWPORT_OFF = 0x20000;

/**
 * 뷰포트 창 모양을 만든다.
 *
 * 90 번의 0x10000 비트가 서 있고 340 이 배치 안의 엔티티를 가리키면, 그
 * 엔티티를 평탄화해 나온 폴리라인을 경계로 쓴다 (LWPOLYLINE·원·타원·스플라인
 * 모두 같은 경로로 처리된다).
 */
function clipShapeOf(ctx: Ctx, vp: DxfViewport, layoutEntities: readonly DxfEntity[]): ClipShape {
  const rect: Rect = {
    minX: vp.center.x - vp.width / 2,
    maxX: vp.center.x + vp.width / 2,
    minY: vp.center.y - vp.height / 2,
    maxY: vp.center.y + vp.height / 2,
  };
  const shape: ClipShape = {
    rect,
    polygon: null,
    convexPlanes: null,
    triangles: null,
    halfPlanes: rectPlanes(rect),
  };

  if (!(vp.statusFlags & NON_RECT_CLIP) || !vp.clipBoundaryHandle) return shape;
  const boundary = layoutEntities.find((e) => e.handle === vp.clipBoundaryHandle);
  if (!boundary) return shape;

  // 경계 엔티티를 그대로 평탄화해 좌표를 얻는다 — 곡선 경계도 이러면 맞는다.
  const probe: Ctx = {
    doc: ctx.doc,
    opts: { ...ctx.opts, applyLineTypes: false, respectLayerState: false },
    scene: emptyScene(),
    segments: 0,
    modelOnly: false,
    frozenLayers: null,
  };
  flattenEntity(probe, boundary, identity(), 0, 7, undefined);
  let best: number[] | null = null;
  for (const path of probe.scene.paths) {
    if (!best || path.coords.length > best.length) best = path.coords;
  }
  if (!best || best.length < 9) return shape;

  const polygon: number[] = [];
  for (let i = 0; i + 2 < best.length; i += 3) {
    const x = best[i];
    const y = best[i + 1];
    const n = polygon.length;
    // 닫힌 폴리라인은 첫 점이 끝에 한 번 더 들어 있다.
    if (n >= 2 && Math.abs(polygon[n - 2] - x) < 1e-9 && Math.abs(polygon[n - 1] - y) < 1e-9) {
      continue;
    }
    polygon.push(x, y);
  }
  if (polygon.length >= 4) {
    const n = polygon.length;
    if (
      Math.abs(polygon[0] - polygon[n - 2]) < 1e-9 &&
      Math.abs(polygon[1] - polygon[n - 1]) < 1e-9
    ) {
      polygon.length = n - 2;
    }
  }
  if (polygon.length < 6) return shape;

  const convex = isConvex(polygon);
  // 볼록하면 반평면 한 벌로 끝난다. 오목할 때만 삼각형으로 쪼갠다.
  const triangles = convex ? null : triangulate(polygon);
  if (!convex && (!triangles || triangles.length === 0)) return shape;

  shape.polygon = polygon;
  shape.convexPlanes = convex
    ? polygonPlanes(polygon).map(([nx, ny, , d]) => [nx, ny, d])
    : null;
  shape.triangles = triangles;
  // 경계 다각형이 창 사각형보다 클 수는 없지만, 작을 수는 있다.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < polygon.length; i += 2) {
    if (polygon[i] < minX) minX = polygon[i];
    if (polygon[i] > maxX) maxX = polygon[i];
    if (polygon[i + 1] < minY) minY = polygon[i + 1];
    if (polygon[i + 1] > maxY) maxY = polygon[i + 1];
  }
  shape.rect = {
    minX: Math.max(rect.minX, minX),
    maxX: Math.min(rect.maxX, maxX),
    minY: Math.max(rect.minY, minY),
    maxY: Math.min(rect.maxY, maxY),
  };
  // 문자는 GPU 반평면으로 자르므로 볼록할 때만 경계를 그대로 쓴다.
  shape.halfPlanes = convex ? polygonPlanes(polygon) : rectPlanes(shape.rect);
  return shape;
}

/**
 * 문자가 차지하는 사각형이 창과 겹치는가.
 *
 * 글자 폭은 폰트에 달려 있어 정확히 알 수 없지만(렌더러가 캔버스로 재서
 * 그린다), 창 밖 문자를 걸러 내는 데에는 넉넉한 어림으로 충분하다.
 * 걸치는 문자는 남겨 두고 실제로 자르는 일은 렌더러가 반평면으로 한다.
 */
function textOverlaps(t: FlatText, r: Rect): boolean {
  const lines = t.text.split('\n').length;
  const h = Math.max(t.height * 1.22 * lines, 1e-9);
  const longest = t.text.split('\n').reduce((n, l) => Math.max(n, l.length), 1);
  const w = Math.max(t.height * 0.75 * (t.widthFactor || 1) * longest, h);

  // 정렬에 따라 기준점이 상자의 어디에 붙는지.
  const x0 = t.hAlign === 0 ? 0 : t.hAlign === 1 ? -w / 2 : -w;
  const y0 = t.vAlign === 3 ? -h : t.vAlign === 2 ? -h / 2 : 0;
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ]) {
    const px = t.x + cx * cos - cy * sin;
    const py = t.y + cx * sin + cy * cos;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return maxX >= r.minX && minX <= r.maxX && maxY >= r.minY && minY <= r.maxY;
}

/** 뷰포트 창 하나에 모형 공간을 그려 넣는다. */
function flattenViewport(ctx: Ctx, vp: DxfViewport, layoutEntities: readonly DxfEntity[]) {
  if (vp.status === 0 || (vp.statusFlags & VIEWPORT_OFF) !== 0) return; // 꺼진 뷰포트
  if (vp.viewportId === 1) return; // 배치 전체를 가리키는 가짜 뷰포트
  // 뷰포트 테두리는 그리지 않으므로 레이어 상태(끄기/동결)는 보지 않는다.
  // "Viewports" 레이어를 꺼 두고 쓰는 도면이 흔한데, 그래도 창 안 내용은 보인다.
  if (vp.invisible) return;
  const m = viewportMatrix(vp);
  if (!m) return;

  const shape = clipShapeOf(ctx, vp, layoutEntities);
  const rect = shape.rect;
  if (rect.maxX - rect.minX <= 0 || rect.maxY - rect.minY <= 0) return;

  // 이 창에서만 꺼 두는 레이어(331). 배치마다 다른 것을 보여 주는 장치라
  // 반영하지 않으면 창 네 개가 전부 같은 그림이 된다.
  let frozen: Set<string> | null = null;
  for (const handle of vp.frozenLayerHandles) {
    const name = ctx.doc.layerNamesByHandle.get(handle);
    if (!name) continue;
    (frozen ??= new Set()).add(name);
  }

  // 모형 공간을 따로 평탄화한 뒤 창 모양으로 잘라 붙인다.
  const sub: Ctx = {
    doc: ctx.doc,
    opts: ctx.opts,
    scene: emptyScene(),
    segments: ctx.segments,
    modelOnly: true,
    frozenLayers: frozen,
  };
  for (const e of ctx.doc.entities) {
    if (e.type === 'VIEWPORT') continue;
    flattenEntity(sub, e, m, 0, 7, undefined);
    if (sub.scene.stats.truncated) break;
  }
  ctx.segments = sub.segments;
  if (sub.scene.stats.truncated) ctx.scene.stats.truncated = true;
  ctx.scene.stats.entities += sub.scene.stats.entities;

  const bump = (layer: string) => {
    ctx.scene.layerCounts[layer] = (ctx.scene.layerCounts[layer] ?? 0) + 1;
  };
  const poly = shape.polygon;

  for (const path of sub.scene.paths) {
    // 창 사각형으로 먼저 거른 다음, 사각형이 아니면 경계로 한 번 더 자른다.
    for (const piece of clipPolyline(path.coords, rect)) {
      for (const part of poly ? clipPolylinePolygon(piece, poly) : [piece]) {
        ctx.scene.paths.push({ ...path, coords: part });
        accumulateBounds(ctx.scene, part);
        bump(path.layer);
      }
    }
  }

  for (const text of sub.scene.texts) {
    // 기준점이 창 밖이어도 글자 몸통이 걸치면 남긴다 — 실제로 자르는 일은
    // 렌더러가 halfPlanes 로 한다.
    if (!textOverlaps(text, rect)) continue;
    if (shape.polygon && !inRect(text.x, text.y, rect) && !pointInPolygon(text.x, text.y, shape.polygon)) {
      continue;
    }
    ctx.scene.texts.push({ ...text, clip: shape.halfPlanes });
    accumulateBounds(ctx.scene, [
      Math.max(rect.minX, Math.min(rect.maxX, text.x)),
      Math.max(rect.minY, Math.min(rect.maxY, text.y)),
      text.z,
    ]);
    bump(text.layer);
  }

  for (const fill of sub.scene.fills) {
    const loops: number[][] = [];
    for (const loop of fill.loops) {
      const clipped = clipLoop(loop, rect);
      if (clipped.length < 6) continue;
      if (!poly) {
        loops.push(clipped);
        continue;
      }
      if (shape.convexPlanes) {
        const part = clipLoopPlanes(clipped, shape.convexPlanes);
        if (part.length >= 6) loops.push(part);
        continue;
      }
      // 오목한 경계는 볼록 조각(삼각형)으로 나눠 자른다. 조각이 여러 개 나와도
      // 렌더러는 루프 목록을 그대로 받으므로 합칠 필요가 없다.
      for (const tri of shape.triangles ?? []) {
        const part = clipLoopPlanes(clipped, trianglePlanes(tri));
        if (part.length >= 6) loops.push(part);
      }
    }
    if (loops.length === 0) continue;
    ctx.scene.fills.push({ ...fill, loops });
    for (const loop of loops) {
      const flat: number[] = [];
      for (let i = 0; i + 1 < loop.length; i += 2) flat.push(loop[i], loop[i + 1], 0);
      accumulateBounds(ctx.scene, flat);
    }
    bump(fill.layer);
  }
}

/** 배치의 용지 한 장을 테두리로 그린다 (LAYOUT 의 LIMMIN/LIMMAX). */
function emitPaperBorder(ctx: Ctx, layout: DxfLayout) {
  const a = layout.limMin;
  const b = layout.limMax;
  const w = b.x - a.x;
  const h = b.y - a.y;
  if (!(w > 1e-9) || !(h > 1e-9)) return; // 용지 정보가 없는 배치
  const coords = [
    a.x, a.y, 0,
    b.x, a.y, 0,
    b.x, b.y, 0,
    a.x, b.y, 0,
    a.x, a.y, 0,
  ];
  ctx.scene.paths.push({
    coords,
    // 도면의 레이어가 아니므로 레이어 패널에 끼지 않게 빈 이름으로 둔다.
    layer: '',
    color: displayHex(8, ctx.opts.darkBackground),
    entityType: 'PAPER',
    weight: 0,
  });
  ctx.segments += 4;
  accumulateBounds(ctx.scene, coords);
}

/** 모형 + 배치 목록을 UI 에 넘길 수 있는 형태로 돌려준다. */
export function listSpaces(doc: DxfDocument): { name: string; isModelSpace: boolean }[] {
  return doc.layouts.map((l) => ({ name: l.name, isModelSpace: l.isModelSpace }));
}

/**
 * 그릴 엔티티를 고른다.
 *
 * 모형 공간은 지금까지와 똑같이 문서의 엔티티 전부(페이퍼 공간 표시가 붙은
 * 것은 flattenEntity 가 걸러낸다). 배치는 그 배치의 BLOCK_RECORD 를 소유자로
 * 갖는 엔티티를 모으고, ENTITIES 섹션이 아니라 같은 이름의 블록 안에 들어
 * 있는 변형도 받아 준다.
 */
function selectSpace(
  doc: DxfDocument,
  space: string | null,
): { entities: DxfEntity[]; modelOnly: boolean; layout: DxfLayout | null } {
  if (space === null || space === '') {
    return { entities: doc.entities, modelOnly: true, layout: null };
  }

  const want = space.toUpperCase();
  const layout = doc.layouts.find((l) => l.name.toUpperCase() === want);
  if (!layout) return { entities: [], modelOnly: false, layout: null };
  if (layout.isModelSpace) return { entities: doc.entities, modelOnly: true, layout: null };

  const handle = layout.blockRecordHandle;
  let entities = handle
    ? doc.entities.filter((e) => e.ownerHandle === handle)
    : doc.entities.filter((e) => e.paperSpace);
  if (entities.length === 0 && layout.blockName) {
    entities = doc.blocks.get(layout.blockName)?.entities ?? [];
  }
  return { entities, modelOnly: false, layout };
}

export function flattenDocument(
  doc: DxfDocument,
  options: Partial<FlattenOptions> = {},
): FlatScene {
  const opts = { ...DEFAULT_FLATTEN_OPTIONS, ...options };
  const scene = emptyScene();
  const { entities, modelOnly, layout } = selectSpace(doc, opts.space);
  const ctx: Ctx = { doc, opts, scene, segments: 0, modelOnly, frozenLayers: null };

  if (opts.paperBorder && layout) emitPaperBorder(ctx, layout);

  const viewports: DxfViewport[] = [];
  for (const e of entities) {
    if (e.type === 'VIEWPORT') {
      if (!modelOnly) viewports.push(e);
      continue;
    }
    flattenEntity(ctx, e, identity(), 0, 7, undefined);
    if (scene.stats.truncated) break;
  }

  // 뷰포트 안쪽(모형 공간)은 배치 엔티티를 다 그린 뒤에 채운다.
  if (opts.viewportContents && !scene.stats.truncated) {
    for (const vp of viewports) {
      flattenViewport(ctx, vp, entities);
      if (scene.stats.truncated) break;
    }
  }

  scene.stats.segments = ctx.segments;

  if (scene.bounds && !Number.isFinite(scene.bounds.minX)) scene.bounds = null;
  return scene;
}
