{ lib }:

with builtins;
with lib;

let
in
opts@{
  deps ? {},
  getOutput ? null,
}:
{
  __type = "taskOutput";
  inherit deps;
  inherit getOutput;
}
