-- Budget & Patrimoine — à coller une fois dans Supabase : SQL Editor → New query → Run.
-- Une seule ligne par utilisateur : le coffre chiffré dans le navigateur (le serveur ne peut pas le lire).

create table if not exists public.vault (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  salt       text not null,               -- sel PBKDF2 (public, sert à dériver la clé de la phrase)
  iterations integer not null,
  iv         text not null,               -- vecteur d'initialisation AES-GCM
  data       text not null check (length(data) < 20000000), -- données chiffrées (base64)
  rev        bigint not null default 1,   -- version : évite qu'un appareil écrase l'autre
  device     text,
  updated_at timestamptz not null default now()
);

-- Sécurité au niveau des lignes : chacun ne voit et ne modifie que SA ligne
alter table public.vault enable row level security;

drop policy if exists "vault: lecture" on public.vault;
drop policy if exists "vault: creation" on public.vault;
drop policy if exists "vault: modification" on public.vault;
drop policy if exists "vault: suppression" on public.vault;
create policy "vault: lecture"      on public.vault for select to authenticated using (user_id = (select auth.uid()));
create policy "vault: creation"     on public.vault for insert to authenticated with check (user_id = (select auth.uid()));
create policy "vault: modification" on public.vault for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "vault: suppression"  on public.vault for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.vault from anon;
grant select, insert, update, delete on public.vault to authenticated;

-- Réveil : appelé tous les 3 jours par la GitHub Action keepalive (le projet gratuit
-- se met en pause après une semaine sans activité). Ne lit aucune donnée.
create or replace function public.ping() returns text language sql stable as $$ select 'ok'::text $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
