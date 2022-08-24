import fs from 'fs'
import url from 'url'
import path from 'path'
import readline from 'readline/promises'
import { current, produce } from 'immer'
import { execa } from 'execa'
import * as _ from 'lodash'
import { NixFlakeMetadata, NixTaskObject, Task } from './interfaces'
import { notEmpty } from './ts'
import chalk from 'chalk'

let getTasksNix = fs.readFileSync(
  path.join(__dirname, '../../nix/lib/getTasks.nix'),
  'utf8',
)
getTasksNix = getTasksNix.substring(
  0,
  getTasksNix.lastIndexOf('# __beginExports__'),
)

export async function nixCurrentSystem() {
  return JSON.parse(
    (
      await execa('nix', [
        'eval',
        '--impure',
        '--json',
        '--expr',
        'builtins.currentSystem',
      ])
    ).stdout,
  )
}

export async function nixGetTasksFromFlake(
  flakeUrl: string,
  flakeTaskAttributes: string[],
) {
  let nixOutputRaw

  // remove tasks. prefix from each attribute path
  // as we pass the tasks attribute to the installable arg for nix eval
  const chompedTaskPaths = flakeTaskAttributes.map(taskAttr => {
    if (!taskAttr.startsWith('tasks.')) {
      throw new Error(
        'nixGetTasksFromFlake(): All tasks must be part of the tasks attribute on the flake outputs',
      )
    }
    return taskAttr.substring('tasks.'.length)
  })

  try {
    const nixArgs = [
      'eval',
      '--json',
      '--apply',
      getTasksNix +
        '\n' +
        `
        let
          taskPaths = [ ${chompedTaskPaths
            .map(attr => `flakeTasks.${attr}`)
            .join(' ')} ];
        in
        flakeTasks: formatTasks (flatten [
          ${chompedTaskPaths
            .map(
              attr => `
          (collectTasks {
            output = flakeTasks.${attr};
            currentPath = ${JSON.stringify('tasks.' + attr)};
          })
          `,
            )
            .join('\n')}
        ])
      `,
      `${flakeUrl}#tasks`,
    ]

    const { stdout } = await execa('nix', nixArgs, { stderr: 'inherit' })

    nixOutputRaw = stdout
  } catch (ex) {
    if (ex.name === 'MaxBufferError') {
      console.error('Max buffer exceeded, circular dependency somewhere?')
      process.exit(1)
    }

    console.error(ex.stderr)
    process.exit(1)
  }

  const nixOutput: any = JSON.parse(nixOutputRaw as string)

  return nixOutput
}

function collectTasks(
  output: any,
  flakePathToUse: string,
  originalFlakeUrl: string,
  passedTaskPaths: string[] = [],
): Task[] {
  return produce<(Task & NixTaskObject)[]>(output, draft => {
    for (const task of draft) {
      const allDiscoveredDeps: any = []

      Object.keys(task.deps).forEach(depKey => {
        const value = task.deps[depKey]
        const foundTaskForDependency =
          typeof value === 'string'
            ? draft.find((_task: any) => _task.id === value)
            : null

        if (foundTaskForDependency) {
          task.deps[depKey] = foundTaskForDependency
          allDiscoveredDeps.push(task.deps[depKey])
        }
      })

      task.allDiscoveredDeps = allDiscoveredDeps
      task.ref = [flakePathToUse, task.flakeAttributePath].join('#')
      task.exactRefMatch = passedTaskPaths.includes(task.flakeAttributePath)
      task.name = task.flakeAttributePath.split('.').at(-1)!
      task.flakePath = flakePathToUse
      task.originalFlakeUrl = originalFlakeUrl
    }

    return draft
  })
}

async function rewriteTaskPaths(taskPaths: string[]) {
  const currentSystem = await nixCurrentSystem()

  return taskPaths.map(taskPath => {
    const [p, a] = taskPath.split('#')
    return [p, `tasks.${currentSystem}` + (a !== '' ? `.${a}` : '')].join('#')
  })
}

