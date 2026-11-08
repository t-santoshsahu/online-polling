# React + TypeScript + Vite

## Poll Option Galleries

Each poll option can have up to 20 image links. In the poll form, use Add image to add each Google Drive sharing link or direct image URL. Google Drive images must be shared so anyone with the link can view them. Residents vote for the option, not individual images.

Apply the `20261108180000_poll_option_galleries.sql` Supabase migration before deploying the gallery-enabled frontend. Existing option images are preserved. Review the migration and obtain approval before applying it to production.

## Admin Poll Management

Admins can edit poll details, deadline, targeted flats, result visibility, and option text and images. Once a vote has been cast, the voting method, voter restriction, and number of options are locked to preserve ballot integrity. Changing the wording or images after voting starts can change the meaning of recorded votes, so the form asks for confirmation.

Admins can view results regardless of the visibility setting. Deleting a poll permanently deletes its options, target flats, votes, and ballot entries. Apply the `20261108190000_admin_poll_management.sql` migration before deploying these controls; obtain approval before applying it to production.

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
