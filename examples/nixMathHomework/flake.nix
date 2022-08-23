{
  description = "A very basic flake";

  inputs = {
    nixpkgs.url = github:nixos/nixpkgs/nixos-22.05;
    utils.url = github:gytis-ivaskevicius/flake-utils-plus;
    nix-task.url = "../../.";
  };

  outputs = inputs@{ self, nixpkgs, utils, nix-task }:
    utils.lib.mkFlake {
      inherit self inputs;

      outputsBuilder = channels: {

        tasks = {

          example = {
            calculate = rec {
              add_3_and_7 = nix-task.lib.mkTask {
                # dir = ./.;
                path = with channels.nixpkgs; [
                  channels.nixpkgs.nodejs-16_x
                ];
                artifacts = [ "homework" ];
                run = ''
                  if [ -t 0 ] ; then
                    echo This shell is interactive
                  else
                    echo This shell is NOT interactive
                  fi
                  expr 3 + 7 > $out/homework
                  echo "got results"
                  cat $out/homework
                  ${channels.nixpkgs.nodejs-16_x}/bin/node --version
                '';
                shellHook = ''
                  taskRunInBackground echo from shell hook
                  taskRunFinally echo will exit now
                  echo "got shell hook!"
                '';
              };
              multiply_by_9 = nix-task.lib.mkTask {
                id = "multiply_by_9";
                deps = { inherit add_3_and_7; };
                path = with channels.nixpkgs; [
                  nodejs
                  jq
                ];
                artifacts = ["result"];
                run = { deps, ... }: ''
                  node --version
                  value=`cat ${deps.add_3_and_7.artifacts.homework}`
                  result=`expr $value \* 9`

                  echo $result > $out/result

                  taskSetOutput "$(jq --null-input -cM --arg result $result '{result:$result}')"
                '';
                getOutput = output: output // {
                  numeric = output.result;
                };
              };
              display_result = nix-task.lib.mkTask {
                id = "display_result";
                deps = {
                  inherit multiply_by_9;
                  foo.output.test = "blah";
                };
                path = with channels.nixpkgs; [
                  nodejs
                ];
                run = { deps, ... }: ''
                  echo "got result!"
                  echo "${deps.multiply_by_9.output.numeric}"

                  echo "dummy dependency test"
                  echo "${deps.foo.output.test}"

                  echo "got all deps"
                  taskGetDeps
                '';
              };

              test_separate = nix-task.lib.mkTask {
                run = ''
                  echo "hello world"
                '';
              };
            };
          };

        };

      };
    };
}