export async function nixGetTasks(
  taskPathsIn: string[],
  opts?: { forDevShell?: boolean },
) {
  const taskPaths = await rewriteTaskPaths(taskPathsIn)

  const taskSplitPaths = taskPaths.map(taskPath => {
    const split = taskPath.split('#')
    return { flakeUrl: split[0], attribute: split[1] }
  })

  // of all the provided tasks, get the unique flake refs
  const flakeUrls = _.uniq(taskSplitPaths.map(taskPath => taskPath.flakeUrl))

  // get flake metadata for each flake ref
  const flakeMetadata: { [key: string]: NixFlakeMetadata } = {}
  for (const flakeUrl of flakeUrls) {
    flakeMetadata[flakeUrl] = await nixGetFlakeMetadata(flakeUrl)
  }

  // get tasks from each provided flake
  let tasks: Task[] = []

  for (const flakeUrl of flakeUrls) {
    const flakeTaskPaths = taskSplitPaths
      .filter(taskPath => taskPath.flakeUrl === flakeUrl)
      .map(taskPath => taskPath.attribute)

    const flakeMeta = flakeMetadata[flakeUrl] ?? {}

    // ideally we want to use the flake copied into /nix/store from this point onwards so that
    // if the user makes any changes to the repo source while nix-task is running, they don't get
    // reflected or break anything until the next nix-task execution.

    // however, nix can't use a flake nested in another flake when it's stored in /nix/store,
    // (this code path gets triggered https://github.com/NixOS/nix/blob/4c8210095e7ed8de2eb4789b0ac6f9b4a39e394e/src/libcmd/installables.hh#L73)
    // so instead we check if a directory is present on the flake, if so use the original source flake directory and print a warning,
    // else use the flake in /nix/store
    let flakePathToUse = path.join(
      ...[flakeMeta.path, flakeMeta.resolved?.dir].filter(notEmpty),
    )
    if (opts?.forDevShell && flakeMeta.originalUrl.startsWith('git+file://')) {
      // always try and resolve flake path to local repo when using a dev shell, as we actually
      // want changes to the Nix files during nix-task shell to be reflected. This is desired behaviour.
      const localRepoPath = getFlakeUrlLocalRepoPath(flakeMeta.originalUrl)
      if (localRepoPath != null) {
        flakePathToUse = localRepoPath.flakeDirectory
      }
    } else if (
      flakeMeta.resolved?.dir != null &&
      flakeMeta.originalUrl.startsWith('git+file://')
    ) {
      // TODO we could resort to copying this nested flake into the store as a separate path or something
      // to avoid this undesirable behaviour?
      console.warn(
        chalk.bold.yellow('warning:'),
        'Flake is in a sub directory of another flake, cannot use immutable source from /nix/store',
      )
      console.warn(
        chalk.bold.yellow('warning:'),
        'This means any changes to the repo source during task execution could break or affect execution',
      )
      flakePathToUse = flakeUrl
    }

    const res = await nixGetTasksFromFlake(flakePathToUse, flakeTaskPaths)
    tasks.push(
      ...collectTasks(
        res,
        flakePathToUse,
        flakeMeta.originalUrl,
        flakeTaskPaths,
      ),
    )
  }

  return tasks
}

