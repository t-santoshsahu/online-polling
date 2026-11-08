---
name: online-polling-supabase
description: 'Use when setting up, building, debugging, or deploying the Housing Society OTP Voting app; includes the project Node/npm path, Supabase CLI connection, migrations, RLS, OTP/profile linking, poll visibility, and voting workflows.'
---

# Online Polling Supabase Workflow

Use this skill for work in this repository. It records verified workspace and remote-project setup so future agents can start with the actual environment rather than rediscovering it.

## Verified Project Setup

- Workspace: `/Users/santosh/test/online-polling`
- Node/npm binaries: `/Users/santosh/.nvm/versions/node/v26.13.0/bin`
- The normal shell did not have `node` or `npm` on `PATH`; prepend the verified path for commands:

  ```sh
  export PATH="/Users/santosh/.nvm/versions/node/v26.13.0/bin:$PATH"
  npm run build
  npm run lint
  ```

- Use `npx --yes supabase ...`; the `supabase` binary was not available directly on `PATH`.
- Supabase CLI version verified: `3.0.0`.
- Frontend environment variable names: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. `.env` contains values; never read values into chat, print them, commit them, or put them in logs. The browser must use only the public anon/publishable key, never a service-role/secret key.
- Vite runs with `npm run dev -- --host 127.0.0.1`; port `5173` may already be occupied, in which case Vite selects another port.

## Supabase CLI Connection

The authenticated CLI was linked to the production project with ref `cqzizhdvzdwgotkaktki` (project name `t-santoshsahu's Project`). These identifiers are not credentials. The workspace did not have a `supabase/config.toml` at initial setup; CLI linking succeeded and `--remote` commands worked afterward.

Check CLI authentication and linkage without exposing tokens:

```sh
npx --yes supabase projects list
npx --yes supabase migration list --remote
```

If the CLI reports `AccessTokenRequiredError`, run `npx supabase login` in the user's terminal. The user must enter the access token directly into the terminal; never request or relay the token through chat. If there is no linked project, link the known project ref:

```sh
npx --yes supabase link --project-ref cqzizhdvzdwgotkaktki
```

For remote schema inspection, favor a read-only query:

```sh
npx --yes supabase db query --remote --read-only "select ..."
```

Never query or print secret values. For table access issues, inspect `pg_policies`, `information_schema.role_table_grants`, and effective privileges with `has_table_privilege`. For enum errors, inspect `information_schema.columns` and labels in `pg_type`/`pg_enum` before adding casts.

## Migration Workflow

Before a remote write, inspect local and remote history and preview pending migrations:

```sh
npx --yes supabase migration list --remote
npx --yes supabase db push --dry-run --remote
```

Apply only after the user has authorized the production change:

```sh
npx --yes supabase db push --remote
```

Use `--yes` only when the user has already explicitly approved applying the reviewed production migrations. The CLI may prompt for database credentials; secrets must be entered directly in the terminal, never sent through chat.

As of 2026-11-08, remote migration history was verified to include:

- `20261107000000_poll_workflows.sql`
- `20261108000000_reconcile_auth_user_profiles.sql`
- `20261108100000_fix_admin_create_poll_enum_casts.sql`
- `20261108110000_poll_read_policies.sql`
- `20261108120000_multi_resident_memberships_and_person_ballots.sql`
- `20261108130000_category_aware_poll_visibility.sql`
- `20261108140000_poll_option_images.sql`
- `20261108150000_ranked_top_three.sql`
- `20261108160000_selected_flat_poll_scope.sql`
- `20261108170000_poll_result_visibility.sql`
- `20261108150000_ranked_top_three.sql`

## Application Architecture Notes

