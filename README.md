# Electron React SQLite Starter

A minimal Electron desktop app using React, TypeScript, Tailwind CSS, shadcn/ui, Drizzle ORM, and SQLite. It includes hot reload during development, a secure typed preload bridge, and packaging for Windows and macOS.

## Requirements

- Node.js 22.12+ or 24+
- npm

## Start development

```bash
npm install
npm run dev
```

The renderer hot-reloads when React or CSS changes. Electron restarts when main-process or preload code changes.

On Windows PowerShell systems that block `npm.ps1`, run the same commands with `npm.cmd`, for example `npm.cmd run dev`.

## Validate and build

```bash
npm run typecheck
npm run build
```

Create an installer for the current platform:

```bash
npm run build:win
npm run build:mac
```

Packaged files are written to `release/`. Build Windows installers on Windows and macOS packages on macOS. macOS signing and notarization require an Apple Developer identity; unsigned local builds work without those credentials.

## Project layout

```text
drizzle/      Generated SQL migrations bundled with packaged apps
src/
  main/       Electron main process, Drizzle schema, and SQLite access
  preload/    Typed, narrow IPC bridge exposed as window.api
  renderer/   React, Tailwind CSS, and shadcn/ui application
```

The SQLite database is created as `app.sqlite` inside Electron's per-user application data directory. Define tables in `src/main/db/schema.ts`; `src/main/database.ts` runs migrations at startup and contains typed key/value queries as an integration example.

After changing the schema, generate a migration:

```bash
npm run db:generate
```

`db:migrate`, `db:push`, and `db:studio` target `local.sqlite` by default. Set `DB_FILE_NAME` to use another development database. Runtime Electron data continues to use the per-user application data directory unless the same variable is set.

The renderer uses the `@/` alias and the shadcn Nova style. Add more components with:

```bash
npx shadcn@latest add card
```

Before shipping, change `build.appId`, `build.productName`, author metadata, and add your own app icons in `package.json`.
