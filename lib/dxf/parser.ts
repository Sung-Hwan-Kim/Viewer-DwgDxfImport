import { lexDxf } from './lexer';
import {
  type DxfAcadTable,
  type DxfArc,
  type DxfBlock,
  type DxfCircle,
  type DxfDimension,
  type DxfDocument,
  type DxfEllipse,
  type DxfEntity,
  type DxfEntityBase,
  type DxfHatch,
  type DxfHatchPatternLine,
  type DxfInsert,
  type DxfLayer,
  type DxfLayout,
  type DxfLeader,
  type DxfLine,
  type DxfLineType,
  type DxfLwPolyline,
  type DxfMLeader,
  type DxfMLeaderAttribute,
  type DxfMLeaderCluster,
  type DxfMText,
  type DxfPair,
  type DxfPoint,
  type DxfPolyline,
  type DxfPolylineVertex,
  type DxfRay,
  type DxfSolid,
  type DxfSpline,
  type DxfTableCell,
  type DxfText,
  type DxfTextStyle,
  type DxfViewport,
  type Point3,
  pt,
} from './types';

/** 그룹 코드 쌍 위를 움직이는 커서. */
class Cursor {
  i = 0;
  constructor(readonly pairs: DxfPair[]) {}
  get done() {
    return this.i >= this.pairs.length;
  }
  peek(): DxfPair | undefined {
    return this.pairs[this.i];
  }
  next(): DxfPair | undefined {
    return this.pairs[this.i++];
  }
}

const num = (v: DxfPair['value']): number =>
  typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Number.parseFloat(String(v)) || 0;
const str = (v: DxfPair['value']): string => (typeof v === 'string' ? v : String(v));

/** code 0 이 나올 때까지의 쌍을 모아 반환한다 (code 0 은 소비하지 않음). */
function collectUntilNextEntity(c: Cursor): DxfPair[] {
  const out: DxfPair[] = [];
  while (!c.done) {
    const p = c.peek()!;
    if (p.code === 0) break;
    out.push(p);
    c.i++;
  }
  return out;
}

function baseEntity(type: string): DxfEntityBase {
  return {
    type,
    handle: '',
    ownerHandle: '',
    layer: '0',
    lineType: 'BYLAYER',
    colorIndex: 256,
    lineWeight: -1,
    lineTypeScale: 1,
    invisible: false,
    extrusion: pt(0, 0, 1),
    paperSpace: false,
  };
}

/** 모든 엔티티 공통 그룹 코드를 적용한다. 처리했으면 true. */
function applyCommon(e: DxfEntityBase, p: DxfPair): boolean {
  switch (p.code) {
    case 5:
      e.handle = str(p.value);
      return true;
    case 330:
      e.ownerHandle = str(p.value);
      return true;
    case 8:
      e.layer = str(p.value);
      return true;
    case 6:
      e.lineType = str(p.value);
      return true;
    case 62:
      e.colorIndex = num(p.value);
      return true;
    case 420:
      e.trueColor = num(p.value) & 0xffffff;
      return true;
    case 370:
      e.lineWeight = num(p.value);
      return true;
    case 48:
      e.lineTypeScale = num(p.value) || 1;
      return true;
    case 60:
      e.invisible = num(p.value) === 1;
      return true;
    case 67:
      e.paperSpace = num(p.value) === 1;
      return true;
    case 210:
      e.extrusion.x = num(p.value);
      return true;
    case 220:
      e.extrusion.y = num(p.value);
      return true;
    case 230:
      e.extrusion.z = num(p.value);
      return true;
    // 서브클래스 마커·확장 데이터 — 그리기에는 필요 없다.
    case 100:
    case 102:
    case 1001:
      return true;
    default:
      return false;
  }
}

// ------------------------------------------------------------- 엔티티별 파서

function parseLine(pairs: DxfPair[]): DxfLine {
  const e = { ...baseEntity('LINE'), start: pt(), end: pt() } as DxfLine;
  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    switch (p.code) {
      case 10: e.start.x = num(p.value); break;
      case 20: e.start.y = num(p.value); break;
      case 30: e.start.z = num(p.value); break;
      case 11: e.end.x = num(p.value); break;
      case 21: e.end.y = num(p.value); break;
      case 31: e.end.z = num(p.value); break;
    }
  }
  return e;
}

function parseLwPolyline(pairs: DxfPair[]): DxfLwPolyline {
  const e = {
    ...baseEntity('LWPOLYLINE'),
    vertices: [],
    closed: false,
    constantWidth: 0,
    elevation: 0,
  } as DxfLwPolyline;

  let current: DxfPolylineVertex | null = null;
  const push = () => {
    if (current) e.vertices.push(current);
  };

  for (const p of pairs) {
    // 10 번은 "새 정점 시작" 신호라 공통 처리보다 먼저 가로챈다.
    if (p.code !== 10 && applyCommon(e, p)) continue;
    switch (p.code) {
      case 10:
        push();
        current = { x: num(p.value), y: 0, z: 0, bulge: 0, startWidth: 0, endWidth: 0 };
        break;
      case 20: if (current) current.y = num(p.value); break;
      case 42: if (current) current.bulge = num(p.value); break;
      case 40: if (current) current.startWidth = num(p.value); break;
      case 41: if (current) current.endWidth = num(p.value); break;
      case 70: e.closed = (num(p.value) & 1) === 1; break;
      case 43: e.constantWidth = num(p.value); break;
      case 38: e.elevation = num(p.value); break;
    }
  }
  push();
  for (const v of e.vertices) v.z = e.elevation;
  return e;
}

function parseCircle(pairs: DxfPair[]): DxfCircle {
  const e = { ...baseEntity('CIRCLE'), center: pt(), radius: 0 } as DxfCircle;
  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    switch (p.code) {
      case 10: e.center.x = num(p.value); break;
      case 20: e.center.y = num(p.value); break;
      case 30: e.center.z = num(p.value); break;
      case 40: e.radius = num(p.value); break;
    }
  }
  return e;
}

function parseArc(pairs: DxfPair[]): DxfArc {
  const e = { ...baseEntity('ARC'), center: pt(), radius: 0, startAngle: 0, endAngle: 0 } as DxfArc;
  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    switch (p.code) {
      case 10: e.center.x = num(p.value); break;
      case 20: e.center.y = num(p.value); break;
      case 30: e.center.z = num(p.value); break;
      case 40: e.radius = num(p.value); break;
      case 50: e.startAngle = num(p.value); break;
      case 51: e.endAngle = num(p.value); break;
    }
  }
  return e;
}

function parseEllipse(pairs: DxfPair[]): DxfEllipse {
  const e = {
    ...baseEntity('ELLIPSE'),
    center: pt(),
    majorAxis: pt(1, 0, 0),
    axisRatio: 1,
    startParam: 0,
    endParam: Math.PI * 2,
  } as DxfEllipse;
  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    switch (p.code) {
      case 10: e.center.x = num(p.value); break;
      case 20: e.center.y = num(p.value); break;
      case 30: e.center.z = num(p.value); break;
      case 11: e.majorAxis.x = num(p.value); break;
      case 21: e.majorAxis.y = num(p.value); break;
      case 31: e.majorAxis.z = num(p.value); break;
      case 40: e.axisRatio = num(p.value); break;
      case 41: e.startParam = num(p.value); break;
      case 42: e.endParam = num(p.value); break;
    }
  }
  return e;
}

