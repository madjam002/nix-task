export interface NixTaskObject {
  __type: 'task'
  id: string
  nixAttributePath: string
  flakeOutputPath: string
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
  flakeOutputPath: string
  nixAttributePath: string
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
