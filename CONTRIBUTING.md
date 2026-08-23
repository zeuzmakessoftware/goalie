# Contributing to Goalie

Thanks for helping improve Goalie. Bug reports, design discussion, documentation fixes, tests, and focused code changes are welcome.

## Development setup

Requirements: Node.js 22 or newer, `pnpm`, and Git.

```sh
pnpm install
pnpm check
```

`pnpm check` runs type-checking, the test suite, the production build, and a package smoke test. Please run it before opening a pull request.

## Pull requests

- Keep changes focused and explain the user-visible behavior or invariant they affect.
- Add or update tests for behavior changes.
- Preserve Goalie's evidence-first and fail-closed safety model.
- Do not commit credentials, `.env` files, generated session state, or provider transcripts.
- Update the relevant documentation when changing commands, configuration, durable state, security boundaries, or replay provenance.

Security-sensitive reports should follow [SECURITY.md](SECURITY.md) instead of being filed publicly.