function parseSpline(pairs: DxfPair[]): DxfSpline {
  const e = {
    ...baseEntity('SPLINE'),
    degree: 3,
    closed: false,
    knots: [],
    weights: [],
    controlPoints: [],
    fitPoints: [],
  } as DxfSpline;

  let cp: Point3 | null = null;
  let fp: Point3 | null = null;

  for (const p of pairs) {
    // 10/11 은 점 시작, 40 은 노트 — 공통 처리에 넘기면 안 된다.
    if (p.code !== 10 && p.code !== 11 && p.code !== 40 && applyCommon(e, p)) continue;
    switch (p.code) {
      case 70: e.closed = (num(p.value) & 1) === 1; break;
      case 71: e.degree = num(p.value) || 3; break;
      case 40: e.knots.push(num(p.value)); break;
      case 41: e.weights.push(num(p.value)); break;
      case 10:
        cp = pt(num(p.value));
        e.controlPoints.push(cp);
        break;
      case 20: if (cp) cp.y = num(p.value); break;
      case 30: if (cp) cp.z = num(p.value); break;
      case 11:
        fp = pt(num(p.value));
        e.fitPoints.push(fp);
        break;
      case 21: if (fp) fp.y = num(p.value); break;
      case 31: if (fp) fp.z = num(p.value); break;
    }
  }
  return e;
}

function parsePoint(pairs: DxfPair[]): DxfPoint {
  const e = { ...baseEntity('POINT'), position: pt() } as DxfPoint;
  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    switch (p.code) {
      case 10: e.position.x = num(p.value); break;
      case 20: e.position.y = num(p.value); break;
      case 30: e.position.z = num(p.value); break;
    }
  }
  return e;
}

function parseText(pairs: DxfPair[]): DxfText {
  const e = {
    ...baseEntity('TEXT'),
    position: pt(),
    alignmentPoint: pt(),
    hasAlignmentPoint: false,
    text: '',
    height: 1,
    rotation: 0,
    widthFactor: 1,
    obliqueAngle: 0,
    styleName: 'STANDARD',
    halign: 0,
    valign: 0,
    mirrorFlags: 0,
  } as DxfText;

  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    switch (p.code) {
      case 10: e.position.x = num(p.value); break;
      case 20: e.position.y = num(p.value); break;
      case 30: e.position.z = num(p.value); break;
      case 11: e.alignmentPoint.x = num(p.value); e.hasAlignmentPoint = true; break;
      case 21: e.alignmentPoint.y = num(p.value); e.hasAlignmentPoint = true; break;
      case 31: e.alignmentPoint.z = num(p.value); break;
      case 1: e.text = str(p.value); break;
      case 40: e.height = num(p.value) || 1; break;
      case 50: e.rotation = num(p.value); break;
      case 41: e.widthFactor = num(p.value) || 1; break;
      case 51: e.obliqueAngle = num(p.value); break;
      case 7: e.styleName = str(p.value); break;
      case 71: e.mirrorFlags = num(p.value); break;
      case 72: e.halign = num(p.value); break;
      case 73: e.valign = num(p.value); break;
    }
  }
  return e;
}

function parseMText(pairs: DxfPair[]): DxfMText {
  const e = {
    ...baseEntity('MTEXT'),
    position: pt(),
    text: '',
    height: 1,
    width: 0,
    attachmentPoint: 1,
    rotation: 0,
    lineSpacing: 1,
    styleName: 'STANDARD',
  } as DxfMText;

  // 본문은 3번 코드로 250자씩 쪼개지고 마지막 조각이 1번으로 온다.
  const chunks: string[] = [];
  let tail = '';
  let xAxis: Point3 | null = null;

  for (const p of pairs) {
    if (p.code !== 11 && applyCommon(e, p)) continue;
    switch (p.code) {
      case 10: e.position.x = num(p.value); break;
      case 20: e.position.y = num(p.value); break;
      case 30: e.position.z = num(p.value); break;
      case 11: xAxis = xAxis ?? pt(); xAxis.x = num(p.value); break;
      case 21: if (xAxis) xAxis.y = num(p.value); break;
      case 3: chunks.push(str(p.value)); break;
      case 1: tail = str(p.value); break;
      case 40: e.height = num(p.value) || 1; break;
      case 41: e.width = num(p.value); break;
      case 71: e.attachmentPoint = num(p.value) || 1; break;
      case 50: e.rotation = num(p.value); break;
      case 44: e.lineSpacing = num(p.value) || 1; break;
      case 7: e.styleName = str(p.value); break;
    }
  }
  e.text = chunks.join('') + tail;
  // 11/21 방향 벡터가 있으면 50번 각도보다 우선한다.
  if (xAxis && (xAxis.x !== 0 || xAxis.y !== 0)) {
    e.rotation = (Math.atan2(xAxis.y, xAxis.x) * 180) / Math.PI;
  }
  return e;
}

function parseInsert(pairs: DxfPair[]): DxfInsert {
  const e = {
    ...baseEntity('INSERT'),
    blockName: '',
    position: pt(),
    scale: pt(1, 1, 1),
    rotation: 0,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
    attributes: [],
  } as DxfInsert;
  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    switch (p.code) {
      case 2: e.blockName = str(p.value); break;
      case 10: e.position.x = num(p.value); break;
      case 20: e.position.y = num(p.value); break;
      case 30: e.position.z = num(p.value); break;
      case 41: e.scale.x = num(p.value); break;
      case 42: e.scale.y = num(p.value); break;
      case 43: e.scale.z = num(p.value); break;
      case 50: e.rotation = num(p.value); break;
      case 70: e.columnCount = num(p.value) || 1; break;
      case 71: e.rowCount = num(p.value) || 1; break;
      case 44: e.columnSpacing = num(p.value); break;
      case 45: e.rowSpacing = num(p.value); break;
    }
  }
  // 스케일 0 은 의미가 없고 행렬을 퇴화시키므로 1 로 되돌린다.
  if (e.scale.x === 0) e.scale.x = 1;
  if (e.scale.y === 0) e.scale.y = 1;
  if (e.scale.z === 0) e.scale.z = 1;
  return e;
}

function parseSolid(pairs: DxfPair[], type: 'SOLID' | '3DFACE'): DxfSolid {
  const e = { ...baseEntity(type), corners: [pt(), pt(), pt(), pt()] } as DxfSolid;
  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    // 10~13 / 20~23 / 30~33 → 네 꼭짓점의 x, y, z
    if (p.code >= 10 && p.code <= 33) {
      const idx = p.code % 10;
      const axis = Math.floor(p.code / 10);
      if (idx <= 3 && axis >= 1 && axis <= 3) {
        const c = e.corners[idx];
        if (axis === 1) c.x = num(p.value);
        else if (axis === 2) c.y = num(p.value);
        else c.z = num(p.value);
      }
    }
  }
  return e;
}

