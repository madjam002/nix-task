import { Command } from 'commander'
import chalk from 'chalk'
import fs from 'fs-extra'
import path from 'path'
import { execa } from 'execa'
import { Task } from '../interfaces'
import _ from 'lodash'
import { getLazyTask, nixGetTasks, preBuild } from '../common'
import {
  createCommandInterface,
  setupRunEnvironment,
  setupRunEnvironmentGlobal,
} from '../setupRunEnvironment'
import * as tmp from 'tmp-promise'

export default async function shell(
  taskPath: string,
  options: any,
  command: Command,
) {
  const tasks = await nixGetTasks([taskPath])

  const exactTask = tasks.find(task => task.nixAttributePath === '')

  if (exactTask == null) {
    throw new Error(
      'nix-task shell(): Must pass an exact path to a task to use a shell',
    )
  }

  const task = exactTask

  if (options.debug) {
    console.log('starting shell for task', task)
  }

  const {
    workingDir,
    dummyHomeDir,
    tmpDir,
    env,
    outJSONFile,
    lazyContext,
    bashStdlib,
  } = await setupRunEnvironment(task, {
    forDevShell: true,
    debug: options.debug,
  })

  let shellHookScript = task.shellHook

  if (shellHookScript === '# __TO_BE_LAZY_EVALUATED__') {
    const builtLazyTask = await getLazyTask(task.ref, lazyContext)

    await preBuild([builtLazyTask])

    shellHookScript = builtLazyTask.shellHook
  } else {
    await preBuild([exactTask])
  }

  await setupRunEnvironmentGlobal()

  const rcTmp = await tmp.file()

  await fs.writeFile(
    rcTmp.path,
    `
source ~/.bashrc
export HOME=${dummyHomeDir}

${bashStdlib}

${shellHookScript}

${
  /* set +e again otherwise Ctrl+C will exit the shell which we don't want for an interactive shell */ ''
}
set +e
`,
  )

  try {
    const proc = execa(
      process.env.PKG_PATH_BASH! + '/bin/bash',
      ['--rcfile', rcTmp.path],
      {
        stdio: ['inherit', 'inherit', 'inherit', undefined, 'pipe'],
        cwd: workingDir,
        env: {
          ...env,
        },
        extendEnv: false,
      },
    )

    const outputRef = { current: null }

    createCommandInterface(proc, { outputRef })

    await proc
  } catch (ex) {
  } finally {
    await Promise.all([rcTmp.cleanup(), tmpDir.cleanup()])
  }
}
