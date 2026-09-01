# Local patches to `bring-mcp`

Upstream: https://github.com/florianwittkamp/bring-mcp (MIT, third-party — Bring!
publishes no official API and no official MCP server).

Forked at `cd61806` ("fix: normalize npm release metadata"), which was upstream
`main` and functionally identical to the published `bring-mcp@1.1.8`.

Branch: `feat/item-icons`.

## Why

On a multilingual list, items added through the API were being stored as free
text such as `Apples / Maçãs`, which Bring cannot match to its catalog — so they
render verbatim with no icon and no aisle, while items added in the phone app get
both.

Working out why led to two findings that shape everything here:

1. **Bring stores an item by a canonical, language-independent id and each
   client renders that id in the list's own article language.** The ids look
   German (`Äpfel`, `Kartoffeln`, `Früchte & Gemüse`) but are identical across
   every locale's catalog; only the display `name` is translated. An item stored
   as `Äpfel` shows as "Maçãs" on a Portuguese phone, with the apple icon, for
   free. So the fix for the bilingual problem is _resolution_, not a combined
   name.
2. **For genuinely custom items** (`Escova De Dentes Colgate Maquina`) there is a
   per-list "item details" record carrying `userIconItemId` and `userSectionId`.
   A long-lived list can accumulate hundreds of these, created by hand in the
   app. Automating that is the second half of this work.

## The undocumented endpoints

No public library implements item-detail writes — not `bring-shopping`, not
`miaucl/bring-api` (which powers the Home Assistant integration), not the two
other Bring MCP servers on GitHub. The endpoint table was recovered from the
Bring! web app's **published source maps** (`src/app/core/bring-api-resources.ts`
in `main.bundle.js.map`); the web app ships the table and the icon-picker UI
state but never wired up the HTTP calls, so verbs and encodings were determined
by probing against a scratch list.

| Operation             | Request                                                               | Notes                                                |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| Create detail record  | `POST v2/bringlistitemdetails`                                        | **`multipart/form-data` only** — everything else 415 |
| Set icon              | `PUT v2/bringlistitemdetails/{uuid}/usericon`                         | **form-urlencoded only** — multipart 415             |
| Set section           | `PUT v2/bringlistitemdetails/{uuid}/usersection`                      | form-urlencoded                                      |
| Delete record         | `DELETE v2/bringlistitemdetails/{uuid}`                               | 204                                                  |
| Read one              | `GET v2/bringlistitemdetails/{uuid}` or `?listUuid=&itemId=`          | **204, not 404, when absent**                        |
| Update record         | `PUT v2/bringlistitemdetails/{uuid}`                                  | **405 — does not exist.** Rename = recreate + delete |
| List article language | `POST v2/bringusersettings/{userUuid}/{listUuid}/listArticleLanguage` | form-urlencoded, `value=`                            |
| Leave/delete a list   | `DELETE v2/bringlists/{listUuid}/users/{userUuid}`                    | the only working delete route                        |

### Traps, each of which cost real time

- **Two different encodings on the same resource family.** The collection accepts
  only multipart; its sub-resources reject multipart and accept only
  form-urlencoded. Getting it backwards yields an opaque Tomcat 415 HTML page.
- **Bodies are decoded as ISO-8859-1 unless the Content-Type carries an explicit
  `charset=UTF-8`.** Without it `Äpfel` is stored as `Ãpfel`. Node's built-in
  `FormData` cannot be used because it owns the Content-Type header and drops the
  charset — hence the hand-built multipart body in `bringHttp.ts`. Adding a
  `_charset_` form field (the usual servlet trick) does **not** work.
- **The newer batch endpoint `PUT v2/bringlists/{listUuid}/items` silently
  half-works.** `TO_PURCHASE` applies, but `TO_RECENTLY` and `REMOVE` do nothing:
  they address the item by uuid, and no endpoint exposes the uuid of an item
  created the legacy way. It returns **200 either way**, so the failure is
  invisible. `batchUpdateList` therefore routes those two operations to the
  name-addressed legacy calls, which are immediate and reliable.
- **`pt-PT` does not exist.** Bring serves `pt-BR` only; `pt-PT` 404s with an HTML
  page that the underlying library then tries to `JSON.parse`. Locales are now
  validated up front with a message that names the alternative.
- **Reading `bring-shopping`'s private `headers`** is how the authenticated
  session is reused for these endpoints. `extractAuthHeaders` validates the shape
  so a future package release fails loudly instead of emitting 401s.

## Files

| File                                            | Change                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bringHttp.ts`                              | **new** — encoding-aware raw request layer                                                                                                |
| `src/catalog.ts`                                | **new** — catalog indexing and conservative resolution                                                                                    |
| `src/bringClient.ts`                            | added catalog, item-detail, batch and settings methods; locale validation on `loadTranslations`/`loadCatalog`. Existing methods untouched |
| `src/tools/iconTools.ts`                        | **new** — 10 tools, plus `bringApiRaw` behind `BRING_MCP_RAW=1`                                                                           |
| `src/schemaShared.ts`                           | added zod params for the above                                                                                                            |
| `src/index.ts`                                  | registers `registerIconTools`                                                                                                             |
| `tests/catalog.spec.ts`                         | **new** — resolver unit tests incl. the wrong-match regression                                                                            |
| `tests/iconTools.spec.ts`                       | **new** — tool registration and delegation                                                                                                |
| `tests/helpers.ts`, `tests/integration.spec.ts` | extended for the new tools                                                                                                                |

The original 16 tools are unchanged in behaviour.

## On matching

Resolution is deliberately strict and returns nothing rather than a guess. An
earlier substring-based version matched `Escova De Dentes Colgate Maquina` to
`Öl` (oil), because "ol" occurs inside "Colgate". Partial matches are whole-token
only with a minimum length; `tests/catalog.spec.ts` pins that case.

`saveItemResolved` uses two different bars, because "is this item" and "is close
enough to borrow an icon from" are different questions:

- score ≥ 90 → store the canonical id (renders translated, with icon)
- score ≥ 50 → store the text **verbatim** and attach the matched icon, so that
  "Escova De Dentes Colgate Maquina" keeps its brand rather than collapsing to
  plain "Escova de dentes"
- otherwise → store the text, no icon

## Upstreaming

Nothing here is household-specific, and the capability exists nowhere else. This
is a reasonable pull request to `florianwittkamp/bring-mcp`; if accepted, the
fork can be retired. The only opinionated default is
`DEFAULT_CATALOG_LOCALES = ['de-DE', 'pt-BR', 'en-US']`, which should become
configurable before proposing it.
