{ lib }:

let
  _lib = lib // {
    mkTask = import ./mkTask.nix { lib = _lib; };
  } // (import ./getTasks.nix);
in
_lib
