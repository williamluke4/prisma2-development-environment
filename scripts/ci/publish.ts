import chalk from 'chalk'
import execa from 'execa'
import path from 'path'
import globby from 'globby'
import topo from 'batching-toposort'
import { promises as fs } from 'fs'
import arg from 'arg'
import pMap from 'p-map'

export type Commit = {
  date: Date
  dir: string
  hash: string
  isMergeCommit: boolean
  parentCommits: string[]
}

async function getLatestChanges(allRepos: boolean): Promise<string[]> {
  const commits = await Promise.all([
    getLatestCommit('prisma2'),
    getLatestCommit('lift'),
    getLatestCommit('photonjs'),
  ])

  commits.sort((a, b) => {
    return a.date < b.date ? 1 : -1
  })

  if (allRepos) {
    return flatten(
      await Promise.all(commits.map(commit => getChangesFromCommit(commit))),
    )
  } else {
    const latestCommit = commits[0]

    return getChangesFromCommit(latestCommit)
  }
}

async function getChangesFromCommit(commit: Commit): Promise<string[]> {
  const hashes = commit.isMergeCommit
    ? commit.parentCommits.join(' ')
    : commit.hash
  const changes = await runResult(
    commit.dir,
    `git diff-tree --no-commit-id --name-only -r ${hashes}`,
  )
  if (changes.trim().length > 0) {
    return changes.split('\n').map(change => path.join(commit.dir, change))
  } else {
    throw new Error(`No changes detected. This must not happen!`)
  }
}

async function getLatestCommit(dir: string): Promise<Commit> {
  const result = await runResult(
    dir,
    'git log --pretty=format:"%ad %H %P" --date=iso-strict -n 1',
  )
  const [date, commit, ...parents] = result.split(' ')

  return {
    date: new Date(date),
    dir,
    hash: commit,
    isMergeCommit: parents.length > 1,
    parentCommits: parents,
  }
}

async function runResult(cwd: string, cmd: string): Promise<string> {
  try {
    const result = await execa.command(cmd, {
      cwd,
      stdio: 'pipe',
      shell: true,
    })
    return result.stdout
  } catch (e) {
    throw new Error(
      chalk.red(
        `Error running ${chalk.bold(cmd)} in ${chalk.underline(cwd)}:`,
      ) + (e.stderr || e.stack || e.message),
    )
  }
}

async function run(cwd: string, cmd: string): Promise<void> {
  console.log(chalk.underline('./' + cwd).padEnd(20), chalk.bold(cmd))
  try {
    await execa.command(cmd, {
      cwd,
      stdio: 'inherit',
      shell: true,
    })
  } catch (e) {
    throw new Error(
      chalk.red(
        `Error running ${chalk.bold(cmd)} in ${chalk.underline(cwd)}:`,
      ) + (e.stderr || e.stack || e.message),
    )
  }
}

type RawPackage = {
  path: string
  packageJson: any
}
type RawPackages = { [packageName: string]: RawPackage }

async function getPackages(): Promise<RawPackages> {
  const packagePaths = await globby(
    [
      'lift/package.json',
      'prisma2/cli/**/package.json',
      'photonjs/packages/**/package.json',
    ],
    {
      ignore: ['**/node_modules/**', '**/examples/**'],
    },
  )
  const packages = await Promise.all(
    packagePaths.map(async p => ({
      path: p,
      packageJson: JSON.parse(await fs.readFile(p, 'utf-8')),
    })),
  )

  return packages.reduce<RawPackages>((acc, p) => {
    if (p.packageJson.name) {
      acc[p.packageJson.name] = p
    }
    return acc
  }, {})
}

type Package = {
  name: string
  path: string
  version: string
  usedBy: string[]
  usedByDev: string[]
  uses: string[]
  usesDev: string[]
  packageJson: any
}

type Packages = { [packageName: string]: Package }

