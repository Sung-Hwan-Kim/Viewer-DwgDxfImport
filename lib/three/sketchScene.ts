import * as THREE from 'three';

import type { FlatScene } from '../dxf/flatten';

/**
 * 평탄화된 도면을 three.js 오브젝트로 만든다.
 *
 * 선은 색깔별로 하나의 LineSegments 로 묶어 드로우 콜을 최소화하고,
 * 채움은 ShapeGeometry, 문자는 캔버스 텍스처 평면으로 그린다.
 */

export type SketchStyle = 'cad' | 'paper' | 'blueprint' | 'sketch';

export interface BuildOptions {
  style: SketchStyle;
  /** 숨길 레이어 이름 */
  hiddenLayers: ReadonlySet<string>;
  /** 모든 선을 한 가지 잉크색으로 */
  monochrome: boolean;
  /** 손그림 떨림 정도 0~1 */
  jitter: number;
  showText: boolean;
  showFills: boolean;
  showHatchPattern: boolean;
}

export interface StyleTokens {
  background: number;
  ink: number;
  /** 밝은 배경인가 */
  light: boolean;
  lineOpacity: number;
  /** 손그림 덧칠 횟수 */
  strokes: number;
}

export const STYLE_TOKENS: Record<SketchStyle, StyleTokens> = {
  cad: { background: 0x1b1d21, ink: 0xffffff, light: false, lineOpacity: 1, strokes: 1 },
  paper: { background: 0xf7f5f0, ink: 0x1d1d1f, light: true, lineOpacity: 0.95, strokes: 1 },
  blueprint: { background: 0x0e3a6b, ink: 0xdfe9f5, light: false, lineOpacity: 0.9, strokes: 1 },
  sketch: { background: 0xf4f1e8, ink: 0x2a2724, light: true, lineOpacity: 0.72, strokes: 2 },
};

export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  style: 'cad',
  hiddenLayers: new Set<string>(),
  monochrome: false,
  jitter: 0.5,
  showText: true,
  showFills: true,
  showHatchPattern: true,
};

export interface BuiltScene {
  group: THREE.Group;
  /** 생성된 선분 개수 */
  segmentCount: number;
  textCount: number;
  dispose: () => void;
}

// ------------------------------------------------------------------ 난수/떨림

/** 좌표로부터 결정적으로 뽑는 [-1, 1] 잡음 — 매 프레임 같은 모양을 유지한다. */
function noise(x: number, y: number, salt: number): number {
  let h = Math.imul(Math.round(x * 131.17) ^ Math.imul(Math.round(y * 97.31), 0x9e3779b1), 0x85ebca6b);
  h ^= Math.imul(salt + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * 폴리라인을 손으로 그린 듯 흔든다.
 * 긴 선분은 잘라 중간 점을 수직 방향으로 밀어 준다.
 */
function jitterPath(coords: number[], amplitude: number, salt: number): number[] {
  if (amplitude <= 0 || coords.length < 6) return coords;
  const out: number[] = [];
  const maxStep = amplitude * 18;

  for (let i = 0; i + 5 < coords.length; i += 3) {
    const x1 = coords[i];
    const y1 = coords[i + 1];
    const z1 = coords[i + 2];
    const x2 = coords[i + 3];
    const y2 = coords[i + 4];
    const z2 = coords[i + 5];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.min(12, Math.ceil(len / Math.max(maxStep, 1e-9))));
    const nx = len > 1e-12 ? -(y2 - y1) / len : 0;
    const ny = len > 1e-12 ? (x2 - x1) / len : 0;

    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const px = x1 + (x2 - x1) * t;
      const py = y1 + (y2 - y1) * t;
      // 끝점은 거의 고정해 도형이 벌어지지 않게 한다.
      const edge = Math.min(t, 1 - t) * 2;
      const w = amplitude * (0.25 + 0.75 * edge);
      const n = noise(px, py, salt);
      out.push(px + nx * n * w, py + ny * n * w, z1 + (z2 - z1) * t);
    }
  }
  const n = coords.length;
  out.push(coords[n - 3], coords[n - 2], coords[n - 1]);
  return out;
}

// ------------------------------------------------------------------ 문자 베이킹

const TEXT_BAKE_PX = 128;
const MAX_TEXT_MESHES = 4000;

