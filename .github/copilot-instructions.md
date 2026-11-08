# AGENT INSTRUCTIONS: Housing Society OTP Voting App

## Tech Stack
- Frontend: Single Page Application (HTML/Tailwind CSS/JS or React) hosted on Netlify.
- Backend & DB: Supabase (Postgres, Auth with Email OTP, RLS).
- Timezone: Asia/Kolkata (IST).

## Database Context
We have already created the database tables in Supabase with the following schema:
- `users`: id, auth_user_id, email, name, contact, flat_number, resident_type (owner/resident), role (admin/regular)
- `polls`: id, title, description, poll_type (single_choice/ranked_choice), restriction (one_per_flat, owners_only_one_per_flat, residents_only_one_per_flat, all_owners, all_residents, all_owners_and_residents), deadline (TIMESTAMPTZ), is_deleted, created_by
- `poll_options`: id, poll_id, option_text, image_url, display_order
- `votes`: id, poll_id, flat_number, resident_type, voted_at
- `ballot_entries`: id, poll_id, option_id, rank_position

## Key Business Logic Requirements
1. Admin Auth: Email + OTP login using Supabase Auth.
2. User CSV Upload: Admin can import users with flat numbers, resident types, and roles into the `users` table.
3. Restrictions Check: Verify voter eligibility based on flat_number and resident_type prior to accepting votes.
4. Anonymous Voting: Save voter identity in `votes` (to lock future attempts) and choice payloads separately in `ballot_entries`.
5. Expiry & IST: Disable voting UI when `deadline` has passed relative to IST time.
6. Ranked Choice Scoring: Calculate live aggregated results using Borda Count scoring.
7. Session Expiry: Enforce 24-hour max session lifetime; terminate on explicit logout.
