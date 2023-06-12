{ lib }:

with builtins;
with lib;

let
in
opts@{
  stableId ? null,
  dir ? null,
  path ? [],
  deps ? {},
  artifacts ? [], # list of file names that this task exports as artifacts
  impureEnvPassthrough ? [],
  run ? "",
  shellHook ? "",
  getOutput ? null,
}:
let
  dirString = if dir == null then null else toString dir;
  initialRunString = if (isString run) then run else "# __TO_BE_LAZY_EVALUATED__";
  initialShellHookString = if (isString shellHook) then shellHook else "# __TO_BE_LAZY_EVALUATED__";
  id = hashString "sha256" (toJSON stableId);
in
if stableId == null || stableId == [] then
  throw "mkTask(): stableId must be provided and be unique for each task"
else
{
  inherit id;
  __type = "task";
  inherit path;
  inherit deps;
  inherit artifacts;
  inherit impureEnvPassthrough;
  dir = dirString;
  run = initialRunString;
  shellHook = initialShellHookString;
  inherit getOutput;

  getLazy = ctx:
    {
      inherit id;
       __type = "task";
      inherit path;
      inherit deps;
      inherit artifacts;
      inherit impureEnvPassthrough;
      dir = dirString;
      run = if (isString run) then run else (run ctx);
      shellHook = if (isString shellHook) then shellHook else (shellHook ctx);
      inherit getOutput;
    };
}
