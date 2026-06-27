# Task 1 Report: Package scaffold, toolchain, and plugin identity

## What was implemented

Seven files created and committed on `milestone-1-plumbing`:

- `package.json` - npm package manifest (verbatim from brief, with exact dependency versions matching signalk-crows-nest)
- `tsconfig.json` - TypeScript config (NodeNext module, ES2022 target, strict, declaration output)
- `tsconfig.test.json` - extends tsconfig.json, adds test tree to includes
- `eslint.config.js` - neostandard flat config with TypeScript enabled (one deviation noted below)
- `src/shared/plugin-id.ts` - four exported identity constants
- `test/plugin-id.test.ts` - three assertions covering PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_REPO_URL

## TDD evidence

### RED

Command: `npm test`

Output summary:
```
Error: Cannot find module '../src/shared/plugin-id.js'
  ...at T._resolveFilename (tsx/dist/register-CqMfTiWi.mjs)
✖ tests 1  pass 0  fail 1
```

Why expected: `src/shared/plugin-id.ts` did not exist yet, so tsx could not resolve the import.

### GREEN

Command: `npm test`

Output summary:
```
✔ plugin id matches the npm package name (1.24ms)
✔ plugin name and description are human readable and non-empty (0.30ms)
✔ the repo url points at the github project (0.33ms)
ℹ tests 3  pass 3  fail 0
```

### Typecheck

Command: `npm run typecheck`

Both `tsc --noEmit` (src tree) and `tsc --noEmit -p tsconfig.test.json` (src and test trees) exited 0 with no output.

### Lint

Command: `npm run lint`

Exited 0. One Node.js runtime warning (stderr, not a lint error) about `MODULE_TYPELESS_PACKAGE_JSON` - see deviation note below.

## Files changed

- `package.json` (created)
- `package-lock.json` (created by npm install, 322 packages)
- `tsconfig.json` (created)
- `tsconfig.test.json` (created)
- `eslint.config.js` (created, one deviation)
- `src/shared/plugin-id.ts` (created)
- `test/plugin-id.test.ts` (created)

## Self-review

- TDD order followed: config files, install, test written, RED confirmed, module written, GREEN confirmed, typecheck, lint, commit.
- All four constants are exported and match the exact string values the test asserts.
- No `prepare` or `prepack` lifecycle script present (correct, avoids `npm pack` stdout contamination in CI).
- `prepublishOnly` only runs `build` as specified.
- Commit subject matches the brief exactly.

## Deviation from brief: eslint.config.js ignores

The brief's `eslint.config.js` specifies `ignores: ['dist/', 'node_modules/', 'container/']`. Running lint with that list caused a hard lint error because ESLint picked up `.remember/tmp/last-ndc.ts` (the `.remember/` directory holds live session state and is in `.gitignore` but not automatically excluded by ESLint).

Fix applied: added `'.remember/'` to the ignores array, matching exactly what signalk-crows-nest does in its eslint config.

## Node.js warning about MODULE_TYPELESS_PACKAGE_JSON

Node warns that `eslint.config.js` uses ESM `import` syntax but `package.json` has no `"type": "module"`. Node still parses it as ESM (zero errors), and ESLint exits 0. The warning recommends adding `"type": "module"`, but that would change TypeScript's compiled output from CommonJS to ESM, breaking Signal K server's `require()`-based plugin loading. The correct resolution is to leave the warning in place. The reference project (signalk-crows-nest) avoids the issue by using CommonJS `require()` syntax in its eslint config; this project follows the brief in using ESM import syntax instead.

## Concerns

None blocking. The `.remember/` ignores deviation is a necessary fix the brief omitted. The MODULE_TYPELESS_PACKAGE_JSON warning is harmless and cannot be resolved without changing the plugin output format.

---

## Fix M1 and M2: eslint config rename and comment

### Commands and output

**M1: rename eslint.config.js to eslint.config.mjs**

```
git mv eslint.config.js eslint.config.mjs
```

No output (success).

**M2: add comment to the ignores array in eslint.config.mjs**

Comment added: `.remember/ holds session-state TypeScript files that flat config would lint and error on, since flat config does not honor .gitignore.`

**Lint verification:**

```
npm run lint

> signalk-binnacle-companion@0.0.1 lint
> eslint .
```

Exit 0. The `MODULE_TYPELESS_PACKAGE_JSON` warning is absent from the output (renaming to `.mjs` signals ESM unconditionally, eliminating the warning).

**Test verification:**

```
npm test

> signalk-binnacle-companion@0.0.1 test
> node --import tsx --test test/*.test.ts

✔ plugin id matches the npm package name (1.086887ms)
✔ plugin name and description are human readable and non-empty (0.264699ms)
✔ the repo url points at the github project (0.29966ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

3/3 pass. No regressions.
