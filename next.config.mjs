import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 画面の比較を邪魔しないよう、開発用の表示を出さない
  devIndicators: false,
  // Next が AGENTS.md を自動生成しないようにする
  agentRules: false,
  // 親ディレクトリ（ホーム）の package-lock.json を拾わせない
  turbopack: { root: here },
};
export default nextConfig;
