import * as fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import Utils from '../utils/utils';
import Uuid from '../utils/uuid';

const REG_UUID = /"uuid":\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/;

/**
 * Cocos资源文件查找
 */
export default class FindAssets {

    public static readonly command: string = 'CocosToolbox.findReferences';

    private static _init: boolean = false;
    private static _watcher: vscode.FileSystemWatcher;
    private static _outputChannel: vscode.OutputChannel;

    private static _deletePathSet: Set<string> = new Set();
    private static _createPathSet: Set<string> = new Set();
    private static _cachePathSet: Set<string> = new Set();
    private static _hasCache: boolean = false;
    private static _waitingPromise: boolean = false;
    private static _waitingResolve: Array<() => void> = [];

    public static init(context: vscode.ExtensionContext): void {
        if (this._init)
            return;
        this._init = true;

        // 缓存需要的资源路径
        setTimeout(() => {
            this.getCacheAssets();
        }, 1000);

        // 创建文件系统监视器，监听特定文件或文件夹的变化
        this._watcher = vscode.workspace.createFileSystemWatcher('**/assets/**/*.{fire,scene,prefab}');
        // 监听文件内容变化事件
        this._watcher.onDidChange(uri => {
        });
        this._watcher.onDidCreate(uri => {
            let path = uri.fsPath;
            this._deletePathSet.delete(path);
            this._createPathSet.add(path);
        });
        this._watcher.onDidDelete(uri => {
            let path = uri.fsPath;
            this._createPathSet.delete(path);
            this._deletePathSet.add(path);
        });

        // 监听查找引用
        this._outputChannel = vscode.window.createOutputChannel('Cocos Assets References');
        let searchLinstener = vscode.commands.registerCommand(this.command, () => {
            this.findCocosAssets(this._outputChannel);
        });

        context.subscriptions.push(this._watcher, this._outputChannel, searchLinstener);
    }

    /**
     * 缓存所有项目内的资源文件路径
     */
    private static async getCacheAssets(): Promise<void> {
        return new Promise((resolve, reject) => {
            // 已缓存
            if (this._hasCache) {
                this.updateCacheAssets();
                resolve();
                return;
            }

            this._waitingResolve.push(resolve);
            if (this._waitingPromise) {
                return;
            }

            this._waitingPromise = true;
            const promises = [
                vscode.workspace.findFiles('assets/**/*.fire'),
                vscode.workspace.findFiles('assets/**/*.scene'),
                vscode.workspace.findFiles('assets/**/*.prefab')
            ];
            Promise.all(promises).then((value) => {
                // 缓存所有资源路径
                let array: vscode.Uri[];
                let uri: vscode.Uri;
                let i: number;
                let j: number;
                for (i = 0; i < value.length; i++) {
                    array = value[i];
                    for (j = 0; j < array.length; j++) {
                        uri = array[j];
                        this._cachePathSet.add(uri.fsPath);
                    }
                }

                this.updateCacheAssets();

                this._hasCache = true;
                this._waitingPromise = false;
                this._waitingResolve.forEach(call => { call() });
            }).catch(() => {
                this._waitingPromise = false;
                this._waitingResolve.forEach(call => { call() });
            });
        });
    }

    /**
     * 更新缓存
     */
    private static updateCacheAssets(): void {
        if (this._createPathSet.size > 0 || this._deletePathSet.size > 0) {
            this._createPathSet.forEach((v) => {
                this._cachePathSet.add(v);
            });
            this._deletePathSet.forEach((v) => {
                this._cachePathSet.delete(v);
            });
        }
    }

    /**
     * 查找引用目标文件的Cocos资源文件
     */
    private static async findCocosAssets(outputChannel: vscode.OutputChannel): Promise<void> {
        try {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor)
                return;

            const activeFile = activeEditor.document.uri;
            const activeFileExtension = path.extname(activeFile.fsPath);
            if (activeFileExtension !== ".ts" && activeFileExtension !== ".js")
                return;

            const metaFilePath = `${activeFile.fsPath}.meta`;
            let checkMeta = await Utils.checkPath(metaFilePath);
            if (!checkMeta)
                return;

            let data = await fs.promises.readFile(metaFilePath, { encoding: 'utf8' });
            let match = REG_UUID.exec(data);
            if (!match)
                return;
            let uuid: string = match[1];
            let compressUuid = Uuid.compressUuid(uuid);

            // 更新资源文件
            await this.getCacheAssets();

            let results: string[] = [];
            for (let path of this._cachePathSet) {
                const fileData = await fs.promises.readFile(path, { encoding: 'utf8' });
                if (!fileData.includes(compressUuid))
                    continue;

                results.push(path);
            }

            let activeFileName = path.basename(activeFile.fsPath);
            outputChannel.clear();
            outputChannel.appendLine(`Cocos Assets References of [${activeFileName}]:`);
            outputChannel.appendLine(`File count ${results.length}.`);
            results.sort();
            results.forEach((reference, index) => {
                outputChannel.appendLine(`[${index + 1}] ${reference}`);
            });

            // Show the output channel in the VS Code UI
            outputChannel.show(true);
        } catch (error) {
            console.error(`Failed to findCocosAssets: ${error}`);
        }
    }
}
