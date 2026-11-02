import AppShell from '@/components/AppShell';
import { ExploreProvider } from '@/state/ExploreStore';
import { buildDataset, type DatasetKey } from '@/lib/trace';

/**
 * 探索画面。描くデータは9通りある。
 *   既定           合成シナリオ（Phase 5A〜5C で作った画面の基準）
 *   ?data=measured PoC-01 で実際の計装から取得した実測データ
 *   ?data=elements PoC-03 の実測データ（①表示された値・②コンポーネントを含む）
 *   ?data=flows    PoC-05 の実測データ（通信を開始したコンポーネントを含む）
 *   ?data=rsc      PoC-02 の実測データ（Server Component の直読み。APIノードが無い）
 *   ?data=rsc-svc  PoC-02 の実測データ（サーバー内部の通信が1段入る）
 *   ?data=lin-a    PoC-04（ケースA）由来を1列に絞れた場合。**推定の関係が1本入る**
 *   ?data=lin-c    PoC-04（ケースC）候補が複数のままの場合。1つに断定しない
 *   ?data=lin-g    PoC-04（ケースG）由来を作らない場合。**切断のまま**
 * いずれも同じ描画部品を通る。違いはデータセットだけである（05c 5.3節）。
 */
const KEYS: Record<string, DatasetKey> = {
  measured: 'measured', elements: 'elements', flows: 'flows',
  rsc: 'rsc', 'rsc-svc': 'rsc-svc',
  'lin-a': 'lin-a', 'lin-c': 'lin-c', 'lin-g': 'lin-g',
};

export default async function Page(
  { searchParams }: { searchParams: Promise<{ data?: string }> },
) {
  const q = await searchParams;
  const key: DatasetKey = KEYS[q.data ?? ''] ?? 'synthetic';
  return (
    /* 7C-3: ?data= で明示的に選んだデータセットは、プロジェクトを開いていても描く */
    <ExploreProvider data={buildDataset(key)} explicitDemo={typeof q.data === 'string' && q.data !== ''}>
      <AppShell />
    </ExploreProvider>
  );
}
