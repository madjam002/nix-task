import { Command } from 'commander'
import { eventChannel, runSaga } from 'redux-saga'
import { call, cancel, delay, fork, race, take } from 'redux-saga/effects'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import fs from 'fs-extra'
import readline from 'node:readline/promises'
import { execa } from 'execa'
import PQueue from 'p-queue'
import _ from 'lodash'
import { Task } from '../interfaces'
import {
  callTaskGetOutput,
  getLazyTask,
  nixGetTasks,
  preBuild,
} from '../common'
import {
  createCommandInterface,
  setupRunEnvironment,
  setupRunEnvironmentGlobal,
} from '../setupRunEnvironment'

const batchingToposort = require('batching-toposort')

export default async function run(
  taskPaths: string[],
  options: any,
  command: Command,
) {
  let tasks = await nixGetTasks(taskPaths, {
    reverse: options.reverse === true,
  })

  const originalTasks = tasks

  if (options?.reverse) {
    // reverse dependencies so it runs in reverse order
    tasks = tasks.map(task => {
      const dependsOnSelf = tasks.filter(_task =>
        _task.allDiscoveredDeps.some(dep => dep.id === task.id),
      )
      return {
        ...task,
        originalDeps: task.allDiscoveredDeps,
        allDiscoveredDeps: dependsOnSelf,
      }
    })
  }

  if (options.debug) {
    console.log(
      'got tasks',
      tasks.map(task => ({
        ...task,
        allDiscoveredDeps: task.allDiscoveredDeps.map(dep => dep.id),
      })),
    )
  }

  const isDryRunMode = options.dryRun ?? false

  const onlyTask =
    options.only === true
      ? tasks.find(task => task.exactRefMatch === true)
      : null

  if (
    options.only === true &&
    (onlyTask == null ||
      tasks.filter(task => task.exactRefMatch === true).length !== 1)
  ) {
    throw new Error(
      'nix-task run(): Must pass an exact path to a single task when using --only',
    )
  }

  const concurrency = options.concurrency
  const isRunningConcurrently = concurrency != null && concurrency > 1

  if (isRunningConcurrently && options.interactive) {
    throw new Error(
      'nix-task run(): Cannot use --concurrency and --interactive at the same time',
    )
  }

  const onlyTags =
    options.onlyTags != null && typeof options.onlyTags === 'string'
      ? options.onlyTags.split(',').map((tag: string) => tag.trim())
      : null

  const filteredTasks =
    onlyTags != null
      ? tasks.filter(
          task =>
            task.tags != null && task.tags?.some(tag => onlyTags.includes(tag)),
        )
      : tasks

  const sortedTasks = onlyTask
    ? [[onlyTask.id]]
    : calculateBatchedRunOrder(filteredTasks, originalTasks)

  if (options.graph) {
    console.log(
      JSON.stringify(
        sortedTasks.map(group =>
          group.map(taskId =>
            taskId.startsWith('OUTPUT:')
              ? `(Output Only) ${
                  tasks.find(
                    task => task.id === taskId.substring('OUTPUT:'.length),
                  )?.prettyRef
                }`
              : tasks.find(task => task.id === taskId)?.prettyRef,
          ),
        ),
        null,
        2,
      ),
    )
    process.exit(0)
    return
  }

  await preBuild(tasks)

  const startTime = Date.now()

  await setupRunEnvironmentGlobal()

  if (isDryRunMode) {
    console.log(chalk.bold.yellow('Instructing tasks to run in dry run mode'))
  }

  const queue = new PQueue({
    concurrency: isRunningConcurrently ? concurrency : 1,
  })

  const taskIdsToRun = _.flatten(sortedTasks)

  const taskDoneStatus: { [taskId: string]: boolean } = {}

  top: for (const group of sortedTasks) {
    for (const _idToRun of group) {
      queue.add(async function () {
        let idToRun = _idToRun

        const isOutputOnly = idToRun.startsWith('OUTPUT:')
        if (isOutputOnly) idToRun = idToRun.substring('OUTPUT:'.length)

        const task = tasks.find(task => task.id === idToRun)!

        // wait for task dependencies to finish (only has any effect when running tasks concurrently)
        if (
          !areAllDependenciesSatisifiedForTask(
            task,
            taskIdsToRun,
            taskDoneStatus,
            isOutputOnly,
          )
        ) {
          if (options.debug) {
            console.log(
              'waiting on dependencies for task',
              _idToRun,
              task.flakeAttributePath,
              pendingDependenciesForTask(
                task,
                taskIdsToRun,
                taskDoneStatus,
                isOutputOnly,
              ).map(dep => dep.flakeAttributePath),
            )
          }
          await new Promise(resolve => {
            const handler = () => {
              if (
                areAllDependenciesSatisifiedForTask(
                  task,
                  taskIdsToRun,
                  taskDoneStatus,
                  isOutputOnly,
                )
              ) {
                queue.removeListener('completed', handler)
                resolve(true)
              }
            }
            queue.on('completed', handler)
          })
        }

        const success = await runSaga({}, runTask, task, {
          interactive: options.interactive,
          debug: options.debug,
          isDryRunMode,
          isOutputOnly,
          isRunningConcurrently,
          customFunctionName: options.custom ?? undefined,
        }).toPromise()
        if (!success) {
          console.log()
          console.log(chalk.red('──') + ' ' + chalk.bold.red('Failed'))
          console.log()
          process.exit(1)
        } else {
          taskDoneStatus[_idToRun] = true
        }
      })
    }
  }

  await queue.onIdle()

  const endTime = Date.now()

  if (sortedTasks.length > 0) {
    console.log()
    console.log(chalk.green('──') + ' ' + chalk.bold.green('Success'))
    console.log(
      '  ',
      'Done in ' + ((endTime - startTime) / 1000).toFixed(2) + 's',
    )
    console.log()
    process.exit(0)
  } else {
    console.log(chalk.gray('──') + ' ' + chalk.bold.gray('No tasks to run'))
    console.log()
    process.exit(127)
  }
}

