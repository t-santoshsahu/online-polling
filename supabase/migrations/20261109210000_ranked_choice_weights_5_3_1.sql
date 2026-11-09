create or replace function public.get_poll_results(p_poll_id uuid)
returns table (
  option_id uuid,
  option_text text,
  image_url text,
  display_order integer,
  single_votes bigint,
  borda_score bigint,
  total_ballots bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_view_poll_results(p_poll_id) then
    raise exception 'Poll results are not available yet';
  end if;

  return query
  with selected_poll as (
    select id, poll_type from public.polls
    where id = p_poll_id and is_deleted = false
  ), ballot_count as (
    select count(*)::bigint as amount from public.votes where poll_id = p_poll_id
  )
  select
    o.id,
    o.option_text,
    o.image_url,
    o.display_order,
    count(e.option_id) filter (where p.poll_type = 'single_choice'),
    coalesce(sum(case
      when p.poll_type = 'ranked_choice' and e.rank_position = 1 then 5
      when p.poll_type = 'ranked_choice' and e.rank_position = 2 then 3
      when p.poll_type = 'ranked_choice' and e.rank_position = 3 then 1
      else 0
    end), 0)::bigint,
    bc.amount
  from selected_poll p
  join public.poll_options o on o.poll_id = p.id
  cross join ballot_count bc
  left join public.ballot_entries e on e.poll_id = p.id and e.option_id = o.id
  group by o.id, o.option_text, o.image_url, o.display_order, p.poll_type, bc.amount;
end;
$$;

revoke all on function public.get_poll_results(uuid) from public, anon;
grant execute on function public.get_poll_results(uuid) to authenticated;