function parseDimension(pairs: DxfPair[]): DxfDimension {
  const e = {
    ...baseEntity('DIMENSION'),
    blockName: '',
    textPosition: pt(),
    definitionPoint: pt(),
    text: '',
    measurement: 0,
  } as DxfDimension;
  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    switch (p.code) {
      case 2: e.blockName = str(p.value); break;
      case 10: e.definitionPoint.x = num(p.value); break;
      case 20: e.definitionPoint.y = num(p.value); break;
      case 30: e.definitionPoint.z = num(p.value); break;
      case 11: e.textPosition.x = num(p.value); break;
      case 21: e.textPosition.y = num(p.value); break;
      case 31: e.textPosition.z = num(p.value); break;
      case 1: e.text = str(p.value); break;
      case 42: e.measurement = num(p.value); break;
    }
  }
  return e;
}

function parseLeader(pairs: DxfPair[]): DxfLeader {
  const e = { ...baseEntity('LEADER'), vertices: [] } as DxfLeader;
  let v: Point3 | null = null;
  for (const p of pairs) {
    if (p.code !== 10 && applyCommon(e, p)) continue;
    switch (p.code) {
      case 10:
        v = pt(num(p.value));
        e.vertices.push(v);
        break;
      case 20: if (v) v.y = num(p.value); break;
      case 30: if (v) v.z = num(p.value); break;
    }
  }
  return e;
}

function parseRay(pairs: DxfPair[], type: 'RAY' | 'XLINE'): DxfRay {
  const e = { ...baseEntity(type), basePoint: pt(), direction: pt(1, 0, 0) } as DxfRay;
  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    switch (p.code) {
      case 10: e.basePoint.x = num(p.value); break;
      case 20: e.basePoint.y = num(p.value); break;
      case 30: e.basePoint.z = num(p.value); break;
      case 11: e.direction.x = num(p.value); break;
      case 21: e.direction.y = num(p.value); break;
      case 31: e.direction.z = num(p.value); break;
    }
  }
  return e;
}

function parseViewport(pairs: DxfPair[]): DxfViewport {
  const e = {
    ...baseEntity('VIEWPORT'),
    center: pt(),
    width: 0,
    height: 0,
    viewCenter: pt(),
    viewHeight: 0,
    viewDirection: pt(0, 0, 1),
    viewTarget: pt(),
    twistAngle: 0,
    status: 1,
    viewportId: 0,
    frozenLayerHandles: [],
    statusFlags: 0,
    clipBoundaryHandle: '',
  } as DxfViewport;
  for (const p of pairs) {
    if (applyCommon(e, p)) continue;
    switch (p.code) {
      case 10: e.center.x = num(p.value); break;
      case 20: e.center.y = num(p.value); break;
      case 30: e.center.z = num(p.value); break;
      case 40: e.width = num(p.value); break;
      case 41: e.height = num(p.value); break;
      case 12: e.viewCenter.x = num(p.value); break;
      case 22: e.viewCenter.y = num(p.value); break;
      case 45: e.viewHeight = num(p.value); break;
      case 16: e.viewDirection.x = num(p.value); break;
      case 26: e.viewDirection.y = num(p.value); break;
      case 36: e.viewDirection.z = num(p.value); break;
      case 17: e.viewTarget.x = num(p.value); break;
      case 27: e.viewTarget.y = num(p.value); break;
      case 37: e.viewTarget.z = num(p.value); break;
      case 51: e.twistAngle = num(p.value); break;
      case 68: e.status = num(p.value); break;
      case 69: e.viewportId = num(p.value); break;
      case 331: e.frozenLayerHandles.push(str(p.value)); break;
      case 90: e.statusFlags = num(p.value); break;
      case 340: e.clipBoundaryHandle = str(p.value); break;
    }
  }
  return e;
}

/**
 * bulge 가 있는 두 점 사이를 호로 세분화해 중간 점들을 돌려준다
 * (시작/끝 점은 포함하지 않는다).
 *
 * bulge = tan(포함각 / 4), 양수면 반시계 방향.
 */
export function bulgeToPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bulge: number,
  segmentsPerTurn = 64,
): Point3[] {
  const out: Point3[] = [];
  if (Math.abs(bulge) < 1e-10) return out;

  const theta = 4 * Math.atan(bulge); // 부호 있는 포함각
  const chord = Math.hypot(x2 - x1, y2 - y1);
  if (chord < 1e-12) return out;

  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  // 현 중점에서 원 중심까지의 거리 (반각이 90도를 넘으면 반대편).
  const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) * (chord / 2)));
  const ux = (x2 - x1) / chord;
  const uy = (y2 - y1) / chord;
  // |theta| > PI 이면 중심이 현의 반대편에 있다.
  const side = Math.sign(theta) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const cx = mx - uy * h * side;
  const cy = my + ux * h * side;

  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const steps = Math.max(2, Math.ceil((Math.abs(theta) / (Math.PI * 2)) * segmentsPerTurn));
  for (let i = 1; i < steps; i++) {
    const a = a1 + (theta * i) / steps;
    out.push(pt(cx + radius * Math.cos(a), cy + radius * Math.sin(a), 0));
  }
  return out;
}

// -------------------------------------------------------------- MULTILEADER

/**
 * MULTILEADER 를 읽는다.
 *
 * 그릴 것은 전부 CONTEXT_DATA{ … } 안에 들어 있고, 그 안은 다시
 * LEADER{ … LEADER_LINE{ … } } 로 중첩된다. 중첩 단계마다 같은 그룹 코드가
 * 다른 뜻으로 쓰이므로(10 = 리더선 정점 / 랜딩 끝점, 304 = 문자 내용 /
 * 리더선 시작 표시) 쌍을 순서대로 훑는 상태 기계로 읽는다.
 *
 * 컨텍스트 뒤에 오는 꼬리는 스타일 설정이라 블록 참조(344)와 속성 값
 * (330 + 302)만 본다.
 */
