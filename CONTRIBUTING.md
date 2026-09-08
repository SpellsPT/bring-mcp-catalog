# Contributing

Thanks for looking. This is a small project maintained in spare time — issues and pull
requests are welcome, and so is "this didn't work for me and here is what I saw".

## Before you start

**Read [the status note in the README](README.md#-status-and-please-read-this-bit).** This
project talks to an unofficial, undocumented API. Behaviour can change without warning, and
the code is written accordingly — defensively, and with tests that pin real observed
responses rather than assumed ones.

## Ground rules that come from experience here

1. **Verify against the real catalog, not a synthetic fixture.** The live Bring! catalog is
   much denser than anything you would invent, and matcher bugs found against a thin fixture
   usually do not reproduce. Several confidently-reported issues turned out to be artefacts
   of a sparse test catalog.
2. **Never widen the write path to fix a search problem.** `findCatalogItem` may return
   low-confidence suggestions (flagged `nearest`), because an agent can use them to ask a
   better question. What gets _attached_ to a list is a separate, stricter decision.
3. **Locale behaviour is configuration, not code.** If a term fails in your language, the fix
   is usually `BRING_MCP_CATALOG_LOCALES`, or a term alias — not a hardcoded special case.
4. **Add a test that fails before your change.** Especially for matcher work; scoring changes
   have a habit of fixing one word and breaking two others.

## Development

```bash
npm install
npm test          # format + lint + jest (210 tests)
npm run build     # tsc
npm run typecheck
```

`npm test` runs prettier and eslint with `--fix`, so formatting is not something you need to
argue with.

## Pull requests

- One logical change per PR, with a description of what you observed, not just what you changed.
- Say how you tested it. "Verified against my own list" is a perfectly good answer.
- If it changes matching behaviour, include the before/after for at least a couple of real terms.

## Reporting a bug

Include the query you typed, what you expected, and what came back — the raw tool output if you
have it. Item names are personal data of a sort, so redact anything you would rather not publish.
