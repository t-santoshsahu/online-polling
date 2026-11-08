create or replace function public.admin_create_poll_with_options(
  p_title text,
  p_description text,
  p_poll_type text,
  p_restriction text,
  p_deadline timestamptz,
  p_options jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_profile public.users%rowtype;
  new_poll_id uuid;
  option_data jsonb;
  option_text text;
  image_url text;
  option_order integer := 0;
begin
  select * into admin_profile from public.users
  where auth_user_id = auth.uid() and role = 'admin'
  limit 1;

  if admin_profile.id is null then
    raise exception 'Admin access required';
  end if;
  if nullif(trim(p_title), '') is null then
    raise exception 'Poll title is required';
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
  if p_deadline <= now() then
    raise exception 'Poll deadline must be in the future';
  end if;
  if jsonb_typeof(p_options) is distinct from 'array' then
    raise exception 'Poll options must be a JSON array';
  end if;
  if jsonb_array_length(p_options) < 2 then
    raise exception 'Poll needs at least two options';
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

  for option_data in select value from jsonb_array_elements(p_options)
  loop
    option_text := nullif(trim(option_data->>'option_text'), '');
    image_url := nullif(trim(option_data->>'image_url'), '');

    if option_text is null and image_url is null then
      raise exception 'Each option needs text, an image URL, or both';
    end if;
    if image_url is not null and image_url !~* '^https?://' then
      raise exception 'Image URLs must use HTTP or HTTPS';
    end if;

    option_order := option_order + 1;
    insert into public.poll_options (poll_id, option_text, image_url, display_order)
    values (new_poll_id, option_text, image_url, option_order);
  end loop;

  return new_poll_id;
end;
$$;

revoke all on function public.admin_create_poll_with_options(text, text, text, text, timestamptz, jsonb) from public;
grant execute on function public.admin_create_poll_with_options(text, text, text, text, timestamptz, jsonb) to authenticated;

drop function public.get_poll_results(uuid);

create function public.get_poll_results(p_poll_id uuid)
returns table (
  option_id uuid,
  option_text text,
  image_url text,
  display_order integer,
  single_votes bigint,
  borda_score bigint,
  total_ballots bigint
)
language sql
security definer
set search_path = public
as $$
  with selected_poll as (
    select id, poll_type
    from public.polls
    where id = p_poll_id and is_deleted = false
  ), option_count as (
    select count(*)::integer as amount
    from public.poll_options
    where poll_id = p_poll_id
  ), ballot_count as (
    select count(*)::bigint as amount
    from public.votes
    where poll_id = p_poll_id
  )
  select
    option_row.id,
    option_row.option_text,
    option_row.image_url,
    option_row.display_order,
    count(entry.option_id) filter (where selected_poll.poll_type = 'single_choice'),
    coalesce(sum(
      case
        when selected_poll.poll_type = 'ranked_choice'
          then option_count.amount - entry.rank_position
        else 0
      end
    ), 0)::bigint,
    ballot_count.amount
  from selected_poll
  join public.poll_options option_row on option_row.poll_id = selected_poll.id
  cross join option_count
  cross join ballot_count
  left join public.ballot_entries entry
    on entry.poll_id = selected_poll.id and entry.option_id = option_row.id
  group by
    option_row.id,
    option_row.option_text,
    option_row.image_url,
    option_row.display_order,
    selected_poll.poll_type,
    option_count.amount,
    ballot_count.amount;
$$;

revoke all on function public.get_poll_results(uuid) from public;
grant execute on function public.get_poll_results(uuid) to authenticated;