export async function preBuild(tasks: Task[]) {
  const proc = execa(
    'nix-store',
    [
      '--realise',
      ..._.uniq(
        tasks.reduce(
          (curr, task) => [...curr, ...(task.storeDependencies ?? [])],
          [],
        ),
      ),
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const stdout = readline.createInterface({
    input: proc.stdout as NodeJS.ReadableStream,
    terminal: false,
  })
  const stderr = readline.createInterface({
    input: proc.stderr as NodeJS.ReadableStream,
    terminal: false,
  })
  stdout.on('line', line => {
    // discard logging any lines where nix-store is just printing store paths
    if (line.match(/^\/nix\/store\/[a-z0-9]{32}-[\w\.-]+$/) == null) {
      console.log(line)
    }
  })
  stderr.on('line', line => {
    // discard logging warnings about paths not being added to garbage collector
    if (
      line.match(/the result might be removed by the garbage collector$/) ==
      null
    ) {
      process.stderr.write(line + '\n')
    }
  })

  await proc
}

export async function getLazyTask(task: Task, ctx: any) {
  let nixOutputRaw

  try {
    if (!task.flakeAttributePath.startsWith('tasks.')) {
      throw new Error(
        'getLazyTask(): Expected task attribute to start with tasks.',
      )
    }
    const chompedTaskPath = task.flakeAttributePath.substring('tasks.'.length)

    const nixArgs = [
      'eval',
      '--no-update-lock-file',
      '--no-write-lock-file',
      '--json',
      '--apply',
      getTasksNix +
        '\n' +
        `
        flakeTasks: formatTasks(
          collectTasks {
            output = flakeTasks.${chompedTaskPath}.getLazy (builtins.fromJSON ${JSON.stringify(
          JSON.stringify(ctx),
        )});
            currentPath = ${JSON.stringify('tasks.' + chompedTaskPath)};
          }
        )
      `,
      `${task.flakePath}#tasks`,
    ]

    const { stdout } = await execa('nix', nixArgs, { stderr: 'inherit' })

    nixOutputRaw = stdout
  } catch (ex) {
    if (ex.name === 'MaxBufferError') {
      console.error('Max buffer exceeded, circular dependency somewhere?')
      process.exit(1)
    }

    console.error(ex.stderr)
    process.exit(1)
  }

  const nixOutput: any = JSON.parse(nixOutputRaw as string)

  return collectTasks(nixOutput, task.flakePath, task.originalFlakeUrl, [])[0]
}

export async function callTaskGetOutput(
  taskPath: string,
  currentOutput: any = {},
) {
  let nixOutputRaw

  try {
    const nixArgs = [
      'eval',
      '--no-update-lock-file',
      '--no-write-lock-file',
      '--json',
      '--apply',
      `
      f:
        f (builtins.fromJSON ${JSON.stringify(
          JSON.stringify(currentOutput ?? {}),
        )})
      `,
      taskPath + '.getOutput',
    ]

    const { stdout } = await execa('nix', nixArgs, { stderr: 'inherit' })

    nixOutputRaw = stdout
  } catch (ex) {
    if (ex.name === 'MaxBufferError') {
      console.error('Max buffer exceeded, circular dependency somewhere?')
      process.exit(1)
    }

    console.error(ex.stderr)
    process.exit(1)
  }

  const nixOutput: any = JSON.parse(nixOutputRaw as string)

  return nixOutput
}

async function nixGetFlakeMetadata(flakeUrl: string) {
  let nixOutputRaw

  try {
    const nixArgs = ['flake', 'metadata', '--json', flakeUrl]

    const { stdout } = await execa('nix', nixArgs, { stderr: 'inherit' })

    nixOutputRaw = stdout
  } catch (ex) {
    if (ex.name === 'MaxBufferError') {
      console.error('Max buffer exceeded, circular dependency somewhere?')
      process.exit(1)
    }

    console.error(ex.stderr)
    process.exit(1)
  }

  const nixOutput: any = JSON.parse(nixOutputRaw as string)

  return nixOutput
}

export function getFlakeUrlLocalRepoPath(flakeUrl: string) {
  const parsed = url.parse(flakeUrl)
  if (parsed.protocol !== 'git+file:') return null
  if (!parsed.pathname) return null

  const params = new URLSearchParams(parsed.query ?? '')
  const dir = params.get('dir')

  return {
    repoRoot: parsed.pathname,
    flakeDirectory:
      dir != null ? path.join(parsed.pathname, dir) : parsed.pathname,
  }
}
