import { ExtensionContext as BaseExtensionContext } from "@foxglove/extension";

declare module "@foxglove/extension" {
  namespace Experimental {
    type FileExtension = `.${string}`;

    type LoaderVersion = "0.1.0";

    export type RegisterCustomDataLoaderArgs = {
      name: string;
      loaderVersion: LoaderVersion;
      supportedFileTypes: readonly FileExtension[];
      supportsMultiFile?: boolean;
      wasmUrl: string;
    };

    export interface ExtensionContext extends BaseExtensionContext {
      registerCustomDataLoader(args: RegisterCustomDataLoaderArgs): void;
    }
  }
}

declare module "*.wasm" {
  const url: string;
  export default url;
}
