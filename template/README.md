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

Tests run with [Vitest](https://vitest.dev) in browser mode, so panels render in Chromium the same
way they do in Foxglove. Install the browser once, then run the tests:

```sh
npx playwright install chromium
npm test
```

`src/ExamplePanel.test.tsx` and `src/index.test.ts` show how to test a panel and the extension's
`activate` function with the helpers from `create-foxglove-extension/testing`:

- `renderPanel(initPanel)` mounts a panel with a mock Foxglove context and records what the panel
  does with it, such as subscriptions, published messages, and saved state.
- `panel.render(renderState)` delivers render state the way Foxglove does and waits for the panel
  to call `done()`.
- `createExtensionContext()` records the panels and converters an extension registers.

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
