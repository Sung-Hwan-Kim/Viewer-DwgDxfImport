import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Next 16 은 Turbopack 이 기본이다. 빈 설정을 둬서 webpack 설정이 없음을 명시한다.
  turbopack: {},
};

export default nextConfig;