function parseMLeader(pairs: DxfPair[]): DxfMLeader {
  const e = {
    ...baseEntity('MULTILEADER'),
    leaders: [],
    arrowSize: 0,
    text: '',
    textPosition: pt(),
    textHeight: 0,
    textRotation: 0,
    textAttachment: 1,
    blockHandle: '',
    blockMatrix: [],
    blockPosition: pt(),
    blockScale: pt(1, 1, 1),
    blockRotation: 0,
    attributes: [],
  } as DxfMLeader;

  let mode: 'head' | 'ctx' | 'leader' | 'line' = 'head';
  /** 컨텍스트가 닫힌 뒤(스타일 꼬리)인가 */
  let tail = false;
  let cluster: DxfMLeaderCluster | null = null;
  let line: Point3[] | null = null;
  let vertex: Point3 | null = null;
  let landingSeen = false;
  let landingEnabled = true;
  let doglegEnabled = true;
  let textDir: Point3 | null = null;
  let textAngle: number | null = null;
  let attr: DxfMLeaderAttribute | null = null;

  const closeCluster = () => {
    if (cluster) {
      cluster.hasLanding = cluster.hasLanding && landingSeen && landingEnabled;
      if (!doglegEnabled) cluster.doglegLength = 0;
    }
    cluster = null;
    line = null;
    vertex = null;
  };

  for (const p of pairs) {
    // 구역 표시는 코드가 겹치므로 먼저 가로챈다.
    if (p.code === 300 && str(p.value).startsWith('CONTEXT_DATA')) {
      mode = 'ctx';
      continue;
    }
    if (p.code === 301 && !tail) {
      closeCluster();
      tail = true;
      mode = 'head';
      continue;
    }
    if (p.code === 302 && mode === 'ctx' && str(p.value).startsWith('LEADER')) {
      closeCluster();
      landingSeen = false;
      landingEnabled = true;
      doglegEnabled = true;
      cluster = {
        lines: [],
        landing: pt(),
        hasLanding: true,
        doglegDirection: pt(1, 0, 0),
        doglegLength: 0,
      };
      e.leaders.push(cluster);
      mode = 'leader';
      continue;
    }
    if (p.code === 303 && mode === 'leader') {
      closeCluster();
      mode = 'ctx';
      continue;
    }
    if (p.code === 304 && mode === 'leader' && str(p.value).startsWith('LEADER_LINE')) {
      line = [];
      cluster?.lines.push(line);
      vertex = null;
      mode = 'line';
      continue;
    }
    if (p.code === 305 && mode === 'line') {
      line = null;
      vertex = null;
      mode = 'leader';
      continue;
    }

    if (mode === 'line') {
      switch (p.code) {
        case 10:
          vertex = pt(num(p.value));
          line?.push(vertex);
          break;
        case 20: if (vertex) vertex.y = num(p.value); break;
        case 30: if (vertex) vertex.z = num(p.value); break;
      }
      continue;
    }

    if (mode === 'leader') {
      switch (p.code) {
        case 10:
          if (cluster) {
            cluster.landing.x = num(p.value);
            landingSeen = true;
          }
          break;
        case 20: if (cluster) cluster.landing.y = num(p.value); break;
        case 30: if (cluster) cluster.landing.z = num(p.value); break;
        case 11: if (cluster) cluster.doglegDirection.x = num(p.value); break;
        case 21: if (cluster) cluster.doglegDirection.y = num(p.value); break;
        case 31: if (cluster) cluster.doglegDirection.z = num(p.value); break;
        case 40: if (cluster) cluster.doglegLength = num(p.value); break;
        case 290: landingEnabled = num(p.value) === 1; break;
        case 291: doglegEnabled = num(p.value) === 1; break;
      }
      continue;
    }

    if (mode === 'ctx') {
      switch (p.code) {
        case 41: e.textHeight = num(p.value); break;
        case 140: e.arrowSize = num(p.value); break;
        case 304: e.text = str(p.value); break;
        case 12: e.textPosition.x = num(p.value); break;
        case 22: e.textPosition.y = num(p.value); break;
        case 32: e.textPosition.z = num(p.value); break;
        case 13: textDir = textDir ?? pt(); textDir.x = num(p.value); break;
        case 23: if (textDir) textDir.y = num(p.value); break;
        case 42: textAngle = num(p.value); break;
        case 171: e.textAttachment = num(p.value); break;
        case 341: if (!e.blockHandle) e.blockHandle = str(p.value); break;
        case 15: e.blockPosition.x = num(p.value); break;
        case 25: e.blockPosition.y = num(p.value); break;
        case 35: e.blockPosition.z = num(p.value); break;
        case 16: e.blockScale.x = num(p.value) || 1; break;
        case 26: e.blockScale.y = num(p.value) || 1; break;
        case 36: e.blockScale.z = num(p.value) || 1; break;
        case 46: e.blockRotation = num(p.value); break;
        case 47: e.blockMatrix.push(num(p.value)); break;
      }
      continue;
    }

    if (tail) {
      switch (p.code) {
        case 344:
          e.blockHandle = str(p.value);
          break;
        case 330:
          // 뒤따르는 302 와 짝을 이루면 블록 속성 값이다.
          attr = { handle: str(p.value), text: '' };
          break;
        case 302:
          if (attr) {
            attr.text = str(p.value);
            e.attributes.push(attr);
            attr = null;
          }
          break;
      }
      continue;
    }
    applyCommon(e, p);
  }
  closeCluster();

  // 문자 방향 벡터(13/23)가 있으면 각도(42)보다 우선한다.
  if (textDir && (textDir.x !== 0 || textDir.y !== 0)) {
    e.textRotation = (Math.atan2(textDir.y, textDir.x) * 180) / Math.PI;
  } else if (textAngle !== null) {
    e.textRotation = (textAngle * 180) / Math.PI;
  }
  if (!(e.textAttachment >= 1 && e.textAttachment <= 9)) e.textAttachment = 1;
  if (e.textHeight <= 0) e.textHeight = 1;
  return e;
}

// --------------------------------------------------------------- ACAD_TABLE

/**
 * ACAD_TABLE 을 읽는다.
 *
 * AutoCAD 는 격자선과 셀 문자를 익명 블록(*T25 등)에 미리 그려 두고 엔티티에는
 * 블록 참조(2)만 남긴다. 그래서 블록 이름과 삽입점이 가장 중요하고, 행/열 치수
 * (91/92, 141/142)와 셀 문자(1/2/302)는 블록이 없을 때의 대비책이다.
 *
 * 같은 코드가 구역마다 다른 뜻이므로(92 = 프록시 그래픽 길이 / 열 수,
 * 91 = 행 수 / 셀 재정의 플래그) 서브클래스 표시(100)와 첫 셀(171)로 구역을
 * 나눠 읽는다.
 */
function parseAcadTable(pairs: DxfPair[]): DxfAcadTable {
  const e = {
    ...baseEntity('ACAD_TABLE'),
    blockName: '',
    position: pt(),
    direction: pt(1, 0, 0),
    rowCount: 0,
    columnCount: 0,
    rowHeights: [],
    columnWidths: [],
    cells: [],
  } as DxfAcadTable;

  let section: 'entity' | 'table' | 'cells' = 'entity';
  let cell: DxfTableCell | null = null;

  for (const p of pairs) {
    if (p.code === 100) {
      if (str(p.value) === 'AcDbTable') section = 'table';
      continue;
    }
    if (p.code === 171 && section !== 'entity') {
      section = 'cells';
      cell = { text: '' };
      e.cells.push(cell);
      continue;
    }

    if (section === 'cells') {
      switch (p.code) {
        case 1:
        case 302:
          if (cell && str(p.value)) cell.text = str(p.value);
          break;
        case 2:
          // 250자가 넘는 셀 문자의 뒷부분.
          if (cell) cell.text += str(p.value);
          break;
      }
      continue;
    }

    if (section === 'table') {
      switch (p.code) {
        case 11: e.direction.x = num(p.value); break;
        case 21: e.direction.y = num(p.value); break;
        case 31: e.direction.z = num(p.value); break;
        case 91: e.rowCount = num(p.value); break;
        case 92: e.columnCount = num(p.value); break;
        case 141: e.rowHeights.push(num(p.value)); break;
        case 142: e.columnWidths.push(num(p.value)); break;
      }
      continue;
    }

    switch (p.code) {
      case 2: e.blockName = str(p.value); break;
      case 10: e.position.x = num(p.value); break;
      case 20: e.position.y = num(p.value); break;
      case 30: e.position.z = num(p.value); break;
      default: applyCommon(e, p); break;
    }
  }

  // 11/21/31 은 단위 벡터여야 한다. LibreDWG 로 변환한 DXF 에는 여기에
  // 쓰레기 값(1e142 등)이 들어 있어 표가 엉뚱하게 돌아가므로, 단위 벡터가
  // 아니면 믿지 않고 기본 방향으로 되돌린다.
  const dirLen = Math.hypot(e.direction.x, e.direction.y, e.direction.z);
  if (!Number.isFinite(dirLen) || Math.abs(dirLen - 1) > 0.25) {
    e.direction = pt(1, 0, 0);
  }
  return e;
}

