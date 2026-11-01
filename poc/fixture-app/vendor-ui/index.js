/* =============================================================================
 * 外部UIライブラリの代役（PoC-03 の題材）。**src/ の外**にあり、
 * 実在のライブラリと同じく **JSX を持たない形で配布済み** のコードである。
 * したがって注入先の JSX が存在せず、要素識別子は原理的に付かない。
 * 「誤ってライブラリ内部を指す」のではなく「特定不能」と返せるかを試す。
 * ========================================================================== */
import { jsx, jsxs } from 'react/jsx-runtime';

export function VendorPanel(props) {
  return jsxs('section', {
    className: 'vendor',
    'data-poc-kind': 'vendor-panel',
    children: [
      jsx('h3', { className: 'vendor-title', children: props.title }),
      jsx('div', { className: 'vendor-slot', children: props.children }),
    ],
  });
}

/* PoC-04 補助ケース X — **解析範囲（src/）の外で作られる値**。
 * 表示されるが、由来をソース解析で src/ の中に辿ることはできない。
 * 「候補を出さない」が正解である。 */
export function outsideLabel() {
  return 'ライブラリ由来';
}
