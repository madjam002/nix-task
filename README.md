# nix-task

> Not ready for use yet, no usable packages are exported from this repository

nix-task is a task/action runner that lets you use the Nix language to write simple tasks or entire CI/CD pipelines, as an alternative to tools like Make, Dagger, Taskfile, etc.

It is not a replacement of CI/CD runners like GitLab CI or GitHub Actions, and instead is designed to complement these tools by being called by CI/CD runners. This allows pipelines to be authored and run agnostic to any particular CI/CD runner.

## Examples

See [examples/nixMathHomework/flake.nix]() as an example.

## Documentation

### Nix library

#### `nix-task.lib.mkTask`

```
nix-task.lib.mkTask({
  # other tasks that this task is dependant on
  deps =? [ other tasks ];

  # nix packages that should be made available to the PATH for task execution
  path =? [ nix pkgs here ];

  # script to run for this task
  run = string | { deps }: string;

  # script to run when entering a shell using `nix-task shell`
  shellHook ?= string | { deps }: string;

  id =? string;
})
```

### Bash stdlib available to tasks

#### `$out`

Returns the path to an output directory where output artifacts can be stored. For this directory to be available, `artifacts = [ "output" "file" "names" "here" ];` needs to be set on the `mkTask`.

#### `$IMPURE_HOME`

Returns the path to your user home directory.

#### `taskSetOutput <json>`

Sets `<json>` as the output of this task, which can be used by other tasks that depend on this task.

#### `taskRunInBackground <command>`

Runs `<command>` in the background of this task. Will be sent a SIGTERM when the task has finished and will wait for the process to gracefully terminate.

#### `taskRunFinally <command>`

Runs `<command>` when this task finishes either successfully or on error.

#### `taskGetDeps`

Dumps the deps and their outputs as JSON.
