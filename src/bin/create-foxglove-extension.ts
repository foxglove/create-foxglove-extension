#!/usr/bin/env node
import { program } from "commander";

import { createCommand } from "..";

program
  .description(
    "Creates a new Foxglove extension. Docs: https://docs.foxglove.dev/docs/visualization/extensions/introduction",
  )
  .showHelpAfterError()
  .argument("<name>", "Name for the new extension")
  .allowExcessArguments(false)
  .action(async (name: string) => {
    await createCommand({ name });
  });

program.parse(process.argv);
