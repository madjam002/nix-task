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
  const tasks = await nixGetTasks(taskPaths)

  if (options.debug) {
    console.log('got tasks', tasks)
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

  const sortedTasks = onlyTask
    ? [[onlyTask.id]]
    : calculateBatchedRunOrder(tasks)

  if (options.graph) {
    console.log(
      JSON.stringify(
        sortedTasks.map(group =>
          group.map(
            taskId => tasks.find(task => task.id === taskId)?.prettyRef,
          ),
        ),
        null,
        2,
      ),
    )
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
    for (const idToRun of group) {
      queue.add(async function () {
        const task = tasks.find(task => task.id === idToRun)!

        // wait for task dependencies to finish (only has any effect when running tasks concurrently)
        if (
          !areAllDependenciesSatisifiedForTask(
            task,
            taskIdsToRun,
            taskDoneStatus,
          )
        ) {
          await new Promise(resolve => {
            const handler = () => {
              if (
                areAllDependenciesSatisifiedForTask(
                  task,
                  taskIdsToRun,
                  taskDoneStatus,
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
          isRunningConcurrently,
        }).toPromise()
        if (!success) {
          console.log()
          console.log(chalk.red('──') + ' ' + chalk.bold.red('Failed'))
          console.log()
          process.exit(1)
        } else {
          taskDoneStatus[task.id] = true
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

function calculateBatchedRunOrder(tasks: Task[]) {
  const dependencyGraph: any = {}

  tasks.forEach(task => {
    if (!dependencyGraph[task.id]) dependencyGraph[task.id] = []

    task.allDiscoveredDeps.forEach(dep => {
      if (!dependencyGraph[dep.id]) dependencyGraph[dep.id] = []
      dependencyGraph[dep.id].push(task.id)
    })
  })

  // TODO while the batching is nice to look at, it's not the most efficient way to do this
  // e.g take two tasks, and another task which depends on task 1. If task 2 takes ages to complete
  // batching will cause task 3 to wait until task 2 has finished even though there's no explicit dependency.
  const runOrder: string[][] = batchingToposort(dependencyGraph)

  return runOrder
}

function areAllDependenciesSatisifiedForTask(
  task: Task,
  taskIdsToRun: string[],
  doneStatus: { [taskId: string]: boolean },
) {
  return task.allDiscoveredDeps.every(dep =>
    taskIdsToRun.includes(dep.id) ? doneStatus[dep.id] === true : true,
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
  },
): any {
  console.log()

  let headerPrefix = ' Running ' + task.prettyRef + ' '

  if (opts.isDryRunMode) {
    headerPrefix += chalk.bold.yellow('(dry run)') + ' '
  }

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

  let runScript = task.run

  if (task.run === '# __TO_BE_LAZY_EVALUATED__') {
    const builtLazyTask = yield call(() => getLazyTask(task, lazyContext))

    yield call(() => preBuild([builtLazyTask]))

    runScript = builtLazyTask.run
  }

  try {
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

      yield fork(function* () {
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

    createCommandInterface(proc, { outputRef })

    yield call(async () => await proc)

    if (task.hasGetOutput) {
      const outputResult = yield call(() =>
        callTaskGetOutput(task.ref, outputRef.current),
      )
      if (outputResult != null) {
        outputRef.current = outputResult
      }
    }

    if (outputRef.current != null) {
      // write/overwrite new out.json file
      yield call(() =>
        fs.writeFile(outJSONFile, JSON.stringify(outputRef.current, null, 2)),
      )
      // clean up any old out.json files for this task ID that might use obsolete name prefixes
      // TODO!
    }

    return true
  } catch (ex) {
    return false
  } finally {
    yield cancel()
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
