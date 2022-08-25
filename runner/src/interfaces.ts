export interface NixTaskObject {
  __type: 'task'
  id: string
  flakeAttributePath: string
  deps: {
    [name: string]: any
  }
  run: string
}

export interface Task {
  __type: 'task'
  id: string
  name: string
  ref: string
  flakeAttributePath: string
  exactRefMatch: boolean // true if the path to this task was passed exactly to the command line
  flakePath: string // path to the resolved flake in the nix store, or original repo path if not supported
  resolvedOriginalFlakeUrl: string // original flake url (resolved to an absolute path)
  originalFlakeUrl: string // original flake url as-is originally passed to nix-task CLI (shouldn't really be used apart from display purposes)
  flakePrettyAttributePath: string // flakeAttributePath with the .tasks.<system> chomped off the front, should only be used for display purposes
  prettyRef: string
  deps: {
    [name: string]: any
  }
  allDiscoveredDeps: Task[]
  dir: string
  path: string[]
  artifacts: string[]
  storeDependencies: string[]
  run: string
  shellHook?: string
  hasGetOutput?: boolean
}

export interface NixFlakeMetadata {
  description: string
  lastModified: number
  locked: {
    dir?: string // present if flake is in subdirectory of repo
    narHash: string
  }
  resolved: {
    dir?: string // present if flake is in subdirectory of repo
  }
  path: string
  originalUrl: string
}
