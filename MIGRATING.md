# Migrating to create-foxglove-extension 2.0

`create-foxglove-extension` generates a starting project once. Projects created with 1.x do not
change when a new version is released, so this guide explains how to bring a 1.x project up to
the 2.0 setup by hand or with a coding agent.

The steps are written so that a coding agent can follow them. To use one, see
[Migrating with a coding agent](#migrating-with-a-coding-agent).

## What changes in 2.0

| Area            | 1.x                                             | 2.0                                                                                     |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Build           | webpack, configured by `foxglove-extension`     | [Vite+](https://viteplus.dev) with the `foxgloveExtension()` plugin in `vite.config.ts` |
| Customization   | `config.ts` exporting a `webpack` function      | Vite options and plugins in `vite.config.ts`                                            |
| Lint and format | ESLint with `@foxglove/eslint-plugin`, Prettier | Oxlint and Oxfmt through `vp check`, configured by `lintConfig` and `fmtConfig`         |
| Type checking   | `ts-loader` during every build                  | `tsc --noEmit` before every build, and `vp check`                                       |
| Tests           | None                                            | Vitest in Chromium with helpers from `create-foxglove-extension/testing`                |
| Node.js         | 14 or newer                                     | 24.11 or newer, or 22.18 or newer with npm 11                                           |

The output format does not change. `npm run package` still produces a `.foxe` file with a single
`dist/extension.js`, and Foxglove loads it the same way. A few bundler details differ from webpack,
which the [config.ts step](#5-move-configts-customizations-into-viteconfigts) and
[troubleshooting](#troubleshooting) cover.

## Before you start

- Install Node.js 24.11 or newer. Node.js 22.18 or newer also works after upgrading to npm 11 with
  `npm install -g npm@11`, because npm 10 cannot install Vite+. Odd-numbered releases such as 23
  and 25 are not supported. Run `node --version` and `npm --version` to check.
- Commit or stash your work so that you can review the migration as one diff.
- Before installing anything from 2.0, run `npm run build` and `npm run package` and confirm they
  succeed with the 1.x toolchain. If the project does not build before the migration, fix that
  first. Delete the `.foxe` file that `npm run package` writes, or add `*.foxe` to `.gitignore`.

For reference, you can generate a new 2.0 project next to yours and compare files:

```sh
npm init foxglove-extension@latest reference-extension
```

## Steps

### 1. Update dependencies

Remove the packages that 2.0 no longer uses. Skip any that are not in your `package.json`.

```sh
npm uninstall @foxglove/eslint-plugin eslint prettier typescript-eslint globals \
  webpack ts-loader style-loader css-loader worker-loader
```

If your project imports one of these packages from its own source code, keep it.

Install the 2.0 toolchain:

```sh
npm install --save-dev --save-exact create-foxglove-extension@^2 vite-plus@^1
```

The Vitest browser provider must match the Vitest version that `vite-plus` bundles. Look it up and
install the provider and Playwright:

```sh
node -p "require('./node_modules/vite-plus/package.json').dependencies.vitest"
# prints a version such as 5.0.3
npm install --save-dev --save-exact @vitest/browser-playwright@<that version> playwright@^1
npx playwright install chromium
```

### 2. Make the package an ES module

Add `"type": "module"` to `package.json`. Vite loads `vite.config.ts` as an ES module, and this
avoids a CommonJS compatibility warning.

Any other `.js` config files in the project that use `require` or `module.exports` must be
converted to `import` and `export`, or renamed to `.cjs`. Skip `eslint.config.js`, because step 7
deletes it. `dist/extension.js` is not affected because Foxglove does not load it as a Node.js
module.

### 3. Update scripts

Replace the `scripts` in `package.json` with the following. Keep any scripts of your own, such as
code generation, and keep `foxglove:prepublish` running them if it did before.

```json
{
  "scripts": {
    "build": "tsc --noEmit && vp build --mode development",
    "check": "vp check",
    "fmt": "vp fmt",
    "foxglove:prepublish": "tsc --noEmit && vp build --mode production",
    "lint": "vp lint",
    "lint:fix": "vp lint --fix",
    "local-install": "foxglove-extension install",
    "package": "foxglove-extension package",
    "test": "vp test"
  }
}
```

Vite removes types without checking them, so `build` and `foxglove:prepublish` run `tsc --noEmit`
first. That keeps a type error from reaching a `.foxe` file, as webpack's `ts-loader` did in 1.x.

Remove `lint:ci` and `pretest` if they exist. Update any CI workflows that call them to use
`npm run check` and `npm test`.

### 4. Add vite.config.ts

Create `vite.config.ts` in the project root:

```ts
import { fmtConfig, foxgloveExtension, lintConfig } from "create-foxglove-extension/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  plugins: [foxgloveExtension()],
  lint: lintConfig,
  fmt: fmtConfig,
  test: {
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
```

If the extension's entry point is not `src/index.ts`, pass it to the plugin, for example
`foxgloveExtension({ entry: "src/main.ts" })`.

### 5. Move config.ts customizations into vite.config.ts

Skip this step if the project has no `config.ts`.

The build stops with an error while `config.ts` contains webpack configuration, because that
configuration no longer applies. Translate each customization, then delete `config.ts`.

| In config.ts                                           | In 2.0                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asset/inline` rules for images, fonts, or other files | Remove. The plugin inlines every imported asset as a data URL.                                                                                                                                                                                                                                      |
| `asset/inline` rule for `.wasm`                        | Remove. Importing a `.wasm` file still returns a base64 data URL.                                                                                                                                                                                                                                   |
| `style-loader` and `css-loader` rules                  | Remove. Imported CSS is injected into the page when the extension loads. `*.module.css` files are CSS modules.                                                                                                                                                                                      |
| `worker-loader` with `inline: "no-fallback"`           | Import the worker with `?worker&inline`, for example `import MyWorker from "./my.worker.ts?worker&inline"`, then call `new MyWorker()`. Remove the `ts-loader` entry from the same rule, and delete worker-loader typing shims such as `export default {} as WorkerInterface` from the worker file. |
| `asset/source` rule or `?raw` imports                  | Remove the rule. `?raw` imports are built in.                                                                                                                                                                                                                                                       |
| `resolve.alias`                                        | [`resolve.alias`](https://vite.dev/config/shared-options#resolve-alias) in `vite.config.ts`.                                                                                                                                                                                                        |
| `resolve.fallback`                                     | The plugin maps `path` to `path-browserify` and `fs` to an empty module. For other Node.js modules, add an alias to a browser package.                                                                                                                                                              |
| `DefinePlugin`                                         | [`define`](https://vite.dev/config/shared-options#define) in `vite.config.ts`. `process.env.NODE_ENV` is already defined.                                                                                                                                                                           |
| Other loaders or plugins                               | Find the equivalent [Vite plugin](https://vite.dev/plugins/). Many Rollup plugins also work.                                                                                                                                                                                                        |

### 6. Update TypeScript configuration

In `tsconfig.json`:

- Add `"./vite.config.ts"` to `include`.
- Remove `"moduleResolution": "node"` (or `"node10"`) and `baseUrl` if they are set. The shared
  base config uses `"moduleResolution": "bundler"`, and TypeScript 7, which `vp check` uses,
  no longer supports either option. `paths` entries resolve relative to `tsconfig.json` without
  `baseUrl`, so rewrite them as `"./src/*"` style paths, and add matching
  [`resolve.alias`](https://vite.dev/config/shared-options#resolve-alias) entries in
  `vite.config.ts` so the build resolves them too.
- Set `lib` to at least `["es2020", "dom", "dom.iterable"]`, and keep any other entries the
  project needs, such as `"webworker"`. A `lib` of only `["dom"]` leaves out the JavaScript
  standard library types.
- Remove `rootDir`, `outDir`, and `declaration`, and add `"noEmit": true`. TypeScript only type
  checks the project because Vite+ builds it. Keep `"composite": false`, which overrides the shared
  base config.

Create `src/env.d.ts` so that TypeScript understands asset, `?raw`, `?worker`, and `.wasm` imports:

```ts
/// <reference types="create-foxglove-extension/client" />
```

Delete any `declare module "*.png"`, `declare module "*.wasm"`, or similar declarations that the
project added for webpack, unless they declare something different.

### 7. Replace ESLint and Prettier

Delete `eslint.config.js` (or `.eslintrc.*`), `.eslintignore`, `.prettierrc*`, and
`.prettierignore`. The ignore patterns in `lintConfig` and `fmtConfig` already cover `dist`.

`fmtConfig` uses the Prettier settings from the 1.x template: `printWidth: 100`,
`trailingComma: "all"`, `arrowParens: "always"`, `tabWidth: 2`, and `semi: true`. If the project
changed any of them, carry the changes over in `vite.config.ts`:

```ts
fmt: { ...fmtConfig, printWidth: 120 },
```

Commit the changes from steps 1 to 7 so far. Then format the project:

```sh
npm run fmt
```

On a project that followed the 1.x lint rules, `npm run fmt` mostly reorders imports, because
import sorting moves from ESLint to the formatter. If it changed any files, commit them on their own
so the rest of the migration is easier to review. If it changed nothing, there is nothing to commit.

Then check the project:

```sh
npm run check
```

`npm run check` runs Oxlint with rules that follow `@foxglove/eslint-plugin`, and type checks the
project. `lintConfig` also turns on Oxlint's `correctness` rules, which include some React rules
that 1.x did not enforce, such as `react/set-state-in-effect`. Fix what it reports. Notes for common
cases:

- `// eslint-disable-next-line <rule>` comments keep working for rules that Oxlint implements.
- `lintConfig` reports disable comments that no longer suppress anything. This includes comments
  for `@foxglove/*` rules and `import/order`, which are not part of `lintConfig`. Delete them.
- To turn a rule off, override it in `vite.config.ts`:

  ```ts
  lint: { ...lintConfig, rules: { ...lintConfig.rules, "no-warning-comments": "off" } },
  ```

`vp check` type checks with TypeScript 7 through tsgolint, not with the `typescript` package in
`node_modules`. Keep the `typescript` dependency, since the `build` and `foxglove:prepublish`
scripts and your editor use it. The two versions occasionally disagree. When they do, change the
code so that both accept it.

If the project has Jest tests, move them to Vitest. Import `describe`, `it`, `expect`, and `vi`
from `vite-plus/test`, replace `jest.fn` and `jest.mock` with `vi.fn` and `vi.mock`, and delete the
Jest config and dependencies.

### 8. Add tests

Add a test file next to each panel, such as `src/MyPanel.test.tsx`. At minimum, check that the
panel renders:

```tsx
import { cleanup, renderPanel } from "create-foxglove-extension/testing";
import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { initMyPanel } from "./MyPanel";

afterEach(cleanup);

it("renders", async () => {
  await renderPanel(initMyPanel);

  // Replace with text, a role, or a label that the panel shows when it first renders
  await expect.element(page.getByText("My panel")).toBeVisible();
});
```

Then add a test for the extension's entry point that checks what `activate` registers:

```ts
import { createExtensionContext } from "create-foxglove-extension/testing";
import { expect, it } from "vite-plus/test";

import { activate } from "./index";

it("registers its panels", () => {
  const extension = createExtensionContext();

  activate(extension.context);

  expect([...extension.panels.keys()]).toEqual(["my-panel"]);
});
```

Use the names the extension already registers. Changing a panel name breaks layouts that use it.

If a panel's `initPanel` function is not exported, take it from what `activate` registers instead of
changing the extension's exports:

```ts
const extension = createExtensionContext();
activate(extension.context);
const panel = await renderPanel(extension.panels.get("my-panel")!.initPanel);
```

`renderPanel` passes `initialState: {}` by default, as Foxglove does for a panel that was just added
to a layout. Pass `initialState` to test a panel restored from a saved layout.

The tests run with React's development build, so React warnings such as missing `key` props appear
in the test output. The 1.x example panel has one in its topic list. Fix them the same way the 2.0
template does, by putting the `key` on a `<Fragment key={...}>` around each row.

From there, `panel.render()` delivers render state such as `topics` and `currentFrame`, and the
harness records subscriptions, published messages, saved state, and the settings tree. See the
[README](./README.md#testing-your-extension) and the tests in a newly generated project for
examples.

### 9. Verify

All of these must succeed:

```sh
npm run check
npm test
npm run build
npm run package
```

Then run `npm run local-install`, open Foxglove, and confirm that each panel loads and behaves as
it did before the migration. Check panels that use workers, wasm, CSS, or images closely, since
those depended on the old webpack configuration.

Finally, add `*.foxe` and `.vitest` to `.gitignore`. `npm run package` writes `.foxe` files, and
failed browser tests write screenshots under `.vitest`. Update the project's README if it mentions
the old lint or build commands.

## Migrating with a coding agent

First, confirm the project builds with 1.x as described in [Before you start](#before-you-start).
Then install the 2.0 package so the agent can read this guide from `node_modules`:

```sh
npm install --save-dev --save-exact create-foxglove-extension@^2
```

Then give the agent this prompt:

```text
Migrate this Foxglove extension from create-foxglove-extension 1.x to 2.0.

Follow node_modules/create-foxglove-extension/MIGRATING.md step by step. Read the files in this
project before changing them, and keep the extension's behavior, panel names, and package.json
metadata (name, publisher, version, displayName, description) unchanged.

Rules:
- Commit the output of `npm run fmt` separately from the other changes.
- Do not disable lint rules or weaken TypeScript settings to make checks pass. Fix the code, or
  ask me if a fix would change behavior. Removing options that the guide says TypeScript 7 no
  longer supports is expected.
- Add a test file for every registered panel with at least an "it renders" test that checks for
  text the panel actually shows, plus a test that `activate` registers the expected panels.
- Translate every customization in config.ts before deleting it, and list each one in your
  summary with how it was translated.

You are done when `npm run check`, `npm test`, `npm run build`, and `npm run package` all pass.
Finish with a summary of what changed, anything you could not migrate, and what I should check by
hand in Foxglove.
```

The tests the agent adds give it a way to confirm the migration worked. After they pass along with
the build and package commands, load the extension in Foxglove to finish checking it.

## Troubleshooting

**`Found webpack configuration in .../config.ts`**
Follow [step 5](#5-move-configts-customizations-into-viteconfigts) and delete `config.ts`.

**`... imports the Node.js module "crypto", which extensions cannot use`**
Extensions run in the browser, where Node.js modules other than `path` and `fs` do not exist.
webpack failed the build on these imports too, unless `config.ts` set a `resolve.fallback`. Switch
to a browser package, or map the module to one with `resolve.alias` in `vite.config.ts`.

**`The build emitted assets/... in addition to extension.js`**
A worker is imported in a way that emits it as a separate file, which Foxglove cannot load. Import
it with `?worker&inline`, as in [step 5](#5-move-configts-customizations-into-viteconfigts).

**`npm error ERESOLVE` mentioning `vitest` or `@vitest/browser-playwright`**
The browser provider version does not match the Vitest version in `vite-plus`. Repeat the version
lookup in [step 1](#1-update-dependencies). Upgrade the provider whenever you upgrade `vite-plus`.

**`browserType.launch: Executable doesn't exist`**
Run `npx playwright install chromium`. On Linux CI machines, use
`npx playwright install --with-deps chromium`.

**`The panel has not set context.onRender`**
`panel.render()` throws this when the panel never set `context.onRender`. `renderPanel` waits for it
for up to `renderTimeoutMs` (one second by default) and then resolves anyway, so that panels without
a render handler can still be tested. If the panel sets `onRender` conditionally, make sure the test
provides what it waits for, such as `initialState`.

**`Cannot find element` and an empty panel**
The panel probably threw while mounting. Look for the error in the test output above the failure.
A common cause is a panel that reads fields from `context.initialState` without a fallback. Give it
a fallback, or pass `initialState` to `renderPanel`.

**`The panel did not call done()`**
Every `onRender` call must eventually call `done()`. Foxglove stops rendering a panel until it
does, so this is usually a real bug.

**`Option 'baseUrl' has been removed` or `Option 'moduleResolution=node10' has been removed`**
`vp check` type checks with TypeScript 7. See [step 6](#6-update-typescript-configuration).

**Code that uses `import.meta.url`**
The bundle is CommonJS, so the plugin defines `import.meta.url` as
`foxglove-extension://<publisher>.<name>/extension.js`. `new URL("./file.wasm", import.meta.url)`
works, because Vite inlines the file as a data URL. Nothing can be fetched relative to that URL, so
code that downloads files next to the script, such as some emscripten loaders, needs the file
imported instead and its data URL passed to the loader. This was also true with webpack, which
replaced `import.meta.url` with a path on the build machine.

**`npm error Cannot read properties of null (reading 'edgesOut')`**
npm 10 cannot install `vite-plus`. Upgrade to npm 11, or use Node.js 24, which includes it.

**Unsupported engine or syntax errors from `vp`**
Check that `node --version` is 24.11 or newer, or 22.18 or newer in the 22 line.
