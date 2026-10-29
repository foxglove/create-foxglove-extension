# ${NAME}

[Foxglove](https://foxglove.dev) allows developers to create [extensions](https://docs.foxglove.dev/docs/visualization/extensions/introduction), or custom code that is loaded and executed inside the Foxglove application. This can be used to add custom panels. Extensions are authored in TypeScript using the `@foxglove/extension` SDK.

## Develop

Extension development uses the `npm` package manager to install development dependencies and run build scripts.

To install extension dependencies, run `npm` from the root of the extension package.

```sh
npm install
```

To build and install the extension into your local Foxglove desktop app, run:

```sh
npm run local-install
```

Open the Foxglove desktop (or `ctrl-R` to refresh if it is already open). Your extension is installed and available within the app.

## Test

Tests run with [Vitest](https://vitest.dev) in Chromium. Install Chromium once, then run the tests:

```sh
npx playwright install chromium
npm test
```

The tests load your extension into a simulated Foxglove from `create-foxglove-extension/testing`.
`src/ExamplePanel.test.tsx` opens the example panel against a simulated recording, plays it, and
checks what the panel shows. Use it as a starting point:

- `simulateFoxglove({ extension: { activate }, dataSource })` loads the extension and opens a data
  source with the topics and messages you give it. `dataSource` can be a recording or a live
  connection with mocked services.
- `foxglove.openPanel(name)` opens one of your panels. Its settings appear in a settings sidebar
  that tests can click and type in.
- `foxglove.advanceTo(time)`, `seek(time)`, and `receive(messages)` play messages to your panels,
  frame by frame, the way Foxglove does.
- `page` from `vite-plus/test/browser` finds and clicks elements, the way a user would.

To watch the tests run in a browser window, run `npx vp test --browser.headless=false`.

Run `npm run check` to check formatting, lint, and types.

## Package

Extensions are packaged into `.foxe` files. These files contain the metadata (package.json) and the build code for the extension.

Before packaging, make sure to set `name`, `publisher`, `version`, and `description` fields in _package.json_. When ready to distribute the extension, run:

```sh
npm run package
```

This command will package the extension into a `.foxe` file in the local directory.

## Publish

You can publish the extension to the public registry or privately for your organization.

See documentation here: https://docs.foxglove.dev/docs/visualization/extensions/publish/#packaging-your-extension