function getPackageDependencies(packages: RawPackages): Packages {
  const packageCache = Object.entries(packages).reduce<Packages>(
    (acc, [name, pkg]) => {
      acc[name] = {
        version: pkg.packageJson.version,
        name,
        path: pkg.path,
        usedBy: [],
        usedByDev: [],
        uses: getPrismaDependencies(pkg.packageJson.dependencies),
        usesDev: getPrismaDependencies(pkg.packageJson.devDependencies),
        packageJson: pkg.packageJson,
      }

      return acc
    },
    {},
  )

  for (const pkg of Object.values(packageCache)) {
    for (const dependency of pkg.uses) {
      if (packageCache[dependency]) {
        packageCache[dependency].usedBy.push(pkg.name)
      } else {
        console.info(`Skipping ${dependency} as it's not in this workspace`)
      }
    }
    for (const devDependency of pkg.usesDev) {
      if (packageCache[devDependency]) {
        packageCache[devDependency].usedByDev.push(pkg.name)
      } else {
        console.info(`Skipping ${devDependency} as it's not in this workspace`)
      }
    }
  }

  return packageCache
}

function getPrismaDependencies(dependencies?: {
  [name: string]: string
}): string[] {
  if (!dependencies) {
    return []
  }
  return Object.keys(dependencies).filter(d => d.startsWith('@prisma'))
}

function getCircularDependencies(packages: Packages): string[][] {
  const circularDeps = []
  for (const pkg of Object.values(packages)) {
    const uses = [...pkg.uses, ...pkg.usesDev]
    const usedBy = [...pkg.usedBy, ...pkg.usedByDev]
    const circles = intersection(uses, usedBy)
    if (circles.length > 0) {
      circularDeps.push(circles)
    }
  }

  return circularDeps
}

function getPackagesAffectedByChange(
  packages: Packages,
  changes: string[],
): Packages {
  const changedPackages = Object.values(packages).filter(p =>
    changes.find(c => c.startsWith(path.dirname(p.path))),
  )

  const affectedPackages: Packages = changedPackages.reduce((acc, p) => {
    acc[p.name] = p
    return acc
  }, {})

  function addDependants(pkg: Package) {
    for (const dependency of pkg.usedBy) {
      if (!affectedPackages[dependency]) {
        affectedPackages[dependency] = packages[dependency]
        addDependants(packages[dependency])
      }
    }
    for (const devDependency of pkg.usedByDev) {
      if (!affectedPackages[devDependency]) {
        affectedPackages[devDependency] = packages[devDependency]
        addDependants(packages[devDependency])
      }
    }
  }

  for (const pkg of changedPackages) {
    addDependants(pkg)
  }

  return affectedPackages
}

function getPublishOrder(packages: Packages): string[][] {
  const dag: { [pkg: string]: string[] } = Object.values(packages).reduce(
    (acc, curr) => {
      acc[curr.name] = [...curr.usedBy, ...curr.usedByDev]
      return acc
    },
    {},
  )

  return topo(dag)
}

/**
 * Either takes the BUILDKITE_TAG env var for the new version or takes the max alpha version + 1
 * For now supporting 2.0.0-alpha.X
 * @param packages Locla package definitions
 */
async function getNewPrisma2Version(packages: Packages): Promise<string> {
  if (process.env.BUILDKITE_TAG) {
    return process.env.BUILDKITE_TAG
  }
  const localPrisma2Version = packages['prisma2'].version
  const localPhotonVersion = packages['@prisma/photon'].version
  const [remotePrisma2Version, remotePhotonVersion] = await Promise.all([
    runResult('.', `npm info prisma2@alpha version`),
    runResult('.', `npm info @prisma/photon@alpha version`),
  ])

  const regex = /alpha\.(\d+)/

  const alphaVersions = [
    localPrisma2Version,
    localPhotonVersion,
    remotePrisma2Version,
    remotePhotonVersion,
  ]
    .filter(v => v.trim().length > 0)
    .map(v => {
      const match = regex.exec(v)
      if (match) {
        return Number(match[1])
      }
      return null
    })
    .filter(v => v)

  const maxAlpha = Math.max(...alphaVersions)

  return `2.0.0-alpha.${maxAlpha + 1}`
}

