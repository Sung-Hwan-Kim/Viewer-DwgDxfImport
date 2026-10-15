/**
 * DXF 데이터 모델.
 *
 * 파서는 DXF 파일을 아래 구조로 정규화한다. 뷰어(three.js 빌더)는 이 구조만
 * 바라보므로, DWG 경로(LibreDWG)도 같은 구조로 변환해 넣으면 그대로 그려진다.
 */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface DxfPair {
  code: number;
  value: string | number | boolean;
}

export interface DxfLayer {
  name: string;
  /** AutoCAD Color Index. 음수면 레이어 꺼짐(off). */
  colorIndex: number;
  /** 24bit true color (group 420). 없으면 undefined. */
  trueColor?: number;
  lineType: string;
  lineWeight: number;
  /** 70번 코드 bit 1 = frozen */
  frozen: boolean;
  off: boolean;
  plottable: boolean;
}

export interface DxfLineType {
  name: string;
  description: string;
  /** 양수=선, 음수=공백, 0=점 */
  pattern: number[];
  patternLength: number;
}

export interface DxfTextStyle {
  name: string;
  fontFile: string;
  bigFontFile: string;
  fixedHeight: number;
  widthFactor: number;
  obliqueAngle: number;
}

export interface DxfBlock {
  name: string;
  basePoint: Point3;
  entities: DxfEntity[];
  /**
   * 블록 안의 속성 정의(ATTDEF). 일반 INSERT 에서는 그리지 않지만
   * MULTILEADER 블록 콘텐츠가 값을 채워 넣을 때 위치/높이를 여기서 가져온다.
   */
  attdefs: DxfText[];
  /** 외부 참조(XREF) 블록이면 true — 내용이 비어 있을 수 있다. */
  isXref: boolean;
}

/** 모든 엔티티가 공유하는 필드. */
export interface DxfEntityBase {
  type: string;
  handle: string;
  ownerHandle: string;
  layer: string;
  lineType: string;
  /** 256 = BYLAYER, 0 = BYBLOCK */
  colorIndex: number;
  trueColor?: number;
  lineWeight: number;
  /** 지정되지 않으면 1 */
  lineTypeScale: number;
  /** 1 = 보이지 않음 */
  invisible: boolean;
  /** 210/220/230 — OCS 법선. 기본 (0,0,1) */
  extrusion: Point3;
  /** 페이퍼 공간 엔티티 여부 (67 = 1) */
  paperSpace: boolean;
}

export interface DxfLine extends DxfEntityBase {
  type: 'LINE';
  start: Point3;
  end: Point3;
}

export interface DxfPolylineVertex extends Point3 {
  /** 다음 정점까지의 호 bulge 값 */
  bulge: number;
  startWidth: number;
  endWidth: number;
}

export interface DxfLwPolyline extends DxfEntityBase {
  type: 'LWPOLYLINE';
  vertices: DxfPolylineVertex[];
  closed: boolean;
  constantWidth: number;
  elevation: number;
}

export interface DxfPolyline extends DxfEntityBase {
  type: 'POLYLINE';
  vertices: DxfPolylineVertex[];
  closed: boolean;
  /** 70번 bit 8 = 3D 폴리라인, bit 16 = 폴리곤 메시 */
  is3d: boolean;
  isMesh: boolean;
}

export interface DxfCircle extends DxfEntityBase {
  type: 'CIRCLE';
  center: Point3;
  radius: number;
}

export interface DxfArc extends DxfEntityBase {
  type: 'ARC';
  center: Point3;
  radius: number;
  /** degree */
  startAngle: number;
  endAngle: number;
}

export interface DxfEllipse extends DxfEntityBase {
  type: 'ELLIPSE';
  center: Point3;
  /** 중심 기준 장축 끝점 벡터 */
  majorAxis: Point3;
  /** 단축/장축 비율 */
  axisRatio: number;
  /** radian */
  startParam: number;
  endParam: number;
}

export interface DxfSpline extends DxfEntityBase {
  type: 'SPLINE';
  degree: number;
  closed: boolean;
  knots: number[];
  weights: number[];
  controlPoints: Point3[];
  fitPoints: Point3[];
}

export interface DxfPoint extends DxfEntityBase {
  type: 'POINT';
  position: Point3;
}

export interface DxfText extends DxfEntityBase {
  type: 'TEXT';
  position: Point3;
  alignmentPoint: Point3;
  hasAlignmentPoint: boolean;
  text: string;
  height: number;
  /** degree */
  rotation: number;
  widthFactor: number;
  obliqueAngle: number;
  styleName: string;
  /** 72: 0=left 1=center 2=right 3=aligned 4=middle 5=fit */
  halign: number;
  /** 73: 0=baseline 1=bottom 2=middle 3=top */
  valign: number;
  /** 71: 2=X 미러, 4=Y 미러 */
  mirrorFlags: number;
}

