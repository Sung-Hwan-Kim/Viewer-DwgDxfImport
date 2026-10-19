# DWG / DXF 스케치 뷰어

Next.js + React Three Fiber(three.js) 로 만든 2D CAD 도면 웹 뷰어입니다. 브라우저에서 DXF/DWG 파일을
직접 읽어 선 도면(스케치)으로 그립니다. 서버로 파일을 올리지 않습니다 — 파싱과
렌더링이 전부 브라우저 안에서 끝납니다.

## 실행

```bash
npm install
npm run dev
```

http://localhost:3000 에서 열립니다. 왼쪽 **예제 도면 열기** 를 누르면 번들된
`public/samples/apartment.dxf` 가 바로 열립니다.

| 스크립트 | 설명 |
| --- | --- |
| `npm run dev` | 개발 서버 (3000 포트) |
| `npm run build` / `npm start` | 프로덕션 빌드 / 실행 |
| `npm run typecheck` | 타입 검사 |
| `npm test` | 평탄화 단위 테스트 (뷰포트 변환·MTEXT 서식) |

`predev` / `prebuild` 에서 `scripts/copy-wasm.mjs` 가 LibreDWG 의 wasm 바이너리를
`public/libredwg/` 로 복사합니다.

## 쓰는 법

- 파일을 창 아무 곳에나 **끌어다 놓거나** 왼쪽에서 선택합니다. (`.dxf`, `.dwg`)
- **휠** 확대/축소 (커서 위치 기준), **드래그** 이동, **전체 보기** 로 화면 맞춤.
- 배치(레이아웃)가 있는 도면은 왼쪽 **공간** 드롭다운으로 모형 ↔ 배치를 전환합니다.
  배치를 보는 동안에는 **용지 테두리 표시** 를 끄고 켤 수 있습니다.
- 레이어 패널에서 레이어를 켜고 끌 수 있습니다.
- **PNG 저장** 으로 현재 화면을 내보냅니다.

### 표현 스타일

| 스타일 | 설명 |
| --- | --- |
| CAD | 어두운 배경 + AutoCAD 인덱스 색 (모형 공간과 같은 느낌) |
| 제도지 | 밝은 종이 배경 |
| 청사진 | 남색 바탕의 청사진 |
| 손그림 스케치 | 종이 배경 + 선 떨림 + 두 번 덧그리기 |

`단색 잉크로 그리기` 를 켜면 레이어 색을 무시하고 한 가지 잉크색으로 그립니다.
`선굵기 표시` 를 끄면 모든 선을 1 px 로 그립니다 (AutoCAD 의 `LWDISPLAY` 와 같은 역할).

## 지원 범위

**읽기**: ASCII DXF, Binary DXF, DWG (LibreDWG 로 DXF 변환 후 처리).
인코딩은 UTF-8 우선, 실패하면 cp949 / windows-1252 로 재시도하므로 구버전
한글 도면의 레이어명도 깨지지 않습니다.

**엔티티**: `LINE`, `LWPOLYLINE`, `POLYLINE`(2D/3D, bulge 호 포함), `CIRCLE`,
`ARC`, `ELLIPSE`, `SPLINE`(NURBS de Boor 평가 / 피팅점 Catmull-Rom), `POINT`,
`SOLID`, `3DFACE`, `TEXT`, `MTEXT`(서식 코드 제거), `ATTRIB`, `INSERT`(블록 전개,
배열 삽입, 중첩 16단계 제한), `DIMENSION`(익명 블록 전개), `LEADER`,
`MULTILEADER`(리더선 + 랜딩 + 화살촉, 문자 콘텐츠와 블록 콘텐츠 모두 — 블록은
속성 값까지 채워 그립니다), `ACAD_TABLE`(AutoCAD 가 만들어 둔 익명 블록 `*T…` 을
전개해 격자선과 셀 문자를 그리고, 블록이 없으면 행/열 치수로 직접 격자를 만듭니다),
`HATCH`(솔리드 채움 + ANSI31 같은 패턴 해치를 경계로 클리핑해 실제 선으로 생성.
경계는 폴리라인뿐 아니라 선분·호·타원 호 에지도 종류에 맞게 풀어 씁니다 —
스플라인 에지만 피팅점/제어 다각형으로 근사합니다),
`VIEWPORT`(배치를 볼 때, 창에 보이는 모형 공간을 축척·시선 방향·비틀기·창별 동결
레이어까지 반영해 그리고 창 모양으로 잘라냅니다 — 사각형이 아닌 경계와 축측도
시선도 다룹니다).

