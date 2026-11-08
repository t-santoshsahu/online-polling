alter function public.submit_poll_ballot(uuid, uuid[], integer[]) rename to submit_poll_ballot_unlocked;
revoke all on function public.submit_poll_ballot_unlocked(uuid, uuid[], integer[]) from public, anon, authenticated;

create function public.submit_poll_ballot(p_poll_id uuid, p_option_ids uuid[], p_rank_positions integer[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.polls where id = p_poll_id for update;
  perform public.submit_poll_ballot_unlocked(p_poll_id, p_option_ids, p_rank_positions);
end;
$$;

revoke all on function public.submit_poll_ballot(uuid, uuid[], integer[]) from public, anon;
grant execute on function public.submit_poll_ballot(uuid, uuid[], integer[]) to authenticated;

create function public.admin_get_poll_for_edit(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not coalesce(public.is_society_admin(), false) then raise exception 'Admin access required'; end if;
  select to_jsonb(p) || jsonb_build_object(
    'options', coalesce((select jsonb_agg(to_jsonb(o) order by o.display_order) from public.poll_options o where o.poll_id = p.id), '[]'::jsonb),
    'flat_numbers', coalesce((select jsonb_agg(target.flat_number order by target.flat_number) from public.poll_target_flats target where target.poll_id = p.id), '[]'::jsonb),
    'has_votes', exists(select 1 from public.votes v where v.poll_id = p.id)
  ) into result from public.polls p where p.id = p_poll_id and not p.is_deleted;
  if result is null then raise exception 'Poll not found'; end if;
  return result;
end;
$$;

revoke all on function public.admin_get_poll_for_edit(uuid) from public, anon;
grant execute on function public.admin_get_poll_for_edit(uuid) to authenticated;

create function public.admin_update_poll(
  p_poll_id uuid, p_title text, p_description text, p_poll_type text,
  p_restriction text, p_deadline timestamptz, p_options jsonb,
  p_flat_scope text, p_flat_numbers text[], p_result_visibility text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_poll public.polls%rowtype;
  option_data jsonb;
  option_id uuid;
  option_ids uuid[] := '{}';
  urls text[];
  updated_option_text text;
  option_order integer := 0;
  has_votes boolean;
  flat_number text;
begin
  if not coalesce(public.is_society_admin(), false) then raise exception 'Admin access required'; end if;
  select * into current_poll from public.polls where id = p_poll_id and not is_deleted for update;
  if not found then raise exception 'Poll not found'; end if;
  select exists(select 1 from public.votes where poll_id = p_poll_id) into has_votes;
  if nullif(trim(p_title), '') is null then raise exception 'Poll title is required'; end if;
  if p_poll_type is null or p_poll_type not in ('single_choice', 'ranked_choice') then raise exception 'Invalid poll type'; end if;
  if p_restriction is null or p_restriction not in ('one_per_flat', 'owners_only_one_per_flat', 'residents_only_one_per_flat', 'all_owners', 'all_residents', 'all_owners_and_residents') then raise exception 'Invalid voter restriction'; end if;
  if p_result_visibility is null or p_result_visibility not in ('always', 'after_vote', 'after_close') then raise exception 'Invalid result visibility'; end if;
  if p_deadline is null then raise exception 'Poll deadline is required'; end if;
  if p_flat_scope is null or p_flat_scope not in ('all', 'selected') then raise exception 'Invalid flat scope'; end if;
  if p_flat_scope = 'selected' and coalesce(cardinality(p_flat_numbers), 0) = 0 then raise exception 'Select at least one flat'; end if;
  if p_flat_scope = 'all' and coalesce(cardinality(p_flat_numbers), 0) > 0 then raise exception 'Do not select flats when scope is all'; end if;
  if p_flat_scope = 'selected' and exists (
    select 1 from unnest(p_flat_numbers) as requested(number)
    where nullif(btrim(requested.number), '') is null
       or not exists (select 1 from public.users u where btrim(u.flat_number) = btrim(requested.number))
  ) then raise exception 'Selected flats must match registered flat numbers'; end if;
  if jsonb_typeof(p_options) is distinct from 'array' or jsonb_array_length(p_options) < 2 then raise exception 'Poll needs at least two options'; end if;
  if p_poll_type = 'ranked_choice' and jsonb_array_length(p_options) < 3 then raise exception 'Ranked-choice polls need at least three options'; end if;
  if has_votes and (p_poll_type is distinct from current_poll.poll_type::text or p_restriction is distinct from current_poll.restriction::text) then
    raise exception 'Voting method and voter restriction cannot change after votes have been cast';
  end if;

  for option_data in select value from jsonb_array_elements(p_options)
  loop
    option_order := option_order + 1;
    option_id := nullif(option_data->>'id', '')::uuid;
    if option_id is not null then
      if option_id = any(option_ids) or not exists (select 1 from public.poll_options where id = option_id and poll_id = p_poll_id) then
        raise exception 'Invalid or duplicate poll option';
      end if;
      option_ids := array_append(option_ids, option_id);
    elsif has_votes then
      raise exception 'Options cannot be added or removed after votes have been cast';
    end if;
    if jsonb_typeof(option_data->'image_urls') is distinct from 'array' or jsonb_array_length(option_data->'image_urls') > 20 then raise exception 'An option can have at most 20 image URLs'; end if;
    if exists (select 1 from jsonb_array_elements(option_data->'image_urls') as image(value) where jsonb_typeof(image.value) <> 'string' or trim(image.value #>> '{}') !~* '^https?://') then raise exception 'Image URLs must use HTTP or HTTPS'; end if;
    select coalesce(array_agg(trim(image.value) order by image.position), '{}') into urls
    from jsonb_array_elements_text(option_data->'image_urls') with ordinality as image(value, position);
    updated_option_text := nullif(trim(option_data->>'option_text'), '');
    if updated_option_text is null and cardinality(urls) = 0 then raise exception 'Each option needs text, an image URL, or both'; end if;
    if option_id is null then
      insert into public.poll_options(poll_id, option_text, image_url, image_urls, display_order)
      values (p_poll_id, updated_option_text, urls[1], urls, option_order) returning id into option_id;
      option_ids := array_append(option_ids, option_id);
    else
      update public.poll_options set option_text = updated_option_text, image_url = urls[1], image_urls = urls, display_order = option_order where id = option_id and poll_id = p_poll_id;
    end if;
  end loop;
  if has_votes and exists (select 1 from public.poll_options where poll_id = p_poll_id and not (id = any(option_ids))) then
    raise exception 'Options cannot be added or removed after votes have been cast';
  end if;
  delete from public.poll_options where poll_id = p_poll_id and not (id = any(option_ids));
  update public.polls set title = trim(p_title), description = nullif(trim(p_description), ''),
    poll_type = p_poll_type::public.poll_type, restriction = p_restriction::public.voting_restriction,
    deadline = p_deadline, flat_scope = p_flat_scope, result_visibility = p_result_visibility
  where id = p_poll_id;
  delete from public.poll_target_flats where poll_id = p_poll_id;
  if p_flat_scope = 'selected' then
    foreach flat_number in array p_flat_numbers loop
      insert into public.poll_target_flats(poll_id, flat_number) values (p_poll_id, btrim(flat_number)) on conflict do nothing;
    end loop;
  end if;
end;
$$;

create function public.admin_delete_poll(p_poll_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_society_admin(), false) then raise exception 'Admin access required'; end if;
  delete from public.polls where id = p_poll_id;
  if not found then raise exception 'Poll not found'; end if;
end;
$$;

revoke all on function public.admin_update_poll(uuid, text, text, text, text, timestamptz, jsonb, text, text[], text) from public, anon;
grant execute on function public.admin_update_poll(uuid, text, text, text, text, timestamptz, jsonb, text, text[], text) to authenticated;
revoke all on function public.admin_delete_poll(uuid) from public, anon;
grant execute on function public.admin_delete_poll(uuid) to authenticated;