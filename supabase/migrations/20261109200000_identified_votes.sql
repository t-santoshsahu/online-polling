alter table public.polls
  add column response_privacy text not null default 'anonymous'
  check (response_privacy in ('anonymous', 'identified'));

alter table public.polls alter column response_privacy set default 'identified';

create function public.prevent_poll_privacy_change_after_vote()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.response_privacy is distinct from old.response_privacy
    and exists (select 1 from public.votes where poll_id = old.id) then
    raise exception 'Response privacy cannot change after votes have been cast';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_poll_privacy_change_after_vote() from public, anon, authenticated;
create trigger poll_privacy_locked_after_vote
before update of response_privacy on public.polls
for each row execute function public.prevent_poll_privacy_change_after_vote();

create function public.admin_create_poll_with_privacy(
  p_title text, p_description text, p_poll_type text, p_restriction text,
  p_deadline timestamptz, p_options jsonb, p_flat_scope text,
  p_flat_numbers text[], p_result_visibility text, p_response_privacy text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_poll_id uuid;
begin
  if p_response_privacy is null or p_response_privacy not in ('anonymous', 'identified') then
    raise exception 'Invalid response privacy';
  end if;
  new_poll_id := public.admin_create_scoped_poll_with_gallery(
    p_title, p_description, p_poll_type, p_restriction, p_deadline,
    p_options, p_flat_scope, p_flat_numbers, p_result_visibility
  );
  update public.polls set response_privacy = p_response_privacy where id = new_poll_id;
  return new_poll_id;
end;
$$;

revoke all on function public.admin_create_poll_with_privacy(text, text, text, text, timestamptz, jsonb, text, text[], text, text) from public, anon;
grant execute on function public.admin_create_poll_with_privacy(text, text, text, text, timestamptz, jsonb, text, text[], text, text) to authenticated;

create function public.admin_update_poll_with_privacy(
  p_poll_id uuid, p_title text, p_description text, p_poll_type text,
  p_restriction text, p_deadline timestamptz, p_options jsonb,
  p_flat_scope text, p_flat_numbers text[], p_result_visibility text,
  p_response_privacy text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_society_admin(), false) then raise exception 'Admin access required'; end if;
  if p_response_privacy is null or p_response_privacy not in ('anonymous', 'identified') then
    raise exception 'Invalid response privacy';
  end if;
  perform 1 from public.polls where id = p_poll_id and not is_deleted for update;
  if not found then raise exception 'Poll not found'; end if;
  if exists (select 1 from public.votes where poll_id = p_poll_id)
    and exists (select 1 from public.polls where id = p_poll_id and response_privacy is distinct from p_response_privacy) then
    raise exception 'Response privacy cannot change after votes have been cast';
  end if;
  perform public.admin_update_poll(p_poll_id, p_title, p_description, p_poll_type,
    p_restriction, p_deadline, p_options, p_flat_scope, p_flat_numbers, p_result_visibility);
  update public.polls set response_privacy = p_response_privacy where id = p_poll_id;
end;
$$;

revoke all on function public.admin_update_poll_with_privacy(uuid, text, text, text, text, timestamptz, jsonb, text, text[], text, text) from public, anon;
grant execute on function public.admin_update_poll_with_privacy(uuid, text, text, text, text, timestamptz, jsonb, text, text[], text, text) to authenticated;

alter table public.ballot_entries
  add column vote_id uuid references public.votes(id) on delete cascade;

create index ballot_entries_vote_id_idx on public.ballot_entries (vote_id);

create or replace function public.submit_poll_ballot_unlocked(
  p_poll_id uuid,
  p_option_ids uuid[],
  p_rank_positions integer[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  voter public.users%rowtype;
  poll public.polls%rowtype;
  status record;
  option_count integer;
  vote_resident_type public.resident_type;
  lock_subject text;
  new_vote_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into voter from public.users where auth_user_id = auth.uid() limit 1;
  select * into poll from public.polls where id = p_poll_id and is_deleted = false limit 1;

  if voter.id is null then
    raise exception 'Registered voter profile not found';
  end if;
  if poll.id is null or poll.deadline <= now() then
    raise exception 'Poll is unavailable or has closed';
  end if;

  lock_subject := case
    when poll.restriction = 'all_owners_and_residents' then 'user:' || voter.id::text
    else 'flat:' || voter.flat_number
  end;
  perform pg_advisory_xact_lock(hashtextextended(p_poll_id::text || ':' || lock_subject, 0));

  select * into status from public._poll_voter_status(p_poll_id, auth.uid());
  if not coalesce(status.eligible, false) then
    raise exception 'You are not eligible to vote in this poll';
  end if;
  if coalesce(status.has_voted, true) then
    raise exception 'A vote has already been recorded for this voter or flat';
  end if;

  if coalesce(array_length(p_option_ids, 1), 0) = 0
     or array_length(p_option_ids, 1) <> array_length(p_rank_positions, 1) then
    raise exception 'A valid vote is required';
  end if;

  if poll.poll_type = 'single_choice' and array_length(p_option_ids, 1) <> 1 then
    raise exception 'Single-choice polls accept exactly one option';
  end if;
  if poll.poll_type = 'single_choice' and p_rank_positions[1] <> 1 then
    raise exception 'Single-choice vote rank must be one';
  end if;
  if poll.poll_type = 'ranked_choice' and array_length(p_option_ids, 1) <> 3 then
    raise exception 'Ranked-choice votes must select exactly three options';
  end if;

  if exists (
    select 1 from unnest(p_option_ids) option_id
    group by option_id having count(*) > 1
  ) or exists (
    select 1 from unnest(p_rank_positions) rank_position
    group by rank_position having count(*) > 1
  ) or exists (
    select 1 from unnest(p_rank_positions) rank_position
    where rank_position < 1
  ) then
    raise exception 'Vote options and ranks must be unique and valid';
  end if;

  select count(*) into option_count
  from public.poll_options
  where poll_id = p_poll_id and id = any(p_option_ids);
  if option_count <> array_length(p_option_ids, 1) then
    raise exception 'Vote contains an option outside this poll';
  end if;

  if poll.poll_type = 'ranked_choice' and (
    (select min(rank_position) from unnest(p_rank_positions) as ranks(rank_position)) <> 1
    or (select max(rank_position) from unnest(p_rank_positions) as ranks(rank_position)) <> 3
  ) then
    raise exception 'Ranked positions must be exactly 1, 2, and 3';
  end if;

  vote_resident_type := case
    when poll.restriction in ('owners_only_one_per_flat', 'all_owners') then 'owner'::public.resident_type
    when poll.restriction in ('residents_only_one_per_flat', 'all_residents') then 'resident'::public.resident_type
    else null
  end;

  insert into public.votes (poll_id, flat_number, resident_type, voter_user_id, voted_at)
  values (p_poll_id, voter.flat_number, vote_resident_type, voter.id, now())
  returning id into new_vote_id;

  insert into public.ballot_entries (poll_id, option_id, rank_position, vote_id)
  select p_poll_id, ballot.option_id, ballot.rank_position,
    case when poll.response_privacy = 'identified' then new_vote_id else null end
  from unnest(p_option_ids, p_rank_positions) as ballot(option_id, rank_position);
end;
$$;

revoke all on function public.submit_poll_ballot_unlocked(uuid, uuid[], integer[]) from public, anon, authenticated;