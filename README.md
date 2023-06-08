# create-foxglove-extension

[![npm version](https://img.shields.io/npm/v/create-foxglove-extension.svg?style=flat)](https://www.npmjs.com/package/create-foxglove-extension)

## Introduction

[Foxglove Studio](https://github.com/foxglove/studio) allows developers to create
extensions, or custom code that is loaded and executed inside the Foxglove Studio
application. This can be used to add custom panels. Extensions are authored in TypeScript
using the `@foxglove/studio` SDK.

## Creating Your First Extension

Make sure you have [Node.js](https://nodejs.org/) 14 or newer installed. In a terminal, go
into the directory where you keep source code (ex: `cd ~/Code`) and run the following
command:

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
the best supported IDE for authoring Foxglove Studio extensions. Look at the files
`src/index.ts` and `src/ExamplePanel.tsx` for a simple example of creating a React element
and registering it as a custom panel. To build and install this extension into your local
Foxglove Studio extensions folder, run:

```sh
npm run local-install
```

This should create a folder under your home directory such as
`~/.foxglove-studio/extensions/unknown.helloworld-0.0.0` containing your compiled
extension. Start Foxglove Studio. If everything succeeded, you should be able to add a new
panel in Foxglove Studio named _"ExamplePanel"_. Each time you make a change to your
extension, you will need to run `npm run local-install` again to build it and copy the
build output to the Foxglove Studio extensions folder in your home directory. You can
either reload Foxglove Studio or close and reopen it to load your latest extension code.

If you just want to confirm your code compiles without installing it locally, run `npm run build`.

You can customize the build and install process by editing your `./config.ts` file. The
config file should look something like this:

```typescript
module.exports = {
  webpack: (config) => {
    config.module.rules.push({
      test: /\.css$/i,
      use: ["style-loader", "css-loader"],
    });
    return config;
  },
};
```

## Publishing Your Extension

All of the metadata for your extension is contained in the _package.json_ file. Before
publishing, make sure you have set `name`, `publisher`, `version`, and `description`. When
you are ready to distribute your extension, run:

```sh
npm run package
```

This will produce a _.foxe_ file such as `helloworld-0.0.0.foxe`. This is essentially a
ZIP archive containing your extension manifest and compiled code that can be opened by the
Foxglove Studio application, which will unpack it and install it to the
`~/.foxglove-studio/extensions` folder. Stay tuned for future instructions on how to
publish Foxglove Studio extensions to a registry so other users can easily search for and
install your extension.

## Examples

You can find examples of different kinds of extensions in the `./examples` directory.

## Stay in touch

Join our [Slack channel](https://foxglove.dev/join-slack) to ask questions, share
feedback, and stay up to date on what our team is working on.
