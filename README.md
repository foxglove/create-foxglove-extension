# create-foxglove-extension

[![npm version](https://img.shields.io/npm/v/create-foxglove-extension.svg?style=flat)](https://www.npmjs.com/package/create-foxglove-extension)

## Introduction

[Foxglove](https://foxglove.dev) allows developers to create
[extensions](https://docs.foxglove.dev/docs/visualization/extensions/introduction), or custom code
that is loaded and executed inside the Foxglove application. Extensions are authored in TypeScript
using the `@foxglove/extension` SDK.

## Upgrading from 1.x

Version 2.0 builds extensions with Vite+ instead of webpack, replaces ESLint and Prettier with
Oxlint and Oxfmt, and adds browser tests. Projects created with 1.x do not update on their own.
Follow [MIGRATING.md](./MIGRATING.md) to upgrade one by hand or with a coding agent.

## Creating Your First Extension

Make sure you have [Node.js](https://nodejs.org/) 24.11 or a newer 24.x release installed. Node.js
22.18 and newer 22.x releases also work after upgrading to npm 11 with `npm install -g npm@11`, since
npm 10 cannot install Vite+.
In a terminal, go into the directory where you keep source code (ex: `cd ~/Code`) and run the
following command:

```sh
npm init foxglove-extension@latest helloworld
```

Feel free to choose an extension name other than _helloworld_. Otherwise, this will create
a folder named _helloworld_ containing your extension. Run a one-time initialization step:

```sh
cd helloworld
npm install
```

This installs all of the dependencies needed to edit and build the extension. You can use
any editor to work on this project, although [VSCode](https://code.visualstudio.com/) is
the best supported IDE for authoring Foxglove extensions. Look at the files
`src/index.ts` and `src/ExamplePanel.tsx` for a simple example of creating a React element
and registering it as a custom panel. To build and install this extension into your local
Foxglove extensions folder, run:

```sh
npm run local-install
```

This should create a folder under your home directory such as
`~/.foxglove-studio/extensions/unknown.helloworld-0.0.0` containing your compiled
extension. Start Foxglove. If everything succeeded, you should be able to add a new
panel in Foxglove named _"ExamplePanel"_. Each time you make a change to your
extension, you will need to run `npm run local-install` again to build it and copy the
build output to the Foxglove extensions folder in your home directory. You can
either reload Foxglove or close and reopen it to load your latest extension code.

If you just want to confirm your code compiles without installing it locally, run `npm run build`,
which type checks your code with TypeScript and then builds it. Run `npm run check` to check
formatting, lint, and types with [Oxfmt](https://oxc.rs/docs/guide/usage/formatter) and
[Oxlint](https://oxc.rs/docs/guide/usage/linter). `npm run fmt` formats your code.

Extensions are built with [Vite+](https://viteplus.dev). The `vite.config.mts` file in your
extension includes the `foxgloveExtension()` plugin, which bundles your code into the single
`dist/extension.js` file that Foxglove loads. Add Vite plugins or options to customize the build:

```typescript
import { fmtConfig, foxgloveExtension, lintConfig } from "create-foxglove-extension/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [foxgloveExtension()],
  lint: lintConfig,
  fmt: fmtConfig,
});
```

The plugin sets the output format, so leave `build.lib` and `build.rolldownOptions.output` out of
`vite.config.mts`.

Images, fonts, `.wasm` files, and CSS imported from your code are inlined into the bundle. Import a
file with `?raw` to get its contents as a string, or with `?worker&inline` to get a Web Worker
constructor. Workers must use `?worker&inline`, because Foxglove only loads `extension.js`.

## Testing Your Extension

New extensions include tests that run with [Vitest](https://vitest.dev) in Chromium, through
Playwright. Install Chromium once, then run the tests:

```sh
npx playwright install chromium
npm test
```

`create-foxglove-extension/testing` simulates Foxglove in the test's browser page. It loads your
extension, opens a data source with the topics and messages you give it, and runs your panels the
way Foxglove does. Nothing reaches a real backend: messages, service responses, parameters, and
`fetch` responses all come from the test.

```typescript
import { cleanup, simulateFoxglove } from "create-foxglove-extension/testing";
import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { activate } from "./index";

afterEach(cleanup);

it("shows the latest speed", async () => {
  const foxglove = await simulateFoxglove({
    extension: { activate },
    dataSource: {
      type: "recording",
      topics: [{ name: "/speed", schemaName: "Speed" }],
      messages: [
        { topic: "/speed", receiveTime: 1, message: { value: 2 } },
        { topic: "/speed", receiveTime: 2, message: { value: 3 } },
      ],
    },
  });
  await foxglove.openPanel("speed-panel");

  await foxglove.advanceTo(2);

  await expect.element(page.getByText("3 m/s")).toBeVisible();
});
```

What the simulation does, like Foxglove:

- Panels get only the render state fields they watch, in one render state object, and render again
  only after they call `done()`. A panel that never calls `done()` fails the test.
- Playback delivers messages only on subscribed topics. Seeking, and changing subscriptions, gives
  each topic its latest message and sets `didSeek`. `advanceTo()` plays frame by frame, and `play()`
  plays in real time.
- The extension's message converters, topic converters, and topic aliases run. Variables, shared
  panel state, and the preview time that panels set come back to them as render state.
- The panel's settings tree appears in a settings sidebar as labeled form controls. Tests can click
  and type in it with `page`, or call `panel.settings.update(path, value)`.
- A recording can seek and load message ranges. A live data source (`type: "live"`) can publish,
  call services, and set parameters. Tests send live messages with `foxglove.receive()`. Service
  handlers in `services` and `onPublish` play the robot: they get a `robot` that can send messages
  back.
- Requests made with `fetch` and `XMLHttpRequest` get the responses in `network.routes`. Requests
  to other servers that no route answers fail, and so do WebSocket and EventSource connections to
  other servers. Images, stylesheets, and fonts from other servers, and requests from workers, are
  not intercepted.

After clicking or typing, `await foxglove.settle()` waits until panels have rendered and until
service calls, mocked responses, and `onPublish` have finished. Expectations made with
`expect.element()` and `expect.poll()` retry on their own.

To find elements in one panel, use its test id: `page.getByTestId(panel.testId).getByText("...")`.
The settings sidebar has its own: `page.getByTestId(panel.settings.testId)`.

`foxglove.problems` lists what Foxglove would warn about, such as a converter that threw or a
blocked request. `renderPanel(initPanel)` opens one panel without an `activate` function.
`createExtensionContext()` records what `activate` registers, and `makeMessageEvent()` builds an
event to call a message converter with directly.

Tests run your source. To test the built `dist/extension.js` the way Foxglove loads it, run
`npm run build` first, then pass the file's contents as `extension: { source }`. One way to read it
without failing when it has not been built:

```typescript
const [source] = Object.values(
  import.meta.glob<string>("../dist/extension.js", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);
```

Tests run headless. To watch them in a browser window, run `npx vp test --browser.headless=false`.

## Publishing Your Extension

All of the metadata for your extension is contained in the _package.json_ file. Before
publishing, make sure you have set `name`, `publisher`, `version`, and `description`. When
you are ready to distribute your extension, run:

```sh
npm run package
```

This will produce a _.foxe_ file such as `helloworld-0.0.0.foxe`. This is essentially a
ZIP archive containing your extension manifest and compiled code that can be opened by the
Foxglove application, which will unpack it and install it to the
`~/.foxglove-studio/extensions` folder. Stay tuned for future instructions on how to
publish Foxglove extensions to a registry so other users can easily search for and
install your extension.

## Examples

You can find examples of different kinds of extensions in the `./examples` directory.

## Stay in touch

Join our [Discord](https://foxglove.dev/chat) to ask questions, share
feedback, and stay up to date on what our team is working on.

## Developer information

Information on developing `create-foxglove-extension` itself.

### Build and Run Locally

Build the `create-foxglove-extension` package locally with:

```bash
npm pack
```

Run the extension generator. The hidden `--create-foxglove-extension-package` option installs the
local build into the new extension instead of the published release:

```bash
npx ./create-foxglove-extension-{VERSION}.tgz example-extension-name \
  --create-foxglove-extension-package ./create-foxglove-extension-{VERSION}.tgz
```

### Release process

1. Bump the version in package.json, and merge to main
2. [Create a new release](https://github.com/foxglove/create-foxglove-extension/releases/new)
3. Create a tag for the version above, with a leading "v" (`v0.0.0`)
4. Generate release notes
5. Publish the release
