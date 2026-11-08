create or replace function public.admin_create_poll(
  p_title text,
  p_description text,
  p_poll_type text,
  p_restriction text,
  p_deadline timestamptz,
  p_options text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_profile public.users%rowtype;
  new_poll_id uuid;
  option_text text;
  option_order integer := 0;
begin
  select * into admin_profile from public.users
  where auth_user_id = auth.uid() and role = 'admin'
  limit 1;

  if admin_profile.id is null then
    raise exception 'Admin access required';
  end if;
  if p_poll_type not in ('single_choice', 'ranked_choice') then
    raise exception 'Invalid poll type';
  end if;
  if p_restriction not in (
    'one_per_flat', 'owners_only_one_per_flat', 'residents_only_one_per_flat',
    'all_owners', 'all_residents', 'all_owners_and_residents'
  ) then
    raise exception 'Invalid voter restriction';
  end if;
  if p_deadline <= now() or cardinality(p_options) < 2 then
    raise exception 'Poll needs a future deadline and at least two options';
  end if;

  insert into public.polls (title, description, poll_type, restriction, deadline, is_deleted, created_by)
  values (
    trim(p_title),
    nullif(trim(p_description), ''),
    p_poll_type::public.poll_type,
    p_restriction::public.voting_restriction,
    p_deadline,
    false,
    admin_profile.id
  )
  returning id into new_poll_id;

  foreach option_text in array p_options
  loop
    option_order := option_order + 1;
    if trim(option_text) <> '' then
      insert into public.poll_options (poll_id, option_text, display_order)
      values (new_poll_id, trim(option_text), option_order);
    end if;
  end loop;

  if (select count(*) from public.poll_options where poll_id = new_poll_id) < 2 then
    raise exception 'Poll needs at least two non-empty options';
  end if;

  return new_poll_id;
end;
$$;