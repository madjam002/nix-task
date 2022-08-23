import commander from 'commander'

const program = new commander.Command()
const collect = (value: string, previous: string[]) => previous.concat([value])

program.version(require('../package.json').version)

program
// program.option(
//   '-K, --keep <env>',
//   'pass through an environment variable to the task sandbox',
//   collect,
//   [],
// )

// program
// program.option('--dry-run', 'run tasks with dry run flag passed in', false)

// program.option(
//   '-J, --concurrency <concurrency>',
//   'maximum number of tasks to run at once',
//   parseInt,
//   4,
// )

program
  .command('run <tasks...>')
  .option(
    '--only',
    "only run the specific tasks passed on the command line, ignoring all dependencies. Dependencies which aren't cached will error.",
    false,
  )
  .option(
    '-i, --interactive',
    'runs tasks with the stdin TTY passed through, enabling interactivity. implies no parallelism',
    false,
  )
  .option('-g, --graph', 'show a dependency graph of the running order', false)
  .option(
    '--debug',
    'show some additional logs to help with debugging task runs',
    false,
  )
  .description('run the provided tasks')
  .action(require('./commands/run').default)

program
  .command('shell <task>')
  .option(
    '--debug',
    'show some additional logs to help with debugging task runs',
    false,
  )
  .option(
    '--no-shell-hook',
    'disable running shell hooks for the specified task',
  )
  .description(
    'open an interactive shell in the context of a task (similar to nix shell)',
  )
  .action(require('./commands/shell').default)

async function run() {
  await program.parseAsync(process.argv)
}

run()
