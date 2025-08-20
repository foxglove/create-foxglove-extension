# CSV Data Loader

This is a simple [Foxglove](https://foxglove.dev/) [extension](https://docs.foxglove.dev/docs/visualization/extensions) that loads a CSV file.
The file must have a column called `timestamp_nanos` in order to be read.

## Building

Install rust with [rustup](https://www.rust-lang.org/tools/install), then install wasm32 support:

```
rustup target add wasm32-unknown-unknown
```

Then to build the rust code and generate the extension file:

```
npm install
npm run package
```

These steps will produce a `.foxe` file you can install as an extension from the Foxglove settings page.
