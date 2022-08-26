import { Command } from 'commander'
import { runSaga } from 'redux-saga'
import { call } from 'redux-saga/effects'
import chalk from 'chalk'
import fs from 'fs-extra'
import path from 'path'
import { execa } from 'execa'
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

  top: for (const group of sortedTasks) {
    for (const idToRun of group) {
      const task = tasks.find(task => task.id === idToRun)!
      const success = await runSaga({}, runTask, task, {
        interactive: options.interactive,
        debug: options.debug,
      }).toPromise()
      if (!success) {
        console.log()
        console.log(chalk.red('──') + ' ' + chalk.bold.red('Failed'))
        console.log()
        process.exit(1)
      }
    }
  }

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

function* runTask(
  task: Task,
  opts: { interactive: boolean; debug?: boolean },
): any {
  console.log()

  const headerPrefix = ' Running ' + task.prettyRef + ' '

  console.log(
    chalk.yellow('──') +
      headerPrefix +
      chalk.yellow(
        ''.padEnd(process.stdout.columns - 2 - headerPrefix.length, '─'),
      ),
  )
  console.log()

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
    setupRunEnvironment(task, { forDevShell: false, debug: opts.debug }),
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
        stdio: [
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
      yield call(() =>
        fs.writeFile(outJSONFile, JSON.stringify(outputRef.current, null, 2)),
      )
    }

    return true
  } catch (ex) {
    return false
  } finally {
    yield call(() => tmpDir.cleanup())
  }
}