그 밖에 처리한 것:

- **OCS → WCS** 임의 축 알고리즘 — 압출 벡터가 기울어진 엔티티도 올바른 위치에.
  좌표를 애초에 WCS 로 저장하는 엔티티(`LINE`, `ELLIPSE`, `SPLINE`, `3DFACE`,
  3D 폴리라인)에는 이 변환을 걸지 않습니다. 걸면 거울 반전된(압출 `-Z`) 타원
  같은 것이 원점 반대편으로 날아갑니다.
- **선종류(LTYPE)** 를 기하로 분해 — 파선/일점쇄선이 줌과 무관하게 도면 단위로 유지.
- **선굵기(LWDISPLAY)** — 370 코드의 1/100 mm 값과 BYLAYER/BYBLOCK/기본값
  (`$LWDEFAULT`) 상속을 풀어 실제 굵기로 그립니다. WebGL 은
  `LineBasicMaterial.linewidth` 를 무시하므로(항상 1 px), 굵은 선은 선분마다
  사각형을 만들어 셰이더에서 두께를 주는 `LineSegments2` 로 그립니다. 굵기는
  AutoCAD 와 같이 **종이 위 밀리미터** 라 줌을 해도 화면에서 변하지 않습니다
  (96 DPI 기준 환산). 1.3 px 이하로 환산되는 선은 그냥 1 px 선으로 그려
  대부분의 도면은 추가 비용이 들지 않고, 굵은 선이 20만 선분을 넘으면 전부
  1 px 로 떨어뜨립니다.
- **ACI 256색 팔레트** 와 BYLAYER / BYBLOCK / true color 해석.
- **배치(레이아웃) 보기** — `OBJECTS` 섹션의 `LAYOUT` 객체로 공간 목록을 만들고,
  배치를 고르면 그 배치의 `BLOCK_RECORD` 에 속한 엔티티(도곽·주석·표)와 뷰포트
  안의 모형 공간 내용을 함께 그립니다. 지금 보지 않는 배치의 엔티티는 DXF 의
  `ENTITIES` 가 아니라 `*Paper_Space1`… 블록에 들어 있는데, 그쪽도 읽습니다.
- 레이어 off / frozen 상태 반영. (뷰포트 **자신**은 예외 — `Viewports` 레이어를
  꺼 둔 도면이 흔해서, 창 테두리는 어차피 안 그리고 안쪽 내용은 그대로 보여 줍니다.)
- **뷰포트별 동결 레이어**(`331`) 반영 — 같은 모형을 보는 창이라도 창마다 다른
  것을 보여 주는 장치라, 무시하면 배치의 창 네 개가 전부 같은 그림이 됩니다.
- **사각형이 아닌 창**(`90` 의 `0x10000` + `340`) — 경계 엔티티를 그대로 평탄화해
  다각형으로 쓰므로 원·타원·스플라인 경계도 맞습니다. 선은 경계와의 교차점으로
  직접 자르고, 면은 경계가 볼록하면 반평면 한 벌로, 오목하면 귀 자르기로 나눈
  삼각형마다 잘라냅니다. (공식 샘플 `colorwh` 의 원형 뷰포트 두 개로 확인했습니다.)
- **축측도 뷰포트** — 시선 방향으로 만든 뷰 좌표계에 모형을 투영하므로, 평면도가
  아닌 창(정면도·아래에서 본 뷰 등)도 그립니다.
- **용지 테두리** — 배치를 보면 `LAYOUT` 의 `LIMMIN`/`LIMMAX` 로 용지 한 장을
  그립니다. 내용이 없는 배치도 빈 종이로 보이고, 화면 맞춤이 용지 기준이 됩니다.
- **문자는 창 경계에서 글자째 잘립니다.** 선·면은 평탄화 단계에서 좌표를 자르지만
  글리프는 자를 수 없어, 걸친 문자에 반평면을 달아 렌더러가 GPU 클리핑으로
  처리합니다(`FlatText.clip` → `Material.clippingPlanes`).
- **해치 패턴은 엔티티 자체 좌표계에서 만든 뒤 변환**합니다. 변환된 경계에 원본
  패턴을 쓰면 축척된 블록·확대된 뷰포트에서 간격이 어긋나고 회전된 블록에서는
  방향까지 틀어집니다. 이렇게 하면 축척·회전·미러·전단이 저절로 맞습니다.

