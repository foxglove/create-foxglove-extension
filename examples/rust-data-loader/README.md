# ndjson foxglove data loader example

## _A Foxglove Data Loader _

This is a simple [Foxglove](http://foxglove.dev/) [extension panel](https://docs.foxglove.dev/docs/visualization/extensions/api/panel) that demonstrates loading a custom file format.

---

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

Once you have installed this extension, you can load files with a `.ndjson` extension such as the
`example.ndjson` file included in this directory.