interface TextTexture {
  texture: THREE.Texture;
  /** 글리프 폭 / 높이 비율 */
  aspect: number;
  lines: number;
}

class TextTextureCache {
  private readonly cache = new Map<string, TextTexture>();
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
  }

  get(text: string, fontFamily: string): TextTexture | null {
    const key = `${fontFamily}::${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (!this.ctx) return null;

    const lines = text.split('\n');
    const fontPx = TEXT_BAKE_PX;
    const pad = Math.round(fontPx * 0.16);
    const lineHeight = Math.round(fontPx * 1.22);

    this.ctx.font = `${fontPx}px ${fontFamily}`;
    let maxWidth = 1;
    for (const l of lines) maxWidth = Math.max(maxWidth, this.ctx.measureText(l).width);

    const w = Math.min(4096, Math.ceil(maxWidth) + pad * 2);
    const h = Math.ceil(lineHeight * lines.length) + pad * 2;
    this.canvas.width = w;
    this.canvas.height = h;

    // 캔버스 크기를 바꾸면 컨텍스트 상태가 초기화되므로 다시 설정한다.
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.font = `${fontPx}px ${fontFamily}`;
    this.ctx.fillStyle = '#ffffff';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < lines.length; i++) {
      this.ctx.fillText(lines[i], pad, pad + lineHeight * i + fontPx * 0.82);
    }

    // 측정용 캔버스는 다음 문자열에 재사용하므로 픽셀을 따로 복사해 둔다.
    const copy = document.createElement('canvas');
    copy.width = w;
    copy.height = h;
    copy.getContext('2d')?.drawImage(this.canvas, 0, 0);

    const texture = new THREE.CanvasTexture(copy);
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;

    const entry: TextTexture = { texture, aspect: w / h, lines: lines.length };
    this.cache.set(key, entry);
    return entry;
  }

  dispose() {
    for (const v of this.cache.values()) v.texture.dispose();
    this.cache.clear();
  }
}

let sharedTextCache: TextTextureCache | null = null;
function textCache(): TextTextureCache {
  if (!sharedTextCache) sharedTextCache = new TextTextureCache();
  return sharedTextCache;
}

// ------------------------------------------------------------------- 빌더

function inkFor(color: number, tokens: StyleTokens, monochrome: boolean): number {
  if (monochrome) return tokens.ink;
  // 어두운 배경 기준으로 평탄화된 흰색은 밝은 배경에서 보이지 않는다.
  if (tokens.light && color === 0xffffff) return tokens.ink;
  if (!tokens.light && color === 0x000000) return 0xffffff;
  return color;
}

export function buildSketchScene(
  scene: FlatScene,
  options: Partial<BuildOptions> = {},
  fontFamily = 'system-ui, sans-serif',
): BuiltScene {
  const opts: BuildOptions = { ...DEFAULT_BUILD_OPTIONS, ...options };
  const tokens = STYLE_TOKENS[opts.style];
  const group = new THREE.Group();
  group.name = 'cad-drawing';

  const disposables: { dispose: () => void }[] = [];
  let segmentCount = 0;

  // 도면 크기에 비례한 떨림 폭.
  const b = scene.bounds;
  const diag = b ? Math.hypot(b.maxX - b.minX, b.maxY - b.minY) : 1;
  const amplitude = opts.style === 'sketch' ? (diag * 0.0009 * opts.jitter) : 0;

  // ---- 선: 색깔별로 모은다 ----
  const byColor = new Map<number, number[]>();

  for (const path of scene.paths) {
    if (opts.hiddenLayers.has(path.layer)) continue;
    if (!opts.showHatchPattern && path.entityType === 'HATCH-PATTERN') continue;

    const color = inkFor(path.color, tokens, opts.monochrome);
    let bucket = byColor.get(color);
    if (!bucket) {
      bucket = [];
      byColor.set(color, bucket);
    }

    for (let pass = 0; pass < tokens.strokes; pass++) {
      const coords =
        amplitude > 0 ? jitterPath(path.coords, amplitude, pass * 7919 + 13) : path.coords;
      // 폴리라인 → 선분 쌍
      for (let i = 0; i + 5 < coords.length; i += 3) {
        bucket.push(
          coords[i], coords[i + 1], coords[i + 2],
          coords[i + 3], coords[i + 4], coords[i + 5],
        );
        segmentCount++;
      }
    }
  }

  for (const [color, coords] of byColor) {
    if (coords.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(coords, 3));
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: tokens.lineOpacity < 1,
      opacity: tokens.lineOpacity,
      depthTest: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 2;
    lines.frustumCulled = false;
    group.add(lines);
    disposables.push(geometry, material);
  }

  // ---- 채움 ----
  if (opts.showFills) {
    for (const fill of scene.fills) {
      if (opts.hiddenLayers.has(fill.layer)) continue;
      if (fill.loops.length === 0) continue;

      const shape = new THREE.Shape();
      const outer = fill.loops[0];
      shape.moveTo(outer[0], outer[1]);
      for (let i = 2; i + 1 < outer.length; i += 2) shape.lineTo(outer[i], outer[i + 1]);
      shape.closePath();

      for (let k = 1; k < fill.loops.length; k++) {
        const hole = fill.loops[k];
        if (hole.length < 6) continue;
        const p = new THREE.Path();
        p.moveTo(hole[0], hole[1]);
        for (let i = 2; i + 1 < hole.length; i += 2) p.lineTo(hole[i], hole[i + 1]);
        p.closePath();
        shape.holes.push(p);
      }

      let geometry: THREE.ShapeGeometry;
      try {
        geometry = new THREE.ShapeGeometry(shape);
      } catch {
        continue; // 삼각분할 실패한 퇴화 경계는 건너뛴다.
      }
      const material = new THREE.MeshBasicMaterial({
        color: inkFor(fill.color, tokens, opts.monochrome),
        transparent: true,
        opacity: opts.style === 'sketch' ? 0.18 : 0.35,
        side: THREE.DoubleSide,
        depthTest: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      group.add(mesh);
      disposables.push(geometry, material);
    }
  }

  // ---- 문자 ----
  let textCount = 0;
  if (opts.showText && typeof document !== 'undefined') {
    const cache = textCache();
    const planeGeometry = new THREE.PlaneGeometry(1, 1);
    disposables.push(planeGeometry);

    for (const t of scene.texts) {
      if (opts.hiddenLayers.has(t.layer)) continue;
      if (textCount >= MAX_TEXT_MESHES) break;
      const baked = cache.get(t.text, fontFamily);
      if (!baked) continue;

      const lineHeight = t.height * 1.22;
      const height = lineHeight * baked.lines;
      const width = height * baked.aspect * (t.widthFactor || 1);

      const material = new THREE.MeshBasicMaterial({
        map: baked.texture,
        color: inkFor(t.color, tokens, opts.monochrome),
        transparent: true,
        depthTest: false,
        // 글리프 가장자리의 반투명 픽셀이 배경을 가리지 않도록.
        alphaTest: 0.04,
      });
      // 뷰포트 창에 걸친 문자는 글리프를 잘라야 해서 GPU 클리핑에 맡긴다.
      // (선·면은 평탄화 단계에서 이미 좌표가 잘려 있다.)
      if (t.clip?.length) {
        material.clippingPlanes = t.clip.map(
          ([nx, ny, nz, d]) => new THREE.Plane(new THREE.Vector3(nx, ny, nz), d),
        );
      }
      const mesh = new THREE.Mesh(planeGeometry, material);

      // 평면은 중심 기준이므로 정렬에 맞춰 반 칸 옮긴다.
      const ax = t.hAlign === 0 ? 0.5 : t.hAlign === 1 ? 0 : -0.5;
      const ay = t.vAlign === 3 ? -0.5 : t.vAlign === 2 ? 0 : 0.5;
      const rad = (t.rotation * Math.PI) / 180;
      const ox = ax * width;
      const oy = ay * height;

      mesh.position.set(
        t.x + ox * Math.cos(rad) - oy * Math.sin(rad),
        t.y + ox * Math.sin(rad) + oy * Math.cos(rad),
        t.z + 0.01,
      );
      mesh.rotation.z = rad;
      mesh.scale.set(width, height, 1);
      mesh.renderOrder = 3;
      group.add(mesh);
      disposables.push(material);
      textCount++;
    }
  }

  return {
    group,
    segmentCount,
    textCount,
    dispose: () => {
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };
}

export function disposeTextCache() {
  sharedTextCache?.dispose();
  sharedTextCache = null;
}
