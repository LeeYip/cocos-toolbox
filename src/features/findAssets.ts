import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import path from "path";
import * as vscode from "vscode";
import Config from "../config";
import Utils from "../utils/utils";
import Uuid from "../utils/uuid";
import { ensureCreatorBridgeReady } from "./creatorBridgeInstaller";
import { buildReferencesHtml } from "./findAssetsView";

const REG_UUID = /"uuid":\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/;
const BRIDGE_SETTINGS_REL_PATH = path.join("local", "vscode-creator-bridge.json");

type CreatorBridgeRuntime = {
    port?: number;
    projectId?: string;
};

type CreatorTarget = {
    requestUrl: string;
    projectId?: string;
    workspacePath?: string;
};

/**
 * Cocos资源文件查找
 */
export default class FindAssets {
    public static readonly command: string = "CocosToolbox.findReferences";

    private static _init: boolean = false;
    private static _watcher: vscode.FileSystemWatcher;
    private static _gitWatchers: vscode.FileSystemWatcher[] = [];
    private static _referencesPanel: vscode.WebviewPanel | undefined;
    private static _currentReferences: string[] = [];
    private static _extensionPath: string = "";

    private static _deletePathSet: Set<string> = new Set();
    private static _createPathSet: Set<string> = new Set();
    private static _cachePathSet: Set<string> = new Set();
    /** 是否需要全量刷新缓存的资源文件 */
    private static _needFullRefresh: boolean = true;
    private static _waitingPromise: boolean = false;
    private static _waitingResolve: Array<() => void> = [];
    private static _searchRunning: boolean = false;
    private static _searchQueued: boolean = false;

    public static init(context: vscode.ExtensionContext): void {
        if (this._init) return;
        this._init = true;
        this._extensionPath = context.extensionPath;

        // 创建文件系统监视器，监听特定文件或文件夹的变化
        this._watcher = vscode.workspace.createFileSystemWatcher("**/assets/**/*.{fire,scene,prefab}");
        // 监听文件内容变化事件
        this._watcher.onDidCreate((uri) => {
            let path = uri.fsPath;
            if (!this.isInWorkspaceAssets(path)) {
                return;
            }

            this._deletePathSet.delete(path);
            this._createPathSet.add(path);
        });
        this._watcher.onDidDelete((uri) => {
            let path = uri.fsPath;
            if (!this.isInWorkspaceAssets(path)) {
                return;
            }

            this._createPathSet.delete(path);
            this._deletePathSet.add(path);
        });

        const onGitChanged = () => {
            this._needFullRefresh = true;
        };
        this._gitWatchers = [vscode.workspace.createFileSystemWatcher("**/.git/HEAD"), vscode.workspace.createFileSystemWatcher("**/.git/refs/heads/**"), vscode.workspace.createFileSystemWatcher("**/.git/packed-refs")];
        this._gitWatchers.forEach((watcher) => {
            watcher.onDidChange(onGitChanged);
            watcher.onDidCreate(onGitChanged);
            watcher.onDidDelete(onGitChanged);
        });

        let searchLinstener = vscode.commands.registerCommand(this.command, async () => {
            await this.runFindCocosAssets();
        });

        context.subscriptions.push(this._watcher, ...this._gitWatchers, searchLinstener);
    }

    /**
     * 判断文件路径是否属于Cocos Creator项目assets目录下
     */
    private static isInWorkspaceAssets(filePath: string): boolean {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }

