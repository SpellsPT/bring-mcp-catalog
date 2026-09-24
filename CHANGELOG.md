# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-09-18

### Changed

- **Rebased onto the original project's MCP SDK v2 release.** The server now runs on
  `@modelcontextprotocol/server` 2.x, following florianwittkamp/bring-mcp. Every tool
  declares an input schema, an output schema, a title and read-only / destructive hints,
  and returns structured results alongside the readable text summary. All 26 tools were
  moved across; the catalog, icon and section tools keep their exact wording and behaviour.
- **Credentials are `BRING_EMAIL` / `BRING_PASSWORD`**, matching the original project.
  `MAIL` / `PW` still work.
- **`deleteMultipleItemsFromList`** structured result gains `notFound`, and `count` /
  `itemNames` now describe what was actually removed, not what was asked for.
- **`getDefaultList`** returns a structured result instead of an error when no list can
  be chosen. It still ignores a stored default pointing at a list the account has left,
  and when several lists exist it names them so the assistant can ask which one.

### Fixed

- **`.env` next to the install is now found** regardless of the directory the MCP client
  starts the server from. Previously only the working directory was searched, so a
  correctly placed `.env` was silently ignored. `BRING_MCP_ENV_FILE` points elsewhere.
- **`getAllUsersFromList` failed outright when any list member had no profile photo.**
  Bring! omits `photoPath` for such members and the strict v2 output schema rejected the
  whole response. Fields Bring! may leave out are now optional.
  Contributed upstream as
  [florianwittkamp/bring-mcp#71](https://github.com/florianwittkamp/bring-mcp/pull/71) (merged
  2026-09-23), where only `photoPath` is loosened — the one field observed missing on a real list.
- **README install instructions**: the recommended `npx bring-mcp-catalog` setup could
  never work — the package is not published to npm. Replaced with a clone-and-build install.

## [0.2.0] — 2026-09-08

### Added

- **Configurable catalog locales.** `BRING_MCP_CATALOG_LOCALES` (default `de-DE,en-US`) selects
  which Bring! catalogs are indexed for matching. Previously hardcoded. Set it to include
  `pt-BR` for Portuguese households, or any locale Bring! publishes.
- **European Portuguese (pt-PT) term aliases.** Bring! publishes a `pt-BR` catalog and no
  `pt-PT`, so European Portuguese words either fail outright or resolve to the wrong product.
  Queries are now rewritten before matching — each alias verified against the live catalog:

  | pt-PT       | → pt-BR     | before                     | after             |
  | ----------- | ----------- | -------------------------- | ----------------- |
  | `sumo`      | `suco`      | no match                   | `Apfelsaft` (100) |
  | `gelado`    | `sorvete`   | `Eistee` (65) — iced _tea_ | `Glacé` (100)     |
  | `fiambre`   | `presunto`  | no match                   | `Schinken` (100)  |
  | `brocolos`  | `brocolis`  | no match                   | `Brokkoli` (100)  |
  | `courgette` | `abobrinha` | no match                   | `Zucchetti` (100) |
  | `beringela` | `berinjela` | no match                   | `Aubergine` (100) |

  Requires the corresponding locale to be indexed — an alias rewrites to a pt-BR word, which
  only matches if `pt-BR` is in `BRING_MCP_CATALOG_LOCALES`.

- **Nearest-match hints instead of silence.** `findCatalogItem` previously returned `[]` when
  nothing cleared the confidence bar, leaving a calling agent nothing to steer by. Sub-threshold
  candidates are now returned flagged `nearest: true`, so an agent can offer the closest options
  and ask, rather than guessing at new spellings. **The write path is unchanged** — a `nearest`
  result is never enough to attach an icon or a canonical id.

### Changed

- Token-coverage floor on the whole-token icon rule: a matched name must cover at least half the
  typed tokens, which removes a class of confident-but-wrong icon assignments.

### Fixed

- Twin reuse could clobber a deliberately pinned icon; it now fills an empty icon and never
  replaces one that was set.
- Permutation twins were unreachable, so a list could acquire a second row for a product it
  already held under a reordered name.
- `&`, `+` and `%` in item names were corrupted on the legacy list-mutation endpoint
  (`Fish & Chips` became `Fish`). Fixed here and contributed upstream as
  [florianwittkamp/bring-mcp#62](https://github.com/florianwittkamp/bring-mcp/pull/62), since it
  affected every user of that package.

### Security

- `fast-uri` 3.1.5 → 3.1.7 — host confusion / SSRF (**high**), inherited transitively via
  `@modelcontextprotocol/sdk`.
- `qs` 6.15.3 → 6.16.0 — array-limit bypass and denial of service (moderate), same route.
- `npm audit --omit=dev` reports zero vulnerabilities.

## [0.1.0] — 2026-09-01

Initial public release, derived from
[florianwittkamp/bring-mcp](https://github.com/florianwittkamp/bring-mcp).

### Added

- **Catalog resolution.** Items are saved under their canonical Bring! catalog id rather than as
  free text, so they arrive with the correct icon and aisle instead of appearing as unmatched
  strings.
- Icon and section tooling: `setItemIcon`, `setItemSection`, `findCatalogItem`,
  `findCatalogSection`, `listItemCustomisations`, and batch item operations.
- A tie guard: where several catalog entries score equally, no icon is assigned rather than an
  arbitrary one being picked.
