-- ══════════════════════════════════════════════════════════
-- ResearchAI — Supabase Database Setup
-- Run this ONCE in Supabase → SQL Editor → New Query → Run
-- ══════════════════════════════════════════════════════════

-- 1. Saved Papers
create table if not exists saved_papers (
  id          uuid default gen_random_uuid() primary key,
  session_id  text not null,
  title       text not null,
  source      text,
  score       text,
  saved_at    timestamptz default now()
);

-- Force add 'score' in case the table was created earlier without it
ALTER TABLE saved_papers ADD COLUMN IF NOT EXISTS score text;
-- Reload Supabase Schema Cache
NOTIFY pgrst, 'reload schema';
create index if not exists idx_saved_session on saved_papers(session_id);

-- 2. Search History
create table if not exists search_history (
  id             uuid default gen_random_uuid() primary key,
  session_id     text not null,
  topic          text not null,
  domain         text,
  engine         text,
  result_snippet text,
  searched_at    timestamptz default now()
);
create index if not exists idx_history_session on search_history(session_id);

-- 3. News Cache (1-hour TTL enforced in backend)
create table if not exists news_cache (
  id         uuid default gen_random_uuid() primary key,
  cache_key  text unique not null,
  topic      text not null,
  articles   jsonb,
  digest     text,
  sentiment  jsonb,
  cached_at  timestamptz default now()
);
create index if not exists idx_news_cache_key on news_cache(cache_key);
create index if not exists idx_news_cached_at on news_cache(cached_at);

-- 4. Sentiment Results
create table if not exists sentiment_results (
  id             uuid default gen_random_uuid() primary key,
  session_id     text not null,
  topic          text not null,
  sentiment_data jsonb,
  article_count  integer,
  analyzed_at    timestamptz default now()
);
create index if not exists idx_sentiment_session on sentiment_results(session_id);

-- ── Row Level Security (optional but recommended) ──────────
-- Enable RLS (service key bypasses it on the backend, safe)
alter table saved_papers     enable row level security;
alter table search_history   enable row level security;
alter table news_cache       enable row level security;
alter table sentiment_results enable row level security;

-- Allow service role full access (backend uses service key)
create policy "service_all_saved"     on saved_papers     for all using (true);
create policy "service_all_history"   on search_history   for all using (true);
create policy "service_all_cache"     on news_cache       for all using (true);
create policy "service_all_sentiment" on sentiment_results for all using (true);

-- Done! ✅
select 'ResearchAI database ready ✅' as status;
