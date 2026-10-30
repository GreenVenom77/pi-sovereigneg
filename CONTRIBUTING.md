# Contributing

Thanks for helping! This is a small, dependency-free pi extension. It is fully vibe-coded (AI-written), so careful human review,
real-world testing against the live API and corrections to API assumptions are especially valuable.

## Setup
```bash
git clone https://github.com/GreenVenom77/pi-sovereigneg
cd pi-sovereigneg
npm install
npm test            # Node 22.6+; uses the built-in test runner, no network needed
npm run typecheck
pi -e ./src/index.ts   # try it in pi without installing
```

## Guidelines
- Keep it dependency-free. Pi core packages are peer dependencies.
- Anything that changes routing, the picker or error handling needs a test (`test/*.test.ts`).
  Tests use a fake pi and a fake API (`test/helpers.ts`): no real key required.
- Never log keys, headers or prompts.
- Update `CHANGELOG.md` under **Unreleased**.
- If a SovereignEG API field is a guess, say so in a comment and make the code tolerant of it missing.

## Releasing (maintainers)
1. Move the Unreleased notes to a new version in `CHANGELOG.md`; bump `version` in `package.json`.
2. `git tag vX.Y.Z && git push --tags`. The release workflow tests the code and creates the GitHub release (there is no npm publish).