type TaskWithOriginalDeps = Task & { originalDeps?: Task[] }

function calculateBatchedRunOrder(
  filteredTasks: TaskWithOriginalDeps[],
  allTasks: TaskWithOriginalDeps[],
) {
  const dependencyGraph: any = {}

  filteredTasks.forEach(task => {
    if (!dependencyGraph[task.id]) dependencyGraph[task.id] = []

    task.allDiscoveredDeps.forEach(dep => {
      if (!filteredTasks.some(_task => _task.id === dep.id)) {
        // if dependency is not present in filteredTasks, then just push a output-only variant which will fetch the output if it is missing
        if (!dependencyGraph[`OUTPUT:${dep.id}`])
          dependencyGraph[`OUTPUT:${dep.id}`] = []
        dependencyGraph[`OUTPUT:${dep.id}`].push(task.id)
        return
      }

      if (!dependencyGraph[dep.id]) dependencyGraph[dep.id] = []
      dependencyGraph[dep.id].push(task.id)
    })

    // ensure outputs are present first when operating in reverse mode
    if (task.originalDeps != null) {
      if (!dependencyGraph[`OUTPUT:${task.id}`])
        dependencyGraph[`OUTPUT:${task.id}`] = []

      task.originalDeps.forEach(dep => {
        if (!dependencyGraph[`OUTPUT:${dep.id}`])
          dependencyGraph[`OUTPUT:${dep.id}`] = []
        dependencyGraph[`OUTPUT:${dep.id}`].push(task.id)
        dependencyGraph[`OUTPUT:${dep.id}`].push(`OUTPUT:${task.id}`)
      })
    }
  })

  // clear any empty output-only trees and also add any missing ones
  while (true) {
    let didChangeDependencyGraph = false

    for (const key of Object.keys(dependencyGraph)) {
      if (key.startsWith('OUTPUT:')) {
        const task =
          (allTasks.find(
            _task => _task.id === key.substring('OUTPUT:'.length),
          ) as TaskWithOriginalDeps) ?? null

        if (task?.allDiscoveredDeps != null) {
          task.allDiscoveredDeps.forEach(dep => {
            if (!dependencyGraph[`OUTPUT:${dep.id}`]) {
              dependencyGraph[`OUTPUT:${dep.id}`] = []
              didChangeDependencyGraph = true
            }
            if (
              !dependencyGraph[`OUTPUT:${dep.id}`].includes(`OUTPUT:${task.id}`)
            ) {
              dependencyGraph[`OUTPUT:${dep.id}`].push(`OUTPUT:${task.id}`)
              didChangeDependencyGraph = true
            }
          })
        }

        if (dependencyGraph[key].length === 0) {
          delete dependencyGraph[key]
          for (const other of Object.values(dependencyGraph as any[])) {
            if (other.includes(key)) {
              removeItem(other, key)
              didChangeDependencyGraph = true
            }
          }
        }
      }
    }

    if (!didChangeDependencyGraph) break
  }

  // for debugging:
  // function depIdToTask(id: string) {
  //   if (id.startsWith('OUTPUT:')) {
  //     return allTasks.find(task => task.id === id.substring('OUTPUT:'.length))
  //   } else {
  //     return allTasks.find(task => task.id === id)
  //   }
  // }
  // console.log(
  //   chain(dependencyGraph)
  //     .pickBy((val, key) => key.startsWith('OUTPUT:'))
  //     .mapValues(val =>
  //       val.map(
  //         item => item.substring(0, 10) + ' ' + depIdToTask(item)?.prettyRef,
  //       ),
  //     )
  //     .mapKeys(
  //       (val, key) => key.substring(0, 10) + ' ' + depIdToTask(key)?.prettyRef,
  //     )
  //     .value(),
  // )
  // // self test for missing keys as otherwise batchingToposort will fail with forEach error
  // for (const other of Object.values(dependencyGraph as any[])) {
  //   for (const key of other) {
  //     if (!dependencyGraph[key]) {
  //       console.log('MISSING KEY', key)
  //     }
  //   }
  // }

  const runOrder: string[][] = batchingToposort(dependencyGraph)

  return runOrder
}