        const normalizedPath = path.normalize(filePath).toLowerCase();
        for (const folder of workspaceFolders) {
            const folderPath = path.normalize(folder.uri.fsPath).toLowerCase();
            const assetsPath = path.join(folderPath, "assets").toLowerCase();
            if (normalizedPath.startsWith(assetsPath + path.sep) || normalizedPath === assetsPath) {
                return true;
            }
        }
        return false;
    }

    /**
     * 缓存所有项目内的资源文件路径
     */
    private static async collectWorkspaceAssetPaths(): Promise<Set<string>> {
        const promises = [vscode.workspace.findFiles("assets/**/*.fire"), vscode.workspace.findFiles("assets/**/*.scene"), vscode.workspace.findFiles("assets/**/*.prefab")];
        const value = await Promise.all(promises);
        const nextCachePathSet: Set<string> = new Set();
        let array: vscode.Uri[];
        let uri: vscode.Uri;
        let i: number;
        let j: number;
        for (i = 0; i < value.length; i++) {
            array = value[i];
            for (j = 0; j < array.length; j++) {
                uri = array[j];
                nextCachePathSet.add(uri.fsPath);
            }
        }
        return nextCachePathSet;
    }

    private static flushWaitingResolvers(): void {
        const waitingResolve = this._waitingResolve;
        this._waitingResolve = [];
        waitingResolve.forEach((call) => {
            call();
        });
    }

    private static async refreshCacheAssetsWithRetry(): Promise<void> {
        let nextCachePathSet = await this.collectWorkspaceAssetPaths();
        if (nextCachePathSet.size === 0 && this._cachePathSet.size > 0) {
            // 第一次全量扫描返回空，尝试重试一次
            const retryCachePathSet = await this.collectWorkspaceAssetPaths();
            if (retryCachePathSet.size > 0) {
                nextCachePathSet = retryCachePathSet;
            } else {
                console.warn("[CocosToolbox] full scan returned empty twice, keep previous cache and retry next time");
                this._needFullRefresh = true;
                return;
            }
        }

        this._cachePathSet = nextCachePathSet;
        this._createPathSet.clear();
        this._deletePathSet.clear();
        this._needFullRefresh = false;
        console.log(`[CocosToolbox] full scan assets count: ${this._cachePathSet.size}`);
    }

    private static getCacheAssets(): Promise<void> {
        return new Promise((resolve) => {
            this._waitingResolve.push(resolve);
            if (this._waitingPromise) {
                return;
            }

            if (!this._needFullRefresh) {
                this.updateCacheAssets();
                this.flushWaitingResolvers();
                return;
            }

            this._waitingPromise = true;
            this.refreshCacheAssetsWithRetry()
                .catch(() => { })
                .finally(() => {
                    this._waitingPromise = false;
                    this.flushWaitingResolvers();
                });
        });
    }

    /**
     * 增量更新缓存
     */
    private static updateCacheAssets(): void {
        if (this._createPathSet.size > 0 || this._deletePathSet.size > 0) {
            this._createPathSet.forEach((v) => {
                this._cachePathSet.add(v);
            });
            this._deletePathSet.forEach((v) => {
                this._cachePathSet.delete(v);
            });
            this._createPathSet.clear();
            this._deletePathSet.clear();
        }
    }

    /**
     * 查找引用目标文件的Cocos资源文件
     */
    private static async runFindCocosAssets(): Promise<void> {
        if (this._searchRunning) {
            this._searchQueued = true;
            return;
        }
        this._searchRunning = true;
        try {
            do {
                this._searchQueued = false;
                await this.findCocosAssets();
            } while (this._searchQueued);
        } finally {
            this._searchRunning = false;
        }
    }

    /**
     * 查找引用目标文件的Cocos资源文件
     */
    private static async findCocosAssets(): Promise<void> {
        try {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) return;

            const activeFile = activeEditor.document.uri;
            const activeFileExtension = path.extname(activeFile.fsPath);
            if (activeFileExtension !== ".ts" && activeFileExtension !== ".js") return;

            await ensureCreatorBridgeReady(this._extensionPath, activeFile.fsPath);

            const metaFilePath = `${activeFile.fsPath}.meta`;
            let checkMeta = await Utils.checkPath(metaFilePath);
            if (!checkMeta) return;

            let data = await fs.promises.readFile(metaFilePath, { encoding: "utf8" });
            let match = REG_UUID.exec(data);
            if (!match) return;
            let uuid: string = match[1];
            let compressUuid = Uuid.compressUuid(uuid);

            // 更新资源文件
            await this.getCacheAssets();

            let results: string[] = [];
            let invalidPaths: string[] = [];
            const cachePaths = Array.from(this._cachePathSet);
            let readIndex = 0;
            const concurrent = Math.min(16, Math.max(1, cachePaths.length));
            const getNextIndex = (): number => {
                if (readIndex >= cachePaths.length) {
                    return -1;
                }
                const nextIndex = readIndex;
                readIndex += 1;
                return nextIndex;
            };
            const readers: Promise<void>[] = [];
            for (let i = 0; i < concurrent; i++) {
                const reader = (async () => {
                    for (let currentIndex = getNextIndex(); currentIndex !== -1; currentIndex = getNextIndex()) {
                        const currentPath = cachePaths[currentIndex];
                        try {
                            const fileData = await fs.promises.readFile(currentPath, { encoding: "utf8" });
                            if (!fileData.includes(compressUuid)) continue;
                            results.push(currentPath);
                        } catch {
                            invalidPaths.push(currentPath);
                        }
                    }
                })();
                readers.push(reader);
            }
            await Promise.all(readers);
            invalidPaths.forEach((invalidPath) => {
                this._cachePathSet.delete(invalidPath);
            });

            let activeFileName = path.basename(activeFile.fsPath);
            results.sort();
            this._currentReferences = results;
            const panel = this.ensureReferencesPanel();
            panel.title = `Cocos Assets References - ${activeFileName}`;
            panel.webview.html = buildReferencesHtml(activeFileName, results);
            panel.reveal(vscode.ViewColumn.Beside, true);
        } catch (error) {
            console.error(`Failed to findCocosAssets: ${error}`);
        }
    }

    private static ensureReferencesPanel(): vscode.WebviewPanel {
        if (this._referencesPanel) {
            return this._referencesPanel;
        }

        const panel = vscode.window.createWebviewPanel("cocosAssetsReferences", "Cocos Assets References", vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        panel.onDidDispose(() => {
            this._referencesPanel = undefined;
            this._currentReferences = [];
        });
        panel.webview.onDidReceiveMessage(async (message) => {
            if (!message || message.type !== "openAsset") {
                return;
            }

            const index = Number(message.index);
            if (!Number.isInteger(index) || index < 0 || index >= this._currentReferences.length) {
                return;
            }

            const referencePath = this._currentReferences[index];
            const result = await this.postToCreator(referencePath);
            panel.webview.postMessage({
                type: "openResult",
                index,
                success: result.success,
                error: result.error,
            });
            if (!result.success) {
                return;
            }
        });
        this._referencesPanel = panel;
        return panel;
    }

    private static async postToCreator(referencePath: string): Promise<{ success: boolean; error?: string }> {
        const target = await this.resolveCreatorTarget(referencePath);
        if (!target) {
            return { success: false, error: "未找到当前项目桥接信息，请先打开 Creator 项目并确保 local/vscode-creator-bridge.json 存在" };
        }
        const assetPath = this.toCreatorAssetPath(referencePath, target.workspacePath);
        if (!assetPath) {
            return { success: false, error: "资源路径转换失败" };
        }

        const result = await this.requestCreator(target, assetPath);
        if (!result.success) {
            return { success: false, error: `项目桥接请求失败: ${result.error}` };
        }
        return { success: true };
    }

    private static async requestCreator(target: CreatorTarget, assetPath: string): Promise<{ success: boolean; error: string }> {
        try {
            const requestUrl = target.requestUrl;
            const targetUrl = new URL(requestUrl);
            const payload = JSON.stringify({
                assetPath,
                projectId: target.projectId,
            });
            const options: http.RequestOptions = {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                    "X-Cocos-Project-Id": target.projectId || "",
                },
            };
            const transport = targetUrl.protocol === "https:" ? https : http;
            return await new Promise<{ success: boolean; error: string }>((resolve) => {
                let settled = false;
                const safeResolve = (result: { success: boolean; error: string }) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    resolve(result);
                };
                const request = transport.request(targetUrl, options, (response) => {
                    let body = "";
                    response.on("data", (chunk) => {
                        body += chunk.toString();
                    });
                    const statusCode = response.statusCode ?? 500;
                    response.on("end", () => {
                        if (statusCode >= 200 && statusCode < 300) {
                            safeResolve({ success: true, error: "" });
                            return;
                        }
                        const detail = this.readResponseMessage(body);
                        safeResolve({ success: false, error: `${requestUrl} 返回状态 ${statusCode}${detail ? `: ${detail}` : ""}` });
                    });
                });
                request.on("error", (error) => {
                    safeResolve({ success: false, error: `${requestUrl} 请求异常: ${error.message}` });
                });
                request.setTimeout(Config.creatorOpenAssetTimeout, () => {
                    request.destroy(new Error("timeout"));
                    safeResolve({ success: false, error: `${requestUrl} 请求超时` });
                });
                request.write(payload);
                request.end();
            });
        } catch {
            return { success: false, error: `${target.requestUrl} 地址非法` };
        }
    }

    private static readResponseMessage(body: string): string {
        if (!body) {
            return "";
        }
        try {
            const data = JSON.parse(body);
            if (data && typeof data.message === "string") {
                return data.message;
            }
        } catch { }
        return "";
    }

    private static async resolveCreatorTarget(referencePath: string): Promise<CreatorTarget | undefined> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(referencePath));
        if (workspaceFolder) {
            const runtimePath = path.join(workspaceFolder.uri.fsPath, BRIDGE_SETTINGS_REL_PATH);
            try {
                const raw = await fs.promises.readFile(runtimePath, { encoding: "utf8" });
                const runtime = JSON.parse(raw) as CreatorBridgeRuntime;
                const runtimePort = Number(runtime.port);
                if (Number.isInteger(runtimePort) && runtimePort > 0 && runtimePort <= 65535 && runtime.projectId) {
                    return {
                        requestUrl: `http://127.0.0.1:${runtimePort}/open-asset`,
                        projectId: String(runtime.projectId),
                        workspacePath: workspaceFolder.uri.fsPath,
                    };
                }
            } catch { }
        }
        return undefined;
    }

    private static toCreatorAssetPath(referencePath: string, workspacePath?: string): string | undefined {
        const normalizeAssetsRelative = (relativePath: string): string | undefined => {
            const normalizedRelative = relativePath.replace(/\\/g, "/");
            const lower = normalizedRelative.toLowerCase();
            if (lower === "assets") {
                return "assets";
            }
            if (lower.startsWith("assets/")) {
                return `assets/${normalizedRelative.slice(7)}`;
            }
            return undefined;
        };
        if (workspacePath) {
            const relativePath = path.relative(workspacePath, referencePath);
            const normalized = normalizeAssetsRelative(relativePath);
            if (normalized) {
                return normalized;
            }
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            for (let i = 0; i < workspaceFolders.length; i++) {
                const relativePath = path.relative(workspaceFolders[i].uri.fsPath, referencePath);
                const normalized = normalizeAssetsRelative(relativePath);
                if (normalized) {
                    return normalized;
                }
            }
        }
        const normalized = referencePath.replace(/\\/g, "/");
        const lowerNormalized = normalized.toLowerCase();
        const index = lowerNormalized.lastIndexOf("/assets/");
        if (index >= 0) {
            return `assets/${normalized.substring(index + 8)}`;
        }
        if (lowerNormalized.startsWith("assets/")) {
            return `assets/${normalized.substring(7)}`;
        }
        return undefined;
    }
}
