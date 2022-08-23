{
  description = "Nix Task Runner";

  inputs = {
    nixpkgs.url = github:nixos/nixpkgs/nixos-22.05;
    utils.url = github:gytis-ivaskevicius/flake-utils-plus;
  };

  outputs = inputs@{ self, nixpkgs, utils }:
    let
      nixpkgsLib = nixpkgs.lib;
      nixpkgsStdEnv = nixpkgs.legacyPackages.x86_64-linux.stdenv;
      flake = utils.lib.mkFlake {
        inherit self inputs;

        outputsBuilder = channels: {
          devShell = import ./shell.nix {
            pkgs = channels.nixpkgs;
          };
        };
      };
    in
    flake // {
      lib = import ./nix/lib { lib = nixpkgsLib; stdenv = nixpkgsStdEnv; };
    };
}
