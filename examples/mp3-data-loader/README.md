# MP3 Data Loader

This extension allows Foxglove to open `.mp3` files and load them as a RawAudio topic.

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
