# AGENTS Instructions

This repository contains a TypeScript implementation of a Model Context Protocol
(MCP) server for the Bring! shopping list API. The following rules summarize the
project guidelines extracted from the README and the Cursor rules.

## Development Workflow

- **Run checks before committing:** Always run `npm run test` and `npm run build`
  before considering a task complete. Both commands must finish successfully.
- **Testing:** `npm run test` runs formatting, ESLint, and Jest tests. Use
  `npm run test:ci` for CI environments.
- **Building:** `npm run build` compiles the TypeScript sources using `tsc`.

## Project Structure

- Source code resides in `src/` with tools grouped in `src/tools/`.
- Tests are located in `tests/` and use Jest.
- The entry point is `src/index.ts`: it loads `.env` (`src/loadEnv.ts`), resolves
  credentials and starts the stdio transport. `src/server.ts` builds the MCP server
  and registers every tool group.
- The Bring! client is `src/bringClient.ts`; raw HTTP for endpoints the
  `bring-shopping` package lacks is `src/bringHttp.ts`; the catalog matcher is
  `src/catalog.ts`.
- Do not commit sensitive information such as `.env` files containing Bring!
  credentials.

## Tool Registration and Integration Tests

- Tools are registered with `registerTool` from `src/registerTool.ts`. Every tool
  must declare a `title`, an `inputSchema`, an `outputSchema` (in
  `src/toolSchemas.ts`) and `annotations` (`src/toolAnnotations.ts`). The MCP SDK
  validates every result against the output schema at runtime, so a schema that is
  stricter than what the live Bring! API returns turns a working call into an error.
- `formatText` sets the human-readable text returned alongside the structured result.
- Integration tests expect **exactly 26** tools to be registered (`bringApiRaw` only
  appears with `BRING_MCP_RAW=1`). If you add or remove tools, update
  `expectedToolNames` in `tests/integration.spec.ts` and the count in
  `tests/protocol.spec.ts`.

## Coding Conventions

- Follow the existing ESLint and Prettier configurations.
- Keep code modular and type-safe. Reuse schemas from
  `src/schemaShared.ts` when possible.
- Add meaningful Jest tests for new features. If a feature is too trivial for a
  test, explain why in a code comment.

By adhering to these guidelines, contributions will remain consistent with the
project's style and quality standards.
