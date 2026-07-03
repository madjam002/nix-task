import url from 'url'
import path from 'path'
import readline from 'node:readline/promises'
import { produce } from 'immer'
import { execa } from 'execa'
import * as _ from 'lodash'
import { NixFlakeMetadata, NixTaskObject, Task } from './interfaces'
import { notEmpty } from './ts'
import chalk from 'chalk'
import { findUp } from 'find-up'
import fss from 'fs-extra'
import { nixEval, startNixRepl } from './nixRepl'

startNixRepl()

let getTasksNix = require(process.env.CONF_NIX_LIB_PATH + '/getTasks.nix')
getTasksNix = getTasksNix.substring(
  0,
  getTasksNix.lastIndexOf('# __beginExports__'),
)

// These timings run concurrently under -J and would otherwise share the same
// console.time label, producing noisy "Label already exists" / "No such label"
// warnings. Give each span a unique, incrementing label so they never collide.
let nixTimerCounter = 0
function startNixTimer(label: string): () => void {
  const uniqueLabel = `${label} #${++nixTimerCounter}`
  console.time(uniqueLabel)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    console.timeEnd(uniqueLabel)
  }
}

export async function nixCurrentSystem() {
  const endTimer = startNixTimer('nix currentSystem')
  try {
    return await nixEval('builtins.currentSystem')
  } finally {
    endTimer()
  }
}

export async function nixGetTasksFromFlake(
  flakeUrl: string,
  flakeTaskAttributes: string[],
) {
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

  const endTimer = startNixTimer('nix getTasksFromFlake')
  try {

    await nixEval(
      `:l ${path.join(process.env.CONF_NIX_LIB_PATH!, './getTasks.nix')}`,
    )
    await nixEval(`:lf ${flakeUrl}`)

    const tasks = await nixEval(
      `
      let
        taskPaths = [ ${chompedTaskPaths
          .map(attr => `tasks.${attr}`)
          .join(' ')} ];
      in
      builtins.toJSON (formatTasks (flatten [
        ${chompedTaskPaths
          .map(
            attr => `
        (collectTasks {
          output = tasks.${attr};
          currentPath = ${JSON.stringify('tasks.' + attr)};
        })
        `,
          )
          .join('\n')}
        ]))
    `,
    )

    return tasks as any[]
  } finally {
    endTimer()
  }
}

