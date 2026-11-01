import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- PoC-03 */
/* 要素識別子の注入。POC03_ANCHOR=1 のときだけ有効にする。
 * 既定で無効なので、PoC-01 の計測は従来と同じ条件で再現できる。 */
/* `1` で注入する。`noop` は計測専用の素通しローダ（PoC-05 第7節）で、
 * 「ローダを挟むこと自体のコスト」を分けて測るためだけに使う。 */
const ANCHOR_MODE = process.env.POC03_ANCHOR ?? '0';
const ANCHOR = ANCHOR_MODE === '1' || ANCHOR_MODE === 'noop';
const ANCHOR_LOADER = path.join(
  here, '..', 'anchor', ANCHOR_MODE === 'noop' ? 'noop-loader.cjs' : 'loader.cjs',
);
/** PoC-02: webpack のサーバー側だけ外部ソースマップに変える */
const SERVER_SOURCEMAP = process.env.POC02_SERVER_SOURCEMAP === '1';

const ANCHOR_OPTS = {
  root: here,
  // 注入範囲はユーザーのソースディレクトリに限る（01b Q-03 C-3）
  scope: 'src',
  outDir: process.env.POC03_ANCHOR_OUT ?? path.join(here, '..', 'out', 'anchors'),
};

/** @type {import('next').NextConfig} */
export default {
  // 開発時の二重実行で1回の操作が2回の通信に見えるのを避ける。
  // PoC は「1回の読み込みで何が起きたか」を観測する
  reactStrictMode: false,
  devIndicators: false,
  agentRules: false,
  turbopack: {
    root: here,
    ...(ANCHOR
      // `as` は付けない。付けると Turbopack が出力の拡張子を足し、
      // 'use client' ページのクライアント入口の解決が page.tsx.tsx になって壊れる
      ? { rules: { '*.tsx': { loaders: [{ loader: ANCHOR_LOADER, options: ANCHOR_OPTS }] } } }
      : {}),
  },
  /* ---------------------------------------------------------------- PoC-02
   * webpack のサーバー側の生成物を、既定の eval 形式から **外部ソースマップ**へ
   * 変える。eval されたモジュールは実行時のスタックから元の位置へ戻せない
   * （サーバー側には CDP が無い）。`POC02_SERVER_SOURCEMAP=1` のときだけ。
   * 既定では無効なので、PoC-01 / PoC-03 / PoC-05 の計測条件は変わらない。
   * ------------------------------------------------------------------- */
  ...(ANCHOR || SERVER_SOURCEMAP
    ? {
      webpack(config, ctx) {
        if (ANCHOR) {
          // enforce: 'pre' で SWC より前に走らせる。入力は素の TSX である
          config.module.rules.push({
            test: /\.(tsx|jsx)$/,
            enforce: 'pre',
            use: [{ loader: ANCHOR_LOADER, options: ANCHOR_OPTS }],
          });
        }
        if (SERVER_SOURCEMAP && ctx && ctx.isServer) config.devtool = 'source-map';
        return config;
      },
    }
    : {}),
  // pg と Prisma をバンドルに取り込ませない。取り込まれると require フックが
  // 効かなくなる可能性がある（Q-01 C-4 / UR-02）。この設定の有無での差も測る
  serverExternalPackages: process.env.POC01_EXTERNALIZE === '0'
    ? []
    : ['pg', '@prisma/client', '@prisma/instrumentation'],
};
