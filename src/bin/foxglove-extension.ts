#!/usr/bin/env node
import { program, Option } from "commander";

import { buildCommand, installCommand, packageCommand, publishCommand, PublishOptions } from "..";
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

program
  .command("publish")
  .description(
    "Create an extensions.json entry for a released extension. This can be added to the https://github.com/foxglove/extension-registry repository",
  )
  .option("--foxe <foxe>", "URL of the published .foxe file")
  .option("--cwd [cwd]", "Directory containing the extension package.json file")
  .option("--version [version]", "Version of the published .foxe file")
  .option("--readme [readme]", "URL of the extension README.md file")
  .option("--changelog [changelog]", "URL of the extension CHANGELOG.md file")
  .action((options: PublishOptions) => {
    main(publishCommand(options));
  });

program.on("command:*", ([_cmd]: string) => {
  program.outputHelp({ error: true });
  process.exit(1);
});

program.parse(process.argv);
