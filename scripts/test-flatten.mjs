/**
 * 평탄화 단위 테스트.
 *
 *   node scripts/test-flatten.mjs      (= npm test)
 *
 * 실제 도면으로는 확인하기 어려운 것들을 작은 입력으로 고정한다.
 *
 *  1. 뷰포트 변환 — 공식 샘플의 뷰포트는 비틀기 각도(51)가 전부 0 이라
 *     부호를 확인할 수 없다. 여기서 직접 DXF 를 만들어 ezdxf 의
 *     Viewport.get_transformation_matrix() 와 같은 식인지 비교한다.
 *  2. 축측도(평면도가 아닌) 뷰포트 — 샘플에 아예 없다.
 *  3. 사각형이 아닌 클리핑 경계(90 번 0x10000 + 340).
 *  4. 용지 테두리, 꺼진 뷰포트, 창별 동결 레이어.
 *  5. MTEXT 서식 코드 제거 — 중첩 중괄호와 종결자 없는 토글 코드가 흔하다.
 */
import { loadLib } from './load-lib.mjs';

const { parseDxf, flattenDocument, stripMTextFormatting } = await loadLib();

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

const VP_CENTER = [100, 50];
const VP_SIZE = [400, 200];
const VIEW_HEIGHT = 100;
const SCALE = VP_SIZE[1] / VIEW_HEIGHT; // 2
const LINE = [10, 20, 30, 20]; // 모형 공간 가로선 (x1,y1,x2,y2)

/**
 * 뷰포트 하나와 선 하나만 있는 최소 DXF.
 * opts: { twist, target, viewCenter, dir, limits, status, flags, boundary,
 *         frozenLayer, modelZ }
 */
function makeDxf(opts = {}) {
  const {
    twist = 0,
    target = [0, 0, 0],
    viewCenter = [20, 20],
    dir = [0, 0, 1],
    limits = null,
    status = 2,
    flags = 0,
    boundary = null, // 배치에 놓을 LWPOLYLINE 꼭짓점 [x,y,...]
    frozenLayer = null,
    modelZ = 0,
  } = opts;

  const out = [];
  const g = (code, value) => out.push(String(code), String(value));

  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER');
  g(0, 'LAYER'); g(5, 'L1'); g(2, '0'); g(62, 7); g(70, 0);
  g(0, 'LAYER'); g(5, 'L2'); g(2, 'HIDDEN_HERE'); g(62, 7); g(70, 0);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'BLOCK_RECORD');
  g(0, 'BLOCK_RECORD'); g(5, '1F'); g(2, '*Model_Space');
  g(0, 'BLOCK_RECORD'); g(5, '23'); g(2, '*Paper_Space');
  g(0, 'ENDTAB'); g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  g(0, 'LINE'); g(5, '100'); g(330, '1F'); g(8, '0');
  g(10, LINE[0]); g(20, LINE[1]); g(30, modelZ);
  g(11, LINE[2]); g(21, LINE[3]); g(31, modelZ);
  // 창별 동결 테스트용 — 다른 레이어의 선 하나
  g(0, 'LINE'); g(5, '101'); g(330, '1F'); g(8, 'HIDDEN_HERE');
  g(10, LINE[0]); g(20, LINE[1] + 1); g(30, modelZ);
  g(11, LINE[2]); g(21, LINE[3] + 1); g(31, modelZ);
  g(0, 'TEXT'); g(5, '102'); g(330, '1F'); g(8, '0');
  g(10, 20); g(20, 20); g(30, 0); g(40, 2); g(1, 'HELLO');

  if (boundary) {
    g(0, 'LWPOLYLINE'); g(5, 'B1'); g(330, '23'); g(67, 1); g(8, '0');
    g(90, boundary.length / 2); g(70, 1);
    for (let i = 0; i < boundary.length; i += 2) {
      g(10, boundary[i]); g(20, boundary[i + 1]);
    }
  }

  g(0, 'VIEWPORT'); g(5, '200'); g(330, '23'); g(67, 1); g(8, '0');
  g(10, VP_CENTER[0]); g(20, VP_CENTER[1]); g(30, 0);
  g(40, VP_SIZE[0]); g(41, VP_SIZE[1]);
  g(68, status); g(69, 2);
  g(12, viewCenter[0]); g(22, viewCenter[1]);
  g(16, dir[0]); g(26, dir[1]); g(36, dir[2]);
  g(17, target[0]); g(27, target[1]); g(37, target[2] ?? 0);
  g(45, VIEW_HEIGHT); g(51, twist);
  g(90, flags);
  if (boundary) g(340, 'B1');
  if (frozenLayer) g(331, frozenLayer);
  g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'OBJECTS');
  g(0, 'LAYOUT'); g(5, '26');
  g(100, 'AcDbPlotSettings'); g(1, 'page setup');
  g(100, 'AcDbLayout'); g(1, 'Sheet'); g(70, 1); g(71, 1);
  if (limits) {
    g(10, limits[0]); g(20, limits[1]); g(11, limits[2]); g(21, limits[3]);
  }
  g(330, '23');
  g(0, 'LAYOUT'); g(5, '22');
  g(100, 'AcDbPlotSettings'); g(1, '');
  g(100, 'AcDbLayout'); g(1, 'Model'); g(70, 1); g(71, 0); g(330, '1F');
  g(0, 'ENDSEC'); g(0, 'EOF');

  return new TextEncoder().encode(out.join('\r\n') + '\r\n').buffer;
}