function pendingDependenciesForTask(
  task: TaskWithOriginalDeps,
  taskIdsToRun: string[],
  doneStatus: { [taskId: string]: boolean },
  isOutputOnly: boolean,
): Task[] {
  // A dependency may be queued as a full run (`dep.id`) and/or an output-only
  // fetch (`OUTPUT:dep.id`). We must wait for the right one, otherwise a
  // dependent builds its lazy context (reading dependency output files) before
  // those files are written and the dependency output comes back null.
  //
  // Which variant to wait for depends on what this task needs:
  //  - A normal task needs the dependency's *run* to have completed, so it
  //    prefers the full variant.
  //  - An output-only task only needs the dependency's *output*, produced by the
  //    OUTPUT: variant. This preference matters in reverse/destroy order, where
  //    both variants are queued: the OUTPUT: fetch is deliberately scheduled
  //    early (before the full run), so an output-only task must wait on it and
  //    not on the full run — which runs afterwards and would otherwise deadlock.
  //
  // If neither variant is queued the dependency isn't part of this run and its
  // output is assumed already available, so it doesn't block.
  const isDepSatisfied = (depId: string) => {
    const preferredOrder = isOutputOnly
      ? [`OUTPUT:${depId}`, depId]
      : [depId, `OUTPUT:${depId}`]
    for (const id of preferredOrder) {
      if (taskIdsToRun.includes(id)) return doneStatus[id] === true
    }
    return true
  }

  // An output-only task still needs its real dependencies' outputs to
  // fetch/compute its own output, regardless of run direction. In reverse mode
  // `allDiscoveredDeps` is rewritten to the task's dependents, so the real
  // dependencies are kept in `originalDeps`.
  const deps = isOutputOnly
    ? task.originalDeps ?? task.allDiscoveredDeps
    : task.allDiscoveredDeps

  return deps.filter(dep => !isDepSatisfied(dep.id))
}

