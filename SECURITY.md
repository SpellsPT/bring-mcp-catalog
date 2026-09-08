# Security Policy

## Reporting a vulnerability

Please open a [security advisory](https://github.com/SpellsPT/bring-mcp-catalog/security/advisories/new)
rather than a public issue. I will respond as soon as I reasonably can — this is a spare-time
project, so please do not expect a same-day answer.

## What this server has access to

Be aware of what you are running before you report, or deploy, anything:

- It authenticates to **Bring!** with the credentials you place in `MAIL` and `PW`, and can
  **read and modify your shopping lists** — adding, renaming and removing items.
- It runs as a **stdio subprocess** of your MCP client. It does not open a network listener,
  so it is not reachable from your network.
- It talks to Bring's own API over HTTPS and to no other host.
- Credentials come from the environment. **Do not commit them.** `.env.example` shows the
  shape; `.env` is gitignored.

## Supported versions

The latest release only. This project has no long-term support branches.

## Dependencies

Dependencies are watched by Dependabot and `npm audit` runs in CI. Note that the two most
recent advisories affecting this project (`fast-uri`, `qs`) arrived **transitively** through
`@modelcontextprotocol/sdk`, not through direct dependencies — so a clean direct dependency
list is not by itself evidence of a clean tree.
