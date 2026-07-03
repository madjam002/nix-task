import { spawn } from 'node:child_process'
import { buffers, CANCEL, channel, eventChannel, runSaga } from 'redux-saga'
import stripAnsi from 'strip-ansi'
import { call, take } from 'redux-saga/effects'
import tmp from 'tmp-promise'
import path from 'path'
import http from 'node:http'
import { text } from 'node:stream/consumers'
import { execa } from 'execa'

const commandQueue = channel(buffers.expanding(100) as any)

export async function startNixRepl() {
  const tmpDir = await tmp.dir({ unsafeCleanup: true })

  let currentEnvContext = process.env

  try {
    const server = http.createServer(async (req, res) => {
      if (req.url === '/evalInTask') {
        try {
          const exec = JSON.parse(await text(req))
          const result = (
            await execa(exec[0], exec.slice(1), {
              env: currentEnvContext,
              extendEnv: false,
              stderr: 'inherit', // show error messages
            })
          ).stdout
          res.writeHead(200)
          res.end(result)
        } catch (ex) {
          res.writeHead(500)
          res.end(ex.message)
        }
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    server.listen(path.join(tmpDir.path, 'control.sock'))

    const task = runSaga({}, function* (): any {
      console.log('nix path: ', process.env.PKG_PATH_NIX_LAZY + '/bin/nix')
      const repl = spawn(
        process.env.PKG_PATH_NIX_LAZY + '/bin/nix',
        ['repl', '--allow-unsafe-native-code-during-evaluation'], // --allow-unsafe-native-code-during-evaluation needed for builtins.exec which is useful in some tasks
        {
          env: {
            ...process.env,
            NIX_TASK_CONTROL_SOCKET: path.join(tmpDir.path, 'control.sock'),
          },
        },
      )

      // repl.stdout.on('data', data => console.log('stdout', data.toString()))
      repl.stderr.on('data', data => console.log('stderr', data.toString()))

      repl.on('close', () => {
        // console.log('Nix repl exited')
        process.exit(1)
      })

      const startupChannel = yield call(() =>
        eventChannel(emitter => {
          const listener = (data: any) => {
            if (data.toString().includes('Type :? for help')) {
              emitter(true)
            }
          }
          repl.stderr.on('data', listener)
          return () => repl.stderr.off('data', listener)
        }),
      )
      yield take(startupChannel)
      startupChannel.close()

      // console.log('Nix repl started')

      try {
        let markerCounter = 0

        while (true) {
          const action = yield take(commandQueue)

          const doneChannel = channel(buffers.none() as any)

          // nix repl streams a result followed by an extra blank line, and its
          // output arrives in arbitrarily-split chunks. Detecting completion by
          // "a chunk ended in a newline" is unreliable: a stray trailing newline
          // from the previous command can land in this command's listening window
          // and complete it early. That cascades — every subsequent command then
          // receives the previous command's (or a null) result, which downstream
          // crashes collectTasks with "TypeError: i is not iterable" or silently
          // runs a task with the wrong data. Instead we append a unique marker
          // expression after each command and only treat it as complete once the
          // marker's evaluated output appears, which the repl can only print once
          // it has finished evaluating the real command.
          const marker = `@@NIX_TASK_REPL_DONE_${markerCounter++}@@`
          const quotedMarker = JSON.stringify(marker)

          let responseOut = ''
          let responseErr = ''

          const stdoutListener = (data: any) => {
            responseOut += data.toString()
            if (responseOut.includes(marker)) {
              doneChannel.put(true)
            }
          }
          const stderrListener = (data: any) => (responseErr += data.toString())
          repl.stdout.on('data', stdoutListener)
          repl.stderr.on('data', stderrListener)

          try {
            currentEnvContext = {
              ...(action.envToPass ?? process.env),
              PATH: process.env.PATH,
            }

            // console.log('--->', action.command)
            repl.stdin.write(action.command.replaceAll('\n', ' ') + '\n') // remove new lines from input command as it will cause command to be sent to REPL
            // evaluate the marker on its own line so its output flushes strictly
            // after the command's output, giving a reliable completion signal
            repl.stdin.write(quotedMarker + '\n')

            yield take(doneChannel)

            currentEnvContext = process.env

            // drop everything from the marker onwards to recover just the
            // command's own output
            const cleaned = stripAnsi(responseOut)
            const markerIndex = cleaned.indexOf(quotedMarker)
            const rawExtracted =
              markerIndex >= 0 ? cleaned.slice(0, markerIndex) : cleaned

            // Framing-integrity check — applies to EVERY command (getTasks,
            // getLazyTask AND getOutput), so a misframe is caught wherever it
            // happens. Two invariants must hold:
            //   1. this command's own completion marker is present in stdout;
            //   2. no OTHER command's marker appears before it — a foreign
            //      marker in the extracted output means a previous command's
            //      result bled into this one.
            // A violation is the root cause of both "TypeError: i is not
            // iterable" (getLazyTask) and spurious null outputs (getOutput).
            // Always log the full exchange so it's diagnosable from CI logs.
            const MARKER_PREFIX = '@@NIX_TASK_REPL_DONE_'
            if (markerIndex < 0 || rawExtracted.includes(MARKER_PREFIX)) {
              console.error(
                `[nix-task] repl framing corruption: ${
                  markerIndex < 0
                    ? "this command's completion marker was not found in stdout"
                    : "another command's marker leaked into this command's output"
                } (marker=${marker}, rawStdoutLen=${responseOut.length}, ` +
                  `stderrLen=${responseErr.length}). The repl output framed ` +
                  `incorrectly; the parsed result for this command is unreliable. ` +
                  `Full exchange follows:`,
              )
              console.error(
                `[nix-task]   command: ${action.command.replaceAll('\n', ' ')}`,
              )
              console.error(
                `[nix-task]   raw stdout: ${JSON.stringify(cleaned)}`,
              )
              console.error(
                `[nix-task]   raw stderr: ${JSON.stringify(responseErr)}`,
              )
            }

            let output: any = rawExtracted
            try {
              output = fromJSON(fromJSON(output))
            } catch (ex) {
              try {
                output = fromJSON(output)
              } catch (ex) {}
            }
            if (typeof output === 'string' && output.trim() === '')
              output = null

            if (
              responseErr.trim() !== '' &&
              (responseErr?.startsWith('error:') ||
                responseErr?.includes(
                  "requires lock file changes but they're not allowed",
                )) &&
              !output
            ) {
              // console.log('got output', { responseErr, output })
              action.reject(new Error('Nix evaluation error: ' + responseErr))
            } else {
              action.resolve(output)
            }
          } finally {
            repl.stdout.off('data', stdoutListener)
            repl.stderr.off('data', stderrListener)
          }
        }

        yield take(CANCEL)
      } finally {
        repl.kill('SIGTERM')
      }
    })
    await task.toPromise()
  } finally {
    await tmpDir.cleanup()
  }
}

function fromJSON(json: any) {
  // apply some fixes as Nix .toJSON sometimes produces invalid JSON
  // console.log('trying from JSON', json.replace(/([^\\])(\\\$)/, '$1$'))
  return JSON.parse(json.replace(/([^\\])(\\\$)/g, '$1$'))
}

export async function nixEval(command: string, envToPass?: any) {
  const responsePromise = new Promise((resolve, reject) =>
    commandQueue.put({ command, resolve, reject, envToPass }),
  )
  return await responsePromise
}