async function publish() {
  const args = arg({
    '--publish': Boolean,
    '--all-repos': Boolean,
  })

  const rawPackages = await getPackages()
  const packages = getPackageDependencies(rawPackages)
  const circles = getCircularDependencies(packages)
  if (circles.length > 0) {
    throw new Error(`Oops, there are circular dependencies: ${circles}`)
  }

  const changes = await getLatestChanges(args['--all-repos'])
  // const changes = ['photonjs/packages/get-platform/readme.md']
  const changedPackages = getPackagesAffectedByChange(packages, changes)

  let publishOrder = getPublishOrder(changedPackages)
  publishOrder = publishOrder.slice(3)

  if (args['--publish']) {
    await publishPackages(changedPackages, publishOrder)
  } else {
    await testPackages(changedPackages, publishOrder)
  }
}

/**
 * Tests packages in "publishOrder"
 * @param packages Packages
 * @param publishOrder string[][]
 */
async function testPackages(
  packages: Packages,
  publishOrder: string[][],
): Promise<void> {
  const order = flatten(publishOrder)
  console.log(chalk.bold(`\nGoing to run tests. Testing order:`))
  console.log(order)
  for (const pkgName of order) {
    const pkg = packages[pkgName]
    if (pkg.packageJson.scripts.test) {
      console.log(`\nTesting ${chalk.magentaBright(pkg.name)}`)
      await run(path.dirname(pkg.path), 'yarn test')
    }
  }
}

function flatten<T>(arr: T[][]): T[] {
  return arr.reduce((acc, val) => acc.concat(val), [])
}

function intersection<T>(arr1: T[], arr2: T[]): T[] {
  return arr1.filter(value => arr2.includes(value))
}

function patch(version: string): string | null {
  // Thanks 🙏 to https://github.com/semver/semver/issues/232#issuecomment-405596809
  const regex = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?<buildmetadata>[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

  const match = regex.exec(version)
  if (match) {
    return `${match.groups.major}.${match.groups.minor}.${Number(
      match.groups.patch,
    ) + 1}`
  }

  return null
}

async function publishPackages(
  packages: Packages,
  publishOrder: string[][],
): Promise<void> {
  // we need to release a new prisma2 cli in all cases.
  // if there is a change in photon, photon will also use this new version
  const prisma2Version = await getNewPrisma2Version(packages)

  console.log(
    chalk.blueBright(
      `\nPublishing ${chalk.bold(
        String(Object.values(packages).length),
      )} packages. New prisma2 version: ${chalk.bold(
        prisma2Version,
      )}. Publish order:`,
    ),
  )
  console.log(publishOrder)

  if (!prisma2Version.includes('alpha')) {
    console.log(
      chalk.red.bold(
        `\nThis will release a new version of prisma2 on latest: ${chalk.underline(
          prisma2Version,
        )}`,
      ),
    )
    console.log(
      chalk.red(
        'Are you absolutely sure you want to do this? We wait for 10secs just in case...',
      ),
    )
    await new Promise(r => {
      setTimeout(r, 10000)
    })
  } else {
    console.log(`Giving you 5sec to review the changes...`)
    await new Promise(r => {
      setTimeout(r, 5000)
    })
  }

  for (const currentBatch of publishOrder) {
    await pMap(
      currentBatch,
      async pkgName => {
        const pkg = packages[pkgName]
        const pkgDir = path.dirname(pkg.path)
        const isPrisma2OrPhoton = ['prisma2', '@prisma/photon'].includes(
          pkgName,
        )
        const tag =
          prisma2Version.includes('alpha') && isPrisma2OrPhoton
            ? 'alpha'
            : 'latest'
        const newVersion = isPrisma2OrPhoton
          ? prisma2Version
          : patch(pkg.version)

        console.log(
          `\nPublishing ${chalk.magentaBright(
            `${pkgName}@${newVersion}`,
          )} ${chalk.dim(`on ${tag}`)}`,
        )

        // If it's Prisma or Photon, there is no need to upgrade the deps
        // This is mostly here, because yarn is buggy
        if (!isPrisma2OrPhoton) {
          try {
            await run(pkgDir, 'yarn upgrade --latest --scope @prisma')
          } catch (e) {
            await run(pkgDir, 'yarn upgrade --latest --scope @prisma')
          }
        }

        await run(
          pkgDir,
          `yarn publish --tag ${tag} --new-version ${newVersion}`,
        )
      },
      {
        concurrency: 1,
      },
    )
  }
}

publish()
