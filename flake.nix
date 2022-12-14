{
  description = "Nix Task Runner";

  inputs = {
    nixpkgs.url = github:nixos/nixpkgs/nixos-22.05;
    utils.url = github:numtide/flake-utils;
    yarnpnp2nix.url = github:madjam002/yarnpnp2nix;
    yarnpnp2nix.inputs.nixpkgs.follows = "nixpkgs";
    yarnpnp2nix.inputs.utils.follows = "utils";
  };

  outputs = inputs@{ self, nixpkgs, utils, ... }:
    let
      nixpkgsLib = nixpkgs.lib;
    in
    (utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            (final: prev: {
              nodejs = prev.nodejs-18_x;
              yarn = (prev.yarn.override { nodejs = prev.nodejs-18_x; });
            })
          ];
        };

        mkYarnPackagesFromManifest = inputs.yarnpnp2nix.lib."${system}".mkYarnPackagesFromManifest;
        runnerYarnPackages = mkYarnPackagesFromManifest {
          inherit pkgs;
          yarnManifest = import ./runner/yarn-manifest.nix;
          packageOverrides = {
            "nix-task@workspace:.".build = ''
              export PKG_PATH_BASH="${pkgs.bashInteractive}"
              export PKG_PATH_COREUTILS="${pkgs.coreutils}"
              export PKG_PATH_JQ="${pkgs.jq}"
              export PKG_PATH_NODEJS="${pkgs.nodejs}"
              export PKG_PATH_UTIL_LINUX="${pkgs.util-linux}"

              node build.js
            '';
          };
        };
      in
      rec {
        devShell = import ./shell.nix {
          inherit pkgs;
        };
        packages = {
          default = runnerYarnPackages."nix-task@workspace:.";
        };
      }
    )) // {
      lib = import ./nix/lib { lib = nixpkgsLib; };
    };
}
