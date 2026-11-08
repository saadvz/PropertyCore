# Contributing to Tour Core

## How to propose a change

1. Fork the repository.
2. Create a branch from `master`.
3. Make your change.
4. Run `npm run typecheck`, `npm run build`, and `npm test`.
5. Open a pull request against `master`.

## Checks

All of these must pass before you open a PR. GitHub Actions CI runs the same three commands:

```bash
npm run typecheck
npm run build
npm test
```

## Documentation

If the change affects behavior, tools, environment variables, or setup, update:

- `README.md`, `docs/environment-variables.md` for settings, and `docs/tour-core/README.md` for touring
- Grok instructions as needed: `GROK_BOOTSTRAP.md`, grok-template context / tool catalog / bot profile, `.grok/skills`, and `src/operator/tools.ts`

Do **not** edit `grok-template/SETUP_PROMPT.md`.

## Design pass for visitor or operator copy

If visitor-facing or operator-facing copy or flow changes, call that out in the pull request so it can get a design pass before merge.
