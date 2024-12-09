#!/usr/bin/env node
import { program, Option } from "commander";

import { buildCommand, installCommand, packageCommand } from "..";
import { fatal } from "../log";

function main(task: Promise<void>): void {
  task.catch(fatal);
}

program.usage("<command> [options]");

program
  .command("build")
  .description("Build an extension, preparing it for packaging or installation")
  .addOption(new Option("--mode [mode]", "Build mode").choices(["development", "production"]))
  .option("--cwd [cwd]", "Directory to run the build command in")
  .action(({ mode, cwd }) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    main(buildCommand({ mode, cwd }));
  });

program
  .command("package")
  .description("Packages an extension")
  .option("-o, --out [path]", "Output .foxe extension file to [path] location")
  .option("--cwd [cwd]", "Directory to run the package command in")
  .action(({ out, cwd }) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    main(packageCommand({ packagePath: out, cwd }));
  });

program
  .command("install")
  .description("Locally installs an extension")
  .option("--cwd [cwd]", "Directory to run the install command in")
  .action(({ cwd }) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    main(installCommand({ cwd }));
  });

program.on("command:*", ([_cmd]: string) => {
  program.outputHelp({ error: true });
  process.exit(1);
});

program.parse(process.argv);
