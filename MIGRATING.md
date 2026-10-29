# Migrating to create-foxglove-extension 2.0

`create-foxglove-extension` generates a starting project once. Projects created with 1.x do not
change when a new version is released, so this guide explains how to bring a 1.x project up to
the 2.0 setup by hand or with a coding agent.

The steps are written so that a coding agent can follow them. To use one, see
[Migrating with a coding agent](#migrating-with-a-coding-agent).

## What changes in 2.0

| Area            | 1.x                                             | 2.0                                                                                      |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Build           | webpack, configured by `foxglove-extension`     | [Vite+](https://viteplus.dev) with the `foxgloveExtension()` plugin in `vite.config.mts` |
| Customization   | `config.ts` exporting a `webpack` function      | Vite options and plugins in `vite.config.mts`                                            |
| Lint and format | ESLint with `@foxglove/eslint-plugin`, Prettier | Oxlint and Oxfmt through `vp check`, configured by `lintConfig` and `fmtConfig`          |
| Type checking   | `ts-loader` during every build                  | `tsc --noEmit` before every build, and `vp check`                                        |
| Tests           | None                                            | Vitest in Chromium with helpers from `create-foxglove-extension/testing`                 |
| Node.js         | 14 or newer                                     | 24.11 or newer, or 22.18 or newer with npm 11                                            |

The output format does not change. `npm run package` still produces a `.foxe` file with a single
`dist/extension.js`, and Foxglove loads it the same way. A few bundler details differ from webpack,
which the [config.ts step](#5-move-configts-customizations-into-viteconfigmts) and
[troubleshooting](#troubleshooting) cover.

## Before you start

- Install Node.js 24.11 or newer. Node.js 22.18 or newer also works after upgrading to npm 11 with
  `npm install -g npm@11`, because npm 10 cannot install Vite+. Odd-numbered releases such as 23
  and 25 are not supported. Run `node --version` and `npm --version` to check.
- Commit or stash your work so that you can review the migration as one diff.
- Before installing anything from 2.0, run `npm run build` and `npm run package` and confirm they
  succeed with the 1.x toolchain. If the project does not build before the migration, fix that
  first.
- Make sure `.gitignore` lists `node_modules`, `dist`, `*.foxe`, and `.vitest`, and create it if
  the project has none. `npm run package` writes `.foxe` files, and failed browser tests write
  screenshots under `.vitest`.

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
npm install --save-dev --save-exact create-foxglove-extension@^2 vite-plus@~1.3.0
```

The build plugin is tested against this `vite-plus` release. Upgrade `vite-plus` when a new
create-foxglove-extension release asks for a newer one, rather than on its own.

npm prints an `ERESOLVE overriding peer dependency` warning about `@vitest/mocker` and `vite`
during this and later installs. It is expected, because `vite-plus` provides its own build of
Vite. If the project already needed `--legacy-peer-deps` for an older dependency, keep passing it
to every install in this guide.

The Vitest browser provider must match the Vitest version that `vite-plus` bundles. Look it up and
install the provider and Playwright:

```sh
node -p "require('./node_modules/vite-plus/package.json').dependencies.vitest"
# prints a version such as 5.0.5
npm install --save-dev --save-exact @vitest/browser-playwright@<that version> playwright@^1
npx playwright install chromium
```

### 2. Leave out "type": "module"

Do not add `"type": "module"` to `package.json`, and remove it if the project sets it. In a
`"type": "module"` package, Vite follows Node.js rules for default imports from CommonJS packages,
so packages such as `react-json-view` import as an object instead of a component, and the panel
fails with "Element type is invalid". The build warns when `"type": "module"` is set. The Vite
config uses the `.mts` extension instead, so Vite loads it as an ES module either way.

### 3. Update scripts

Replace the `scripts` in `package.json` with the following. Keep any scripts of your own, such as
code generation.

```json
{
  "scripts": {
    "build": "tsc --noEmit && vp build --mode development",
    "check": "vp check",
    "fmt": "vp fmt",
    "foxglove:prepublish": "tsc --noEmit && vp build --mode production",
    "lint": "vp check",
    "lint:ci": "vp check",
    "lint:fix": "vp check --fix",
    "local-install": "foxglove-extension install",
    "package": "foxglove-extension package",
    "test": "vp test run"
  }
}
```

Vite removes types without checking them, so `build` and `foxglove:prepublish` run `tsc --noEmit`
first. That keeps a type error from reaching a `.foxe` file, as webpack's `ts-loader` did in 1.x.

If the project builds inputs before bundling, such as WASM with `npm run build:wasm`, put that
step at the start of `build` and `foxglove:prepublish`, for example
`"build": "npm run build:wasm && tsc --noEmit && vp build --mode development"`. Tests import the
same files, so also keep a `"pretest": "npm run build:wasm"` script.

Remove `pretest` unless it builds inputs as described above. `lint` and `lint:ci` now run the same
checks as `check`, so CI workflows that call them keep working.

`npm test` runs the tests once. Run `npx vp test` instead to rerun them as files change.

### 4. Add vite.config.mts

Create `vite.config.mts` in the project root:

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

### 5. Move config.ts customizations into vite.config.mts

Skip this step if the project has no `config.ts`.

The build stops with an error while `config.ts` contains webpack configuration, because that
configuration no longer applies. Translate each customization, then delete `config.ts`.

| In config.ts                                           | In 2.0                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asset/inline` rules for images, fonts, or other files | Remove. The plugin inlines every imported asset as a data URL.                                                                                                                                                                                                                                                                                                                                                 |
| `asset/inline` rule for `.wasm`                        | Remove. Importing a `.wasm` file still returns a base64 data URL.                                                                                                                                                                                                                                                                                                                                              |
| `style-loader` and `css-loader` rules                  | Remove. Imported CSS is injected into the page when the extension loads. `*.module.css` files are CSS modules.                                                                                                                                                                                                                                                                                                 |
| `worker-loader` with `inline: "no-fallback"`           | Import the worker with `?worker&inline`, for example `import MyWorker from "./my.worker.ts?worker&inline"`, then call `new MyWorker()`. Remove the `ts-loader` entry from the same rule, and delete worker-loader typing shims such as `export default {} as WorkerInterface` from the worker file. If the worker file then has no `import` or `export`, add `export {};` so TypeScript treats it as a module. |
| `asset/source` rule or `?raw` imports                  | Remove the rule. `?raw` imports are built in.                                                                                                                                                                                                                                                                                                                                                                  |
| `resolve.alias`                                        | [`resolve.alias`](https://vite.dev/config/shared-options#resolve-alias) in `vite.config.mts`.                                                                                                                                                                                                                                                                                                                  |
| `resolve.fallback`                                     | The plugin maps `path` to `path-browserify` and `fs` to an empty module. For other Node.js modules, add an alias to a browser package.                                                                                                                                                                                                                                                                         |
| `DefinePlugin`                                         | [`define`](https://vite.dev/config/shared-options#define) in `vite.config.mts`. `process.env.NODE_ENV` is already defined.                                                                                                                                                                                                                                                                                     |
| Other loaders or plugins                               | Find the equivalent [Vite plugin](https://vite.dev/plugins/). Many Rollup plugins also work.                                                                                                                                                                                                                                                                                                                   |

### 6. Update TypeScript configuration

In `tsconfig.json`:

- Keep `include` limited to `src`. `vite.config.mts` does not need to be in it.
- Remove `"moduleResolution": "node"` (or `"node10"`) and `baseUrl` if they are set. The shared
  base config uses `"moduleResolution": "bundler"`, and TypeScript 7, which `vp check` uses,
  no longer supports either option. `paths` entries resolve relative to `tsconfig.json` without
  `baseUrl`, so rewrite them as `"./src/*"` style paths, and add matching
  [`resolve.alias`](https://vite.dev/config/shared-options#resolve-alias) entries in
  `vite.config.mts` so the build resolves them too.
- Set `lib` to at least `["es2020", "dom", "dom.iterable"]`, and keep any other entries the
  project needs, such as `"webworker"`. A `lib` of only `["dom"]` leaves out the JavaScript
  standard library types.
- Remove `rootDir`, `outDir`, and `declaration`, along with the 1.x comment above them, and add
  `"noEmit": true`. TypeScript only type checks the project because Vite+ builds it.
- Set `"composite": false`, and add it if it is missing. The shared base config sets
  `"composite": true`, which makes the type check write a `tsconfig.tsbuildinfo` file.
- `target` can be removed. Vite chooses the output target itself.
- `vp check` type checks with TypeScript 7, which only loads `@types` packages that `types` lists.
  `process.env.NODE_ENV` and `global` are declared for you. If the code uses other globals from an
  `@types` package, such as `Buffer` or `NodeJS.Timeout` from `@types/node`, install the package and
  add it to `types`, for example `"types": ["node"]`.

Create `src/env.d.ts` so that TypeScript understands asset, `?raw`, `?worker`, and `.wasm` imports:

```ts
/// <reference types="create-foxglove-extension/client" />
```

Delete any `declare module "*.png"`, `declare module "*.wasm"`, or similar declarations that the
project added for webpack, unless they declare something different.

### 7. Replace ESLint and Prettier

Delete `eslint.config.js` (or `.eslintrc.*`), `.eslintignore`, `.prettierrc*`, and
`.prettierignore`. Like the 1.x ESLint config, `lintConfig` only lints and type checks TypeScript
files in `src`, and `fmtConfig` only formats them. In VS Code, copy the `.vscode` folder from a new 2.0 project so that
format on save uses the same formatter as `npm run check`.

`fmtConfig` uses the Prettier settings from the 1.x template: `printWidth: 100`,
`trailingComma: "all"`, `arrowParens: "always"`, `tabWidth: 2`, and `semi: true`. If the project
changed any of them, carry the changes over in `vite.config.mts`:

```ts
fmt: { ...fmtConfig, printWidth: 120 },
```

Commit the changes from steps 1 to 7 so far. Then format the project:

```sh
npm run fmt
```

`fmtConfig` does not sort imports, so on a project that followed the 1.x Prettier settings,
`npm run fmt` changes little. If it changed any files, commit them on their own so the rest of the
migration is easier to review. If it changed nothing, there is nothing to commit.

Then check the project:

```sh
npm run check
```

`npm run check` checks formatting first, then runs Oxlint with the rules from the 1.x ESLint config
and type checks `src`. It shows lint results only after formatting passes. `npm run lint` runs the
same checks. `lintConfig` also turns on Oxlint's `correctness` rules, which can report a few problems that
1.x did not, such as calling `setState` in `componentDidUpdate`. Fix what it reports. Notes for common
cases:

- `// eslint-disable-next-line <rule>` comments keep working for rules that Oxlint implements.
- `lintConfig` reports disable comments that no longer suppress anything. This includes comments
  for `@foxglove/*` rules and `import/order`, which are not part of `lintConfig`. Delete them.
- Uses of deprecated APIs are reported, such as the `datatype` field of a topic. Switch to the
  replacement the message names.
- To turn a rule off, override it in `vite.config.mts`:

  ```ts
  lint: { ...lintConfig, rules: { ...lintConfig.rules, "no-warning-comments": "off" } },
  ```

`vp check` type checks with TypeScript 7 through tsgolint, not with the `typescript` package in
`node_modules`. Keep the `typescript` dependency, since the `build` and `foxglove:prepublish`
scripts and your editor use it. The two versions occasionally disagree. When they do, change the
code so that both accept it. A common case is `new Blob([bytes])`, where TypeScript 7 reports that
`Uint8Array<ArrayBufferLike>` is not assignable to `BlobPart`. Write `bytes as Uint8Array<ArrayBuffer>`
when the bytes are known to be backed by an `ArrayBuffer`.

If the project has Jest tests, move them to Vitest. Import `describe`, `it`, `expect`, and `vi`
from `vite-plus/test`, replace `jest.fn` and `jest.mock` with `vi.fn` and `vi.mock`, and delete the
Jest config and dependencies.

### 8. Add tests

Tests load the extension into a simulated Foxglove from `create-foxglove-extension/testing`. It
opens a data source with the topics and messages a test gives it, and runs the extension's panels,
converters, and topic aliases the way Foxglove does. Add a test file next to each panel, such as
`src/MyPanel.test.tsx`. At minimum, check that the panel renders:

```tsx
import { cleanup, simulateFoxglove } from "create-foxglove-extension/testing";
import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { activate } from "./index";

afterEach(cleanup);

it("renders", async () => {
  const foxglove = await simulateFoxglove({ extension: { activate } });
  await foxglove.openPanel("my-panel");

  // Replace with text, a role, or a label that the panel shows when it first renders
  await expect.element(page.getByText("My panel")).toBeVisible();
  expect(foxglove.problems).toEqual([]);
});
```

Use the panel names the extension already registers. Changing a panel name breaks layouts that use
it. `openPanel` fails with the registered names if the name is wrong.

Then test what the panel does with data. Give the simulation the topics and messages the panel
expects, play them, and check what the panel shows:

```tsx
const foxglove = await simulateFoxglove({
  extension: { activate },
  dataSource: {
    type: "recording",
    topics: [{ name: "/gps", schemaName: "GpsFix" }],
    messages: [{ topic: "/gps", receiveTime: 1, message: { lat: 1, lon: 2 } }],
  },
});
await foxglove.openPanel("my-panel", { initialState: { topic: "/gps" } });

await foxglove.advanceTo(1);

await expect.element(page.getByText("1, 2")).toBeVisible();
```

- `initialState` opens the panel as if it was restored from a saved layout. It defaults to `{}`,
  which is what Foxglove passes to a panel that was just added.
- A live data source (`type: "live"`) tests panels that publish or call services. Give it mocked
  service responses in `services`, send messages with `foxglove.receive()`, and check
  `foxglove.published` and `foxglove.serviceCalls`.
- The panel's settings appear in a settings sidebar as labeled form controls. Click and type in it
  with `page`, or call `panel.settings.update(["general", "topic"], "/imu")`.
- Converters and topic aliases that the extension registers run in the simulation. A panel that
  subscribes with `convertTo` gets converted messages.
- `fetch` requests to other servers fail unless `network.routes` answers them, so tests never
  depend on a real backend.

For an extension without panels, test what `activate` registers with `createExtensionContext`:

```ts
import type { Experimental } from "@foxglove/extension";
import { createExtensionContext, makeMessageEvent } from "create-foxglove-extension/testing";

// Pass Experimental.ExtensionContext when `activate` takes that type, as data loaders do
const extension = createExtensionContext<Experimental.ExtensionContext>();
activate(extension.context);

// A data loader
expect(extension.dataLoaders).toEqual([expect.objectContaining({ supportedFileType: ".xyz" })]);

// A schema converter
const event = makeMessageEvent({
  topic: "/gps",
  schemaName: "GpsFix",
  message: { lat: 1, lon: 2 },
});
expect(extension.schemaConverters[0]?.converter(event.message, event)).toEqual({
  latitude: 1,
  longitude: 2,
});

// A topic alias function
const aliases = extension.topicAliasFunctions[0]?.({ topics: [], globalVariables: {} });
```

The `Experimental` types need a version of `@foxglove/extension` that includes them.

The tests run with React's development build, so React warnings such as missing `key` props appear
in the test output. Coding agents get a reporter that hides the output of passing tests, so run
`npx vp test run --reporter=verbose` to see them. The 1.x example panel has one in its topic list.
Fix them the same way the 2.0 template does, by putting the `key` on a `<Fragment key={...}>` around
each row.

Vitest runs workers as module workers from its dev server, so a browser test proves a worker round
trip but not the inlined worker in the bundle. To test the bundle itself, build it and pass its
contents as `extension: { source }`. Loading the extension in Foxglove in step 9 covers that too.
See the [README](./README.md#testing-your-extension) and the tests in a newly generated project for
examples.

### 9. Verify

All of these must succeed:

```sh
npm run check
npm test
npm run build
npm run package
```

Then run `npm run local-install`, open Foxglove, and confirm that the extension behaves as it did
before the migration. Add each panel to a layout, open a file in each format a data loader
supports, and view data that a message converter or topic alias applies to. Check panels that use
workers, wasm, CSS, or images closely, since those depended on the old webpack configuration.

Finally, update the project's README if it mentions the old lint or build commands.

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
- Add a test file for every registered panel. Open the panel with `simulateFoxglove` and test at
  least that it renders text it actually shows. If the panel shows message data, also play
  messages on a topic it subscribes to and check what it shows. Add a test of what `activate`
  registers: panels, message converters, topic aliases, or data loaders.
- Run the tests with `npx vp test run --reporter=verbose` and fix any React warnings they print.
- Do not add "type": "module" to package.json.
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
Follow [step 5](#5-move-configts-customizations-into-viteconfigmts) and delete `config.ts`.

**`Element type is invalid: expected a string ... but got: object`**
The project's `package.json` sets `"type": "module"`, so a default import from a CommonJS package
returns the whole module instead of the component. Remove `"type": "module"`, as in
[step 2](#2-leave-out-type-module).

**`... imports the Node.js module "crypto", which extensions cannot use`**
Extensions run in the browser, where Node.js modules other than `path` and `fs` do not exist.
webpack failed the build on these imports too, unless `config.ts` set a `resolve.fallback`. Switch
to a browser package, or map the module to one with `resolve.alias` in `vite.config.mts`.

**`The build emitted assets/... in addition to extension.js`**
A worker is imported in a way that emits it as a separate file, which Foxglove cannot load. Import
it with `?worker&inline`, as in [step 5](#5-move-configts-customizations-into-viteconfigmts).

**`npm error ERESOLVE` mentioning `vitest` or `@vitest/browser-playwright`**
The browser provider version does not match the Vitest version in `vite-plus`. Repeat the version
lookup in [step 1](#1-update-dependencies). Upgrade the provider whenever you upgrade `vite-plus`.
An `npm error ERESOLVE` about another package, such as `react-json-view` and React 18, is an
existing peer conflict in the project. Pass `--legacy-peer-deps` to the installs, as the project
did before.

**`npm warn ERESOLVE overriding peer dependency` or `npm ls` reporting an invalid `vite`**
Both are expected. `vite-plus` provides its own build of Vite under the `vite` name.

**`browserType.launch: Executable doesn't exist`**
Run `npx playwright install chromium`. On Linux CI machines, use
`npx playwright install --with-deps chromium`.

**`The simulated Foxglove did not settle`**
The message names the cause. Most often a panel did not call `done()` after a render, or called its
context on every render, for example by setting a variable each time it renders. Foxglove would
keep rendering that panel without stopping.

**`initPanel of panel "..." threw` or an empty panel**
The panel threw while mounting. A common cause is a panel that reads fields from
`context.initialState` without a fallback. Give it a fallback, or pass `initialState` to
`openPanel`.

**`Panel "..." did not call done()`**
Every `onRender` call must eventually call `done()`. Foxglove stops rendering a panel until it does,
so this is usually a real bug.

**`No mocked response for GET https://...`**
The extension called `fetch`. Add a route for it to `network.routes` in the `simulateFoxglove`
options. Set `network.allowUnmocked` only if the test should reach the real server.

**`Option 'baseUrl' has been removed` or `Option 'moduleResolution=node10' has been removed`**
`vp check` type checks with TypeScript 7. See [step 6](#6-update-typescript-configuration).

**Code that expects base64 image data URLs**
Vite inlines SVG files as URL-encoded `data:image/svg+xml,...` URLs and other files as base64. Both
work as an `<img>` source. Code that decodes the data URL itself needs to handle both forms.

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
