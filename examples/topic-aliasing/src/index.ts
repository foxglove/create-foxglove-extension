import { ExtensionContext } from "@lichtblick/suite";

export function activate(extensionContext: ExtensionContext): void {
  // Register a topic alias function that takes the current list of datasource topics and
  // global variables and outputs a list of topic aliases.
  extensionContext.registerTopicAliases(({ topics, globalVariables }) => {
    // Output a list of aliased topics, in this case influenced by the current value of
    // the global variable `device`.
    const camera = globalVariables["camera"] ?? "FRONT";
    const bulkAliasedTopics = topics.map((topic) => {
      return {
        sourceTopicName: topic.name,
        name: `/bulk_aliases${topic.name.toLowerCase()}`,
      };
    });
    return [
      { sourceTopicName: `/CAM_${camera}/image_rect_compressed`, name: `/selected_camera_image` },
      { sourceTopicName: "/imu", name: "/aliased_imu" },
      { sourceTopicName: "/odom", name: "/aliased_odom" },
      ...bulkAliasedTopics,
    ];
  });
}
