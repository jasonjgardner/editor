import { Command } from 'dash-compiler'
import { App } from '/@/App'
import { AnyDirectoryHandle } from '/@/components/FileSystem/Types'
import { iterateDir } from '/@/utils/iterateDir'

export async function generateCommandSchemas() {
	const app = await App.getApp()

	const v1CompatMode = app.project.config.get().bridge?.v1CompatMode ?? false
	const fromFilePath = `BP/commands`

	let baseDir: AnyDirectoryHandle
	try {
		baseDir = await app.project!.fileSystem.getDirectoryHandle(fromFilePath)
	} catch {
		return []
	}

	const schemas: any[] = []

	await iterateDir(
		baseDir,
		async (fileHandle, filePath) => {
			const [
				_,
				fileContent,
			] = await app.project.compilerService.compileFile(
				app.project.absolutePath(filePath),
				await fileHandle
					.getFile()
					.then(
						async (file) => new Uint8Array(await file.arrayBuffer())
					)
			)
			const file = new File([fileContent], fileHandle.name)
			const command = new Command(
				await file.text(),
				'development',
				v1CompatMode
			)

			await command.load('client')

			schemas.push(...command.getSchema())
		},
		undefined,
		fromFilePath
	)

	return schemas
}
