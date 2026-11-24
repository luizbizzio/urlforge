# URLForge

URLForge is a reversible, client-side URL compressor. The static app selects the shortest available encoding that restores the browser-serialized URL. Compression, decompression, redirects, validation, i18n, copy, and QR generation all run in the browser. Links created with meta-v7 are still readable.

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

## Suffix compression

URLForge includes the [ha.mr codec by p2r3](https://github.com/p2r3/ha.mr) alongside its own encoders. The [MIT license](vendor/ha.mr/LICENSE) is included in the source and in the static build.

The suffix model predicts characters using up to three preceding characters. It covers path, query, and fragment while reusing the ha.mr encoding for the origin. The selector compares its payload against exact meta-v7 candidates and uses a lossless Forge fallback for forms that meta-v7 normalizes, including empty query and fragment markers and lowercase percent escapes.

For URLs with a query, a second model learns from up to eight preceding characters within the current URL. It tracks separate counts for the path, parameter names, values and fragment. Repeated names and values can then cost fewer bits. The selector includes the format marker when comparing lengths. A single dot between the encoded origin and suffix identifies the frozen model, and a double dot in that position identifies the adaptive model.

An additional candidate separates identifiers from the surrounding text. It packs decimal and hexadecimal runs, UUIDs and consecutive percent-escaped bytes, and can carry mixed-case URL-safe IDs verbatim. The first field after the origin encodes the surrounding text, and each subsequent dot-separated field restores one identifier. The format preserves leading zeroes and escape case. Run `benchmark:suffix` and inspect `vsBeforeIdentifierSuffix` for the change in final link size.

The selector also tries the adaptive model on paths and fragments of at least 24 characters. When a first directory is present, the single-dot format can encode it with the origin and use the frozen model for the remaining suffix. Compare final URL sizes with the preceding selector in `vsBeforePathChanges`.

For UTF-8 percent escapes, the Unicode candidate stores the shared high bits of a run of code points once. It retains literal underscores and hyphens, encoded spaces and the original case of the escapes. The benchmark reports its effect on final link length in `vsBeforeUnicode`.

The compact fragment format uses 76 ASCII symbols and ends in a letter or number. It carries either the shortest existing fragment or the ha.mr v0 representation without its fixed version bit. A reserved punctuation character identifies the compact format. The selector emits it only when it saves at least one character. See `vsBeforeCompact` in the suffix benchmark.

Run the benchmark against the native ASCII ha.mr encoder, ha.mr with the shared safe alphabet, and the previous Forge selector.

```sh
npm run benchmark:suffix
npm run benchmark:suffix -- --base https://urlforge.pages.dev/# --ada ./ada-urls.txt
```

The defaults use 440 generated inputs and [98 links from the public Hacker News API](test/fixtures/hacker-news-2026-11-23.txt). The optional `--ada` input uses the [pinned Ada URL corpus](https://raw.githubusercontent.com/ada-url/url-dataset/ef7065196980ab7956bacc60b4bda663939f659c/out.txt) and adds 400 test URLs. Domain groups used by the test sets are held out from training. The report counts complete URLs with an identical base, rejects reference results that change the serialized destination, and reports size, wins, ties, losses, and encode/decode p95 in Node.

The counts in `src/suffix-model-v1.js` are part of the wire format. To reproduce them, run the following command with the pinned corpus and compare the output with the checked-in file. A different model requires a new wire format so existing links retain their meaning.

```sh
node src/train-suffix-model.js ./ada-urls.txt ./test/fixtures/hacker-news-2026-11-23.txt ./model-check.js
```

With `--ada`, the benchmark also measures queries from held-out domain groups absent from the first two public samples. It takes up to four URLs per group in corpus order, up to 500 in total. The pinned corpus yields 141 queries across 92 groups. The `vsBeforeAdaptiveQuery` field reports the size change against the shortest exact candidate available before the adaptive model.

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
