create or replace function public.link_my_user_profile()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  verified_email text := lower(trim(coalesce(auth.jwt()->>'email', '')));
  profile_id uuid;
  matching_profiles integer;
  linked_role text;
begin
  if auth.uid() is null or verified_email = '' then
    raise exception 'Authenticated email required';
  end if;

  select count(*) into matching_profiles
  from public.users
  where lower(trim(email)) = verified_email;

  if matching_profiles = 0 then
    raise exception 'No resident profile matches the verified email %', verified_email;
  end if;
  if matching_profiles > 1 then
    raise exception 'Multiple resident profiles match the verified email %', verified_email;
  end if;

  select id into profile_id
  from public.users
  where lower(trim(email)) = verified_email
  for update;

  update public.users
  set auth_user_id = auth.uid()
  where id = profile_id
  returning role into linked_role;

  if linked_role is null or linked_role not in ('admin', 'regular') then
    raise exception 'Resident profile has an invalid role';
  end if;

  return linked_role;
end;
$$;

revoke all on function public.link_my_user_profile() from public;
grant execute on function public.link_my_user_profile() to authenticated;