# This file can't import anything as we include the contents of this file
# directly in nix eval --apply arguments (see how this file is included in runner/src/common.ts)

with builtins;

let
  flatten = x:
    if isList x
    then concatMap (y: flatten y) x
    else [x];
  mapAttrsToList = f: attrs:
    map (name: f name attrs.${name}) (attrNames attrs);
  collect = pred: attrs:
    if pred attrs then
      [ attrs ]
    else if isAttrs attrs then
      concatMap (collect pred) (attrValues attrs)
    else
      [];

  ###

  getDrvDependenciesFromString = str:
    let
      # builtins.getContext is undocumented
      # see - https://github.com/NixOS/nix/blob/d5e979ab87ab894fde132799dac242780b28bc05/src/libexpr/primops/context.cc#L49
      ctx = builtins.getContext str;
    in
    attrNames ctx;

  depsWithDerivations = deps:
    mapAttrs (name: value:
      if (isTask value) then value.id else value
    ) deps;
  reuseWorkingDirectoryDerivation = reuseWorkingDirectory:
    if reuseWorkingDirectory != null then reuseWorkingDirectory.id else null;


  collectMaybeTask = { taskDefinition, currentPath, opts }:
    if isTask taskDefinition then
      collectTask { inherit taskDefinition; inherit currentPath; inherit opts; }
    else
      collectTasks { output = taskDefinition; inherit currentPath; inherit opts; }
    ;

  collectTask = { taskDefinition, currentPath, opts }:
    let
      task = with taskDefinition; (if (hasAttr "includeExtraAttributes" opts) && opts.includeExtraAttributes == true then taskDefinition else {}) // {
        inherit id;
        inherit __type;
        getLazy = null;
        flakeAttributePath = currentPath;
        deps = depsWithDerivations taskDefinition.deps;
        storeDependencies = uniquePredicate (a: b: a != b) (
          (map (pathItem: if (hasAttr "drvPath" pathItem) then pathItem.drvPath else pathItem) taskDefinition.path)
          ++ (getDrvDependenciesFromString taskDefinition.run)
          ++ (getDrvDependenciesFromString taskDefinition.shellHook)
        );
        inherit dir;
        inherit path;
        inherit artifacts;
        inherit run;
        inherit shellHook;
        hasGetOutput = getOutput != null && isFunction getOutput;
      };
      depsTasks = flatten (mapAttrsToList (key: value: collectMaybeTask { taskDefinition = value; inherit opts; currentPath = "${if currentPath != "" then "${currentPath}." else ""}deps.${key}"; }) taskDefinition.deps);
    in
    [task] ++ depsTasks;

  isTask = maybeTask: (isAttrs maybeTask) && (hasAttr "__type" maybeTask) && maybeTask.__type == "task";

  collectTasks = { output, currentPath, opts ? {} }:
    if isTask output then
      (collectTask { taskDefinition = output; inherit currentPath; inherit opts; })
    else if isAttrs output then
      concatMap (attrName: collectMaybeTask { taskDefinition = output.${attrName}; inherit opts; currentPath = if currentPath != "" then "${currentPath}.${attrName}" else attrName; }) (attrNames output)
    else
      [];

  uniquePredicate = pred: list:
    if list == [] then
      []
    else
      let
        x = head list;
      in [x] ++ uniquePredicate pred (filter (y: pred x y) list);

  # sort by shortest path to task
  sortTasks = a: b: (builtins.stringLength a.flakeAttributePath) < (builtins.stringLength b.flakeAttributePath);

  formatTasks = collectedTasks:
    let
      orderedTasks = sort sortTasks (collectedTasks);
      taskDefinitions = uniquePredicate (a: b: a.id != b.id) orderedTasks;
    in
      taskDefinitions;

  getAllTasks = tasks:
    formatTasks (collectTasks {
      output = tasks;
      currentPath = "";
      opts.includeExtraAttributes = true; # include all attributes as getAllTasks shouldn't be serialised to JSON so functions don't matter
    });
in
