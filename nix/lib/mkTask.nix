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

  dirStringForHash =
    # if dir is a /nix/store path, remove the /nix/store/**-** prefix as otherwise
    # the id will change every time a file in the repo is updated as a new source store path
    # will be created
    let
      splitPath = splitString "/" dirString;
    in
    if (elemAt splitPath 1) == "nix" && (elemAt splitPath 2) == "store" then
      concatStringsSep "/" (sublist 4 99 splitPath)
    else
      dirString;

  idHashInputs = [
    (if (isString run) then "" else (
      if id != null then id
      else throw "mkTask(): id: must be provided if run: is a function"
    ))
    (if dirString != null then dirStringForHash else "")
    path
    initialRunString
    initialShellHookString
  ];
  hash = hashString "sha256" (toJSON idHashInputs);
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
