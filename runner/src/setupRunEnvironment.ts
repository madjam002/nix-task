import path from 'path'
import fs from 'fs-extra'
import os from 'os'
import readline from 'node:readline/promises'
import chalk from 'chalk'
import * as tmp from 'tmp-promise'
import { execa, ExecaChildProcess } from 'execa'
import { CANCEL, eventChannel, runSaga, stdChannel } from 'redux-saga'
import { call, take, race, fork } from 'redux-saga/effects'
import buildLazyContextForTask from './buildLazyContextForTask'
import { Task } from './interfaces'
import { getFlakeUrlLocalRepoPath } from './common'
import config from './config'

export async function setupRunEnvironmentGlobal() {
  const flakeRootDir = process.cwd() // todo look for flake.nix or something?
  const nixTaskStateDir = path.join(flakeRootDir, '.nix-task')

  await fs.ensureDir(path.join(nixTaskStateDir, 'output'))
}

export async function setupRunEnvironment(
  task: Task,
  opts: { forDevShell: boolean; debug?: boolean; isDryRunMode?: boolean },
) {
  const flakeRootDir = process.cwd() // todo look for flake.nix or something?
  const flakeLocalRepoPath = getFlakeUrlLocalRepoPath(
    task.resolvedOriginalFlakeUrl,
  )?.repoRoot
  const nixTaskStateDir = path.join(flakeRootDir, '.nix-task')
  const taskDirName = `${task.name}-${task.id.substring(0, 12)}` // show name first so that if the name is truncated it's easy to understand what it is
  const dummyHomeDir = path.join(nixTaskStateDir, 'home', taskDirName) // separate home directory for each task so we don't have collisions when running concurrently
  const tempWorkingDir = path.join(nixTaskStateDir, 'work', taskDirName)
  const artifactsDir = path.join(nixTaskStateDir, 'artifacts', taskDirName)
  const outJSONFile = path.join(
    nixTaskStateDir,
    'output',
    taskDirName + '.json',
  )

  const tmpDir = await tmp.dir({ unsafeCleanup: true })

  if (!task.dir) {
    // if no dir provided, create a new temporary working directory
    await fs.ensureDir(tempWorkingDir)
  }

  await fs.ensureDir(dummyHomeDir)

  // only create artifacts dir if the task has specified it exports artifacts
  if (task.artifacts != null && task.artifacts.length > 0) {
    await fs.ensureDir(artifactsDir)
  }

  let workingDir =
    (function () {
      if (!task.dir) return null
      if (!task.dir.startsWith('/nix/store')) return task.dir

      if (opts.forDevShell && flakeLocalRepoPath != null) {
        // if setting up environment for dev shell, use the actual repo as the working directory
        // so changes are reflected immediately, rather than the repo source copied into the /nix/store
        const nixStoreSource = task.dir.split('/').slice(0, 4).join('/')
        const pathInNixStoreSource = path.relative(nixStoreSource, task.dir)
        return path.join(flakeLocalRepoPath, pathInNixStoreSource)
      } else {
        // just return copied source in /nix/store (will be read only)
        return task.dir
      }
    })() || tempWorkingDir

  const env: any = {
    IMPURE_HOME: process.env.HOME,
    __taskPath: [process.env.PKG_PATH_COREUTILS, ...task.path]
      .map(pkg => pkg + '/bin')
      .join(':'),
    TMP: tmpDir.path,
    TMPDIR: tmpDir.path,
    TEMP: tmpDir.path,
    TEMPDIR: tmpDir.path,
    NIX_TASK_FLAKE_PATH: task.ref,
    out: artifactsDir,
  }

  if (
    task.impureEnvPassthrough != null &&
    task.impureEnvPassthrough.length > 0
  ) {
    task.impureEnvPassthrough.forEach(envName => {
      env[`IMPURE_${envName}`] = process.env[envName]
    })
  }

  const lazyContext: any = await buildLazyContextForTask(task, {
    nixTaskStateDir,
  })

  if (opts.debug) {
    console.log('task lazyContext', lazyContext)
  }

  let spawnCmd = process.env.PKG_PATH_BASH! + '/bin/bash'
  let spawnArgs: string[] = []

  if (config?.experimental?.taskUserNamespaces && os.platform() === 'linux') {
    // if running on linux, run the command in a lightweight user namespace
    // so that mounts can be created without root
    spawnArgs = ['--map-root-user', '--mount', spawnCmd]
    spawnCmd = 'unshare'
  }

  return {
    workingDir,
    dummyHomeDir,
    artifactsDir,
    outJSONFile,
    tmpDir,
    env,
    lazyContext,
    bashStdlib: getBashStdlib({
      lazyContext,
      dummyHomeDir,
      isDryRunMode: opts.isDryRunMode ?? false,
    }),
    spawnCmd,
    spawnArgs,
  }
}