function sheet(opts, flattenOpts = {}) {
  const doc = parseDxf(makeDxf(opts));
  return flattenDocument(doc, { darkBackground: true, space: 'Sheet', ...flattenOpts });
}

/** 레이어 '0' 의 모형 선이 배치에서 어디에 놓였는가. */
function modelLine(scene) {
  return scene.paths.find((p) => p.entityType === 'LINE' && p.layer === '0');
}

const fmt = (v) => v.map((n) => n.toFixed(4)).join(', ');
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

// --------------------------------------------------- 1. 평면도 뷰포트 변환

/** ezdxf 와 같은 식: paper = R(+twist)·scale·(model − target) + 창중심 − scale·뷰중심 */
function expectPaper(x, y, twist, target, viewCenter) {
  const t = (twist * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const dx = SCALE * (x - target[0]);
  const dy = SCALE * (y - target[1]);
  return [
    c * dx - s * dy + (VP_CENTER[0] - SCALE * viewCenter[0]),
    s * dx + c * dy + (VP_CENTER[1] - SCALE * viewCenter[1]),
  ];
}

for (const { twist, target, viewCenter } of [
  { twist: 0, target: [0, 0], viewCenter: [20, 20] },
  { twist: 90, target: [0, 0], viewCenter: [20, 20] },
  { twist: 30, target: [0, 0], viewCenter: [20, 20] },
  { twist: -45, target: [5, 7], viewCenter: [20, 20] },
  { twist: 180, target: [5, 7], viewCenter: [0, 0] },
]) {
  const scene = sheet({ twist, target, viewCenter });
  const path = modelLine(scene);
  const label = `뷰포트 twist=${String(twist).padStart(4)} target=(${target})`;
  if (!path) {
    check(false, label, '경로가 나오지 않았다');
    continue;
  }
  const got = [path.coords[0], path.coords[1], path.coords[3], path.coords[4]];
  const a = expectPaper(LINE[0], LINE[1], twist, target, viewCenter);
  const b = expectPaper(LINE[2], LINE[3], twist, target, viewCenter);
  check(near([a[0], a[1], b[0], b[1]], got), label, `(${fmt(got)})`);
}

// ------------------------------------------------------- 2. 축측도 뷰포트

// 아래에서 본 뷰(시선 −Z): 임의 축 알고리즘의 축은 ax=(−1,0,0), ay=(0,1,0)
// 이므로 X 가 뒤집힌다.
{
  const scene = sheet({ dir: [0, 0, -1], target: [0, 0, 0], viewCenter: [0, 0] });
  const path = modelLine(scene);
  const want = [
    VP_CENTER[0] - SCALE * LINE[0], VP_CENTER[1] + SCALE * LINE[1],
    VP_CENTER[0] - SCALE * LINE[2], VP_CENTER[1] + SCALE * LINE[3],
  ];
  const got = path ? [path.coords[0], path.coords[1], path.coords[3], path.coords[4]] : [];
  check(path && near(want, got), '아래에서 본 뷰포트는 X 가 뒤집힌다', `(${fmt(got)})`);
}

// 정면도(시선 +Y): ax=(−1,0,0), ay=(0,0,1) 이라 화면 x = −X, 화면 y = Z.
{
  const z = 7;
  const scene = sheet({ dir: [0, 1, 0], target: [0, 0, 0], viewCenter: [0, 0], modelZ: z });
  const path = modelLine(scene);
  const want = [
    VP_CENTER[0] - SCALE * LINE[0], VP_CENTER[1] + SCALE * z,
    VP_CENTER[0] - SCALE * LINE[2], VP_CENTER[1] + SCALE * z,
  ];
  const got = path ? [path.coords[0], path.coords[1], path.coords[3], path.coords[4]] : [];
  check(path && near(want, got), '정면도 뷰포트는 Z 를 세로축으로 쓴다', `(${fmt(got)})`);
}

// --------------------------------------------- 3. 사각형이 아닌 클리핑 경계

{
  // 창 한가운데의 작은 정사각형 경계. 모형 선은 창을 가로지르지만
  // 경계 안쪽(20 단위)만 남아야 한다.
  const boundary = [90, 40, 110, 40, 110, 60, 90, 60];
  const scene = sheet({
    viewCenter: [20, 20],
    flags: 0x10000,
    boundary,
  });
  const path = modelLine(scene);
  const width = path ? Math.abs(path.coords[3] - path.coords[0]) : -1;
  check(Math.abs(width - 20) < 1e-9, '비사각 경계로 선을 자른다', `남은 길이 ${width}`);

  // 플래그가 없으면 경계를 무시하고 창 사각형 그대로.
  const plain = modelLine(sheet({ viewCenter: [20, 20], boundary }));
  const w2 = plain ? Math.abs(plain.coords[3] - plain.coords[0]) : -1;
  check(Math.abs(w2 - 40) < 1e-9, '플래그 없으면 경계를 무시한다', `남은 길이 ${w2}`);
}

{
  // 오목한 경계(ㄷ 자) — 가운데가 파여 선이 두 조각으로 갈라져야 한다.
  const boundary = [80, 40, 120, 40, 120, 60, 112, 60, 112, 48, 88, 48, 88, 60, 80, 60];
  const scene = sheet({ viewCenter: [20, 20], flags: 0x10000, boundary });
  const pieces = scene.paths.filter((p) => p.entityType === 'LINE' && p.layer === '0');
  check(pieces.length === 2, '오목한 경계는 선을 두 조각으로 나눈다', `조각 ${pieces.length}개`);
}

// ------------------------------------- 4. 용지 테두리 · 꺼짐 · 동결 레이어

{
  const scene = sheet({ limits: [-5, -10, 835, 584] });
  const paper = scene.paths.find((p) => p.entityType === 'PAPER');
  const ok =
    paper &&
    near([paper.coords[0], paper.coords[1]], [-5, -10]) &&
    near([paper.coords[6], paper.coords[7]], [835, 584]);
  check(Boolean(ok), '용지 테두리를 LIMMIN/LIMMAX 로 그린다');
  check(
    scene.bounds.minX <= -5 && scene.bounds.maxX >= 835,
    '용지 테두리가 범위에 들어간다',
  );

  const off = sheet({ limits: [-5, -10, 835, 584] }, { paperBorder: false });
  check(
    !off.paths.some((p) => p.entityType === 'PAPER'),
    'paperBorder:false 면 그리지 않는다',
  );

  const none = sheet({});
  check(
    !none.paths.some((p) => p.entityType === 'PAPER'),
    '용지 정보가 없으면 그리지 않는다',
  );
}

check(!modelLine(sheet({ status: 0 })), '68=0 인 뷰포트는 건너뛴다');
check(!modelLine(sheet({ flags: 0x20000 })), '90 번 0x20000(꺼짐)이면 건너뛴다');

{
  const scene = sheet({ frozenLayer: 'L2' });
  const hidden = scene.paths.some((p) => p.layer === 'HIDDEN_HERE');
  check(!hidden && Boolean(modelLine(scene)), '창별 동결 레이어(331)를 반영한다');
  const all = sheet({});
  check(
    all.paths.some((p) => p.layer === 'HIDDEN_HERE'),
    '동결 지정이 없으면 그대로 보인다',
  );
}

{
  // 창 안 문자에는 렌더러가 쓸 반평면이 붙는다.
  const scene = sheet({});
  const text = scene.texts.find((t) => t.text === 'HELLO');
  check(text?.clip?.length === 4, '창 안 문자에 클리핑 반평면 4개가 붙는다');
  const poly = sheet({
    flags: 0x10000,
    boundary: [90, 40, 110, 40, 110, 60, 90, 60],
  });
  const t2 = poly.texts.find((t) => t.text === 'HELLO');
  check(t2?.clip?.length === 4, '볼록 경계는 그 변으로 자른다', `${t2?.clip?.length}개`);
}

{
  const doc = parseDxf(makeDxf({}));
  const names = doc.layouts.map((l) => `${l.name}${l.isModelSpace ? '*' : ''}`).join(', ');
  check(names === 'Model*, Sheet', '배치 목록은 모형이 먼저', names);
  const model = flattenDocument(doc, { darkBackground: true });
  check(
    !model.paths.some((p) => p.entityType === 'PAPER'),
    '모형 공간에는 용지 테두리를 그리지 않는다',
  );
}

// ------------------------------------------------------- 5. MTEXT 서식 코드

for (const [raw, want] of [
  ['{\\LLIVING ROOM\\P\\H0.6667x;\\lHRWD FLOOR}', 'LIVING ROOM\nHRWD FLOOR'],
  ['{\\fArial|b1|i0|c0|p34;DOOR SCHEDULE}', 'DOOR SCHEDULE'],
  ['{\\C1;빨강}{\\C3;초록}', '빨강초록'],
  ['A{B}{C}}', 'ABC'],
  ['3\\\\4', '3\\4'],
  ['\\A1;가운데', '가운데'],
  ['폭\\~250', '폭 250'],
  ['{\\H2.5x;큰} 글자', '큰 글자'],
]) {
  const got = stripMTextFormatting(raw);
  check(got === want, `MTEXT ${JSON.stringify(raw)}`, got === want ? '' : `-> ${JSON.stringify(got)}`);
}

console.log(failures === 0 ? '\n전부 통과' : `\n${failures}건 실패`);
process.exitCode = failures ? 1 : 0;
