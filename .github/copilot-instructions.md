# AGENT INSTRUCTIONS: Housing Society OTP Voting App

## Tech Stack
- Frontend: Single Page Application (HTML/Tailwind CSS/JS or React) hosted on Netlify.
- Backend & DB: Supabase (Postgres, Auth with Email OTP, RLS).
- Timezone: Asia/Kolkata (IST).

## Database Context
We have already created the database tables in Supabase with the following schema:
- `users`: id, auth_user_id, email, name, contact, flat_number, role (admin/regular)
- `user_resident_types`: user_id, resident_type (owner/resident); each user may have either or both categories
- `polls`: id, title, description, poll_type (single_choice/ranked_choice), restriction (one_per_flat, owners_only_one_per_flat, residents_only_one_per_flat, all_owners, all_residents, all_owners_and_residents), deadline (TIMESTAMPTZ), is_deleted, created_by
- `poll_options`: id, poll_id, option_text, image_url, display_order
- `votes`: id, poll_id, voter_user_id, flat_number, resident_type (nullable category snapshot), voted_at
- `ballot_entries`: id, poll_id, option_id, rank_position

## Key Business Logic Requirements
1. Admin Auth: Email + OTP login using Supabase Auth.
2. User CSV Upload: Admin can import users with flat numbers, resident types, and roles into the `users` table.
3. Restrictions Check: Verify voter eligibility based on resident-type memberships and flat_number prior to accepting votes.
4. Vote Privacy: Each poll has identified or anonymous responses. New polls default to identified; existing polls remain anonymous. Link `ballot_entries` to `votes` only for identified polls; never change privacy after votes exist. Keep individual choices inaccessible to ordinary users. Historical choices may be unlinked. The `all_owners_and_residents` restriction permits one vote per registered user, not one per flat.
5. Expiry & IST: Disable voting UI when `deadline` has passed relative to IST time.
6. Ranked Choice Scoring: Calculate live aggregated results using Borda Count scoring.
7. Session Expiry: Enforce 24-hour max session lifetime; terminate on explicit logout.
