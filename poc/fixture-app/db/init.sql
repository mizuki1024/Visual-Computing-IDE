-- =============================================================================
-- PoC-01 検証用の完全な合成データ。
--   * 実案件のスキーマを写したものではない
--   * 氏名・住所・連絡先・決済情報・識別可能な個人情報を一切含まない
--   * 地名は架空（実在の自治体名を使わない）。それ以外は連番である
-- =============================================================================
drop schema if exists poc cascade;
create schema poc;

create table poc.regions (
  id         serial primary key,
  code       text not null unique,
  name       text not null
);

create table poc.listings (
  id             serial primary key,
  code           text not null unique,
  region         text not null,
  plan           text not null,
  scale          text not null,
  available_from date not null,
  created_at     timestamptz not null default now()
);

create table poc.listing_views (
  id         serial primary key,
  listing_id integer not null references poc.listings(id),
  viewed_on  date not null,
  views      integer not null
);

insert into poc.regions (code, name) values
  ('RG-01', 'アオバ台'), ('RG-02', 'シラカワ野'),
  ('RG-03', 'ミナト浜'),  ('RG-04', 'ヒガシ丘');

insert into poc.listings (code, region, plan, scale, available_from)
select
  'No.' || (900000 + g),
  (array['アオバ台','シラカワ野','ミナト浜','ヒガシ丘'])[1 + (g % 4)],
  (array['標準プラン','拡張プラン'])[1 + (g % 2)],
  (array['小規模','中規模','大規模'])[1 + (g % 3)],
  date '2026-04-01' + (g * 30)
from generate_series(1, 12) as g;

insert into poc.listing_views (listing_id, viewed_on, views)
select l.id, date '2026-10-01' + (n - 1), n * 7
from poc.listings l, generate_series(1, 3) as n;

-- 行数の推定値を使えるようにする（情報スキーマからの読み取りの題材）
analyze poc.listings;
analyze poc.regions;
analyze poc.listing_views;
