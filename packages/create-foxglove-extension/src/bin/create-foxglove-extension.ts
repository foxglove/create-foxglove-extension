#!/usr/bin/env node
import { program } from "commander";

import { createCommand } from "../create";

program
  .description("Creates a new Foxglove Studio extension")
  .showHelpAfterError()
  .argument("<name>", "Name for the new extension")
  .allowExcessArguments(false)
  .action(async (name: string) => {
    return await createCommand({ name });
  });

program.parse(process.argv);
