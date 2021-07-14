import json5 from 'json5'
import { TCompilerPluginFactory } from '../../TCompilerPluginFactory'
import { Command } from './Command'
import { transformCommands } from './transformCommands'
import { setObjectAt } from '/@/utils/walkObject'

export const CustomCommandsPlugin: TCompilerPluginFactory<{
	include: Record<string, string[]>
	isFileRequest: boolean
	mode: 'dev' | 'build'
	v1CompatMode?: boolean
}> = ({
	fileSystem,
	options: {
		include = {},
		isFileRequest,
		mode = 'dev',
		v1CompatMode = false,
	} = {},
}) => {
	const isCommand = (filePath: string | null) =>
		filePath?.startsWith('BP/commands/')
	const isMcfunction = (filePath: string | null) =>
		filePath?.startsWith('BP/functions/') &&
		filePath?.endsWith('.mcfunction')

	const loadCommandsFor = (filePath: string) =>
		Object.entries(include).find(([startPath]) =>
			filePath.startsWith(startPath)
		)?.[1]
	const withSlashPrefix = (filePath: string) =>
		['BP/animations/', 'BP/animation_controllers/'].some((typePath) =>
			filePath.startsWith(typePath)
		)

	return {
		async buildStart() {
			// Load default command locations and merge them with user defined locations
			include = Object.assign(
				await fileSystem.readJSON(
					'data/packages/minecraftBedrock/location/validCommand.json'
				),
				include
			)
		},
		transformPath(filePath) {
			if (isCommand(filePath) && !isFileRequest) return null
		},
		async read(filePath, fileHandle) {
			if (!fileHandle) return

			if (isCommand(filePath) && filePath.endsWith('.js')) {
				const file = await fileHandle.getFile()
				return await file.text()
			} else if (isMcfunction(filePath)) {
				const file = await fileHandle.getFile()
				return await file.text()
			} else if (loadCommandsFor(filePath) && fileHandle) {
				// Currently, MoLang in function files is not supported so we can just load files as JSON
				const file = await fileHandle.getFile()
				try {
					return json5.parse(await file.text())
				} catch (err) {
					console.error(err)
				}
			}
		},
		async load(filePath, fileContent) {
			if (isCommand(filePath)) {
				const command = new Command(fileContent, mode, v1CompatMode)

				await command.load()
				return command
			}
		},
		async registerAliases(filePath, fileContent) {
			if (isCommand(filePath)) return [`command#${fileContent.name}`]
		},
		async require(filePath) {
			if (loadCommandsFor(filePath) || isMcfunction(filePath)) {
				// Register custom commands as JSON/mcfunction file dependencies
				return ['BP/commands/**/*.js', 'BP/commands/*.js']
			}
		},
		async transform(filePath, fileContent, dependencies = {}) {
			const includePaths = loadCommandsFor(filePath)

			if (includePaths && includePaths.length > 0) {
				// For every MoLang location
				includePaths.forEach((includePath) =>
					// Search it inside of the JSON & transform it if it exists
					setObjectAt<string | string[]>(
						includePath,
						fileContent,
						(commands) => {
							if (!commands) return commands
							const hasSlashPrefix = withSlashPrefix(filePath)

							commands = Array.isArray(commands)
								? commands
								: [commands]

							return transformCommands(
								commands.map((command) =>
									hasSlashPrefix ? command : `/${command}`
								),
								dependencies,
								false
							).map((command) =>
								hasSlashPrefix ? command : command.slice(1)
							)
						}
					)
				)
			} else if (isMcfunction(filePath)) {
				const commands = (<string>fileContent)
					.split('\n')
					.map((command) => command.trim())
					.filter(
						(command) => command !== '' && !command.startsWith('#')
					)
					.map((command) => `/${command}`)

				return transformCommands(commands, dependencies, true)
					.map((command) =>
						command.startsWith('/') ? command.slice(1) : command
					)
					.join('\n')
			}
		},
		finalizeBuild(filePath, fileContent) {
			// Necessary to make auto-completions work for TypeScript components
			if (isCommand(filePath)) {
				return (<Command>fileContent).toString()
			}
			// Make sure JSON files are transformed back into a format that we can write to disk
			else if (
				loadCommandsFor(filePath) &&
				typeof fileContent !== 'string'
			)
				return JSON.stringify(fileContent, null, '\t')
		},
	}
}