// --------------------------------------------------------------------- HATCH

/** 경계 정의가 끝났음을 알리는 그룹 코드들 (해치 스타일·패턴·그라데이션·시드점). */
const HATCH_AFTER_BOUNDARY = new Set([
  41, 43, 44, 45, 46, 47, 49, 52, 53, 75, 76, 77, 78, 79, 98,
  450, 451, 452, 453, 460, 461, 462, 463, 470, 1000, 1001, 1070,
]);

/** 호 한 토막을 선분 점열로 풀어 loop 에 잇는다. 각도는 degree. */
function pushArcEdge(
  loop: Point3[],
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  endDeg: number,
  ccw: boolean,
  /** 타원 에지용 — 장축 방향과 단축 길이 */
  major?: { ux: number; uy: number; len: number; minor: number },
) {
  if (!major && radius <= 1e-12) return;
  const a0 = (startDeg * Math.PI) / 180;
  let a1 = (endDeg * Math.PI) / 180;
  // 50/51 은 반시계 기준 각도다. 73 = 0 이면 경계가 시계 방향으로 지난다.
  if (ccw) {
    while (a1 < a0 - 1e-9) a1 += Math.PI * 2;
  } else {
    while (a1 > a0 + 1e-9) a1 -= Math.PI * 2;
  }
  const span = a1 - a0;
  const steps = Math.max(2, Math.ceil((Math.abs(span) / (Math.PI * 2)) * 64));
  for (let i = 0; i <= steps; i++) {
    const t = a0 + (span * i) / steps;
    let x: number;
    let y: number;
    if (major) {
      const ca = major.len * Math.cos(t);
      const sa = major.minor * Math.sin(t);
      x = cx + ca * major.ux - sa * major.uy;
      y = cy + ca * major.uy + sa * major.ux;
    } else {
      x = cx + radius * Math.cos(t);
      y = cy + radius * Math.sin(t);
    }
    pushLoopPoint(loop, x, y);
  }
}

/** 직전 점과 같은 자리면 넣지 않는다 (에지 사이 이음새 중복 방지). */
function pushLoopPoint(loop: Point3[], x: number, y: number) {
  const last = loop[loop.length - 1];
  if (last && Math.abs(last.x - x) < 1e-12 && Math.abs(last.y - y) < 1e-12) return;
  loop.push(pt(x, y, 0));
}

/**
 * 에지 하나를 읽어 loop 에 잇는다. 커서는 72(에지 종류) 바로 뒤에 있어야 한다.
 *
 * 에지 종류마다 같은 코드가 다른 뜻이다 — 10 은 선분이면 시작점, 호·타원이면
 * **중심**, 스플라인이면 제어점이다. 종류를 보지 않고 10 을 전부 정점으로
 * 취급하면 호의 중심이 경계에 끼어들어 도형이 엉뚱한 곳까지 늘어난다.
 */
function readHatchEdge(pairs: DxfPair[], start: number, type: number, loop: Point3[]): number {
  const n = pairs.length;
  let i = start;
  /** 10/20 — 선분 시작점 · 호/타원 중심 · 스플라인 제어점 */
  const a: Point3[] = [];
  /** 11/21 — 선분 끝점 · 타원 장축 끝(중심 기준) · 스플라인 피팅점 */
  const b: Point3[] = [];
  let radius = 0;
  let startAngle = 0;
  let endAngle = 0;
  let ccw = true;

  while (i < n) {
    const p = pairs[i];
    if (p.code === 72 || p.code === 92 || p.code === 330) break;
    if (HATCH_AFTER_BOUNDARY.has(p.code)) break;
    // 스플라인 에지에서 97 은 피팅점 개수라 아직 끝이 아니다.
    if (p.code === 97 && type !== 4) break;
    switch (p.code) {
      case 10: {
        const x = num(p.value);
        let y = 0;
        if (i + 1 < n && pairs[i + 1].code === 20) {
          y = num(pairs[i + 1].value);
          i++;
        }
        a.push(pt(x, y, 0));
        break;
      }
      case 11: {
        const x = num(p.value);
        let y = 0;
        if (i + 1 < n && pairs[i + 1].code === 21) {
          y = num(pairs[i + 1].value);
          i++;
        }
        b.push(pt(x, y, 0));
        break;
      }
      // 스플라인에서 40 은 노트 값, 73 은 유리 여부라 쓰지 않는다.
      case 40: if (type !== 4) radius = num(p.value); break;
      case 50: startAngle = num(p.value); break;
      case 51: endAngle = num(p.value); break;
      case 73: if (type !== 4) ccw = num(p.value) === 1; break;
    }
    i++;
  }

  switch (type) {
    case 1: // 선분
      if (a.length) pushLoopPoint(loop, a[0].x, a[0].y);
      if (b.length) pushLoopPoint(loop, b[0].x, b[0].y);
      break;
    case 2: // 호
      if (a.length) pushArcEdge(loop, a[0].x, a[0].y, radius, startAngle, endAngle, ccw);
      break;
    case 3: { // 타원 호 — 11/21 은 중심 기준 장축 끝점, 40 은 축 비
      if (!a.length || !b.length) break;
      const len = Math.hypot(b[0].x, b[0].y);
      if (len < 1e-12) break;
      pushArcEdge(loop, a[0].x, a[0].y, 0, startAngle, endAngle, ccw, {
        ux: b[0].x / len,
        uy: b[0].y / len,
        len,
        minor: len * (radius || 1),
      });
      break;
    }
    case 4: {
      // 스플라인 — 피팅점이 있으면 그걸 잇고, 없으면 제어 다각형으로 근사한다.
      const src = b.length >= 2 ? b : a;
      for (const v of src) pushLoopPoint(loop, v.x, v.y);
      break;
    }
    default:
      // 알 수 없는 종류는 점만 이어 둔다 — 적어도 엉뚱한 곳으로 튀지는 않는다.
      for (const v of a) pushLoopPoint(loop, v.x, v.y);
      break;
  }
  return i;
}

