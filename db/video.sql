create table video (
  id uuid primary key default gen_random_uuid(),
  provider_name text,
  video_id text,
  import_link text not null unique,
  title text not null,
  description text,
  post_type text not null,
  upload_time timestamptz,
  import_time timestamptz not null default now(),
  last_sync timestamptz,
  likes integer not null default 0,
  view_count integer not null default 0,
  unique (provider_name, video_id)
);
