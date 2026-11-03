/* =============================================================================
 * 方式2（React の _debugStack + ソースマップ）を**比較のために**実測する道具。
 * 最小のソースマップ消費器。mappings の VLQ を解いて (行,列) を元の位置へ戻す。
 * 採用方式ではない。方式1 と並べて精度を比べるためだけに使う。
 * ========================================================================== */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHAR = new Map([...B64].map((c, i) => [c, i]));

function decodeVlq(str, i) {
  let result = 0;
  let shift = 0;
  let cont = true;
  while (cont) {
    const d = CHAR.get(str[i++]);
    if (d === undefined) return null;
    cont = !!(d & 32);
    result += (d & 31) * (2 ** shift);
    shift += 5;
  }
  const neg = result & 1;
  result >>= 1;
  return { value: neg ? -result : result, next: i };
}

/** mappings を行ごとのセグメント配列に展開する（0 始まり） */
export function parseMappings(mappings) {
  const lines = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const lineStr of mappings.split(';')) {
    const segs = [];
    let genCol = 0;
    for (const segStr of lineStr.split(',')) {
      if (!segStr) continue;
      let i = 0;
      const fields = [];
      while (i < segStr.length) {
        const d = decodeVlq(segStr, i);
        if (!d) break;
        fields.push(d.value);
        i = d.next;
      }
      genCol += fields[0];
      if (fields.length >= 4) {
        srcIdx += fields[1];
        srcLine += fields[2];
        srcCol += fields[3];
        segs.push({ genCol, srcIdx, srcLine, srcCol });
      } else {
        segs.push({ genCol, srcIdx: null, srcLine: null, srcCol: null });
      }
    }
    segs.sort((a, b) => a.genCol - b.genCol);
    lines.push(segs);
  }
  return lines;
}

/**
 * 生成後の (line, col) ※1始まり／0始まり を元の位置へ戻す。
 * インデックスマップ（sections 形式）にも対応する。
 * @returns {{source:string, line:number, column:number}|null}
 */
export function originalPositionFor(map, line1, col0) {
  if (!map || typeof map !== 'object') return null;

  // sections 形式（インデックスマップ）。該当する区画を選んで再帰する
  if (Array.isArray(map.sections)) {
    let pick = null;
    for (const sec of map.sections) {
      const o = sec.offset ?? { line: 0, column: 0 };
      if (o.line < line1 - 1 || (o.line === line1 - 1 && o.column <= col0)) pick = sec;
      else break;
    }
    if (!pick || !pick.map) return null;
    const o = pick.offset ?? { line: 0, column: 0 };
    const innerLine = line1 - o.line;
    const innerCol = o.line === line1 - 1 ? col0 - o.column : col0;
    return originalPositionFor(pick.map, innerLine, innerCol);
  }

  if (typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return null;
  const lines = map.__parsed ?? (map.__parsed = parseMappings(map.mappings));
  const segs = lines[line1 - 1];
  if (!segs || !segs.length) return null;
  let found = null;
  for (const s of segs) {
    if (s.genCol > col0) break;
    if (s.srcIdx !== null) found = s;
  }
  if (!found) return null;
  const src = map.sources[found.srcIdx];
  if (src == null) return null;
  const root = map.sourceRoot ? `${String(map.sourceRoot).replace(/\/$/, '')}/` : '';
  return { source: `${root}${src}`, line: found.srcLine + 1, column: found.srcCol + 1 };
}

/**
 * 7C（A3）: originalPositionFor と**同じ規則**で元の位置へ戻し、そのとき使った（最も内側の）区画の
 * 元のソースの内容（`sourcesContent` の該当の要素）も返す。無ければ sourceContent は null（一致とは扱わない側の判断は呼び出し側）。
 * 既存の originalPositionFor の戻り値・振る舞いは変えない（PoC の照合器が共有しているため、別の関数にした）。
 * @returns {{source:string, line:number, column:number, sourceContent:string|null, section:number[]}|null}
 */
export function originalPositionDetail(map, line1, col0) {
  if (!map || typeof map !== 'object') return null;
  if (Array.isArray(map.sections)) {
    let pick = null;
    let idx = -1;
    /* originalPositionFor と同じ「offset が位置以下の最後の区画（並びの途中で超えたら打ち切る）」 */
    for (let i = 0; i < map.sections.length; i++) {
      const o = map.sections[i].offset ?? { line: 0, column: 0 };
      if (o.line < line1 - 1 || (o.line === line1 - 1 && o.column <= col0)) { pick = map.sections[i]; idx = i; } else break;
    }
    if (!pick || !pick.map) return null;
    const o = pick.offset ?? { line: 0, column: 0 };
    const innerLine = line1 - o.line;
    const innerCol = o.line === line1 - 1 ? col0 - o.column : col0;
    const r = originalPositionDetail(pick.map, innerLine, innerCol);
    return r ? { ...r, section: [idx, ...r.section] } : null;
  }
  if (typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return null;
  const lines = map.__parsed ?? (map.__parsed = parseMappings(map.mappings));
  const segs = lines[line1 - 1];
  if (!segs || !segs.length) return null;
  let found = null;
  for (const s of segs) {
    if (s.genCol > col0) break;
    if (s.srcIdx !== null) found = s;
  }
  if (!found) return null;
  const src = map.sources[found.srcIdx];
  if (src == null) return null;
  const root = map.sourceRoot ? `${String(map.sourceRoot).replace(/\/$/, '')}/` : '';
  const sc = Array.isArray(map.sourcesContent) ? map.sourcesContent[found.srcIdx] : undefined;
  return {
    source: `${root}${src}`, line: found.srcLine + 1, column: found.srcCol + 1,
    sourceContent: typeof sc === 'string' ? sc : null, section: [],
  };
}
