# Contributing to URLForge

Use Node.js 20.19 or newer. Run `npm ci`, `npm run dev`, and `npm test`. Use `npm run build` to check the production bundle. The core codec is in [`src/codec.js`](src/codec.js) and compact-fragment fixtures are in [`test/compact-fragment.test.js`](test/compact-fragment.test.js).

## Review a change

- For codec changes, round-trip URLs with Unicode, percent escapes, repeated query keys, and fragments. Check decoding of previously generated links and handling of a malformed payload.
- Use the same fixture set to compare encoded lengths before and after a compression change. Include round-trip results alongside size changes. `npm run benchmark:final:sample` is a bounded starting point for final-output experiments.
- For UI or privacy changes, run `npm run test:web` and check the encode, copy, QR, and decode paths affected by your change. Use public sample URLs in test data.

Include the mode, a minimal example URL, and whether existing short links remain readable.
