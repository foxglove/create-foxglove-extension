# topic-aliasing-extension

This is an example of a Lichtblick topic alias extension. Topic alias extensions
dynamically alias data source topics to topics with new names of your choosing.

This example automatically remaps all topics as well as remapping a specific topic
selected by the user by setting the `camera` global variable.

## Develop

Extension development uses the `npm` package manager to install development dependencies
and run build scripts.

To install extension dependencies, run `npm` from the root of the extension package.

```sh
npm install
```

To build and install the extension into your local Lichtblick desktop app, run:

```sh
npm run local-install
```

Open the Lichtblick desktop app (or `ctrl-R` to refresh if it is already open). Your
extension is installed and available within the app.

## Package

Extensions are packaged into `.foxe` files. These files contain the metadata
(package.json) and the build code for the extension.

Before packaging, make sure to set `name`, `publisher`, `version`, and `description`
fields in _package.json_. When ready to distribute the extension, run:

```sh
npm run package
```

This command will package the extension into a `.foxe` file in the local directory.

## Publish

You can publish the extension for the public marketplace or privately for your
organization.
