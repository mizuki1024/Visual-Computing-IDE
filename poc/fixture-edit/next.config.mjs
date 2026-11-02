import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

/* 編集 PoC の題材。要素識別子の注入は PoC-03 のローダ（poc/anchor/loader.cjs）をそのまま使う。
 * POC03_ANCHOR=1 のときだけ有効（poc/fixture-app と同じ取り決め。src/server/anchors.ts の anchorSupport が読む）。 */
const ANCHOR = process.env.POC03_ANCHOR === '1';
const ANCHOR_LOADER = path.join(here, '..', 'anchor', 'loader.cjs');
const ANCHOR_OPTS = {
  root: here,
  scope: 'src',
  outDir: process.env.POC03_ANCHOR_OUT ?? path.join(here, '..', 'out', 'anchors-edit'),
};

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: false,
  devIndicators: false,
  agentRules: false,
  turbopack: {
    root: here,
    ...(ANCHOR ? { rules: { '*.tsx': { loaders: [{ loader: ANCHOR_LOADER, options: ANCHOR_OPTS }] } } } : {}),
  },
};
