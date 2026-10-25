-- Zaptats — Piece 1: tattoo requests, photos, and artist-only access
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.

-- ---------------------------------------------------------------
-- 1. Who is the artist? (only people listed here can see requests)
-- ---------------------------------------------------------------
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- No policies on purpose: nobody can read or edit this table from the website.
-- You add yourself once from the SQL Editor (see the end of this file).

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------
-- 2. Tattoo requests
-- ---------------------------------------------------------------
create type public.request_status as enum ('new', 'replied', 'quoted', 'declined', 'archived');

create table if not exists public.tattoo_requests (
  id            uuid primary key,                       -- created by the form so photos can be linked
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- who
  name          text not null check (char_length(name) between 1 and 100),
  phone         text not null check (char_length(phone) between 7 and 30),
  email         text not null check (char_length(email) between 5 and 200 and email like '%_@_%._%'),

  -- the tattoo
  placement     text not null check (char_length(placement) between 1 and 200),
  size          text not null check (char_length(size) between 1 and 200),
  has_picture   boolean not null default true,
  description   text check (description is null or char_length(description) <= 2000),
  style         text check (style is null or char_length(style) <= 100),

  -- age / minors
  is_adult      boolean not null,
  minor_age     smallint check (minor_age is null or minor_age between 1 and 17),
  parent_name   text check (parent_name is null or char_length(parent_name) <= 100),
  parent_phone  text check (parent_phone is null or char_length(parent_phone) <= 30),

  -- artist-only fields (the public form can never set these)
  status        public.request_status not null default 'new',
  artist_notes  text,

  -- a minor request must include the age and a parent contact
  constraint minor_needs_parent check (
    is_adult
    or (minor_age is not null and parent_name is not null and parent_phone is not null)
  ),
  -- no picture means we need a description
  constraint no_picture_needs_description check (
    has_picture or (description is not null and char_length(description) > 0)
  )
);

create index if not exists tattoo_requests_status_created_idx
  on public.tattoo_requests (status, created_at desc);

alter table public.tattoo_requests enable row level security;

-- Anyone (a visitor on the website) may SUBMIT a request, but only as a brand-new
-- request: they cannot set the status or add private notes.
create policy "visitors can submit new requests"
  on public.tattoo_requests
  for insert
  to anon, authenticated
  with check (status = 'new' and artist_notes is null);

-- Only the artist can read, update, or delete requests.
create policy "artist can read requests"
  on public.tattoo_requests for select to authenticated using (public.is_admin());

create policy "artist can update requests"
  on public.tattoo_requests for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "artist can delete requests"
  on public.tattoo_requests for delete to authenticated using (public.is_admin());

-- keep updated_at honest
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tattoo_requests_touch
  before update on public.tattoo_requests
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------
-- 3. Reference photos (a list of files belonging to each request)
-- ---------------------------------------------------------------
create table if not exists public.request_images (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.tattoo_requests (id) on delete cascade,
  storage_path text not null unique,
  created_at   timestamptz not null default now()
);
create index if not exists request_images_request_idx on public.request_images (request_id);

alter table public.request_images enable row level security;

create policy "visitors can attach photos"
  on public.request_images for insert to anon, authenticated
  with check (true);

create policy "artist can read photos list"
  on public.request_images for select to authenticated using (public.is_admin());

create policy "artist can delete photos list"
  on public.request_images for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------
-- 4. Private photo storage
--    Private bucket, 5 MB per file, real image types only.
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'request-images', 'request-images', false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "visitors can upload request photos"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'request-images');

create policy "artist can view request photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'request-images' and public.is_admin());

create policy "artist can delete request photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'request-images' and public.is_admin());

-- ---------------------------------------------------------------
-- 5. AFTER you create your own login (Authentication -> Users -> Add user),
--    run this ONE line separately, with YOUR email in place of the example:
--
--    insert into public.admins (user_id)
--    select id from auth.users where email = 'you@example.com';
-- ---------------------------------------------------------------
