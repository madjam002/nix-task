import path from 'path'
import fs from 'fs-extra'
import { Task } from './interfaces'

export default async function buildLazyContextForTask(
  task: Task,
  { nixTaskStateDir }: { nixTaskStateDir: string },
) {
  const depKeys = Object.keys(task.deps)

  const depsContext: any = {}

  for (const depKey of depKeys) {
    const _dep = task.deps[depKey]

    if (_dep?.__type === 'task' && _dep?.id != null) {
      // dep is a reference to another task, fetch outputs and artifacts
      const dep = _dep as Task
      const depDirName = `${dep.name}-${dep.id.substring(0, 12)}`
      const depArtifactsDir = path.join(
        nixTaskStateDir,
        'artifacts',
        depDirName,
      )
      const depOutFile = path.join(
        nixTaskStateDir,
        'output',
        depDirName + '.json',
      )

      try {
        const outputRaw = await fs.readFile(depOutFile, 'utf8')
        const output = JSON.parse(outputRaw)
        if (!depsContext[depKey]) depsContext[depKey] = {}
        depsContext[depKey].output = output
      } catch (ex) {
        // throw new Error(
        //   'Error reading output for dependency ' +
        //     depKey +
        //     ' from ' +
        //     outputFilePath +
        //     ', have the dependency tasks run successfully?',
        // )
      }

      if (dep.artifacts != null && dep.artifacts.length > 0) {
        const artifactFilesAndFolders = await fs.readdir(depArtifactsDir)

        const artifactPaths: any = {}

        for (const artifactName of artifactFilesAndFolders) {
          artifactPaths[artifactName] = path.join(depArtifactsDir, artifactName)
        }

        if (!depsContext[depKey]) depsContext[depKey] = {}
        depsContext[depKey].artifacts = artifactPaths
      }
    } else {
      // dep is just a plain object, return as is
      depsContext[depKey] = _dep
    }
  }

  return {
    deps: depsContext,
  }
}
