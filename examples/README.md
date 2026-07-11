# Examples

Runnable examples for the Pug Web SDK. Each loads the built single-file bundle (`dist/cdn/pug.min.js`) as `window.pug` — one request, no module-per-file waterfall — so build first:

```bash
bun run build
bun run serve   # serves the repo root on http://localhost:3000
```

Then open the example URL.

| Example | URL | Shows |
| --- | --- | --- |
| [`privacy/`](./privacy/) | http://localhost:3000/examples/privacy/ | `data-pug-no-capture` text redaction and the `sanitizeUrl` hook (route masking + PII query-param stripping) |
