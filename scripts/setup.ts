import execa from "execa";
import chalk from "chalk";
import Debug from "debug";
import fs from "fs";
import path from "path";
import pMap from "p-map";
import del from "del";
Debug.enable("setup");
const debug = Debug("setup");

async function main() {
  debug(`Cloning/Pulling all three main repos`);
  await Promise.all([
    cloneOrPull("lift"),
    cloneOrPull("photonjs"),
    cloneOrPull("prisma2")
  ]);

  debug(`Installing dependencies, building packages`);

  await pMap(
    [
      "photonjs/packages/get-platform",
      "photonjs/packages/fetch-engine",
      "photonjs/packages/engine-core",
      "photonjs/packages/photon",

      "prisma2/cli/cli",
      "prisma2/cli/generator-helper",
      "prisma2/cli/ink-components",
      "prisma2/cli/introspection",
      "prisma2/cli/sdk"
    ],
    pkg => initPackage(pkg),
    { concurrency: 4 }
  );

  await run("lift", "yarn install");
  await run("lift", "yarn build");

  await run("prisma2/cli/prisma2", "yarn install");
  await run("prisma2/cli/prisma2", "yarn build");

  // Cleanup React mess
  await del("lift/node_modules");
  await del("prisma2/cli/ink-components/node_modules");
  await del("prisma2/cli/introspection/node_modules");
  await del("prisma2/cli/prisma2/node_modules");

  // Install again
  await run("lift", "yarn install");

  // await run(".", "npx lerna bootstrap");
}

main().catch(console.error);

async function initPackage(packageName: string) {
  await run(packageName, "npm i --no-progress --no-package-lock");
  await run(packageName, "yarn build");
}

function cloneOrPull(repo: string) {
  if (fs.existsSync(path.join(__dirname, "../", repo))) {
    return run(repo, `git pull origin master`);
  } else {
    return run(".", `git clone ${repoUrl(repo)}`);
  }
}

function repoUrl(repo: string, org: string = "prisma") {
  return `https://github.com/${org}/${repo}.git`;
}

export async function run(cwd: string, cmd: string): Promise<void> {
  debug(chalk.underline("./" + cwd).padEnd(20), chalk.bold(cmd));
  try {
    await execa.command(cmd, {
      cwd,
      stdio: "inherit"
    });
  } catch (e) {
    throw new Error(
      chalk.bold.red(
        `Error running ${chalk.bold(cmd)} in ${chalk.underline(cwd)}:`
      ) + (e.stack || e.message)
    );
  }
}
