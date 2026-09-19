# URL Forge

URL Forge is a reversible, client-side URL compressor. The web app uses the existing meta-v7 codec and works as a static site: compression, decompression, redirects, validation, i18n, copy, and QR generation all run in the browser.

Telemetry is optional and isolated in `functions/`. The static app does not need Cloudflare, a database, or an API.

## Local development

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
```

Run checks and build:

```bash
npm test
npm run build
npm run preview
```

The production output is written to `dist/`.

## Public configuration

Copy `.env.example` to `.env.local` when configuration is needed:

```dotenv
PUBLIC_SHORT_URL_BASE=https://urlforge.pages.dev/#
TELEMETRY_ENDPOINT=
```

`PUBLIC_SHORT_URL_BASE` is optional. Without it, the app uses its current origin followed by `/#`. Set it explicitly for hosts mounted below a path, including GitHub Pages project sites. Production short-link bases must use HTTPS; HTTP is accepted only on loopback during local development.

`TELEMETRY_ENDPOINT` is optional. When empty, no telemetry request is made.

## Static hosting

Run `npm ci && npm run build`, then publish the entire `dist/` directory. This works with Cloudflare Pages, GitHub Pages, Netlify, Vercel, or a generic static host.

- Cloudflare Pages: build command `npm run build`, output directory `dist`.
- Netlify: build command `npm run build`, publish directory `dist`.
- Vercel: framework preset `Vite`, build command `npm run build`, output directory `dist`.
- GitHub Pages: publish `dist/` and set `PUBLIC_SHORT_URL_BASE` to the deployed project URL ending in `/#` when using a repository subpath.

The host must serve `index.html` at the configured short-link base. No redirect API is required because payloads are stored in the URL fragment.

## Optional Cloudflare telemetry

This section is not required for the static product.

1. Create a D1 database:

   ```bash
   npx wrangler@latest d1 create url-forge-telemetry
   ```

2. Copy `wrangler.toml.example` to `wrangler.toml` and replace only the D1 database ID returned by Cloudflare.
3. Apply the versioned migration:

   ```bash
   npx wrangler@latest d1 migrations apply url-forge-telemetry --remote
   ```

4. Store the admin token as an encrypted Pages secret:

   ```bash
   npx wrangler@latest pages secret put ADMIN_TOKEN --project-name url-forge
   ```

5. Configure the frontend build variable to the deployed endpoint, for example `TELEMETRY_ENDPOINT=https://your-installation.example/api/telemetry`, and rebuild.

The aggregate metrics endpoint is `GET /api/admin/metrics` with `Authorization: Bearer <ADMIN_TOKEN>`. There is no public admin dashboard. The database stores only the closed technical event schema; URLs, payloads, request headers, cookies, and persistent user identifiers are not stored.

For local Cloudflare testing, apply migrations with `--local` and use `npx wrangler@latest pages dev dist`. Keep local secrets in `.dev.vars`, which is ignored by Git.

## Privacy and portability

Only the language preference is stored in `localStorage`. Link history is not stored. If telemetry is disabled, offline, blocked, or misconfigured, the compressor and redirect flow continue normally.

The vendored ha.mr code remains unmodified and retains its own license in `vendor/ha.mr/LICENSE`.
