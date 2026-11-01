'use client';
/* =============================================================================
 * Webプレビュー（現物）。IDE はプレビューの中身を動かさない（03b 8.3節）。
 * 追跡できる値は合成データの経路にある1件だけである。他の文字に押せる見た目を
 * 与えない（IX-23：押せるのに何も起きない導線を作らない）。
 *
 * Phase 7B-1: 開発サーバーを扱っている間は LivePreview（実プレビュー）に切り替える。
 * 合成データ・記録データの表示（以下）は変えていない。
 * ========================================================================== */
import { useExplore, sameRef } from '@/state/ExploreStore';
import { useRuntime } from '@/state/RuntimeStore';
import FloatingPanel from './FloatingPanel';
import LivePreview, { wantsLivePreview } from './LivePreview';

const FILTERS = ['エリア', '種別', '規模', '状況'];

function Card({ no, region, plan, scale, date, b, children }: {
  no: string; region: string; plan: string; scale: string; date: string;
  b?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className={`card${b ? ' b' : ''}`}>
      <div className="thumb" />
      <div className="cb">
        <div className="no">{no}</div>
        <div className="crow"><em aria-hidden>◎</em>{children ?? region}</div>
        <div className="crow"><em aria-hidden>⚡</em>{plan}</div>
        <div className="crow"><em aria-hidden>▣</em>{scale}</div>
        <div className="crow"><em aria-hidden>▤</em>{date}</div>
      </div>
    </div>
  );
}

export default function PreviewPanel() {
  const { data, selection, select } = useExplore();
  const { runtime, liveSeen } = useRuntime();
  /*
   * Phase 7B-1: IDE が開発サーバーを扱っている間は、同じパネルの中身を実プレビューにする。
   * それ以外（プロジェクト未指定・この画面で起動を観測していない）は、以下の従来の表示のまま。
   */
  if (wantsLivePreview(runtime, liveSeen)) return <LivePreview />;
  // 追跡できる値があるのは、経路に「表示された値」のノードがあるときだけである。
  // PoC-01 の実測データには無い（ブラウザDOMの読み取りは PoC-03 の範囲）。
  const valueNode = data.nodes.find((n) => n.kind === 'value');
  const picked = !!valueNode && sameRef(selection, { type: 'node', id: valueNode.id });
  const componentNode = data.nodes.find((n) => n.kind === 'component');

  /*
   * 実測データで値のノードがある場合（PoC-03）。
   * **合成の見本サイトを出してはいけない。** その値は観測していない。
   * 出せるのは「どの要素を選んだか」と「値の形」だけである。
   * 値そのものは保存していないので、ここにも出ない。
   */
  if (valueNode && data.origin !== 'synthetic') {
    const shapeRow = valueNode.overview.find((r) => r.k === '値の形');
    const page = data.pages.find((x) => x.current)?.path ?? '—';
    return (
      <FloatingPanel id="preview" title="プレビュー" note="現物"
        style={{ left: 232, top: 16, width: 392 }}>
        <div className="pvb">
          <div className="site" style={{ padding: 18 }}>
            <div className="s-nav"><span className="s-logo">{data.project}</span></div>
            <div className="cards" style={{ paddingTop: 10 }}>
              <div className="card">
                <div className="cb">
                  <div className="no">{page}</div>
                  <div className="crow">
                    <em aria-hidden>◎</em>
                    {/* 押すと経路へフォーカスする。札に出すのは要素の参照であって値ではない */}
                    <button type="button" className={`trk${picked ? ' on' : ''}`}
                      aria-pressed={picked}
                      title="この要素の出所をたどる"
                      onClick={() => select({ type: 'node', id: valueNode.id }, { focus: true })}>
                      {valueNode.chipSub}
                    </button>
                  </div>
                  {componentNode && (
                    <div className="crow"><em aria-hidden>▣</em>{componentNode.chipSub}</div>
                  )}
                  {shapeRow && <div className="crow"><em aria-hidden>▤</em>{shapeRow.v}</div>}
                </div>
              </div>
            </div>
          </div>
          {picked && <div className="pvbadge" style={{ top: 112 }}>1</div>}
        </div>
        <div className="pvfoot">
          {picked
            ? <>選択中 <b>{valueNode.identifier}</b>
              <em>— 値そのものは保存していません。対応付けは要素識別子で行っています</em></>
            : <em>観測した要素 {valueNode.identifier}（値そのものは保存していません）</em>}
        </div>
      </FloatingPanel>
    );
  }

  if (!valueNode) {
    return (
      <FloatingPanel id="preview" title="プレビュー" note="現物"
        style={{ left: 232, top: 16, width: 392 }}>
        <div className="pvb">
          <div className="site" style={{ padding: 18 }}>
            <div className="s-nav"><span className="s-logo">{data.project}</span></div>
            <p className="pgnone" style={{ paddingLeft: 0 }}>
              このデータでは、画面に表示された値を観測していません。
              ブラウザのDOMの読み取りとコンポーネントの対応づけは、この検証の範囲外です。
            </p>
            <p className="pgnone" style={{ paddingLeft: 0, paddingTop: 0 }}>
              観測したページ: <code>{data.pages.find((x) => x.current)?.path ?? '—'}</code>
            </p>
          </div>
        </div>
        <div className="pvfoot">
          <em>たどれるのは、ブラウザが行った通信から下流だけです</em>
        </div>
      </FloatingPanel>
    );
  }

  return (
    <FloatingPanel id="preview" title="プレビュー" note="現物"
      style={{ left: 232, top: 16, width: 392 }}>
      <div className="pvb">
        <div className="site">
          <div className="s-nav">
            <span className="s-logo">{data.project}</span>
            <span className="lnk">物件一覧</span><span className="lnk">サービス</span>
            <span className="lnk">お知らせ</span>
          </div>
          <div className="hero">
            <div className="t"><b>エリアから<br />物件をさがす</b></div>
            <div className="sbox">エリア・種別・条件で検索</div>
          </div>
          <div className="filters">
            {FILTERS.map((f) => <div key={f} className="fl">{f} <span aria-hidden>▾</span></div>)}
          </div>
          <div className="cards">
            <Card no="No.900001" region="千葉県" plan="標準プラン" scale="中規模" date="2027年4月">
              {/* 計装で追跡できた唯一の値。押すと経路へフォーカスする */}
              <button type="button" className={`trk${picked ? ' on' : ''}`}
                aria-pressed={picked}
                title="この値の出所をたどる"
                onClick={() => select({ type: 'node', id: valueNode.id }, { focus: true })}>
                千葉県
              </button>
            </Card>
            <Card no="No.900002" region="茨城県" plan="標準プラン" scale="小規模" date="2026年10月" b />
          </div>
        </div>
        {/* ステップバッジは選択しているときだけ出す（03a 5節 F-2「選択時に表示」） */}
        {picked && <div className="pvbadge" style={{ top: 196 }}>1</div>}
      </div>
      <div className="pvfoot">
        {picked
          ? <>選択中 <b>「千葉県」</b><em>— 追跡できる値は合成データのこの1件だけです</em></>
          : <em>この合成データで出所をたどれる値は「千葉県」の1件だけです</em>}
      </div>
    </FloatingPanel>
  );
}
