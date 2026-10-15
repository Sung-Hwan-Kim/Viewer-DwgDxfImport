import CadViewer from '@/components/CadViewer';

/**
 * 뷰어는 클라이언트 컴포넌트다. 첫 렌더에서는 빈 캔버스 컨테이너만 나오고
 * WebGL 컨텍스트와 three.js 씬은 마운트 뒤 effect 에서 만들어진다.
 */
export default function Page() {
  return <CadViewer />;
}
