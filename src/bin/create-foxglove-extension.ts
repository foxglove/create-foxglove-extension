#!/usr/bin/env node
import { Option, program } from "commander";

import { createCommand } from "..";

program
  .description(
    "Creates a new Foxglove extension. Docs: https://docs.foxglove.dev/docs/visualization/extensions/introduction",
  )
  .showHelpAfterError()
  .argument("<name>", "Name for the new extension")
  // Installs an unreleased build of this package, such as a local tarball, into the new extension
  .addOption(new Option("--create-foxglove-extension-package <spec>").hideHelp())
  .allowExcessArguments(false)
  .action(async (name: string, options: { createFoxgloveExtensionPackage?: string }) => {
    await createCommand({
      name,
      createFoxgloveExtensionPackage: options.createFoxgloveExtensionPackage,
    });
  });

program.parse(process.argv);
