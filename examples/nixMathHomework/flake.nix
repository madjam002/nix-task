{
  description = "A very basic flake";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.05";
    utils.url = "github:gytis-ivaskevicius/flake-utils-plus";
    nix-task.url = "path:../../";
    nix-task.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs@{ self, nixpkgs, utils, nix-task }:
    utils.lib.mkFlake {
      inherit self inputs;

      outputsBuilder = channels: {

        tasks = rec {

          outside_dependency = nix-task.lib.mkTask {
            stableId = [ "outside_dependency" ];
            dir = ./.;
            path = with channels.nixpkgs; [ jq ];
            run = ''
              taskSetOutput "$(jq --null-input -cM --arg result 123 '{result:$result}')"
            '';
            fetchOutput = ''
              taskSetOutput "$(jq --null-input -cM --arg result 123 '{result:$result}')"
            '';
          };

          example = {
            calculate = rec {
              add_3_and_7 = nix-task.lib.mkTask {
                stableId = [ "add_3_and_7" ];
                tags = [ "test_calculate" ];
                dir = ./.;
                deps = { inherit outside_dependency; };
                path = with channels.nixpkgs; [
                  channels.nixpkgs.nodejs_20
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
                  ${channels.nixpkgs.nodejs_20}/bin/node --version

                  echo "got directory"
                '';
                shellHook = ''
                  taskRunInBackground echo from shell hook
                  taskRunFinally echo will exit now
                  echo "got shell hook!"
                '';
                custom.destroy = ''
                  echo "destroy 3"
                '';
                fetchOutput = ''
                  expr 3 + 7 > $out/homework
                '';
              };
              multiply_by_9 = nix-task.lib.mkTask {
                stableId = "multiply_by_9";
                tags = [ "test_calculate" ];
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
                # custom.destroy = '' # test no destroy function should just silently pass
                #   echo "destroy 2"
                # '';
                fetchOutput = { deps, ... }: ''
                  value=`cat ${deps.add_3_and_7.artifacts.homework}`
                  result=`expr $value \* 9`
                  taskSetOutput "$(jq --null-input -cM --arg result $result '{result:$result}')"
                '';
              };
              display_result = nix-task.lib.mkTask {
                stableId = [ "display_result" ];
                tags = [ "test_calculate" "test_result" ];
                deps = {
                  inherit multiply_by_9;
                  foo.output.test = "blah";
                  dummy = null;
                };
                path = with channels.nixpkgs; [
                  nodejs
                ];
                run = { deps, ... }: ''
                  echo "got result!"
                  echo "${deps.multiply_by_9.output.numeric}"

                  echo "dummy dependency test"
                  echo "${deps.foo.output.test}"

                  echo "flake ref"
                  echo "$NIX_TASK_FLAKE_PATH"

                  echo "got all deps"
                  taskGetDeps
                '';
                custom.destroy = { deps, ... }: ''
                  echo "destroy 1"

                  echo "test file"
                  file="${builtins.toFile "backendConfig.json" (builtins.toJSON (
                    { result = "${deps.multiply_by_9.output.numeric}"; }
                  ))}"
                  echo "$file"
                  cat $file
                '';
              };

              test_separate = nix-task.lib.mkTask {
                stableId = [ "test_separate" ];
                run = ''
                  echo "hello world"
                '';
              };
            };

            passthroughTest = nix-task.lib.mkTask {
              stableId = [ "passthrough_test" ];
              dir = ./.;
              path = with channels.nixpkgs; [
                channels.nixpkgs.nodejs_20
              ];
              impureEnvPassthrough = [ "SSH_AUTH_SOCK" ];
              run = ''
                echo "got ssh auth sock $IMPURE_SSH_AUTH_SOCK"
                env
              '';
              shellHook = ''
                echo "got shell hook!"
                echo "got ssh auth sock $IMPURE_SSH_AUTH_SOCK"
                env
              '';
            };

            execTest = nix-task.lib.mkTask {
              stableId = [ "exec_test" ];
              dir = ./.;
              path = with channels.nixpkgs; [
                channels.nixpkgs.nodejs_20
              ];
              run = { deps }: ''
                echo "test 1 home $HOME"
                echo "test 2 home ${builtins.exec [ "bash" "-c" ''echo "\"$HOME\""'' ]}"
                echo "test 3 home $(taskEval "task: builtins.exec [ \"execInTask\" \"bash\" \"-c\" '''echo \"\\\"\$HOME\\\"\"''' ]")"
                echo "^^ above should be the same"
              '';
            };
          };

          # don't modify this and instead duplicate it as it contains a specific bug where dependency ordering of outputs
          # when doing --only-tags test_e2e was incorrect
          complex_environment_example_1 = rec {
            infra = rec {
              kubernetes_cluster =
                let
                  prerequisites = nix-task.lib.mkTask {
                    stableId = "infra/kubernetes_cluster/prerequisites";
                    deps = {

                    };
                  };
                  infrastructure = nix-task.lib.mkTask {
                    stableId = "infra/kubernetes_cluster/infrastructure";
                    deps = {
                      inherit prerequisites;
                    };
                    # produce an output so kubernetes_cluster's mkTaskOutput
                    # getOutput can read `deps.infrastructure.output`. Emit it both
                    # when run normally and when its output is fetched under
                    # --only-tags, so both paths make the output available.
                    run = ''
                      taskSetOutput '{"ready":true}'
                    '';
                    fetchOutput = ''
                      taskSetOutput '{"ready":true}'
                    '';
                  };
                  resources = nix-task.lib.mkTask {
                    stableId = "infra/kubernetes_cluster/resources";
                    deps = {
                      inherit infrastructure;
                    };
                  };
                in
                {
                  inherit prerequisites;
                  inherit infrastructure;
                  inherit resources;
                  output = nix-task.lib.mkTaskOutput {
                    deps = {
                      inherit resources;
                      inherit infrastructure;
                    };
                    getOutput = { deps, ... }: deps.infrastructure.output;
                  };
                };

              message_bus = nix-task.lib.mkTask {
                stableId = "infra/message_bus";
                deps = {
                  inherit kubernetes_cluster;
                };
              };
            };

            staging = rec {
              namespace = nix-task.lib.mkTask {
                stableId = "staging/namespace";
                tags = [ "environment" ];
                deps = {
                  inherit (infra) kubernetes_cluster;
                };
              };
              service_1 = nix-task.lib.mkTask {
                stableId = "staging/service_1";
                tags = [ "environment" ];
                deps = {
                  inherit (infra) kubernetes_cluster;
                  inherit namespace;
                };
              };
              service_2 = nix-task.lib.mkTask {
                stableId = "staging/service_2";
                tags = [ "environment" ];
                deps = {
                  inherit (infra) kubernetes_cluster;
                  inherit namespace;
                };
              };
              service_3 = nix-task.lib.mkTask {
                stableId = "staging/service_3";
                tags = [ "environment" ];
                deps = {
                  inherit (infra) kubernetes_cluster message_bus;
                  inherit namespace;
                };
              };
              test = {
                e2e = nix-task.lib.mkTask {
                  stableId = "staging/test_e2e";
                  tags = [ "test_e2e" ];
                  deps = {
                    inherit (infra) message_bus;
                    inherit namespace;
                    inherit service_3;
                  };
                };
              };
            };
          };
        };

      };
    };
}
