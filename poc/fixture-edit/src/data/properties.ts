/* 完全な合成データ（架空の番号・既存の都道府県名と電力会社の一般名詞のみ）。実在の案件ではない。 */
export interface Property { no: number; pref: string; utility: string; done: string }

export const PROPERTIES: Property[] = [
  { no: 900001, pref: '千葉県', utility: '東京電力', done: '2027年4月' },
  { no: 900002, pref: '茨城県', utility: '東京電力', done: '2026年10月' },
  { no: 900003, pref: '群馬県', utility: '東京電力', done: '2027年1月' },
  { no: 900004, pref: '栃木県', utility: '東京電力', done: '2026年12月' },
  { no: 900005, pref: '埼玉県', utility: '東京電力', done: '2027年7月' },
  { no: 900006, pref: '神奈川県', utility: '東京電力', done: '2027年3月' },
  { no: 900007, pref: '静岡県', utility: '中部電力', done: '2027年5月' },
  { no: 900008, pref: '長野県', utility: '中部電力', done: '2027年2月' },
  { no: 900009, pref: '新潟県', utility: '東北電力', done: '2026年11月' },
  { no: 900010, pref: '山梨県', utility: '東京電力', done: '2027年6月' },
];
