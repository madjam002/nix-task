{ lib, stdenv }:

with builtins;
with lib;

let
in
opts@{
  id ? null,
  dir ? null,
  path ? [],
  deps ? {},
  artifacts ? [], # list of file names that this task exports as artifacts
  run ? "",
  shellHook ? "",
  getOutput ? null,
}:
let
  dirString = if dir == null then null else toString dir;
  initialRunString = if (isString run) then run else "# __TO_BE_LAZY_EVALUATED__";
  initialShellHookString = if (isString shellHook) then shellHook else "# __TO_BE_LAZY_EVALUATED__";

  hash = hashString "sha256" (toJSON [
    (if (isString run) then "" else (
      if id != null then id
      else throw "mkTask(): id: must be provided if run: is a function"
    ))
    dirString
    path
    initialRunString
    initialShellHookString
  ]);
in
{
  id = hash;
  __type = "task";
  inherit path;
  inherit deps;
  inherit artifacts;
  dir = dirString;
  run = initialRunString;
  shellHook = initialShellHookString;
  inherit getOutput;

  getLazy = ctx:
    {
      id = hash;
       __type = "task";
      inherit path;
      inherit deps;
      inherit artifacts;
      dir = dirString;
      run = if (isString run) then run else (run ctx);
      shellHook = if (isString shellHook) then shellHook else (shellHook ctx);
      inherit getOutput;
    };
}
