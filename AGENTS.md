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
- The MCP server entry point is `src/index.ts`.
- Do not commit sensitive information such as `.env` files containing Bring!
  credentials.

## Tool Registration and Integration Tests

- Tools are registered via helper functions in `src/index.ts` and files under
  `src/tools/`.
- Integration tests expect **exactly 16** tools to be registered. If you add or
  remove tools, update the `expectedToolNames` array in
  `tests/integration.spec.ts`.

## Coding Conventions

- Follow the existing ESLint and Prettier configurations.
- Keep code modular and type-safe. Reuse schemas from
  `src/schemaShared.ts` when possible.
- Add meaningful Jest tests for new features. If a feature is too trivial for a
  test, explain why in a code comment.

By adhering to these guidelines, contributions will remain consistent with the
project's style and quality standards.