**지원하지 않음**: `IMAGE`(래스터 참조), `OLE2FRAME`, `3DSOLID` /
`PLANESURFACE` / `LIGHT` 등 3D 전용 엔티티, 폴리곤 메시, 표의 셀 병합,
외부 참조(XREF) 실제 로딩, SHX 폰트 글리프(문자는 시스템 폰트로 그립니다).
열어 본 도면에서 건너뛴 엔티티는 사이드바 "도면 정보"에 종류와 개수가 표시되고,
그릴 것이 하나도 없으면 화면에 그 이유를 안내합니다.

## 검증

AutoCAD 공식 샘플 도면 18개(DWG, AC1021~AC1024)로 확인했습니다.

- **18/18 변환 성공** — LibreDWG 가 모두 DXF 로 바꿨고, 파싱·평탄화에서 예외 없음.
- `architectural_example-imperial` 은 DWG→DXF 변환 결과와 **같은 도면의 공식 DXF**
  파일이 엔티티 수·종류·좌표 범위까지 동일했습니다(변환 무손실 확인).
- 가장 큰 `colorwh.dwg`(36,374 엔티티 → 144,670 선분)도 0.4초에 처리.
- 빈 화면이 나온 2개(`visualization_-_aerial`, `visualization_-_sun_and_sky_demo`)는
  모형 공간에 3DSOLID/PLANESURFACE 만 있는 3D 샘플로, 2D 뷰어에서는 정상 동작입니다.
- **배치**: DWG 18개 + 공식 DXF 15개에서 배치 목록을 모두 읽었고, 도곽·표·주석이
  있는 배치는 뷰포트 안 모형 공간까지 그려집니다
  (`blocks_and_tables_-_metric` 의 `ISO A1` → 경로 1,808 · 문자 533,
  `DOOR SCHEDULE` 같은 표 문자 포함). 배치를 추가해도 **모형 공간 결과는
  33개 파일 모두 한 글자도 바뀌지 않습니다.**
- `title_block-*` 세 개는 도곽이 배치가 아니라 모형 공간에 들어 있어, 배치를
  고르면 비어 있는 것이 정상입니다.
- 공식 샘플의 뷰포트는 비틀기 각도(`51`)가 전부 0 이고 축측도 창도 없어서,
  그 둘은 `npm test` 가 직접 만든 DXF 로 확인합니다 — 비틀기 0°/±30°/±45°/90°/180°,
  아래에서 본 뷰와 정면도, 오목·볼록 클리핑 경계, 용지 테두리, 꺼진 뷰포트,
  창별 동결 레이어까지 30건입니다. 비틀기 부호의 기준은 AutoCAD 의 표준
  DCS→WCS 행렬(`Rotation(−twist)`)과 ezdxf 의
  `Viewport.get_transformation_matrix()` 로, 둘 다 같은 방향입니다.
- 사각형이 아닌 창은 `colorwh` 의 원형 뷰포트 두 개가 실제로 쓰고 있어, 색상환이
  원으로 잘리는 것을 브라우저에서 확인했습니다.

직접 점검하려면:

```bash
node scripts/check-drawing.mjs <파일경로> [--dump-dxf 변환결과.dxf] [--space "ISO A1"]
```

브라우저와 같은 경로를 Node 에서 돌려 레이어·블록·공간(배치) 목록·엔티티 종류·
건너뛴 항목·좌표 범위를 출력합니다. `--dump-dxf` 를 주면 DWG 에서 변환된 DXF 를
저장해 직접 열어 볼 수 있고, `--space` 에 배치 이름을 주면 그 배치를 평탄화합니다
(생략하면 모형 공간).

## 구조