/** 폴리라인 형태의 경계 경로(92 플래그 bit 1)를 읽는다. */
function readHatchPolylinePath(pairs: DxfPair[], start: number, loop: Point3[]): number {
  const n = pairs.length;
  let i = start;
  let closed = false;
  let count = 0;

  // 72 = bulge 유무, 73 = 닫힘 여부, 93 = 정점 수 (이 순서로 온다)
  while (i < n) {
    const c = pairs[i].code;
    if (c === 72) { i++; continue; }
    if (c === 73) { closed = num(pairs[i].value) === 1; i++; continue; }
    if (c === 93) { count = num(pairs[i].value); i++; break; }
    break;
  }

  let bulge = 0;
  let read = 0;
  while (i < n && read < count) {
    const p = pairs[i];
    if (p.code === 10) {
      const x = num(p.value);
      let y = 0;
      if (i + 1 < n && pairs[i + 1].code === 20) {
        y = num(pairs[i + 1].value);
        i++;
      }
      const prev = loop[loop.length - 1];
      if (prev && bulge !== 0) {
        for (const q of bulgeToPoints(prev.x, prev.y, x, y, bulge)) pushLoopPoint(loop, q.x, q.y);
      }
      bulge = 0;
      pushLoopPoint(loop, x, y);
      read++;
      i++;
      continue;
    }
    if (p.code === 42) {
      bulge = num(p.value);
      i++;
      continue;
    }
    break;
  }
  // 마지막 정점의 bulge 는 닫는 구간에 붙는다.
  if (i < n && pairs[i].code === 42) {
    bulge = num(pairs[i].value);
    i++;
  }
  if (closed && bulge !== 0 && loop.length > 1) {
    const last = loop[loop.length - 1];
    const first = loop[0];
    for (const q of bulgeToPoints(last.x, last.y, first.x, first.y, bulge)) pushLoopPoint(loop, q.x, q.y);
  }
  return i;
}

/**
 * 경계 정의 구역(91 뒤)을 통째로 읽는다. 커서는 91 바로 뒤에 있어야 하고,
 * 경계가 끝난 지점(해치 스타일 등이 시작되는 자리)의 인덱스를 돌려준다.
 */
function readHatchBoundary(
  pairs: DxfPair[],
  start: number,
  pathCount: number,
  loops: Point3[][],
): number {
  const n = pairs.length;
  let i = start;
  let paths = 0;

  while (i < n && paths < pathCount) {
    // 다음 경로 머리(92)를 찾는다.
    while (i < n && pairs[i].code !== 92) {
      if (HATCH_AFTER_BOUNDARY.has(pairs[i].code)) return i;
      i++;
    }
    if (i >= n) break;
    const flags = num(pairs[i].value);
    i++;
    paths++;

    const loop: Point3[] = [];
    if ((flags & 2) !== 0) {
      i = readHatchPolylinePath(pairs, i, loop);
    } else {
      // 93 = 에지 수, 그 뒤로 에지마다 72(종류) + 종류별 코드.
      let edges = 0;
      if (i < n && pairs[i].code === 93) {
        edges = num(pairs[i].value);
        i++;
      }
      let read = 0;
      while (i < n && read < edges) {
        if (pairs[i].code !== 72) break;
        const type = num(pairs[i].value);
        i++;
        i = readHatchEdge(pairs, i, type, loop);
        read++;
      }
    }
    if (loop.length > 1) loops.push(loop);
  }

  // 남은 경계 부속(97 + 330 참조 목록 등)을 흘려보낸다.
  while (i < n && !HATCH_AFTER_BOUNDARY.has(pairs[i].code)) i++;
  return i;
}

/**
 * HATCH 를 읽는다.
 *
 * 경계 정의(91 이후)는 "경로 수 → 경로마다 종류(92)와 내용" 으로 중첩돼 있고,
 * 같은 그룹 코드가 경로·에지 종류마다 다른 뜻을 갖는다. 그래서 경계는 전용
 * 리더(readHatchBoundary)로 순서대로 읽고, 여기서는 패턴 정보만 본다.
 */
function parseHatch(pairs: DxfPair[]): DxfHatch {
  const e = {
    ...baseEntity('HATCH'),
    patternName: 'SOLID',
    solid: true,
    elevation: 0,
    boundary: { loops: [] },
    patternAngle: 0,
    patternScale: 1,
    patternLines: [],
  } as DxfHatch;

  const n = pairs.length;
  let i = 0;
  /** 경계 정의가 끝난 뒤 나오는 패턴 정의선. */
  let patLine: DxfHatchPatternLine | null = null;

  while (i < n) {
    const p = pairs[i];
    if (p.code === 91) {
      i = readHatchBoundary(pairs, i + 1, num(p.value), e.boundary.loops);
      continue;
    }
    switch (p.code) {
      case 2: e.patternName = str(p.value); break;
      case 70: e.solid = num(p.value) === 1; break;
      case 52: e.patternAngle = num(p.value); break;
      case 41: e.patternScale = num(p.value) || 1; break;
      case 30: e.elevation = num(p.value); break;

      // ---- 패턴 정의선 ----
      case 53:
        patLine = { angle: num(p.value), baseX: 0, baseY: 0, offsetX: 0, offsetY: 0, dashes: [] };
        e.patternLines.push(patLine);
        break;
      case 43: if (patLine) patLine.baseX = num(p.value); break;
      case 44: if (patLine) patLine.baseY = num(p.value); break;
      case 45: if (patLine) patLine.offsetX = num(p.value); break;
      case 46: if (patLine) patLine.offsetY = num(p.value); break;
      case 49: if (patLine) patLine.dashes.push(num(p.value)); break;

      default:
        applyCommon(e, p);
        break;
    }
    i++;
  }
  return e;
}

// -------------------------------------------------------------- 엔티티 스트림

function buildEntity(type: string, pairs: DxfPair[]): DxfEntity | null {
  switch (type) {
    case 'LINE': return parseLine(pairs);
    case 'LWPOLYLINE': return parseLwPolyline(pairs);
    case 'CIRCLE': return parseCircle(pairs);
    case 'ARC': return parseArc(pairs);
    case 'ELLIPSE': return parseEllipse(pairs);
    case 'SPLINE': return parseSpline(pairs);
    case 'POINT': return parsePoint(pairs);
    case 'TEXT':
    case 'ATTRIB': return parseText(pairs);
    case 'MTEXT': return parseMText(pairs);
    case 'SOLID':
    case 'TRACE': return parseSolid(pairs, 'SOLID');
    case '3DFACE': return parseSolid(pairs, '3DFACE');
    case 'HATCH': return parseHatch(pairs);
    case 'DIMENSION': return parseDimension(pairs);
    case 'LEADER': return parseLeader(pairs);
    case 'MULTILEADER':
    case 'MLEADER': return parseMLeader(pairs);
    case 'ACAD_TABLE': return parseAcadTable(pairs);
    case 'VIEWPORT': return parseViewport(pairs);
    case 'RAY': return parseRay(pairs, 'RAY');
    case 'XLINE': return parseRay(pairs, 'XLINE');
    default: return null;
  }
}

/** VERTEX 엔티티 하나를 폴리라인 정점으로 변환. */
function parseVertex(pairs: DxfPair[]): { vertex: DxfPolylineVertex; isMeshVertex: boolean } {
  const v: DxfPolylineVertex = { x: 0, y: 0, z: 0, bulge: 0, startWidth: 0, endWidth: 0 };
  let flags = 0;
  for (const p of pairs) {
    switch (p.code) {
      case 10: v.x = num(p.value); break;
      case 20: v.y = num(p.value); break;
      case 30: v.z = num(p.value); break;
      case 42: v.bulge = num(p.value); break;
      case 40: v.startWidth = num(p.value); break;
      case 41: v.endWidth = num(p.value); break;
      case 70: flags = num(p.value); break;
    }
  }
  // bit 16 = 폴리곤 메시 꼭짓점, bit 128 만 선 외 면 정의 정점 → 경로에서 제외.
  const isMeshVertex = (flags & 16) !== 0 || ((flags & 128) !== 0 && (flags & 64) === 0);
  return { vertex: v, isMeshVertex };
}