function areAllDependenciesSatisifiedForTask(
  task: TaskWithOriginalDeps,
  taskIdsToRun: string[],
  doneStatus: { [taskId: string]: boolean },
  isOutputOnly: boolean,
) {
  return (
    pendingDependenciesForTask(task, taskIdsToRun, doneStatus, isOutputOnly)
      .length === 0
  )
}

let lastTaskIdToBeLogged: string | null = null

function* runTask(
  task: Task,
  opts: {
    interactive: boolean
    debug?: boolean
    isDryRunMode: boolean
    isRunningConcurrently?: boolean
    isOutputOnly?: boolean
    customFunctionName?: string
  },
): any {
  console.log()

  let headerPrefix = ' Running ' + task.prettyRef + ' '

  if (opts.isDryRunMode) {
    headerPrefix += chalk.bold.yellow('(dry run)') + ' '
  }

  if (!opts.isOutputOnly) {
    console.log(
      chalk.yellow('──') +
        headerPrefix +
        chalk.yellow(
          ''.padEnd(
            process.stdout.columns - 2 - stripAnsi(headerPrefix).length,
            '─',
          ),
        ),
    )
    console.log()
  } else {
    headerPrefix = ' Get output ' + task.prettyRef + ' '
    console.log(
      chalk.gray('──') +
        headerPrefix +
        chalk.gray(
          ''.padEnd(
            process.stdout.columns - 2 - stripAnsi(headerPrefix).length,
            '─',
          ),
        ),
    )
    console.log()
  }

  lastTaskIdToBeLogged = task.id

  if (opts.debug) {
    console.log('running task', task)
  }

  const {
    workingDir,
    dummyHomeDir,
    tmpDir,
    env,
    outJSONFile,
    lazyContext,
    bashStdlib,
    spawnCmd,
    spawnArgs,
  } = yield call(() =>
    setupRunEnvironment(task, {
      forDevShell: false,
      debug: opts.debug,
      isDryRunMode: opts.isDryRunMode,
    }),
  )

  let runScript =
    opts?.isOutputOnly === true
      ? task.fetchOutput
      : opts?.customFunctionName != null
      ? task.customFunctions[opts.customFunctionName]
      : task.run

  if (runScript === '# __TO_BE_LAZY_EVALUATED__') {
    const builtLazyTask = yield call(() => getLazyTask(task, lazyContext))

    yield call(() => preBuild([builtLazyTask]))

    runScript =
      opts?.isOutputOnly === true
        ? builtLazyTask.fetchOutput
        : opts?.customFunctionName != null
        ? builtLazyTask.customFunctions[opts.customFunctionName]
        : builtLazyTask.run
  }

  let backgroundLogTask

  try {
    if (runScript == null) {
      // if no script defined, just log and continue pass
      if (opts.isOutputOnly === true) {
        console.log(chalk.gray(`No fetchOutput defined for task, continuing`))
      } else if (opts.customFunctionName != null) {
        console.log(
          chalk.gray(
            `No "${opts.customFunctionName}" script defined for task, continuing`,
          ),
        )
      } else {
        console.log(chalk.gray('No run script defined for task, continuing'))
      }
      return true
    }

    const proc = execa(
      spawnCmd,
      [
        ...spawnArgs,
        '--norc',
        '--noprofile',
        '-c',
        bashStdlib + '\n' + runScript,
      ],
      {
        stdio: opts.isRunningConcurrently
          ? ['ignore', 'pipe', 'pipe', undefined, 'pipe']
          : [
              opts.interactive ? 'inherit' : 'ignore',
              'inherit',
              'inherit',
              undefined,
              'pipe',
            ],
        cwd: workingDir,
        env: {
          ...env,
          HOME: dummyHomeDir,
        },
        extendEnv: false,
      },
    )

    if (opts.isRunningConcurrently) {
      // when running concurrently, buffer stdout/stderr so that it's a bit easier to read when multiple
      // tasks are running in parallel
      const stdout = createProcessOutputChannel(
        proc.stdout as NodeJS.ReadableStream,
      )
      const stderr = createProcessOutputChannel(
        proc.stderr as NodeJS.ReadableStream,
      )

      backgroundLogTask = yield fork(function* () {
        let collectedLines: any[] = []
        function printLines() {
          if (lastTaskIdToBeLogged !== task.id) {
            // only log task header if the last log lines came from a different task
            console.log()
            const headerPrefix = ' ' + task.prettyRef + ' '
            console.log(
              chalk.gray('──') +
                headerPrefix +
                chalk.gray(
                  ''.padEnd(
                    process.stdout.columns - 2 - stripAnsi(headerPrefix).length,
                    '─',
                  ),
                ),
            )
            console.log()
            lastTaskIdToBeLogged = task.id
          }
          for (const line of collectedLines) {
            if (line.type === 'out') console.log(line.line)
            else if (line.type === 'err') console.error(line.line)
          }
          collectedLines = []
        }

        try {
          while (true) {
            const [out, err, didDelay] = yield race([
              take(stdout),
              take(stderr),
              delay(500),
            ])
            if (out != null) collectedLines.push({ type: 'out', line: out })
            if (err != null) collectedLines.push({ type: 'err', line: err })

            const shouldPrint =
              collectedLines.length === 0 || // print straight away if it's the first lines in a batch
              didDelay // or the delay time has passed

            if (shouldPrint && collectedLines.length > 0) {
              printLines()
            }
          }
        } finally {
          // print any remaining lines
          printLines()
        }
      })
    }

    const outputRef = { current: null }

    createCommandInterface(proc, { task, outputRef })

    yield call(async () => await proc)

    if (
      task.hasGetOutput &&
      (opts?.customFunctionName == null || opts.isOutputOnly === true)
    ) {
      const outputResult = yield call(() =>
        callTaskGetOutput(task, outputRef.current),
      )
      if (outputResult != null) {
        outputRef.current = outputResult
      }
    }

    if (
      outputRef.current != null &&
      (opts?.customFunctionName == null || opts.isOutputOnly === true)
    ) {
      // write/overwrite new out.json file.
      // Write to a temp file then rename: rename is atomic on the same
      // filesystem, so a concurrently-running task's buildLazyContextForTask can
      // never observe a half-written (unparseable) output file under -J.
      yield call(async () => {
        const tmpFile = `${outJSONFile}.tmp-${process.pid}-${task.id.slice(
          0,
          8,
        )}`
        await fs.writeFile(tmpFile, JSON.stringify(outputRef.current, null, 2))
        await fs.rename(tmpFile, outJSONFile)
      })
      // clean up any old out.json files for this task ID that might use obsolete name prefixes
      // TODO!
    }

    return true
  } catch (ex) {
    // console.log('got exception', ex)
    return false
  } finally {
    if (backgroundLogTask?.cancel) backgroundLogTask.cancel()
    yield call(() => tmpDir.cleanup())
  }
}

function createProcessOutputChannel(stream: NodeJS.ReadableStream) {
  const lineInterface = readline.createInterface(stream)
  return eventChannel(emitter => {
    lineInterface.on('line', data => {
      emitter(data)
    })

    return () => {
      lineInterface.close()
    }
  })
}

function removeItem(array: any[], item: any) {
  var i = array.length

  while (i--) {
    if (array[i] === item) {
      array.splice(i, 1)
    }
  }
}
