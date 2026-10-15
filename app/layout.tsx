import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'DWG / DXF 스케치 뷰어',
  description: 'three.js 로 DWG·DXF 도면을 읽어 스케치처럼 보여주는 웹 뷰어',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
