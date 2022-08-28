{ pkgs, ... }:

with pkgs;

let
  nixTaskDev = writeShellScriptBin "nix-task" ''
    NODE_PATH=$REPO_ROOT/runner/node_modules node -r esbuild-register $REPO_ROOT/runner/src/index.ts "$@"
  '';
in
mkShell {
  buildInputs = [
    nodejs-18_x
    nixTaskDev
  ];

  shellHook = ''
    # $PWD in shellHook is always the root of the repo
    export REPO_ROOT=$PWD

    export PKG_PATH_BASH="${pkgs.bashInteractive}"
    export PKG_PATH_COREUTILS="${pkgs.coreutils}"
    export PKG_PATH_JQ="${pkgs.jq}"
    export PKG_PATH_NODEJS="${pkgs.nodejs-18_x}"
    export PKG_PATH_UTIL_LINUX="${pkgs.util-linux}"
  '';
}