/**
 * ENTITIES 섹션이나 BLOCK 안의 엔티티 스트림을 읽는다.
 * 커서는 code 0 쌍 바로 앞에 있어야 하고, stopAt 에 해당하는 code 0 을 만나면
 * 그것을 소비하지 않고 멈춘다.
 */
function parseEntityStream(
  c: Cursor,
  stopAt: ReadonlySet<string>,
  skipped: Record<string, number>,
  attdefs?: DxfText[],
): DxfEntity[] {
  const out: DxfEntity[] = [];

  while (!c.done) {
    const head = c.peek()!;
    if (head.code !== 0) {
      c.i++;
      continue;
    }
    const type = str(head.value);
    if (stopAt.has(type)) break;

    c.i++; // code 0 소비
    const pairs = collectUntilNextEntity(c);

    if (type === 'POLYLINE') {
      const poly = {
        ...baseEntity('POLYLINE'),
        vertices: [],
        closed: false,
        is3d: false,
        isMesh: false,
      } as DxfPolyline;
      for (const p of pairs) {
        if (applyCommon(poly, p)) continue;
        if (p.code === 70) {
          const f = num(p.value);
          poly.closed = (f & 1) === 1;
          poly.is3d = (f & 8) !== 0;
          poly.isMesh = (f & 16) !== 0 || (f & 64) !== 0;
        }
      }
      // 뒤따르는 VERTEX 들을 SEQEND 까지 흡수한다.
      while (!c.done) {
        const h = c.peek()!;
        if (h.code !== 0) { c.i++; continue; }
        const t = str(h.value);
        if (t === 'VERTEX') {
          c.i++;
          const { vertex, isMeshVertex } = parseVertex(collectUntilNextEntity(c));
          if (!isMeshVertex) poly.vertices.push(vertex);
          continue;
        }
        if (t === 'SEQEND') {
          c.i++;
          collectUntilNextEntity(c);
        }
        break;
      }
      out.push(poly);
      continue;
    }

    if (type === 'INSERT') {
      const ins = parseInsert(pairs);
      // 속성(ATTRIB)이 뒤따를 수 있다.
      while (!c.done) {
        const h = c.peek()!;
        if (h.code !== 0) { c.i++; continue; }
        const t = str(h.value);
        if (t === 'ATTRIB') {
          c.i++;
          ins.attributes.push(parseText(collectUntilNextEntity(c)));
          continue;
        }
        if (t === 'SEQEND') {
          c.i++;
          collectUntilNextEntity(c);
        }
        break;
      }
      out.push(ins);
      continue;
    }

    // 속성 정의는 삽입할 때 그려지지 않지만, MULTILEADER 블록 콘텐츠가
    // 값을 채워 넣을 때 위치를 가져다 쓰므로 블록별로 모아 둔다.
    if (type === 'ATTDEF') {
      if (attdefs) attdefs.push(parseText(pairs));
      continue;
    }
    // 짝 없이 남은 제어 엔티티는 조용히 넘긴다.
    if (type === 'SEQEND' || type === 'VERTEX' || type === 'ENDBLK') continue;

    const built = buildEntity(type, pairs);
    if (built) out.push(built);
    else skipped[type] = (skipped[type] ?? 0) + 1;
  }
  return out;
}

// ------------------------------------------------------------------ 섹션 파서

function parseTables(c: Cursor, doc: DxfDocument) {
  while (!c.done) {
    const head = c.peek()!;
    if (head.code === 0 && str(head.value) === 'ENDSEC') break;
    if (head.code !== 0) { c.i++; continue; }

    const type = str(head.value);
    c.i++;
    const pairs = collectUntilNextEntity(c);

    if (type === 'LAYER') {
      let layerHandle = '';
      const layer: DxfLayer = {
        name: '',
        colorIndex: 7,
        lineType: 'CONTINUOUS',
        lineWeight: -3,
        frozen: false,
        off: false,
        plottable: true,
      };
      for (const p of pairs) {
        switch (p.code) {
          case 5: layerHandle = str(p.value); break;
          case 2: layer.name = str(p.value); break;
          case 62: {
            const v = num(p.value);
            layer.colorIndex = Math.abs(v);
            layer.off = v < 0;
            break;
          }
          case 420: layer.trueColor = num(p.value) & 0xffffff; break;
          case 6: layer.lineType = str(p.value); break;
          case 370: layer.lineWeight = num(p.value); break;
          case 70: layer.frozen = (num(p.value) & 1) !== 0; break;
          case 290: layer.plottable = Boolean(p.value); break;
        }
      }
      if (layer.name) {
        doc.layers.set(layer.name, layer);
        if (layerHandle) doc.layerNamesByHandle.set(layerHandle, layer.name);
      }
      continue;
    }

    if (type === 'LTYPE') {
      const lt: DxfLineType = { name: '', description: '', pattern: [], patternLength: 0 };
      for (const p of pairs) {
        switch (p.code) {
          case 2: lt.name = str(p.value); break;
          case 3: lt.description = str(p.value); break;
          case 40: lt.patternLength = num(p.value); break;
          case 49: lt.pattern.push(num(p.value)); break;
        }
      }
      if (lt.name) doc.lineTypes.set(lt.name.toUpperCase(), lt);
      continue;
    }

    if (type === 'BLOCK_RECORD') {
      // MULTILEADER 의 블록 참조(341/344)는 BLOCK_RECORD 핸들을 가리킨다.
      let handle = '';
      let name = '';
      for (const p of pairs) {
        if (p.code === 5) handle = str(p.value);
        else if (p.code === 2) name = str(p.value);
      }
      if (handle && name) doc.blockNamesByHandle.set(handle, name);
      continue;
    }

    if (type === 'STYLE') {
      const st: DxfTextStyle = {
        name: '',
        fontFile: '',
        bigFontFile: '',
        fixedHeight: 0,
        widthFactor: 1,
        obliqueAngle: 0,
      };
      for (const p of pairs) {
        switch (p.code) {
          case 2: st.name = str(p.value); break;
          case 3: st.fontFile = str(p.value); break;
          case 4: st.bigFontFile = str(p.value); break;
          case 40: st.fixedHeight = num(p.value); break;
          case 41: st.widthFactor = num(p.value) || 1; break;
          case 50: st.obliqueAngle = num(p.value); break;
        }
      }
      if (st.name) doc.textStyles.set(st.name.toUpperCase(), st);
      continue;
    }
  }
}

