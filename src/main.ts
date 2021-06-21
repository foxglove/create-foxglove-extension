import program, { Option } from "commander";

import { buildCommand } from "./build";
import { createCommand } from "./create";
import { fatal } from "./log";
import { installCommand, packageCommand, publishCommand } from "./package";

function main(task: Promise<void>): void {
  task.catch(fatal);
}

module.exports = function (argv: string[]): void {
  program.usage("<command> [options]");

  program
    .command("create <name>")
    .description("Create a new extension")
    .option("--cwd [cwd]", "Directory to create the extension in")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    .action((name, { cwd }) => main(createCommand({ name, cwd })));

  program
    .command("build")
    .description("Build an extension, preparing it for packaging or installation")
    .addOption(new Option("--mode [mode]", "Build mode").choices(["development", "production"]))
    .option("--cwd [cwd]", "Directory to run the build command in")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    .action(({ mode, cwd }) => main(buildCommand({ mode, cwd })));

  program
    .command("package")
    .description("Packages an extension")
    .option("-o, --out [path]", "Output .foxe extension file to [path] location")
    .option("--cwd [cwd]", "Directory to run the package command in")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    .action(({ out, cwd }) => main(packageCommand({ packagePath: out, cwd })));

  program
    .command("install")
    .description("Locally installs an extension")
    .option("--cwd [cwd]", "Directory to run the install command in")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    .action(({ cwd }) => main(installCommand({ cwd })));

  program
    .command("publish")
    .description(
      "Create an extensions.json entry for a released extension. This can be added to the https://github.com/foxglove/studio-extension-marketplace repository",
    )
    .option("--foxe <foxe>", "URL of the published .foxe file")
    .option("--cwd [cwd]", "Directory containing the extension package.json file")
    .option("--version [version]", "Version of the published .foxe file")
    .option("--readme [readme]", "URL of the extension README.md file")
    .option("--changelog [changelog]", "URL of the extension CHANGELOG.md file")
    .action((options) => main(publishCommand(options)));

  program.on("command:*", ([_cmd]: string) => {
    program.outputHelp({ error: true });
    process.exit(1);
  });

  program.parse(argv);
};
