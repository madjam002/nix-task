import fs from 'fs'
import path from 'path'
import readline from 'readline/promises'
import { current, produce } from 'immer'
import { execa } from 'execa'
import * as _ from 'lodash'
import { NixTaskObject, Task } from './interfaces'

const getTasksNix = fs.readFileSync(
  path.join(__dirname, 'getTasks.nix'),
  'utf8',
)

const createRef = (...parts: string[]) => parts.filter(part => !!part).join('.')

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

export async function nixGetTasksForSelector(
  attributeSelector: string | null = null,
) {
  let nixOutputRaw

  try {
    const nixArgs = [
      'eval',
      '--json',
      '--apply',
      getTasksNix + '\n' + 'tasks: getTasks tasks',
      attributeSelector != null ? attributeSelector : '.#jobs',
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

export function collectTasks(
  output: any,
  prependNixAttribute: string | null = null,
): Task[] {
  return produce<(Task & NixTaskObject)[]>(output, draft => {
    for (const job of draft) {
      const allDiscoveredDeps: any = []

      Object.keys(job.deps).forEach(depKey => {
        const value = job.deps[depKey]
        const foundJobForDependency =
          typeof value === 'string'
            ? draft.find((_job: any) => _job.id === value)
            : null

        if (foundJobForDependency) {
          job.deps[depKey] = foundJobForDependency
          allDiscoveredDeps.push(job.deps[depKey])
        }
      })

      job.allDiscoveredDeps = allDiscoveredDeps
      job.ref =
        prependNixAttribute != null
          ? createRef(prependNixAttribute, job.nixAttributePath)
          : createRef('.#jobs', job.nixAttributePath)
      job.flakeOutputPath = job.ref.split('#')[1] // path to the job from the root of the flake output
      job.name = job.flakeOutputPath.split('.').at(-1)!
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

export async function nixGetTasks(taskPaths: string[]) {
  let tasks: Task[] = []

  if (taskPaths != null && taskPaths.length > 0) {
    // cannot be parallel with Promise.all as nix flakes call git operations sometimes which lock the repo
    const _taskPaths = await rewriteTaskPaths(taskPaths)
    for (const taskPath of _taskPaths) {
      const res = await nixGetTasksForSelector(taskPath)
      tasks.push(...collectTasks(res, taskPath))
    }
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

export async function getLazyTask(taskPath: string, ctx: any) {
  let nixOutputRaw

  try {
    const nixArgs = [
      'eval',
      '--no-update-lock-file',
      '--no-write-lock-file',
      '--json',
      '--apply',
      getTasksNix +
        '\n' +
        `
        tasks: getTasks (tasks (builtins.fromJSON ${JSON.stringify(
          JSON.stringify(ctx),
        )}))
      `,
      taskPath + '.getLazy',
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

  return collectTasks(nixOutput)[0]
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