function parseBlocks(c: Cursor, doc: DxfDocument) {
  while (!c.done) {
    const head = c.peek()!;
    if (head.code === 0 && str(head.value) === 'ENDSEC') break;
    if (head.code !== 0) { c.i++; continue; }
    if (str(head.value) !== 'BLOCK') { c.i++; collectUntilNextEntity(c); continue; }

    c.i++;
    const pairs = collectUntilNextEntity(c);
    const block: DxfBlock = {
      name: '',
      basePoint: pt(),
      entities: [],
      attdefs: [],
      isXref: false,
    };
    /** BLOCK 의 소유자(330)가 곧 이 블록의 BLOCK_RECORD 핸들이다. */
    let recordHandle = '';
    for (const p of pairs) {
      switch (p.code) {
        case 2:
        case 3:
          if (!block.name) block.name = str(p.value);
          break;
        case 330: recordHandle = str(p.value); break;
        case 10: block.basePoint.x = num(p.value); break;
        case 20: block.basePoint.y = num(p.value); break;
        case 30: block.basePoint.z = num(p.value); break;
        case 70: block.isXref = (num(p.value) & 4) !== 0; break;
      }
    }
    block.entities = parseEntityStream(c, new Set(['ENDBLK', 'ENDSEC']), doc.skipped, block.attdefs);
    // ENDBLK 소비
    if (!c.done && c.peek()!.code === 0 && str(c.peek()!.value) === 'ENDBLK') {
      c.i++;
      collectUntilNextEntity(c);
    }
    if (block.name) {
      doc.blocks.set(block.name, block);
      if (recordHandle) doc.blockNamesByHandle.set(recordHandle, block.name);
    }
  }
}

/**
 * OBJECTS 섹션에서 LAYOUT 객체만 추려 공간 목록을 만든다.
 *
 * LAYOUT 은 AcDbPlotSettings 와 AcDbLayout 두 서브클래스를 이어 붙여 쓰는데,
 * 둘 다 코드 1(이름)과 330(소유자)을 갖는다. 그래서 서브클래스 마커(100)를
 * 보고 AcDbLayout 구간의 값만 받는다.
 */
function parseObjects(c: Cursor, doc: DxfDocument) {
  while (!c.done) {
    const head = c.peek()!;
    if (head.code === 0 && str(head.value) === 'ENDSEC') break;
    if (head.code !== 0) { c.i++; continue; }

    const type = str(head.value);
    c.i++;
    const pairs = collectUntilNextEntity(c);
    if (type !== 'LAYOUT') continue;

    const layout: DxfLayout = {
      name: '',
      tabOrder: 0,
      blockRecordHandle: '',
      blockName: '',
      isModelSpace: false,
      limMin: pt(),
      limMax: pt(),
    };
    let inLayout = false;
    for (const p of pairs) {
      if (p.code === 100) {
        inLayout = str(p.value) === 'AcDbLayout';
        continue;
      }
      if (!inLayout) continue;
      switch (p.code) {
        case 1: layout.name = str(p.value); break;
        case 71: layout.tabOrder = num(p.value); break;
        case 330: layout.blockRecordHandle = str(p.value); break;
        case 10: layout.limMin.x = num(p.value); break;
        case 20: layout.limMin.y = num(p.value); break;
        case 11: layout.limMax.x = num(p.value); break;
        case 21: layout.limMax.y = num(p.value); break;
      }
    }
    if (layout.name) doc.layouts.push(layout);
  }
}

/** 배치 목록의 블록 이름을 채우고, 모형 공간이 맨 앞에 오도록 정렬한다. */
function resolveLayouts(doc: DxfDocument) {
  for (const l of doc.layouts) {
    l.blockName = doc.blockNamesByHandle.get(l.blockRecordHandle) ?? '';
    l.isModelSpace = l.blockName
      ? l.blockName.toUpperCase() === '*MODEL_SPACE'
      : l.tabOrder === 0 && l.name.toUpperCase() === 'MODEL';
  }
  // 이름이 같은 배치는 하나만 남긴다(변환기가 중복으로 내보내는 경우가 있다).
  const seen = new Set<string>();
  doc.layouts = doc.layouts.filter((l) => {
    const key = l.name.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  doc.layouts.sort((a, b) => {
    if (a.isModelSpace !== b.isModelSpace) return a.isModelSpace ? -1 : 1;
    return a.tabOrder - b.tabOrder || a.name.localeCompare(b.name);
  });

  if (!doc.layouts.some((l) => l.isModelSpace)) {
    doc.layouts.unshift({
      name: 'Model',
      tabOrder: 0,
      blockRecordHandle: '',
      blockName: '*Model_Space',
      isModelSpace: true,
      limMin: pt(),
      limMax: pt(),
    });
  }
  // LAYOUT 객체가 없는 옛 DXF(R12 등)라도 67=1 엔티티가 있으면 배치가 하나 있는 셈이다.
  if (doc.layouts.length === 1 && doc.entities.some((e) => e.paperSpace)) {
    doc.layouts.push({
      name: 'Layout1',
      tabOrder: 1,
      blockRecordHandle: '',
      blockName: '',
      isModelSpace: false,
      limMin: pt(),
      limMax: pt(),
    });
  }
}

function parseHeader(c: Cursor, doc: DxfDocument) {
  let varName = '';
  while (!c.done) {
    const p = c.peek()!;
    if (p.code === 0 && str(p.value) === 'ENDSEC') break;
    c.i++;
    if (p.code === 9) {
      varName = str(p.value);
      doc.header[varName] = [];
    } else if (varName) {
      doc.header[varName].push(p);
    }
  }
}

// ---------------------------------------------------------------------- 진입점

export function emptyDocument(source: DxfDocument['source']): DxfDocument {
  return {
    header: {},
    layers: new Map(),
    lineTypes: new Map(),
    textStyles: new Map(),
    blocks: new Map(),
    blockNamesByHandle: new Map(),
    layerNamesByHandle: new Map(),
    layouts: [],
    entities: [],
    skipped: {},
    source,
    version: '',
  };
}

/** 이미 렉싱된 그룹 코드 쌍을 문서로 조립한다. */
export function assembleDocument(pairs: DxfPair[], doc: DxfDocument): DxfDocument {
  const c = new Cursor(pairs);

  while (!c.done) {
    const p = c.next()!;
    if (p.code !== 0 || str(p.value) !== 'SECTION') continue;
    const namePair = c.peek();
    if (!namePair || namePair.code !== 2) continue;
    const section = str(namePair.value);
    c.i++;

    switch (section) {
      case 'HEADER':
        parseHeader(c, doc);
        break;
      case 'TABLES':
        parseTables(c, doc);
        break;
      case 'BLOCKS':
        parseBlocks(c, doc);
        break;
      case 'ENTITIES':
        doc.entities = parseEntityStream(c, new Set(['ENDSEC']), doc.skipped);
        break;
      case 'OBJECTS':
        parseObjects(c, doc);
        break;
      default:
        // CLASSES, THUMBNAILIMAGE 등은 그리기에 쓰이지 않는다.
        while (!c.done) {
          const q = c.peek()!;
          if (q.code === 0 && str(q.value) === 'ENDSEC') break;
          c.i++;
        }
        break;
    }
  }

  const acad = doc.header.$ACADVER?.[0];
  doc.version = acad ? str(acad.value) : '';

  resolveLayouts(doc);

  // 레이어 0 은 항상 존재해야 한다.
  if (!doc.layers.has('0')) {
    doc.layers.set('0', {
      name: '0',
      colorIndex: 7,
      lineType: 'CONTINUOUS',
      lineWeight: -3,
      frozen: false,
      off: false,
      plottable: true,
    });
  }
  return doc;
}

export function parseDxf(buffer: ArrayBuffer): DxfDocument {
  const { pairs, flavor } = lexDxf(buffer);
  return assembleDocument(pairs, emptyDocument(flavor));
}
