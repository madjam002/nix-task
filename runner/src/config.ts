import { cosmiconfigSync } from 'cosmiconfig'

const explorerSync = cosmiconfigSync('nix-task', {
  searchPlaces: ['.nix-task.yaml', '.nix-task.yml'],
})

const result = explorerSync.search()

export interface Config {
  experimental?: {
    taskUserNamespaces?: boolean
  }
}

export default (result?.config ?? {}) as Config