- The React entry point is `src/main.tsx`; the root UI and OTP/profile routing are in `src/App.tsx`.
- `src/supabaseClient.js` owns the Supabase client, sourced from Vite environment variables.
- `src/contexts/AuthContext.tsx` provides email OTP request/verification, local sign-out, and a client-side 24-hour session cap.
- `link_my_user_profile()` matches the signed-in, verified Auth email to one `public.users` row and reconciles `auth_user_id`; its return role must be `admin` or `regular`.
- Authorization roles are stored in the `public.users.role` enum `user_role` (`admin`/`regular`). Resident categories live in `public.user_resident_types`; a profile may have both `owner` and `resident` memberships. The legacy `users.resident_type` column remains nullable for compatibility and is not authoritative.
- Poll columns use PostgreSQL enums `public.poll_type` and `public.voting_restriction`. RPC parameters arrive as text and must be explicitly cast when inserted into enum columns.
- `AdminDashboard.jsx` creates polls through `admin_create_scoped_poll_with_options` using structured text/image options, flat scope, and `result_visibility` (`always`, `after_vote`, `after_close`). Option text and image URL are independently optional, but each option must have at least one. Public Google Drive share links are converted to thumbnail URLs; Drive files must allow anyone with the link to view.
- Admin CSV accepts `resident_types` separated by semicolons (for example `owner;resident`); the legacy single `resident_type` column remains accepted. Regular users need at least one resident category; admins may have none.
- `VotingDashboard.jsx` filters to non-deleted polls with future deadlines, fetches options, calls `get_my_poll_vote_status`, and submits ballots through `submit_poll_ballot`. Ranked polls require selecting exactly three options and assigning unique positions 1, 2, and 3; the RPC enforces this contract.
- `PollResults.jsx` fetches aggregate-only results and listens on private Realtime Broadcast topics; it must not expose individual anonymous ballot entries. Ranked Borda scoring is top-three only: 3, 2, 1 points; unselected options score zero.
- Poll result visibility is enforced by `can_view_poll_results` and the guarded `get_poll_results` RPC. `get_my_poll_result_status` powers UI messages; `after_vote` means the current user profile submitted a ballot, while `after_close` releases results when the deadline has passed. Admins can view results at all times.
- `ImageLightbox.jsx` provides the shared accessible full-screen option image viewer used by admin previews, ballots, and results. It closes on Escape, close button, or backdrop click.
- RLS is enabled. Authenticated `polls` and `poll_options` SELECT policies use `public.can_view_poll(...)`: linked admins can see all polls; residents can see only open, non-deleted polls matching their `user_resident_types` memberships.
- `votes` stores `voter_user_id` plus flat/category snapshots for duplicate prevention; `ballot_entries` stores choices separately. `all_owners_and_residents` allows one ballot per user profile, not per flat; a dual-category user still gets one ballot. Other existing restrictions retain their flat/category lock behavior. Never query or expose identity through ballot result UI.

## Troubleshooting Checks

- If a successful OTP ends at `Account not registered`, inspect the full profile-link RPC error and verify the profile email matches the verified Auth email. Confirm `20261108000000_reconcile_auth_user_profiles.sql` is remote-applied.
- If profile linking returns `null`, compare remote migration history and the live `pg_get_functiondef('public.link_my_user_profile()'::regprocedure)`. The applied replacement raises on missing/invalid role instead of silently returning null.
- If a poll is in the database but absent from a dashboard, first check `is_deleted`, `deadline`, and database `now()`. Then check category membership and `public.can_view_poll(...)` RLS policies for both `polls` and `poll_options`.
- If results are hidden or an RPC returns `Poll results are not available yet`, verify the poll's `result_visibility`, deadline, and whether the current voter profile has a row in `votes` for that poll.
- If poll creation returns SQLSTATE `42804` with an enum mismatch, cast RPC text arguments to the live enum types. The verified live types are `public.poll_type` and `public.voting_restriction`.
- Poll option images use existing `poll_options.image_url`; results are returned by `get_poll_results` with the image URL, while ballot choices remain anonymous.
- Verify database facts with read-only CLI queries before editing frontend filters or changing remote data.
- Local checks: `npm run build` and `npm run lint`, with the Node path above exported first.