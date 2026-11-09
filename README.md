# React + TypeScript + Vite

## Add A User

Run the single-user script from the project root using Node.js 20.12 or newer. Install dependencies with `npm install`. The script requires an authenticated Supabase CLI linked to the target project and a matching `VITE_SUPABASE_URL` in `.env`.

If the CLI is not already authenticated or linked, run:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
```

Enter any requested access token or database credentials directly in the terminal. The linked project may be a production database; check the project reference before creating users.

For example, to add an owner:

```sh
node --env-file=.env scripts/add-user.mjs \
  --email resident@example.com \
  --name "Resident Name" \
  --flat "Koel-001" \
  --type owner \
  --contact "9876543210"
```

Arguments:

- `--email`: User's email address, required.
- `--name`: User's name, required.
- `--flat`: Apartment number, required.
- `--type`: `owner` or `tenant`, required. Owners receive both owner and resident memberships; tenants receive resident membership.
- `--contact`: Phone number, optional.
- `--role`: `regular` or `admin`, optional; defaults to `regular`.

Use `--role admin` only for an administrator. The script refuses to overwrite an existing public profile. If the email already exists in Supabase Auth but has no public profile, the script links that Auth account to the new profile instead of creating a duplicate. On success it prints the project reference, email, Auth ID, profile ID, resident memberships, and whether it created the Auth account.

The script creates an Auth account with a randomly generated, discarded password and confirms the email administratively without sending an email or verifying mailbox ownership. It links the account to a new `public.users` profile; residents can sign in using the application's email OTP flow. The script uses the linked project's service role key locally; never expose it in browser code or logs. If a later step fails, the script attempts to remove records created by that invocation and reports any cleanup failure.

Use `node scripts/add-user.mjs --help` for the argument summary and `node --test scripts/add-user.test.mjs` to run the mocked tests.

## Poll Option Galleries

Each poll option can have up to 20 image links. In the poll form, use Add image to add each Google Drive sharing link or direct image URL. Google Drive images must be shared so anyone with the link can view them. Residents vote for the option, not individual images.

Apply the `20261108180000_poll_option_galleries.sql` Supabase migration before deploying the gallery-enabled frontend. Existing option images are preserved. Review the migration and obtain approval before applying it to production.

## Admin Poll Management

Admins can edit poll details, deadline, targeted flats, result visibility, response privacy, and option text and images. Once a vote has been cast, the voting method, voter restriction, response privacy, and number of options are locked to preserve vote integrity. Changing the wording or images after voting starts can change the meaning of recorded votes, so the form asks for confirmation.

Admins can view results regardless of the visibility setting. Deleting a poll permanently deletes its options, target flats, votes, and choices. Apply the `20261108190000_admin_poll_management.sql` migration before deploying these controls; obtain approval before applying it to production.

## Vote Privacy

After applying `20261109200000_identified_votes.sql`, admins can select response privacy for each poll. New polls default to recording voters' choices; database administrators can identify how a person voted. Anonymous polls do not link choices to voter records, although the voter and flat are still recorded to prevent duplicate votes. Existing polls remain anonymous and existing choices cannot reliably be attributed to voters. Privacy cannot be changed after a vote. The application shows aggregate results only; individual choices are not exposed to regular users. Apply the migration before deploying the updated admin interface.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