function collectTasks(
  output: any,
  originalFlakeUrl: string,
  resolvedOriginalFlakeUrl: string,
  passedTaskPaths: string[] = [],
): Task[] {
  return produce<(Task & NixTaskObject)[]>(output, draft => {
    for (const task of draft) {
      const allDiscoveredDeps: any = []

      function addDeps(objWithDeps: any) {
        Object.keys(objWithDeps.deps).forEach(depKey => {
          const value = objWithDeps.deps[depKey]
          const foundTaskForDependency =
            typeof value === 'string'
              ? draft.find((_task: any) => _task.id === value)
              : null

          if (value?.__type === 'taskOutput' && value?.deps != null) {
            value.ref = [originalFlakeUrl, value.flakeAttributePath].join('#')
            addDeps(value)
          } else if (foundTaskForDependency) {
            objWithDeps.deps[depKey] = foundTaskForDependency
            allDiscoveredDeps.push(foundTaskForDependency)
          }
        })
      }

      addDeps(task)

      task.allDiscoveredDeps = allDiscoveredDeps
      task.ref = [originalFlakeUrl, task.flakeAttributePath].join('#')
      task.exactRefMatch = passedTaskPaths.includes(task.flakeAttributePath)
      task.name = task.flakeAttributePath.split('.').at(-1)!
      // task.flakePath = flakePathToUse
      task.resolvedOriginalFlakeUrl = resolvedOriginalFlakeUrl
      task.originalFlakeUrl = originalFlakeUrl

      // strip the .tasks.<system> prefix from the attribute (for display purposes only)
      task.flakePrettyAttributePath = task.flakeAttributePath.replace(
        /^(tasks\.[\w\-_]+\.)/,
        '',
      )
      task.prettyRef = [
        task.originalFlakeUrl,
        task.flakePrettyAttributePath,
      ].join('#')
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
  opts?: { forDevShell?: boolean; reverse?: boolean },
) {
  const taskPaths = await rewriteTaskPaths(taskPathsIn)

  const taskSplitPaths = taskPaths.map(taskPath => {
    const split = taskPath.split('#')
    return { flakeUrl: split[0], attribute: split[1] }
  })

  // of all the provided tasks, get the unique flake refs
  const flakeUrls = _.uniq(taskSplitPaths.map(taskPath => taskPath.flakeUrl))

  // get tasks from each provided flake
  let tasks: Task[] = []

  for (const flakeUrl of flakeUrls) {
    const flakeTaskPaths = taskSplitPaths
      .filter(taskPath => taskPath.flakeUrl === flakeUrl)
      .map(taskPath => taskPath.attribute)

    const res = await nixGetTasksFromFlake(flakeUrl, flakeTaskPaths)

    let resolvedFlakeUrl = flakeUrl

    if (flakeUrl === '.') {
      const foundFlakeFile = await findUp('flake.nix')
      if (foundFlakeFile != null) {
        const rootDir = path.dirname(foundFlakeFile)
        const hasGit = await fss.pathExists(path.join(rootDir, '.git'))
        resolvedFlakeUrl = hasGit
          ? `git+file://${rootDir}`
          : `file://${rootDir}`
      }
    }

    tasks.push(...collectTasks(res, flakeUrl, resolvedFlakeUrl, flakeTaskPaths))
  }

  return tasks
}

export async function preBuild(tasks: Task[]) {
  const endTimer = startNixTimer('nix store realise')
  try {
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
  } finally {
    endTimer()
  }
}

export async function getLazyTask(task: Task, ctx: any) {
  const endTimer = startNixTimer('nix getLazyTask')
  try {
    if (!task.flakeAttributePath.startsWith('tasks.')) {
      throw new Error(
        'getLazyTask(): Expected task attribute to start with tasks.',
      )
    }
    const chompedTaskPath = task.flakeAttributePath.substring('tasks.'.length)

    let tasksOutput
    try {
      tasksOutput = await nixEval(
        `
      __toJSON (formatTasks(
        collectTasks {
          output = tasks.${chompedTaskPath}.getLazy (builtins.fromJSON ${JSON.stringify(
          JSON.stringify(ctx),
        )});
          currentPath = ${JSON.stringify('tasks.' + chompedTaskPath)};
        }
      ))
    `,
      )
    } catch (ex) {
      // The repl framing is verified independently (see nixRepl.ts), so a nix
      // evaluation error here is a real evaluation problem, not a serialisation
      // one. The most common one — "expected a set but found null" — happens
      // when this task's getLazy/run dereferences a dependency output that is
      // null. Name the null dependencies so the failure is actionable.
      logNullContextDeps(task.flakeAttributePath, ctx)
      throw ex
    }

    if (!Array.isArray(tasksOutput)) {
      // getLazyTask must receive an array of tasks from the repl. A non-array
      // here is what surfaces downstream as the opaque "TypeError: i is not
      // iterable" inside collectTasks/immer. Fail loudly with the actual value
      // and command so a repl framing/serialisation problem is diagnosable.
      console.error(
        `[nix-task] getLazyTask("${task.flakeAttributePath}") expected an array ` +
          `from the nix repl but received ${describeReplValue(tasksOutput)}. ` +
          `This indicates a nix-repl framing/serialisation issue.`,
      )
      console.error(
        '[nix-task] raw value:',
        JSON.stringify(tasksOutput)?.slice(0, 1000),
      )
      throw new Error(
        `getLazyTask("${task.flakeAttributePath}"): nix repl returned ` +
          `${describeReplValue(tasksOutput)} instead of a task array`,
      )
    }

    return collectTasks(
      tasksOutput,
      task.originalFlakeUrl,
      task.resolvedOriginalFlakeUrl,
      [],
    )[0]
  } finally {
    endTimer()
  }
}

function describeReplValue(value: any): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `an array (length ${value.length})`
  if (typeof value === 'string')
    return `a string (length ${value.length}): ${JSON.stringify(
      value.slice(0, 120),
    )}`
  return `a ${typeof value}`
}

// On a nix evaluation failure while lazily evaluating a task or its getOutput,
// report which dependency outputs were null in the context. A null dependency
// output that gets dereferenced (deps.<name>.output.<field>) is the usual cause
// of "expected a set but found null". An output is null when the dependency
// produced no output and wasn't (re)run in this invocation — under --only-tags
// it is fetched via its fetchOutput hook, which can return nothing (or it
// defines none), so the output is absent even though the dependency "ran".
function logNullContextDeps(attrPath: string, ctx: any) {
  const deps = ctx?.deps
  if (deps == null || typeof deps !== 'object') return
  const nullDeps = Object.keys(deps).filter(
    depKey => deps[depKey] != null && deps[depKey].output === null,
  )
  if (nullDeps.length === 0) return
  console.error(
    `[nix-task] "${attrPath}" was evaluated with null outputs for these ` +
      `dependencies: ${nullDeps.join(', ')}. If the nix error above is ` +
      `"expected a set but found null", one of these is being dereferenced. ` +
      `A dependency output is null when that task produced no output and was ` +
      `not (re)run in this invocation (e.g. fetched via fetchOutput under ` +
      `--only-tags, which returned nothing).`,
  )
}

export async function callTaskGetOutput(task: Task, currentOutput: any = {}) {
  const endTimer = startNixTimer('nix taskGetOutput')
  try {
    let output
    try {
      output = await nixEval(
        `
      __toJSON (${
        task.flakeAttributePath
      }.getOutput (builtins.fromJSON ${JSON.stringify(
          JSON.stringify(currentOutput ?? {}),
        )}))
    `,
      )
    } catch (ex) {
      logNullContextDeps(task.flakeAttributePath, currentOutput)
      throw ex
    }

    return output
  } finally {
    endTimer()
  }
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