export interface DxfMText extends DxfEntityBase {
  type: 'MTEXT';
  position: Point3;
  text: string;
  height: number;
  /** 참조 사각형 너비. 0이면 줄바꿈 없음 */
  width: number;
  /** 1=TL 2=TC 3=TR 4=ML 5=MC 6=MR 7=BL 8=BC 9=BR */
  attachmentPoint: number;
  /** degree */
  rotation: number;
  /** 줄 간격 배수 */
  lineSpacing: number;
  styleName: string;
}

export interface DxfInsert extends DxfEntityBase {
  type: 'INSERT';
  blockName: string;
  position: Point3;
  scale: Point3;
  /** degree */
  rotation: number;
  columnCount: number;
  rowCount: number;
  columnSpacing: number;
  rowSpacing: number;
  attributes: DxfText[];
}

export interface DxfSolid extends DxfEntityBase {
  type: 'SOLID' | '3DFACE';
  corners: Point3[];
}

export interface DxfHatchBoundaryPath {
  /** 경계를 선분으로 평탄화한 폴리라인들 */
  loops: Point3[][];
}

/**
 * 해치 패턴을 이루는 평행선 한 줄의 정의.
 * DXF 에는 각도·축척이 이미 반영된 최종값이 저장된다.
 */
export interface DxfHatchPatternLine {
  /** degree */
  angle: number;
  baseX: number;
  baseY: number;
  /** 선 방향 기준 x=선을 따라, y=선에 수직인 간격 */
  offsetX: number;
  offsetY: number;
  /** 양수=선, 음수=공백 */
  dashes: number[];
}

export interface DxfHatch extends DxfEntityBase {
  type: 'HATCH';
  patternName: string;
  solid: boolean;
  elevation: number;
  boundary: DxfHatchBoundaryPath;
  patternAngle: number;
  patternScale: number;
  patternLines: DxfHatchPatternLine[];
}

export interface DxfDimension extends DxfEntityBase {
  type: 'DIMENSION';
  /** 치수가 그려진 익명 블록 이름(*D1 등) */
  blockName: string;
  textPosition: Point3;
  definitionPoint: Point3;
  text: string;
  measurement: number;
}

export interface DxfLeader extends DxfEntityBase {
  type: 'LEADER';
  vertices: Point3[];
}

/**
 * MULTILEADER 의 리더선 한 다발 (CONTEXT_DATA 안의 `LEADER{}` 하나).
 *
 * 한 다발에 속한 리더선들은 모두 같은 끝점(landing)에서 만나고, 거기서
 * 랜딩(수평 꼬리)이 doglegDirection 방향으로 doglegLength 만큼 뻗어 콘텐츠에 닿는다.
 */
export interface DxfMLeaderCluster {
  /** `LEADER_LINE{}` 마다 하나 — 화살촉 쪽이 첫 점이다. */
  lines: Point3[][];
  /** 리더선들이 만나는 공통 끝점 (랜딩 시작점) */
  landing: Point3;
  hasLanding: boolean;
  /** 랜딩 방향 단위 벡터 */
  doglegDirection: Point3;
  /** 랜딩 길이. 0 이면 꼬리를 그리지 않는다. */
  doglegLength: number;
}

/** 블록 콘텐츠 멀티리더가 블록 안 ATTDEF 에 채워 넣는 값. */
export interface DxfMLeaderAttribute {
  /** 대상 ATTDEF 의 핸들 */
  handle: string;
  text: string;
}

export interface DxfMLeader extends DxfEntityBase {
  type: 'MULTILEADER';
  leaders: DxfMLeaderCluster[];
  /** 화살촉 크기(140). 0 이면 화살촉을 그리지 않는다. */
  arrowSize: number;
  /** 문자 콘텐츠(304). 비어 있으면 문자 없음. MTEXT 서식 코드가 섞여 있다. */
  text: string;
  textPosition: Point3;
  textHeight: number;
  /** degree */
  textRotation: number;
  /** MTEXT 와 같은 1~9 부착점 */
  textAttachment: number;
  /** 블록 콘텐츠의 BLOCK_RECORD 핸들(341/344). 비어 있으면 블록 없음. */
  blockHandle: string;
  /** 47 × 16 — 행 우선 4×4 변환. 길이가 16 이면 이것을 그대로 쓴다. */
  blockMatrix: number[];
  blockPosition: Point3;
  blockScale: Point3;
  /** radian */
  blockRotation: number;
  attributes: DxfMLeaderAttribute[];
}

/** ACAD_TABLE 셀 하나 — 병합은 다루지 않고 문자만 본다. */
export interface DxfTableCell {
  text: string;
}

export interface DxfAcadTable extends DxfEntityBase {
  type: 'ACAD_TABLE';
  /**
   * 표 기하가 통째로 들어 있는 익명 블록(`*T25` 등) 이름.
   * AutoCAD 는 격자선과 셀 문자를 이 블록에 미리 그려 두므로, 있으면
   * INSERT 처럼 전개하는 쪽이 정확하다. 없을 때만 행/열 정보로 재구성한다.
   */
  blockName: string;
  position: Point3;
  /** 11/21/31 — 행 방향 벡터. 기본 (1,0,0) */
  direction: Point3;
  rowCount: number;
  columnCount: number;
  /** 141 × 행 수 */
  rowHeights: number[];
  /** 142 × 열 수 */
  columnWidths: number[];
  /** 행 우선 셀 목록 */
  cells: DxfTableCell[];
}

