/* =============================================================================
 * プレビューの中継と DevServerManager をつなぐ（Phase 7B-1）。
 *
 * 中継の転送先は **DevServerManager が `running` と観測した開発サーバー**だけである。
 * それ以外の状態（起動中・停止・失敗）では転送しない。
 * ========================================================================== */
import { accessConfig, isAllowedIdeHost, isLoopbackHost, hostnameOf, type AccessConfig } from './access';
import { devServer } from './devServer';
import { pidAlive } from './net';
import type { Finding } from './projectInspect';
import { PreviewGateway, type GatewayInfo } from './previewGateway';

export interface PreviewInfo {
  gateway: GatewayInfo;
  /**
   * **この要求を出したブラウザから見た**中継の origin。IDE の画面はこれを iframe に使う。
   * 決められなければ null（理由は error）
   */
  origin: string | null;
  /** 中継が転送しているか（開発サーバーが実行中か） */
  forwarding: boolean;
  /** 中継を使えない理由。03d の4要素 */
  error: Finding | null;
  /** 設定の誤り（VCIDE_* の解釈に失敗したもの） */
  configProblems: string[];
}

const RUN_REASON: Record<string, string> = {
  idle: 'IDE はまだ開発サーバーを起動していません。',
  validating: 'IDE はプロジェクトの構成を検証しています。',
  starting: '開発サーバーは起動中です。HTTP の応答を確認するまで転送しません。',
  stopping: '開発サーバーを停止しています。',
  stopped: '開発サーバーは停止しています。',
  error: '開発サーバーは起動できていないか、終了しました。',
};

function makeGateway(cfg: AccessConfig): PreviewGateway {
  return new PreviewGateway({
    config: cfg,
    target: () => {
      const s = devServer().snapshot();
      if (s.state !== 'running' || !s.port) return { target: null, reason: RUN_REASON[s.state] ?? '' };
      // 状態の確認（/api/runtime/status）の間に落ちていることがある。転送の前に生存を見る
      if (s.pid && !pidAlive(s.pid)) {
        return { target: null, reason: `開発サーバーのプロセス（PID ${s.pid}）は終了しています。` };
      }
      return { target: { port: s.port }, reason: '' };
    },
  });
}

/** 単一実体（devServer と同じく globalThis に置く。dev の再評価で二重に待ち受けないため） */
export function previewGateway(): PreviewGateway {
  const g = globalThis as unknown as { __vcidePreviewGateway__?: PreviewGateway };
  g.__vcidePreviewGateway__ ??= makeGateway(accessConfig());
  return g.__vcidePreviewGateway__;
}

/** 要求の Host から、そのブラウザが使うべき中継の origin を決める */
export function previewOriginFor(hostHeader: string | null, gw: GatewayInfo, cfg: AccessConfig): {
  origin: string | null; error: Finding | null;
} {
  if (gw.state !== 'listening' || !gw.port) {
    return {
      origin: null,
      error: {
        code: 'preview-gateway-unavailable', severity: 'blocker',
        fact: 'プレビューの中継を用意できませんでした。',
        reason: gw.reason ?? '理由を特定できません。',
        impact: '開発サーバーのページをプレビューに表示できません。開発サーバーの起動・停止は行えます。',
        action: 'ポートを空けるか、IDE を VCIDE_PREVIEW_PORT=<空いているポート> で起動し直してください。',
      },
    };
  }
  if (hostHeader && isLoopbackHost(hostHeader)) {
    const name = hostnameOf(hostHeader);
    return { origin: `http://${name === '0.0.0.0' ? '127.0.0.1' : name}:${gw.port}`, error: null };
  }
  if (hostHeader && isAllowedIdeHost(hostHeader, cfg) && cfg.previewPublicOrigin) {
    return { origin: cfg.previewPublicOrigin, error: null };
  }
  return {
    origin: null,
    error: {
      code: 'preview-origin-unknown', severity: 'blocker',
      fact: 'このブラウザからプレビューの中継に届く URL がわかりません。',
      reason: `IDE には転送された URL（${hostHeader ?? '不明'}）で接続しています。`
        + `プレビューの中継（サーバー側の 127.0.0.1:${gw.port}）がブラウザからどの URL で見えるかは、IDE の起動時に指定されていません。`,
      impact: 'プレビューは表示しません。ブラウザの localhost はサーバーの localhost ではないため、開発サーバーの URL を直接開いても届きません。',
      action: `ポート ${gw.port} を転送し、IDE を VCIDE_PREVIEW_ORIGIN=<その転送 URL> で起動し直してください（Codespaces では VCIDE_ALLOWED_HOSTS=codespaces）。`,
    },
  };
}

/** 状態 API が返すプレビューの情報。中継の待ち受けもここで始める */
export async function previewInfo(hostHeader: string | null): Promise<PreviewInfo> {
  const cfg = accessConfig();
  const gw = await previewGateway().ensure();
  const { origin, error } = previewOriginFor(hostHeader, gw, cfg);
  const s = devServer().snapshot();
  return {
    gateway: gw,
    origin,
    forwarding: s.state === 'running',
    error,
    configProblems: cfg.problems,
  };
}