function getBashStdlib({
  lazyContext,
  dummyHomeDir,
  isDryRunMode,
}: {
  lazyContext?: any
  dummyHomeDir: string
  isDryRunMode: boolean
}) {
  let experimentalTaskUserNamespacesSetup = ''

  if (config?.experimental?.taskUserNamespaces && os.platform() === 'linux') {
    // bind mount the root home directory to the temp home directory that we've created for this task
    experimentalTaskUserNamespacesSetup = `
${process.env.PKG_PATH_UTIL_LINUX}/bin/mount --bind ${dummyHomeDir} /root
    `.trim()
  }

  return `
set -e

${experimentalTaskUserNamespacesSetup}

function taskRunShouldApply {
  ${isDryRunMode ? 'false' : 'true'}
}

export -f taskRunShouldApply

function taskSetOutput {
  ${process.env.PKG_PATH_JQ}/bin/jq --null-input -cM \
    --arg output "$1" \
    '{"cmd":"setOutput","output":$output}' >&4
}

export -f taskSetOutput

function taskGetDeps {
  echo ${JSON.stringify(JSON.stringify(lazyContext?.deps ?? {}))}
}

export -f taskGetDeps

function taskRunInBackground {
  allEnv="$(${
    process.env.PKG_PATH_NODEJS
  }/bin/node -e 'console.log(JSON.stringify(process.env))')"

  ${process.env.PKG_PATH_JQ}/bin/jq --null-input -cM \
    --arg command "$*" \
    --arg env "$allEnv" \
    --arg cwd "$PWD" \
    '{"cmd":"runInBackground","command":$command,"cwd":$cwd,"env":$env}' >&4
}

export -f taskRunInBackground

function taskRunFinally {
  allEnv="$(${
    process.env.PKG_PATH_NODEJS
  }/bin/node -e 'console.log(JSON.stringify(process.env))')"

  ${process.env.PKG_PATH_JQ}/bin/jq --null-input -cM \
    --arg command "$*" \
    --arg env "$allEnv" \
    --arg cwd "$PWD" \
    '{"cmd":"runFinally","command":$command,"cwd":$cwd,"env":$env}' >&4
}

export -f taskRunFinally

export PATH="$__taskPath"
`.trim()
}

export function createCommandInterface(
  proc: ExecaChildProcess,
  args: { outputRef: { current: null } },
) {
  const exitChannel = stdChannel()
  proc.on('exit', () => exitChannel.put({ type: 'exit' }))

  const task = runSaga({}, function* (): any {
    const cmdsToRunFinally: any = []

    const commandChannel = yield call(createCommandChannel, proc)

    while (true) {
      const [cmd, willExit] = yield race([
        take(commandChannel),
        take(exitChannel, 'exit'),
      ])
      if (willExit) {
        break
      }

      if (cmd.cmd === 'setOutput') {
        const outputParsed = JSON.parse(cmd.output)
        args.outputRef.current = outputParsed
      } else if (cmd.cmd === 'runInBackground') {
        yield fork(runInBackground, cmd, exitChannel)
      } else if (cmd.cmd === 'runFinally') {
        cmdsToRunFinally.push(cmd)
      }
    }

    for (const finallyCmd of cmdsToRunFinally) {
      yield fork(runSync, finallyCmd, exitChannel)
    }

    yield take(CANCEL)
  })

  return task
}

function createCommandChannel(proc: ExecaChildProcess) {
  const commandListener = readline.createInterface(
    proc.stdio[4] as NodeJS.ReadableStream,
  )
  return eventChannel(emitter => {
    commandListener.on('line', data => {
      const cmd = (function () {
        try {
          return JSON.parse(data)
        } catch (ex) {
          console.log(chalk.red('Failed to decode IPC'), chalk.red(data))
        }
      })()
      if (!cmd) return

      emitter(cmd)
    })

    return () => {
      commandListener.close()
    }
  })
}

function* runInBackground(
  cmd: { command: string; env: any; cwd: string },
  exitChannel: any,
) {
  console.log(chalk.gray('& ' + cmd.command))

  const proc = execa(
    process.env.PKG_PATH_BASH! + '/bin/bash',
    ['--noprofile', '--norc', '-c', cmd.command],
    {
      stdio: 'pipe',
      cwd: cmd.cwd,
      env: JSON.parse(cmd.env),
      extendEnv: false,
    },
  )

  const stdout = readline.createInterface(proc.stdout as NodeJS.ReadableStream)
  const stderr = readline.createInterface(proc.stderr as NodeJS.ReadableStream)
  stdout.on('line', line =>
    process.stdout.write('\n' + chalk.gray(line) + '\n'),
  )
  stderr.on('line', line => process.stderr.write('\n' + chalk.red(line) + '\n'))

  yield race([take(CANCEL), take(exitChannel, 'exit')])

  proc.kill('SIGTERM')
}

function* runSync(
  cmd: { command: string; env: any; cwd: string },
  exitChannel: any,
) {
  console.log(chalk.gray('& ' + cmd.command))

  const proc = execa(
    process.env.PKG_PATH_BASH! + '/bin/bash',
    ['--noprofile', '--norc', '-c', cmd.command],
    {
      stdio: 'pipe',
      cwd: cmd.cwd,
      env: JSON.parse(cmd.env),
      extendEnv: false,
    },
  )

  const stdout = readline.createInterface(proc.stdout as NodeJS.ReadableStream)
  const stderr = readline.createInterface(proc.stderr as NodeJS.ReadableStream)
  stdout.on('line', line => process.stdout.write(chalk.gray(line) + '\n'))
  stderr.on('line', line => process.stderr.write(chalk.red(line) + '\n'))

  yield call(async () => {
    await proc
  })
}
