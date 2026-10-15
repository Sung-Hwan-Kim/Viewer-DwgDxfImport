'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface DrawingCanvasHandle {
  /** 도면 전체가 보이도록 맞춘다. */
  fit: (bounds?: Bounds | null) => void;
  /** 화면 중심 기준 배율 조정 (1보다 크면 확대). */
  zoomBy: (factor: number) => void;
  /** 현재 1픽셀이 몇 도면 단위인지 */
  unitsPerPixel: () => number;
  /** 화면을 PNG 로 내보낸다. */
  toPNG: () => string | null;
}

interface Props {
  /** 그릴 오브젝트. 바뀌면 이전 것을 떼고 새로 붙인다. */
  object: THREE.Object3D | null;
  background: number;
  /** 도면 좌표를 마우스로 훑을 때 */
  onCursor?: (x: number, y: number) => void;
  /** 뷰가 바뀔 때마다 (줌 배율 표시용) */
  onViewChange?: (unitsPerPixel: number) => void;
}

const MIN_UPP = 1e-7;
const MAX_UPP = 1e9;

const DrawingCanvas = forwardRef<DrawingCanvasHandle, Props>(function DrawingCanvas(
  { object, background, onCursor, onViewChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const contentRef = useRef<THREE.Object3D | null>(null);

  /** 화면 중심의 도면 좌표와 픽셀당 도면 단위 — 뷰 상태 전부. */
  const view = useRef({ cx: 0, cy: 0, upp: 1 });
  const size = useRef({ w: 1, h: 1 });
  const needsRender = useRef(true);
  /** 마지막으로 맞춘 도면 범위. 사용자가 뷰를 건드리기 전까지 리사이즈 때 다시 맞춘다. */
  const fitBounds = useRef<Bounds | null>(null);
  const userMoved = useRef(false);
  /**
   * 드래그 상태. 핸들러 바깥(ref)에 둔다 — 안에 두면 입력 핸들러를 다시 붙일 때
   * 드래그 중이라는 사실이 통째로 날아가 화면 이동이 중간에 끊긴다.
   */
  const drag = useRef({ active: false, pointerId: -1, lastX: 0, lastY: 0 });

  /**
   * 콜백은 ref 로 들고 있는다. 부모가 다시 렌더될 때마다 새 함수가 내려와도
   * 입력 핸들러를 떼었다 붙이지 않기 위해서다. onCursor 는 포인터가 움직일
   * 때마다 부모 상태를 바꾸므로, 이걸 의존성에 두면 드래그 도중에 핸들러가
   * 갈아끼워져 이동량이 뚝뚝 끊긴다.
   */
  const onCursorRef = useRef(onCursor);
  const onViewChangeRef = useRef(onViewChange);
  useEffect(() => {
    onCursorRef.current = onCursor;
    onViewChangeRef.current = onViewChange;
  });

  const applyCamera = useCallback(() => {
    const cam = cameraRef.current;
    if (!cam) return;
    const { cx, cy, upp } = view.current;
    const halfW = (size.current.w * upp) / 2;
    const halfH = (size.current.h * upp) / 2;
    cam.left = cx - halfW;
    cam.right = cx + halfW;
    cam.top = cy + halfH;
    cam.bottom = cy - halfH;
    cam.updateProjectionMatrix();
    needsRender.current = true;
  }, []);

  const fit = useCallback(
    (bounds?: Bounds | null) => {
      if (!bounds || !Number.isFinite(bounds.minX)) return;
      fitBounds.current = bounds;
      userMoved.current = false;
      const w = Math.max(bounds.maxX - bounds.minX, 1e-9);
      const h = Math.max(bounds.maxY - bounds.minY, 1e-9);
      const pad = 1.08;
      view.current.cx = (bounds.minX + bounds.maxX) / 2;
      view.current.cy = (bounds.minY + bounds.maxY) / 2;
      view.current.upp = Math.max(
        MIN_UPP,
        Math.max(w / Math.max(size.current.w, 1), h / Math.max(size.current.h, 1)) * pad,
      );
      applyCamera();
      onViewChange?.(view.current.upp);
    },
    [applyCamera, onViewChange],
  );

  // 리사이즈 핸들러가 최신 fit 을 쓰되, 그 때문에 렌더러를 다시 만들지는 않게 한다.
  const fitRef = useRef(fit);
  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);

  useImperativeHandle(
    ref,
    (): DrawingCanvasHandle => ({
      fit,
      zoomBy: (factor) => {
        userMoved.current = true;
        view.current.upp = Math.min(MAX_UPP, Math.max(MIN_UPP, view.current.upp / factor));
        applyCamera();
        onViewChange?.(view.current.upp);
      },
      unitsPerPixel: () => view.current.upp,
      toPNG: () => {
        const r = rendererRef.current;
        const s = sceneRef.current;
        const c = cameraRef.current;
        if (!r || !s || !c) return null;
        // preserveDrawingBuffer 를 켜지 않았으므로 직전에 한 번 더 그린다.
        r.render(s, c);
        return r.domElement.toDataURL('image/png');
      },
    }),
    [applyCamera, fit, onViewChange],
  );

  // ---- 초기화 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    // 뷰포트 안 문자를 창 모양으로 자르려면 머티리얼별 클리핑이 필요하다.
    renderer.localClippingEnabled = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!needsRender.current) return;
      needsRender.current = false;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      size.current = { w, h };
      renderer.setSize(w, h, false);
      // 사용자가 아직 뷰를 움직이지 않았다면 새 크기에 맞춰 다시 맞춘다.
      // (로드 직후 창 크기가 바뀌는 경합을 막는다.)
      if (!userMoved.current && fitBounds.current) fitRef.current?.(fitBounds.current);
      else applyCamera();
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, [applyCamera]);

  // ---- 배경색 ----
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.background = new THREE.Color(background);
    needsRender.current = true;
  }, [background]);

  // ---- 콘텐츠 교체 ----
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (contentRef.current) scene.remove(contentRef.current);
    contentRef.current = object;
    if (object) scene.add(object);
    needsRender.current = true;
  }, [object]);

  // ---- 입력 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const toWorld = (clientX: number, clientY: number) => {
      const rect = host.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const { cx, cy, upp } = view.current;
      return {
        x: cx + (px - rect.width / 2) * upp,
        y: cy - (py - rect.height / 2) * upp,
      };
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMoved.current = true;
      const before = toWorld(e.clientX, e.clientY);
      // 트랙패드와 휠의 delta 크기 차이를 흡수한다.
      const step = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) / 100, 1);
      const factor = Math.exp(step * 0.22);
      view.current.upp = Math.min(MAX_UPP, Math.max(MIN_UPP, view.current.upp * factor));
      const after = toWorld(e.clientX, e.clientY);
      // 커서 아래 좌표가 그대로 머물도록 중심을 보정.
      view.current.cx += before.x - after.x;
      view.current.cy += before.y - after.y;
      applyCamera();
      onViewChangeRef.current?.(view.current.upp);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      const d = drag.current;
      d.active = true;
      d.pointerId = e.pointerId;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      userMoved.current = true;
      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        // 이미 놓인 포인터면 캡처가 거부된다 — 이동 자체에는 지장이 없다.
      }
      host.style.cursor = 'grabbing';
    };

    const onPointerMove = (e: PointerEvent) => {
      const d = drag.current;
      if (d.active && e.pointerId === d.pointerId) {
        const dx = e.clientX - d.lastX;
        const dy = e.clientY - d.lastY;
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        view.current.cx -= dx * view.current.upp;
        view.current.cy += dy * view.current.upp;
        applyCamera();
      }
      const report = onCursorRef.current;
      if (report) {
        const p = toWorld(e.clientX, e.clientY);
        report(p.x, p.y);
      }
    };

    const endDrag = (e: PointerEvent) => {
      const d = drag.current;
      if (e.pointerId !== d.pointerId) return;
      d.active = false;
      d.pointerId = -1;
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
      host.style.cursor = 'grab';
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', endDrag);
    host.addEventListener('contextmenu', onContextMenu);
    host.style.cursor = 'grab';

    return () => {
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', endDrag);
      host.removeEventListener('pointercancel', endDrag);
      host.removeEventListener('contextmenu', onContextMenu);
    };
    // applyCamera 는 고정이라 이 효과는 한 번만 돈다 — 콜백은 위의 ref 로 받는다.
  }, [applyCamera]);

  return <div ref={hostRef} className="canvas-host" />;
});

export default DrawingCanvas;
