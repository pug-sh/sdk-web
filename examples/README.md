# Examples

Runnable examples for the Pug Web SDK. Each imports the built SDK from `dist/`, so build first:

```bash
bun run build
bun run serve   # serves the repo root on http://localhost:3000
```

Then open the example URL.

| Example | URL | Shows |
| --- | --- | --- |
| [`privacy/`](./privacy/) | http://localhost:3000/examples/privacy/ | `data-pug-no-capture` text redaction and the `sanitizeUrl` hook (route masking + PII query-param stripping) |
