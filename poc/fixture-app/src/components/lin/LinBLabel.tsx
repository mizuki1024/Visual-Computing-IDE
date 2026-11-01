/* PoC-04 ケース B — 最内側。props で受け取った値だけを描く。
 * 由来は2段さかのぼらないと分からない（page → LinBCard → ここ）。 */
export default function LinBLabel({ text }: { text: string }) {
  return <span data-poc-field="b-label">{text}</span>;
}
