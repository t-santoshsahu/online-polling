alter table public.polls
  add column if not exists entry_points integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.polls'::regclass
      and conname = 'polls_entry_points_nonnegative'
  ) then
    alter table public.polls
      add constraint polls_entry_points_nonnegative check (entry_points >= 0);
  end if;

  if (
    select count(*) from public.polls
    where title in ('Rangoli - Residents Choice', 'Door Decor - Residents Choice')
      and not is_deleted
  ) <> 2 then
    raise exception 'Expected both current Residents Choice polls';
  end if;
end;
$$;

update public.polls
set entry_points = 10
where title in ('Rangoli - Residents Choice', 'Door Decor - Residents Choice')
  and not is_deleted;