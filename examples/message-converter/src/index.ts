import { ExtensionContext } from "@foxglove/extension";
import { LocationFix } from "@foxglove/schemas";

type MyGps = {
  lat: number;
  lon: number;
};

// activate is the entry point for our entire extension.
export function activate(extensionContext: ExtensionContext): void {
  // Register a message converter from our custom Gps message type to `foxglove.LocationFix`
  // This will enable Foxglove to visualize our custom Gps message in the Map panel.
  extensionContext.registerMessageConverter({
    fromSchemaName: "My.Gps",
    toSchemaName: "foxglove.LocationFix",
    converter: (msg: MyGps): Partial<LocationFix> => {
      return {
        latitude: msg.lat,
        longitude: msg.lon,
      };
    },
  });
}