/**
 * 배치(페이퍼 공간)에 뚫린 뷰포트 — 모형 공간의 일부를 들여다보는 창.
 *
 * 중심/크기는 배치 좌표계, viewCenter/viewHeight 는 모형 좌표계의 보이는 영역이다.
 * 두 쌍이 곧 "모형 → 배치" 변환과 잘라낼 사각형을 정의한다.
 */
export interface DxfViewport extends DxfEntityBase {
  type: 'VIEWPORT';
  /** 배치 좌표계에서 뷰포트 창의 중심 */
  center: Point3;
  /** 배치 좌표계에서의 창 너비(40)·높이(41) */
  width: number;
  height: number;
  /** 창에 보이는 모형 영역의 중심(12/22, DCS) */
  viewCenter: Point3;
  /** 창에 보이는 모형 영역의 높이(45, 도면 단위) */
  viewHeight: number;
  /** 시선 방향(16/26/36). (0,0,1) 이 평면도 */
  viewDirection: Point3;
  /** 뷰 타깃점(17/27/37) — DCS 원점 */
  viewTarget: Point3;
  /** 뷰 비틀기 각도(51), degree */
  twistAngle: number;
  /** 68 — 0 이면 꺼진 뷰포트 */
  status: number;
  /** 69 — 1 은 배치 전체를 가리키는 가짜 뷰포트다. */
  viewportId: number;
  /** 331 × n — 이 뷰포트에서만 동결된 LAYER 레코드 핸들. */
  frozenLayerHandles: string[];
  /**
   * 90 — 비트 플래그. 0x10000 = 사각형이 아닌 클리핑 사용,
   * 0x20000 = 뷰포트 꺼짐.
   */
  statusFlags: number;
  /** 340 — 사각형이 아닌 클리핑 경계 엔티티의 핸들. */
  clipBoundaryHandle: string;
}

export interface DxfRay extends DxfEntityBase {
  type: 'RAY' | 'XLINE';
  basePoint: Point3;
  direction: Point3;
}

export type DxfEntity =
  | DxfLine
  | DxfLwPolyline
  | DxfPolyline
  | DxfCircle
  | DxfArc
  | DxfEllipse
  | DxfSpline
  | DxfPoint
  | DxfText
  | DxfMText
  | DxfInsert
  | DxfSolid
  | DxfHatch
  | DxfDimension
  | DxfLeader
  | DxfMLeader
  | DxfAcadTable
  | DxfViewport
  | DxfRay;

/**
 * 배치(레이아웃) 하나. OBJECTS 섹션의 LAYOUT 객체에서 읽는다.
 *
 * 모형 공간도 레이아웃으로 저장되므로(보통 이름이 "Model"), 공간 목록은
 * 이 배열 하나로 표현된다.
 */
export interface DxfLayout {
  /** 탭 이름 (코드 1) */
  name: string;
  /** 탭 순서 (코드 71). 모형 공간은 0 */
  tabOrder: number;
  /** 이 배치의 엔티티를 소유하는 BLOCK_RECORD 핸들 (AcDbLayout 의 330) */
  blockRecordHandle: string;
  /** 위 핸들이 가리키는 블록 이름 (*Model_Space / *Paper_Space …) */
  blockName: string;
  isModelSpace: boolean;
  /**
   * 용지 한 장의 범위 (10/20 = LIMMIN, 11/21 = LIMMAX), 배치 좌표계.
   * LIMMIN 은 (−왼쪽 여백, −아래 여백) 이고 LIMMAX − LIMMIN 이 곧 용지 크기다.
   * 둘 다 0 이면 정보가 없는 것으로 본다.
   */
  limMin: Point3;
  limMax: Point3;
}

export interface DxfDocument {
  /** $INSUNITS, $EXTMIN 등 헤더 변수 */
  header: Record<string, DxfPair[]>;
  layers: Map<string, DxfLayer>;
  lineTypes: Map<string, DxfLineType>;
  textStyles: Map<string, DxfTextStyle>;
  blocks: Map<string, DxfBlock>;
  /** BLOCK_RECORD 핸들 → 블록 이름. MULTILEADER 의 블록 참조(341/344) 해석용. */
  blockNamesByHandle: Map<string, string>;
  /** LAYER 핸들 → 레이어 이름. 뷰포트별 동결 레이어(331) 해석용. */
  layerNamesByHandle: Map<string, string>;
  /** 모형 + 배치 목록. 탭 순서대로, 모형 공간이 맨 앞. */
  layouts: DxfLayout[];
  entities: DxfEntity[];
  /** 파싱 중 건너뛴 엔티티 타입 → 개수 */
  skipped: Record<string, number>;
  /** 원본 포맷 */
  source: 'dxf-ascii' | 'dxf-binary' | 'dwg';
  /** AC1015 등 */
  version: string;
}

export const ORIGIN: Point3 = { x: 0, y: 0, z: 0 };

export function pt(x = 0, y = 0, z = 0): Point3 {
  return { x, y, z };
}
