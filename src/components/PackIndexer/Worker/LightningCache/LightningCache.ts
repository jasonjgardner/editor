import { FileType } from '/@/components/Data/FileType'
import { run } from '/@/components/Extensions/Scripts/run'
import { walkObject } from '/@/utils/walkObject'
import json5 from 'json5'
import type { PackIndexerService } from '../Main'
import type { LightningStore } from './LightningStore'
import { runScript } from './Script'
import { extname } from '/@/utils/path'

const knownTextFiles = new Set([
	'.js',
	'.ts',
	'.lang',
	'.mcfunction',
	'.txt',
	'.molang',
])

export interface ILightningInstruction {
	'@filter'?: string[]
	'@map'?: string
	[str: string]: undefined | string | string[]
}

export class LightningCache {
	protected folderIgnoreList = new Set<string>()
	protected totalTime = 0

	constructor(
		protected service: PackIndexerService,
		protected lightningStore: LightningStore
	) {}

	async loadIgnoreFolders() {
		try {
			const file = await this.service.fileSystem.readFile(
				'bridge/.ignore-folders'
			)
			;(await file.text())
				.split('\n')
				.concat(['bridge', 'builds'])
				.forEach((folder) => this.folderIgnoreList.add(folder))
		} catch {
			;['bridge', 'builds'].forEach((folder) =>
				this.folderIgnoreList.add(folder)
			)
		}
	}

	async start() {
		await this.lightningStore.setup()

		if (this.folderIgnoreList.size === 0) await this.loadIgnoreFolders()

		if (this.service.getOptions().noFullLightningCacheRefresh) {
			const filePaths = this.lightningStore.allFiles()
			if (filePaths.length > 0) return [filePaths, []]
		}

		let anyFileChanged = false
		const filePaths: string[] = []
		const changedFiles: string[] = []
		await this.iterateDir(
			this.service.fileSystem.baseDirectory,
			async (fileHandle, filePath) => {
				const fileDidChange = await this.processFile(
					filePath,
					fileHandle
				)

				if (fileDidChange) {
					if (!anyFileChanged) anyFileChanged = true
					changedFiles.push(filePath)
				}
				filePaths.push(filePath)

				this.service.progress.addToCurrent()
			}
		)

		if (
			anyFileChanged ||
			this.lightningStore.visitedFiles !== this.lightningStore.totalFiles
		)
			await this.lightningStore.saveStore()
		return [filePaths, changedFiles]
	}

	protected async iterateDir(
		baseDir: FileSystemDirectoryHandle,
		callback: (
			file: FileSystemFileHandle,
			filePath: string
		) => void | Promise<void>,
		fullPath = ''
	) {
		for await (const [fileName, entry] of baseDir.entries()) {
			const currentFullPath =
				fullPath.length === 0 ? fileName : `${fullPath}/${fileName}`

			if (entry.kind === 'directory') {
				if (this.folderIgnoreList.has(currentFullPath)) continue
				await this.iterateDir(entry, callback, currentFullPath)
			} else if (fileName[0] !== '.') {
				this.service.progress.addToTotal(2)
				await callback(<FileSystemFileHandle>entry, currentFullPath)
			}
		}
	}

	/**
	 * @returns Whether this file did change
	 */
	async processFile(filePath: string, fileHandle: FileSystemFileHandle) {
		const file = await fileHandle.getFile()
		const fileType = FileType.getId(filePath)

		// First step: Check lastModified time. If the file was not modified, we can skip all processing
		if (
			file.lastModified ===
			this.lightningStore.getLastModified(filePath, fileType)
		) {
			this.lightningStore.setVisited(filePath, true, fileType)
			return false
		}

		const ext = extname(filePath)

		// Second step: Process file
		if (ext === '.json') {
			await this.processJSON(filePath, fileType, file)
		} else if (knownTextFiles.has(ext)) {
			await this.processText(filePath, fileType, file)
		} else {
			this.lightningStore.add(
				filePath,
				{ lastModified: file.lastModified },
				fileType
			)
		}

		return true
	}

	async processText(filePath: string, fileType: string, file: File) {
		const instructions = await FileType.getLightningCache(filePath)

		// JavaScript cache API
		if (typeof instructions === 'string') {
			const cacheFunction = runScript(instructions)
			if (typeof cacheFunction !== 'function') return

			const fileContent = await file.text()
			const textData = cacheFunction(fileContent)

			this.lightningStore.add(
				filePath,
				{
					lastModified: file.lastModified,
					data:
						Object.keys(textData).length > 0 ? textData : undefined,
				},
				fileType
			)
		}

		this.lightningStore.add(
			filePath,
			{ lastModified: file.lastModified },
			fileType
		)
	}

	/**
	 * Process a JSON file
	 * @returns Whether this json file did change
	 */
	async processJSON(filePath: string, fileType: string, file: File) {
		const fileContent = await file.text()

		// JSON API
		let data: any
		try {
			data = json5.parse(fileContent)
		} catch {
			this.lightningStore.add(
				filePath,
				{
					lastModified: file.lastModified,
				},
				fileType
			)
			return
		}

		// Load instructions for current file
		const instructions = await FileType.getLightningCache(filePath)

		// No instructions = no work
		if (instructions.length === 0 || typeof instructions === 'string') {
			this.lightningStore.add(
				filePath,
				{
					lastModified: file.lastModified,
				},
				fileType
			)
			return
		}

		// console.log(instructions)
		const collectedData: Record<string, string[]> = {}
		const onReceiveData = (
			key: string,
			filter?: string[],
			mapFunc?: string
		) => (data: any) => {
			let readyData: string[]
			if (Array.isArray(data)) readyData = data
			else if (typeof data === 'object')
				readyData = Object.keys(data ?? {})
			else readyData = [data]

			if (filter) readyData = readyData.filter((d) => !filter.includes(d))
			if (mapFunc)
				readyData = readyData
					.map((value) => run(mapFunc, { value }))
					.filter((value) => value !== undefined)

			if (!collectedData[key]) collectedData[key] = readyData
			else
				collectedData[key] = [
					...new Set(collectedData[key].concat(readyData)),
				]
		}

		for (const instruction of instructions) {
			const key = Object.keys(instruction).find(
				(key) => !key.startsWith('@')
			)
			if (!key) continue
			const paths = instruction[key] as string[]

			if (Array.isArray(paths)) {
				for (const path of paths) {
					walkObject(
						path,
						data,
						onReceiveData(
							key,
							instruction['@filter'],
							instruction['@map']
						)
					)
				}
			} else {
				walkObject(
					paths,
					data,
					onReceiveData(
						key,
						instruction['@filter'],
						instruction['@map']
					)
				)
			}
		}

		this.lightningStore.add(
			filePath,
			{
				lastModified: file.lastModified,
				data:
					Object.keys(collectedData).length > 0
						? collectedData
						: undefined,
			},
			fileType
		)

		return
	}
}