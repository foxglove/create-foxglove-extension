import { ExtensionContext } from "@foxglove/studio";

export function activate(extensionContext: ExtensionContext): void {
  // Register a topic alias function that takes the current list of datasource topics and
  // global variables and outputs a list of topic aliases.
  extensionContext.registerTopicAliases(({ topics, globalVariables }) => {
    // Output a list of aliased topics, in this case influenced by the current value of
    // the global variable `device`.
    const device = globalVariables["device"] ?? "default";
    const bulkAliasedTopics = topics.map((topic) => {
      return {
        sourceTopicName: topic.name,
        name: `/bulk_aliases${topic.name}`,
      };
    });
    return [
      { sourceTopicName: "/imu", name: `/aliased_imu_${device}` },
      { sourceTopicName: "/odom", name: "/aliased_odom" },
      ...bulkAliasedTopics,
    ];
  });
}
