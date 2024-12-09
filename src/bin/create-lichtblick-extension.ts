#!/usr/bin/env node
import { program } from "commander";

import { createCommand } from "..";

program
  .description("Creates a new Lichtblick extension.")
  .showHelpAfterError()
  .argument("<name>", "Name for the new extension")
  .allowExcessArguments(false)
  .action(async (name: string) => {
    await createCommand({ name });
  });

program.parse(process.argv);
