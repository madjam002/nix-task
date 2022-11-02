{ pkgs, ... }:

with pkgs;

let
  nixTaskDev = writeShellScriptBin "nix-task" ''
    (cd $REPO_ROOT/runner && yarn node build)
    node $REPO_ROOT/runner/nix-task "$@"
  '';
in
mkShell {
  buildInputs = [
    nodejs
    yarn
    nixTaskDev
  ];

  shellHook = ''
    # $PWD in shellHook is always the root of the repo
    export REPO_ROOT=$PWD

    export PKG_PATH_BASH="${pkgs.bashInteractive}"
    export PKG_PATH_COREUTILS="${pkgs.coreutils}"
    export PKG_PATH_JQ="${pkgs.jq}"
    export PKG_PATH_NODEJS="${pkgs.nodejs}"
    export PKG_PATH_UTIL_LINUX="${pkgs.util-linux}"
  '';
}
