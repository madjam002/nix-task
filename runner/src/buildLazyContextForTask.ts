import path from 'path'
import fs from 'fs-extra'
import { Task } from './interfaces'
import { callTaskGetOutput } from './common'

export default async function buildLazyContextForTask(
  task: Pick<Task, 'deps'>,
  { nixTaskStateDir }: { nixTaskStateDir: string },
) {
  const depKeys = Object.keys(task.deps)

  const depsContext: any = {}

  const [outFiles, artifactDirectories] = await Promise.all([
    fs.readdir(path.join(nixTaskStateDir, 'output')).catch(ex => []),
    fs.readdir(path.join(nixTaskStateDir, 'artifacts')).catch(ex => []),
  ])

  for (const depKey of depKeys) {
    const _dep = task.deps[depKey]

    if (_dep?.__type === 'task' && _dep?.id != null) {
      // dep is a reference to another task, fetch outputs and artifacts
      const dep = _dep as Task
      const depArtifactsDirName = findFileOrDirectoryForTask(
        dep.id,
        artifactDirectories,
      )
      const depArtifactsDir =
        depArtifactsDirName != null
          ? path.join(nixTaskStateDir, 'artifacts', depArtifactsDirName)
          : null
      const depOutFileName = findFileOrDirectoryForTask(dep.id, outFiles)
      const depOutFile =
        depOutFileName != null
          ? path.join(nixTaskStateDir, 'output', depOutFileName)
          : null

      if (depOutFile != null) {
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
      }

      if (
        depArtifactsDir != null &&
        dep.artifacts != null &&
        dep.artifacts.length > 0
      ) {
        const artifactFilesAndFolders = await fs.readdir(depArtifactsDir)

        const artifactPaths: any = {}

        for (const artifactName of artifactFilesAndFolders) {
          artifactPaths[artifactName] = path.join(depArtifactsDir, artifactName)
        }

        if (!depsContext[depKey]) depsContext[depKey] = {}
        depsContext[depKey].artifacts = artifactPaths
      }
    } else if (_dep?.__type === 'taskOutput') {
      const taskOutputDep = _dep
      const taskOutputDepsContext = await buildLazyContextForTask(
        { deps: taskOutputDep.deps },
        { nixTaskStateDir },
      )
      const taskOutputResult = await callTaskGetOutput(
        taskOutputDep.ref,
        taskOutputDepsContext,
      )
      if (!depsContext[depKey]) depsContext[depKey] = {}
      depsContext[depKey].output = taskOutputResult
    } else {
      // dep is just a plain object, return as is
      depsContext[depKey] = _dep
    }
  }

  return {
    deps: depsContext,
  }
}

function findFileOrDirectoryForTask(taskId: string, readDirItems: string[]) {
  // dep.name might not be consistent across runs (the name is inferred from attributes),
  // so the ID is the only stable identifier, we need to look solely based on that
  return (
    readDirItems.find(item =>
      item.match(`-${taskId.substring(0, 12)}(.[a-zA-Z]+)?$`),
    ) ?? null
  )
}
