# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the React and Carbon UI: pages, reusable components, API clients, and SCSS.
- `worker/` contains the Hono API, authentication, MongoDB access, services, and scheduled jobs. `shared/` holds validation schemas and rules used by both client and server.
- `netlify/functions/` provides API and scheduled-function entry points. Keep scheduled function settings aligned with `worker/cron/index.ts`.
- `test/` contains Vitest tests and fixtures; `scripts/` contains local database and cron utilities. Static site files live in `public/`; project images and documentation live in `assets/` and `docs/`.

## Build, Test, and Development Commands

Use Node 24 and pnpm 12 (see `packageManager` in `package.json`). Copy `.env.example` to `.env` and configure a local MongoDB replica set; see `DEV.md` for setup.

- `pnpm install` installs dependencies.
- `pnpm run dev` starts Vite and the local API at `http://localhost:5173`.
- `pnpm run build` builds the SPA in `dist/`; `pnpm run preview` builds and previews it.
- `pnpm run typecheck` checks the app, worker, and Node TypeScript configurations.
- `pnpm test` runs the Vitest suite.
- `pnpm run db:reset` deletes local app collections, recreates indexes, and seeds data.

## Coding Style & Naming

Follow the surrounding TypeScript, TSX, and SCSS conventions: two-space indentation, double quotes, and semicolons. Use PascalCase for React components and page files (for example, `LeaseDetail.tsx`), and descriptive camelCase for functions and variables. Put shared validation in `shared/` and keep route handlers and business logic in their existing `worker/` layers. No dedicated lint or formatting command is configured; run typechecking before submitting changes.

## Testing Guidelines

Name tests `test/<area>.test.ts`. Add focused Vitest coverage for changed rules, API behavior, and failure paths. Integration tests use an in-memory MongoDB replica set and mock external requests; the first run may download MongoDB. Run `pnpm test` and `pnpm run typecheck` before opening a pull request. No coverage threshold is configured.

## Commits & Pull Requests

Recent commits use concise conventional prefixes such as `feat:`, `fix:`, and `docs:`, often with Korean descriptions. Describe the change and verification in pull requests, link the relevant issue when available, and include screenshots for UI changes.

## Configuration & Safety

Never commit secrets. Use a local database for development: the Atlas connection described in `DEV.md` can point to production. Remote database commands and disabling `DNS_DRY_RUN` can affect live data or DNS; check the target before running them. See `SECURITY.md` and `DEV.md` for operational guidance.