```
app/                 Next.js App Router (서버 렌더는 껍데기만)
components/
  CadViewer.tsx      상태·워커·패널 오케스트레이션
  DrawingCanvas.tsx  R3F <Canvas> 와 2D 팬/줌 (직교 카메라, on-demand 렌더)
  LayerPanel.tsx     레이어 목록
lib/
  dxf/
    lexer.ts         바이트 → (그룹 코드, 값) 쌍  (ASCII/Binary, 인코딩 추정)
    parser.ts        쌍 → DxfDocument (헤더/테이블/블록/엔티티)
    flatten.ts       DxfDocument → 선분·문자·면  (블록 전개, 곡선 분해, 대시, 해치,
                     공간 선택과 뷰포트 클리핑)
    colors.ts        ACI 팔레트
    types.ts         데이터 모델
  dwg/loadDwg.ts     DWG → DXF (LibreDWG WASM, 동적 import)
  three/sketchScene.ts  평탄화 결과 → three.js 오브젝트 (색상별 배치, 손그림 효과)
scripts/
  check-drawing.mjs    도면 점검 CLI
  test-flatten.mjs     평탄화 단위 테스트 (`npm test`)
  load-lib.mjs         위 둘이 쓰는 lib 컴파일 헬퍼
  worker/parse.worker.ts  파싱·평탄화를 워커에서 수행 (문서를 캐시해 공간 전환은
                          다시 파싱하지 않음)
```

설계상 **DWG 는 DXF 로 변환한 뒤 같은 경로를 탑니다.** 렌더링 코드는 DWG 를 따로
알지 못하므로 분기가 한 곳(`lib/worker/parse.worker.ts`)뿐입니다.

파싱과 평탄화는 Web Worker 에서 돌아가 큰 도면을 열어도 UI 가 멈추지 않습니다.
선은 색·굵기별로 하나의 `LineSegments` 로 합쳐 드로우 콜을 줄이고, 화면은 변화가
있을 때만 다시 그립니다(R3F `frameloop="demand"`).

화면 쪽은 **React Three Fiber** 를 씁니다. 캔버스·렌더 루프·직교 카메라·마우스
조작이 `<Canvas>` 와 `useThree` 위에 올라가 있습니다. 다만 평탄화 결과로 만든
선·면·문자 묶음은 `buildSketchScene()` 이 한 번에 만든 `THREE.Group` 을
`<primitive>` 로 통째로 붙입니다 — 수십만 선분과 수천 개의 문자 평면을 JSX 로
쪼개면 재조정 비용만 늘고 얻는 것이 없기 때문입니다. 2D 도면이라 직교 카메라의
프러스텀을 직접 계산하므로 카메라에 `manual` 을 세워 R3F 가 창 크기에 맞춰
덮어쓰지 않게 합니다.

## 성능 안전장치

- 선분 총량 상한 (기본 400만) — 넘으면 일부만 그리고 사이드바에 알립니다.
- 블록 중첩 깊이 16단계, 배열 삽입 행·열 각 1000 제한.
- 해치 하나당 생성 선 4000개 제한. 해치 패턴을 엔티티 좌표계에서 만들기 때문에
  25배로 확대된 뷰포트에서도 선 수가 모형 공간과 같습니다.
- 클리핑 경계가 2048 꼭짓점을 넘으면 삼각형 분할을 포기하고 창 사각형으로
  대신합니다.

## 라이선스

이 프로젝트는 **GPL-3.0-only** 입니다. 전문은 [LICENSE](LICENSE) 에 있습니다.

```
Copyright (C) 2026 Sung-Hwan Kim

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License version 3 as
published by the Free Software Foundation.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
```

DWG 지원에 쓰는 [`@mlightcad/libredwg-web`](https://github.com/mlightcad/libredwg-web)
이 **GPL-3.0** 이라, 그것을 함께 배포하는 이상 결과물 전체가 GPL 을 따릅니다.
저장소 라이선스를 거기에 맞춘 이유입니다. (패키지가 선언한 `GPL-3.0` 은 "이후
버전도 허용" 여부가 분명하지 않아, 더 좁은 쪽인 `GPL-3.0-only` 로 잡았습니다.)

DXF 파서·렌더러는 이 저장소의 자체 구현이고 LibreDWG 에 의존하지 않습니다.
DWG 지원이 필요 없다면 `lib/dwg/` 와 워커의 동적 import 한 줄만 제거하면 GPL
의존이 사라지고(동적 import 라 DXF 전용 번들에는 애초에 포함되지 않습니다),
그때는 라이선스를 원하는 대로 다시 고를 수 있습니다.

three.js, React Three Fiber, Next.js, React 는 MIT 입니다.

## 참고

예제 도면 `public/samples/apartment.dxf` 와 ACI 팔레트 구성 규칙은
[storytold/cadcraft](https://github.com/storytold/cadcraft) (MIT OR Apache-2.0)
에서 가져왔습니다.
