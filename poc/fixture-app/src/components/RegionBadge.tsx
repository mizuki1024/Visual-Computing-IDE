/* PoC-03 題材 — ネストの最内側。props で受け取った値だけを描く。
 * この値が「どこから来たか」は、このファイルを見ても分からない。
 * それが derives を実測にできない理由そのものである（02a 3.5.1）。 */
export default function RegionBadge({ region }: { region: string }) {
  return (
    <span className="badge">
      <span className="badge-dot" aria-hidden="true" />
      <span className="badge-text">{region}</span>
    </span>
  );
}
