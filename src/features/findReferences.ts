import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import Utils from "../utils/utils";
import Uuid from "../utils/uuid";
import { openAssetInCreator, openNodeInCreator, toCreatorAssetPath } from "./creatorBridgeClient";
import { ensureCreatorBridgeReady, isCocosCreatorProjectRoot } from "./creatorBridgeInstaller";
import { buildReferencesHtml } from "./findReferencesView";
import type { ReferenceAsset, ReferenceNode } from "./findReferencesTypes";

const REG_UUID = /"uuid":\s*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/;
const REFERENCE_ASSET_GLOB = "assets/**/*.{fire,scene,prefab}";
const PREFAB_META_GLOB = "assets/**/*.prefab.meta";

type WorkspaceAssetCache = {
    cachePathSet: Set<string>;
    createPathSet: Set<string>;
    deletePathSet: Set<string>;
    /** 是否需要全量刷新缓存的资源文件 */
    needFullRefresh: boolean;
    waitingPromise: boolean;
    waitingResolve: Array<() => void>;
};

type SerializedRef = {
    __id__?: number;
};

type SerializedPrefabInfo = {
    asset?: unknown;
    fileId?: string;
};

type SerializedNodeInfo = {
    index: number;
    name: string;
    uuid?: string;
    parentIndex?: number;
    childIndexes: number[];
    componentIndexes: number[];
    hierarchyOrderPath?: number[];
    hideInDisplayPath: boolean;
};

type OrderedReferenceNode = {
    referenceNode: ReferenceNode;
    hierarchyOrderPath?: number[];
};

type SerializedPrefabInfoData = {
    assetUuid?: string;
    fileId?: string;
    overrideName?: string;
    prefabName?: string;
};

type PrefabAssetInfo = {
    metaName?: string;
    prefabPath: string;
};

type PrefabAssetIndexTarget = {
    key: string;
    workspacePath: string;
};

/**
 * Cocos资源文件查找
 */
export default class FindReferences {
    public static readonly command: string = "CocosToolbox.findReferences";

    private static _init: boolean = false;
    private static _workspaceWatchers: Map<string, vscode.Disposable[]> = new Map();
    private static _watcherRefreshVersion: number = 0;
    private static _referencesPanel: vscode.WebviewPanel | undefined;
    private static _currentReferences: ReferenceAsset[] = [];
    private static _currentCompressedUuid: string = "";
    private static _extensionPath: string = "";

    private static _workspaceCaches: Map<string, WorkspaceAssetCache> = new Map();
    private static _prefabAssetIndexes: Map<string, Promise<Map<string, PrefabAssetInfo>>> = new Map();
    private static _prefabRootNames: Map<string, Promise<string | undefined>> = new Map();
    private static _searchRunning: boolean = false;
    private static _searchQueued: boolean = false;
    private static _pendingSearchUri: vscode.Uri | undefined;

    public static init(context: vscode.ExtensionContext): void {
        if (this._init) {
            return;
        }
        this._init = true;
        this._extensionPath = context.extensionPath;

        void this.refreshWorkspaceWatchers();

        let searchLinstener = vscode.commands.registerCommand(this.command, async (uri?: vscode.Uri) => {
            await this.runFindCocosAssets(uri);
        });
        let workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void this.refreshWorkspaceWatchers();
        });

        context.subscriptions.push(searchLinstener, workspaceFoldersListener, {
            dispose: () => {
                this.disposeWorkspaceWatchers();
            },
        });
    }

    private static async refreshWorkspaceWatchers(): Promise<void> {
        const refreshVersion = ++this._watcherRefreshVersion;
        const nextWatchers: Map<string, vscode.Disposable[]> = new Map();

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of workspaceFolders) {
            if (!(await isCocosCreatorProjectRoot(folder.uri.fsPath))) {
                continue;
            }
            if (refreshVersion !== this._watcherRefreshVersion) {
                this.disposeWatcherMap(nextWatchers);
                return;
            }

            const disposables = this.createWorkspaceWatchers(folder);
            if (refreshVersion !== this._watcherRefreshVersion) {
                this.disposeWatcherMap(nextWatchers);
                this.disposeDisposables(disposables);
                return;
            }
            nextWatchers.set(folder.uri.fsPath, disposables);
        }

        if (refreshVersion !== this._watcherRefreshVersion) {
            this.disposeWatcherMap(nextWatchers);
            return;
        }

        const previousWatchers = this._workspaceWatchers;
        this._workspaceWatchers = nextWatchers;
        this.disposeWatcherMap(previousWatchers);
        this.disposeUnusedWorkspaceCaches(nextWatchers);
    }

    private static disposeUnusedWorkspaceCaches(activeWorkspaces: Map<string, vscode.Disposable[]>): void {
        this._workspaceCaches.forEach((_cache, workspacePath) => {
            if (!activeWorkspaces.has(workspacePath)) {
                this._workspaceCaches.delete(workspacePath);
                this.invalidatePrefabCache(workspacePath);
            }
        });
    }

    private static createWorkspaceWatchers(workspaceFolder: vscode.WorkspaceFolder): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        const assetWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, REFERENCE_ASSET_GLOB));
        disposables.push(
            assetWatcher,
            assetWatcher.onDidCreate((uri) => {
                this.markAssetCreated(uri);
                this.invalidatePrefabRootName(uri.fsPath);
            }),
            assetWatcher.onDidChange((uri) => {
                this.invalidatePrefabRootName(uri.fsPath);
            }),
            assetWatcher.onDidDelete((uri) => {
                this.markAssetDeleted(uri);
                this.invalidatePrefabRootName(uri.fsPath);
            }),
        );

        const prefabMetaWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, PREFAB_META_GLOB));
        const onPrefabMetaChanged = () => {
            this.invalidatePrefabAssetIndex(workspaceFolder.uri.fsPath);
        };
        disposables.push(
            prefabMetaWatcher,
            prefabMetaWatcher.onDidCreate(onPrefabMetaChanged),
            prefabMetaWatcher.onDidChange(onPrefabMetaChanged),
            prefabMetaWatcher.onDidDelete(onPrefabMetaChanged),
        );

        const onGitChanged = () => {
            const cache = this.getWorkspaceCache(workspaceFolder);
            cache.needFullRefresh = true;
            this.invalidatePrefabCache(workspaceFolder.uri.fsPath);
        };
        const gitWatchers = [
            vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, ".git/HEAD")),
            vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, ".git/refs/heads/**")),
            vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, ".git/packed-refs")),
        ];
        gitWatchers.forEach((watcher) => {
            disposables.push(
                watcher,
                watcher.onDidChange(onGitChanged),
                watcher.onDidCreate(onGitChanged),
                watcher.onDidDelete(onGitChanged),
            );
        });

        return disposables;
    }

    private static disposeWorkspaceWatchers(): void {
        this.disposeWatcherMap(this._workspaceWatchers);
        this._workspaceWatchers.clear();
    }

    private static disposeWatcherMap(watcherMap: Map<string, vscode.Disposable[]>): void {
        watcherMap.forEach((watchers) => {
            this.disposeDisposables(watchers);
        });
        watcherMap.clear();
    }

    private static disposeDisposables(disposables: vscode.Disposable[]): void {
        disposables.forEach((disposable) => {
            disposable.dispose();
        });
    }

    private static invalidatePrefabCache(workspacePath: string): void {
        this.invalidatePrefabAssetIndex(workspacePath);
        this.invalidatePrefabRootNamesInWorkspace(workspacePath);
    }

    private static invalidatePrefabAssetIndex(workspacePath: string): void {
        this._prefabAssetIndexes.delete(workspacePath);
    }

    private static invalidatePrefabRootName(filePath: string): void {
        if (path.extname(filePath).toLowerCase() !== ".prefab") {
            return;
        }
        this._prefabRootNames.delete(filePath);
    }

    private static invalidatePrefabRootNamesInWorkspace(workspacePath: string): void {
        Array.from(this._prefabRootNames.keys()).forEach((prefabPath) => {
            if (this.isPathInWorkspace(prefabPath, workspacePath)) {
                this._prefabRootNames.delete(prefabPath);
            }
        });
    }

    private static isPathInWorkspace(filePath: string, workspacePath: string): boolean {
        const relativePath = path.relative(workspacePath, filePath);
        return !!relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
    }

    private static markAssetCreated(uri: vscode.Uri): void {
        const cache = this.getWorkspaceCacheByUri(uri);
        if (!cache) {
            return;
        }

        cache.deletePathSet.delete(uri.fsPath);
        cache.createPathSet.add(uri.fsPath);
    }

    private static markAssetDeleted(uri: vscode.Uri): void {
        const cache = this.getWorkspaceCacheByUri(uri);
        if (!cache) {
            return;
        }

        cache.createPathSet.delete(uri.fsPath);
        cache.deletePathSet.add(uri.fsPath);
    }

    /**
     * 获取资源文件所属工作区缓存
     */
    private static getWorkspaceCacheByUri(uri: vscode.Uri): WorkspaceAssetCache | undefined {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            return undefined;
        }
        return this.getWorkspaceCache(workspaceFolder);
    }

    private static getWorkspaceCache(workspaceFolder: vscode.WorkspaceFolder): WorkspaceAssetCache {
        const workspacePath = workspaceFolder.uri.fsPath;
        let cache = this._workspaceCaches.get(workspacePath);
        if (!cache) {
            cache = {
                cachePathSet: new Set(),
                createPathSet: new Set(),
                deletePathSet: new Set(),
                needFullRefresh: true,
                waitingPromise: false,
                waitingResolve: [],
            };
            this._workspaceCaches.set(workspacePath, cache);
        }
        return cache;
    }

    /**
     * 缓存指定项目内的资源文件路径
     */
    private static async collectWorkspaceAssetPaths(workspaceFolder: vscode.WorkspaceFolder): Promise<Set<string>> {
        const nextCachePathSet: Set<string> = new Set();
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, REFERENCE_ASSET_GLOB));
        for (const uri of uris) {
            nextCachePathSet.add(uri.fsPath);
        }
        return nextCachePathSet;
    }

    private static flushWaitingResolvers(cache: WorkspaceAssetCache): void {
        const waitingResolve = cache.waitingResolve;
        cache.waitingResolve = [];
        waitingResolve.forEach((call) => {
            call();
        });
    }

    private static async refreshCacheAssetsWithRetry(workspaceFolder: vscode.WorkspaceFolder, cache: WorkspaceAssetCache): Promise<void> {
        let nextCachePathSet = await this.collectWorkspaceAssetPaths(workspaceFolder);
        if (nextCachePathSet.size === 0 && cache.cachePathSet.size > 0) {
            // 第一次全量扫描返回空，尝试重试一次
            const retryCachePathSet = await this.collectWorkspaceAssetPaths(workspaceFolder);
            if (retryCachePathSet.size > 0) {
                nextCachePathSet = retryCachePathSet;
            } else {
                console.warn("[CocosToolbox] full scan returned empty twice, keep previous cache and retry next time");
                cache.needFullRefresh = true;
                return;
            }
        }

        cache.cachePathSet = nextCachePathSet;
        cache.createPathSet.clear();
        cache.deletePathSet.clear();
        cache.needFullRefresh = false;
    }

    private static getCacheAssets(workspaceFolder: vscode.WorkspaceFolder): Promise<WorkspaceAssetCache> {
        const cache = this.getWorkspaceCache(workspaceFolder);
        return new Promise((resolve) => {
            cache.waitingResolve.push(() => {
                resolve(cache);
            });
            if (cache.waitingPromise) {
                return;
            }

            if (!cache.needFullRefresh) {
                this.updateCacheAssets(cache);
                this.flushWaitingResolvers(cache);
                return;
            }

            cache.waitingPromise = true;
            this.refreshCacheAssetsWithRetry(workspaceFolder, cache)
                .catch(() => { })
                .finally(() => {
                    cache.waitingPromise = false;
                    this.flushWaitingResolvers(cache);
                });
        });
    }

    /**
     * 增量更新缓存
     */
    private static updateCacheAssets(cache: WorkspaceAssetCache): void {
        if (cache.createPathSet.size > 0 || cache.deletePathSet.size > 0) {
            cache.createPathSet.forEach((v) => {
                cache.cachePathSet.add(v);
            });
            cache.deletePathSet.forEach((v) => {
                cache.cachePathSet.delete(v);
            });
            cache.createPathSet.clear();
            cache.deletePathSet.clear();
        }
    }

    /**
     * 查找引用目标文件的Cocos资源文件
     */
    private static async runFindCocosAssets(uri?: vscode.Uri): Promise<void> {
        if (this._searchRunning) {
            this._pendingSearchUri = uri;
            this._searchQueued = true;
            return;
        }
        this._searchRunning = true;
        try {
            let searchUri = uri;
            do {
                this._searchQueued = false;
                await this.findCocosAssets(searchUri);
                searchUri = this._pendingSearchUri;
                this._pendingSearchUri = undefined;
            } while (this._searchQueued);
        } finally {
            this._pendingSearchUri = undefined;
            this._searchRunning = false;
        }
    }

    /**
     * 查找引用目标文件的Cocos资源文件
     */
    private static async findCocosAssets(uri?: vscode.Uri): Promise<void> {
        try {
            const activeFile = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!activeFile) {
                return;
            }

            const activeFileExtension = path.extname(activeFile.fsPath);
            if (activeFileExtension !== ".ts" && activeFileExtension !== ".js") {
                return;
            }

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeFile);
            if (!workspaceFolder) {
                return;
            }

            const assetPath = toCreatorAssetPath(activeFile.fsPath, workspaceFolder.uri.fsPath);
            if (!assetPath || assetPath === "assets") {
                vscode.window.showWarningMessage("请选择 assets 目录下的 Cocos Creator 脚本文件。");
                return;
            }

            if (!(await isCocosCreatorProjectRoot(workspaceFolder.uri.fsPath))) {
                vscode.window.showWarningMessage("当前文件不属于 Cocos Creator 项目。");
                return;
            }

            await ensureCreatorBridgeReady(this._extensionPath, activeFile.fsPath);

            const metaFilePath = `${activeFile.fsPath}.meta`;
            let checkMeta = await Utils.checkPath(metaFilePath);
            if (!checkMeta) {
                return;
            }

            let data = await fs.promises.readFile(metaFilePath, { encoding: "utf8" });
            let match = REG_UUID.exec(data);
            if (!match) {
                return;
            }
            let uuid: string = match[1];
            let compressUuid = Uuid.compressUuid(uuid);

            // 更新资源文件
            const cache = await this.getCacheAssets(workspaceFolder);

            let results: ReferenceAsset[] = [];
            let invalidPaths: string[] = [];
            const cachePaths = Array.from(cache.cachePathSet);
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
                            if (!fileData.includes(compressUuid)) {
                                continue;
                            }
                            const creatorAssetPath = toCreatorAssetPath(currentPath, workspaceFolder.uri.fsPath);
                            if (!creatorAssetPath) {
                                continue;
                            }
                            results.push({
                                filePath: currentPath,
                                creatorAssetPath,
                                nodesLoaded: false,
                            });
                        } catch {
                            invalidPaths.push(currentPath);
                        }
                    }
                })();
                readers.push(reader);
            }
            await Promise.all(readers);
            invalidPaths.forEach((invalidPath) => {
                cache.cachePathSet.delete(invalidPath);
            });

            let activeFileName = path.basename(activeFile.fsPath);
            results.sort((a, b) => a.filePath.localeCompare(b.filePath));
            this._currentCompressedUuid = compressUuid;
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
        });
        panel.onDidDispose(() => {
            this._referencesPanel = undefined;
            this._currentReferences = [];
            this._currentCompressedUuid = "";
        });
        panel.webview.onDidReceiveMessage(async (message) => {
            if (!message || (message.type !== "openAsset" && message.type !== "loadNodes" && message.type !== "openNode")) {
                return;
            }

            const index = Number(message.index);
            if (!Number.isInteger(index) || index < 0 || index >= this._currentReferences.length) {
                return;
            }

            const reference = this._currentReferences[index];
            if (message.type === "loadNodes") {
                await this.loadReferenceNodes(panel, index, reference);
                return;
            }

            const nodeIndex = Number(message.nodeIndex);
            const node = message.type === "openNode" && Number.isInteger(nodeIndex) && nodeIndex >= 0 && reference.nodes && nodeIndex < reference.nodes.length ? reference.nodes[nodeIndex] : undefined;
            const result = node ? await openNodeInCreator(reference.filePath, node) : await openAssetInCreator(reference.filePath);
            panel.webview.postMessage({
                type: "openResult",
                index,
                nodeIndex: node ? nodeIndex : undefined,
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

    private static async loadReferenceNodes(panel: vscode.WebviewPanel, index: number, reference: ReferenceAsset): Promise<void> {
        if (reference.nodesLoaded) {
            panel.webview.postMessage({
                type: "nodesLoaded",
                index,
                nodes: reference.nodes ?? [],
                error: reference.nodesError,
            });
            return;
        }
        if (reference.nodesLoading) {
            return;
        }
        reference.nodesLoading = true;
        panel.webview.postMessage({ type: "nodesLoading", index });
        try {
            const fileData = await fs.promises.readFile(reference.filePath, { encoding: "utf8" });
            const nodes = await this.findReferencedNodes(fileData, this._currentCompressedUuid, reference.filePath);
            reference.nodes = nodes;
            reference.nodesLoaded = true;
            reference.nodesError = undefined;
            panel.webview.postMessage({
                type: "nodesLoaded",
                index,
                nodes,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            reference.nodes = [];
            reference.nodesLoaded = true;
            reference.nodesError = message;
            panel.webview.postMessage({
                type: "nodesLoaded",
                index,
                nodes: [],
                error: message,
            });
        } finally {
            reference.nodesLoading = false;
        }
    }

    private static async findReferencedNodes(fileData: string, compressUuid: string, referencePath: string): Promise<ReferenceNode[]> {
        if (!compressUuid) {
            return [];
        }
        const parsed = this.parseSerializedAsset(fileData);
        if (!Array.isArray(parsed)) {
            return [];
        }

        const prefabInfos = await this.collectPrefabInfos(parsed, referencePath);
        const nodes = this.collectSerializedNodes(parsed, prefabInfos);
        if (nodes.size === 0) {
            return [];
        }

        const componentToNode = new Map<number, SerializedNodeInfo>();
        nodes.forEach((node) => {
            node.componentIndexes.forEach((componentIndex) => {
                componentToNode.set(componentIndex, node);
            });
        });

        this.fillHierarchyOrderPaths(nodes);

        const allowPathOnlyNode = path.extname(referencePath).toLowerCase() === ".prefab";
        const result = new Map<string, OrderedReferenceNode>();
        parsed.forEach((item, index) => {
            if (!this.containsString(item, compressUuid)) {
                return;
            }
            const node = this.resolveReferencedNode(index, item, nodes, componentToNode);
            if (!node) {
                return;
            }
            const nodePath = this.createNodePath(node, nodes, false, allowPathOnlyNode && !node.uuid);
            if (!node.uuid && (!allowPathOnlyNode || !nodePath)) {
                return;
            }
            const displayPath = this.createNodePath(node, nodes, true);
            const resultKey = node.uuid || `path:${nodePath}`;
            result.set(resultKey, {
                referenceNode: {
                    name: node.name,
                    path: nodePath,
                    displayPath,
                    uuid: node.uuid,
                },
                hierarchyOrderPath: node.hierarchyOrderPath,
            });
        });
        return Array.from(result.values())
            .sort((a, b) => this.compareReferenceNodes(a, b))
            .map((item) => item.referenceNode);
    }

    private static parseSerializedAsset(fileData: string): unknown {
        try {
            return JSON.parse(fileData);
        } catch {
            return undefined;
        }
    }

    private static collectSerializedNodes(items: unknown[], prefabInfos: Map<number, SerializedPrefabInfoData>): Map<number, SerializedNodeInfo> {
        const nodes = new Map<number, SerializedNodeInfo>();
        items.forEach((item, index) => {
            if (!this.isSerializedNode(item)) {
                return;
            }
            const prefabInfoIndex = this.readRefIndex(item._prefab);
            const prefabInfo = prefabInfoIndex === undefined ? undefined : prefabInfos.get(prefabInfoIndex);
            const parentIndex = this.readRefIndex(item._parent);
            const name = typeof item._name === "string" && item._name ? item._name : prefabInfo?.overrideName || prefabInfo?.prefabName || `Node ${index}`;
            nodes.set(index, {
                index,
                name,
                uuid: this.readNodeUuid(item, prefabInfo),
                parentIndex,
                childIndexes: this.readRefIndexes(item._children),
                componentIndexes: this.readRefIndexes(item._components),
                hideInDisplayPath: item.__type__ === "cc.Scene" && parentIndex === undefined,
            });
        });
        nodes.forEach((node) => {
            node.childIndexes.forEach((childIndex) => {
                const child = nodes.get(childIndex);
                if (child) {
                    child.parentIndex = node.index;
                }
            });
        });
        return nodes;
    }

    private static fillHierarchyOrderPaths(nodes: Map<number, SerializedNodeInfo>): void {
        const roots = Array.from(nodes.values()).filter((node) => node.parentIndex === undefined || !nodes.has(node.parentIndex));
        roots.sort((a, b) => a.index - b.index);
        roots.forEach((root, rootOrder) => {
            this.fillHierarchyOrderPath(root, nodes, [rootOrder], new Set());
        });
    }

    private static fillHierarchyOrderPath(node: SerializedNodeInfo, nodes: Map<number, SerializedNodeInfo>, orderPath: number[], visited: Set<number>): void {
        if (visited.has(node.index)) {
            return;
        }
        visited.add(node.index);
        node.hierarchyOrderPath = orderPath;
        node.childIndexes.forEach((childIndex, childOrder) => {
            const child = nodes.get(childIndex);
            if (!child) {
                return;
            }
            this.fillHierarchyOrderPath(child, nodes, [...orderPath, childOrder], visited);
        });
        visited.delete(node.index);
    }

    private static compareReferenceNodes(a: OrderedReferenceNode, b: OrderedReferenceNode): number {
        const hierarchyCompare = this.compareOrderPaths(a.hierarchyOrderPath, b.hierarchyOrderPath);
        if (hierarchyCompare !== 0) {
            return hierarchyCompare;
        }
        return (a.referenceNode.displayPath || a.referenceNode.path).localeCompare(b.referenceNode.displayPath || b.referenceNode.path);
    }

    private static compareOrderPaths(a: number[] | undefined, b: number[] | undefined): number {
        if (!a && !b) {
            return 0;
        }
        if (!a) {
            return 1;
        }
        if (!b) {
            return -1;
        }
        const length = Math.min(a.length, b.length);
        for (let i = 0; i < length; i++) {
            const diff = a[i] - b[i];
            if (diff !== 0) {
                return diff;
            }
        }
        return a.length - b.length;
    }

    private static async collectPrefabInfos(items: unknown[], referencePath: string): Promise<Map<number, SerializedPrefabInfoData>> {
        const nameOverrides = this.collectPrefabNameOverrides(items);
        const target = this.resolvePrefabAssetIndexTarget(referencePath);
        const prefabAssetIndex = target ? await this.getPrefabAssetIndex(target) : undefined;
        const entries = await Promise.all(items.map(async (item, index): Promise<[number, SerializedPrefabInfoData] | undefined> => {
            if (!this.isObject(item)) {
                return undefined;
            }
            const prefabInfo = item as SerializedPrefabInfo;
            const fileId = typeof prefabInfo.fileId === "string" && prefabInfo.fileId ? prefabInfo.fileId : undefined;
            const assetUuid = this.readUuidRef(prefabInfo.asset);
            if (!fileId && !assetUuid) {
                return undefined;
            }
            const overrideName = fileId ? nameOverrides.get(fileId) : undefined;
            const assetInfo = assetUuid ? prefabAssetIndex?.get(assetUuid) : undefined;
            const prefabName = !overrideName && assetInfo ? (await this.readPrefabRootName(assetInfo.prefabPath)) || assetInfo.metaName : undefined;
            return [
                index,
                {
                    assetUuid,
                    fileId,
                    overrideName,
                    prefabName,
                },
            ];
        }));
        return new Map(entries.filter((entry): entry is [number, SerializedPrefabInfoData] => entry !== undefined));
    }

    private static collectPrefabNameOverrides(items: unknown[]): Map<string, string> {
        const names = new Map<string, string>();
        items.forEach((item) => {
            if (!this.isObject(item) || item.__type__ !== "CCPropertyOverrideInfo") {
                return;
            }
            if (!Array.isArray(item.propertyPath) || item.propertyPath.length !== 1 || item.propertyPath[0] !== "_name") {
                return;
            }
            if (typeof item.value !== "string" || !item.value) {
                return;
            }
            const targetInfoIndex = this.readRefIndex(item.targetInfo);
            if (targetInfoIndex === undefined) {
                return;
            }
            const targetInfo = items[targetInfoIndex];
            if (!this.isObject(targetInfo)) {
                return;
            }
            const localIds = Array.isArray(targetInfo.localID) ? targetInfo.localID : typeof targetInfo.localID === "string" ? [targetInfo.localID] : [];
            localIds.forEach((localId) => {
                if (typeof localId === "string" && localId) {
                    names.set(localId, item.value as string);
                }
            });
        });
        return names;
    }

    private static resolveReferencedNode(
        itemIndex: number,
        item: unknown,
        nodes: Map<number, SerializedNodeInfo>,
        componentToNode: Map<number, SerializedNodeInfo>,
    ): SerializedNodeInfo | undefined {
        const directNode = nodes.get(itemIndex);
        if (directNode) {
            return directNode;
        }
        const componentNode = componentToNode.get(itemIndex);
        if (componentNode) {
            return componentNode;
        }
        if (this.isObject(item)) {
            const ownerIndex = this.readRefIndex(item.node) ?? this.readRefIndex(item._node);
            if (ownerIndex !== undefined) {
                return nodes.get(ownerIndex);
            }
        }
        return undefined;
    }

    private static createNodePath(node: SerializedNodeInfo, nodes: Map<number, SerializedNodeInfo>, includeAllAncestors: boolean, includePathOnlyNodes: boolean = false): string {
        const parts: string[] = [];
        let current: SerializedNodeInfo | undefined = node;
        const visited = new Set<number>();
        while (current && !visited.has(current.index)) {
            visited.add(current.index);
            if (includeAllAncestors ? !current.hideInDisplayPath : !!current.uuid || includePathOnlyNodes) {
                parts.push(current.name);
            }
            current = current.parentIndex === undefined ? undefined : nodes.get(current.parentIndex);
        }
        return parts.reverse().join("/");
    }

    private static readNodeUuid(item: Record<string, unknown>, prefabInfo?: SerializedPrefabInfoData): string | undefined {
        const id = item._id;
        if (typeof id === "string" && id) {
            return id;
        }
        const uuid = item._uuid;
        if (typeof uuid === "string" && uuid) {
            return uuid;
        }
        const prefabInfoIndex = this.readRefIndex(item._prefab);
        if (prefabInfoIndex !== undefined) {
            return prefabInfo?.fileId;
        }
        return undefined;
    }

    private static readUuidRef(value: unknown): string | undefined {
        if (!this.isObject(value)) {
            return undefined;
        }
        const uuid = value.__uuid__;
        return typeof uuid === "string" && uuid ? uuid : undefined;
    }

    private static resolvePrefabAssetIndexTarget(referencePath: string): PrefabAssetIndexTarget | undefined {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(referencePath));
        if (workspaceFolder) {
            return {
                key: workspaceFolder.uri.fsPath,
                workspacePath: workspaceFolder.uri.fsPath,
            };
        }
        const assetsPart = `${path.sep}assets${path.sep}`;
        const assetsIndex = referencePath.lastIndexOf(assetsPart);
        if (assetsIndex < 0) {
            return undefined;
        }
        const workspacePath = referencePath.slice(0, assetsIndex);
        return {
            key: workspacePath,
            workspacePath,
        };
    }

    private static getPrefabAssetIndex(target: PrefabAssetIndexTarget): Promise<Map<string, PrefabAssetInfo>> {
        let cached = this._prefabAssetIndexes.get(target.key);
        if (cached) {
            return cached;
        }
        cached = this.collectPrefabAssetIndex(target);
        this._prefabAssetIndexes.set(target.key, cached);
        return cached;
    }

    private static async collectPrefabAssetIndex(target: PrefabAssetIndexTarget): Promise<Map<string, PrefabAssetInfo>> {
        const index = new Map<string, PrefabAssetInfo>();
        const metaPaths = await this.findPrefabMetaPaths(path.join(target.workspacePath, "assets"));
        await Promise.all(metaPaths.map(async (metaPath) => {
            try {
                const raw = await fs.promises.readFile(metaPath, { encoding: "utf8" });
                const data = JSON.parse(raw) as Record<string, unknown>;
                const uuid = data.uuid;
                if (typeof uuid !== "string" || !uuid) {
                    return;
                }
                const userData = this.isObject(data.userData) ? data.userData : undefined;
                const syncNodeName = userData && typeof userData.syncNodeName === "string" && userData.syncNodeName ? userData.syncNodeName : undefined;
                index.set(uuid, {
                    metaName: syncNodeName,
                    prefabPath: metaPath.slice(0, -".meta".length),
                });
            } catch { }
        }));
        return index;
    }

    private static async findPrefabMetaPaths(dirPath: string): Promise<string[]> {
        const result: string[] = [];
        async function walk(currentPath: string): Promise<void> {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
            } catch {
                return;
            }
            await Promise.all(entries.map(async (entry) => {
                const entryPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    await walk(entryPath);
                    return;
                }
                if (entry.isFile() && entry.name.endsWith(".prefab.meta")) {
                    result.push(entryPath);
                }
            }));
        }
        await walk(dirPath);
        return result;
    }

    private static readPrefabRootName(prefabPath: string): Promise<string | undefined> {
        let cached = this._prefabRootNames.get(prefabPath);
        if (cached) {
            return cached;
        }
        cached = this.doReadPrefabRootName(prefabPath);
        this._prefabRootNames.set(prefabPath, cached);
        return cached;
    }

    private static async doReadPrefabRootName(prefabPath: string): Promise<string | undefined> {
        try {
            const raw = await fs.promises.readFile(prefabPath, { encoding: "utf8" });
            const parsed = this.parseSerializedAsset(raw);
            if (!Array.isArray(parsed)) {
                return undefined;
            }
            const prefabAsset = parsed.find((item) => this.isObject(item) && item.__type__ === "cc.Prefab");
            const rootIndex = this.isObject(prefabAsset) ? this.readRefIndex(prefabAsset.data) : undefined;
            const rootNode = rootIndex === undefined ? parsed.find((item) => this.isObject(item) && item.__type__ === "cc.Node") : parsed[rootIndex];
            if (this.isObject(rootNode) && typeof rootNode._name === "string" && rootNode._name) {
                return rootNode._name;
            }
        } catch { }
        return undefined;
    }

    private static readRefIndexes(value: unknown): number[] {
        if (!Array.isArray(value)) {
            return [];
        }
        return value.map((item) => this.readRefIndex(item)).filter((item): item is number => item !== undefined);
    }

    private static readRefIndex(value: unknown): number | undefined {
        if (!this.isObject(value)) {
            return undefined;
        }
        const ref = value as SerializedRef;
        return Number.isInteger(ref.__id__) ? ref.__id__ : undefined;
    }

    private static containsString(value: unknown, needle: string): boolean {
        if (typeof value === "string") {
            return value.includes(needle);
        }
        if (Array.isArray(value)) {
            return value.some((item) => this.containsString(item, needle));
        }
        if (this.isObject(value)) {
            return Object.values(value).some((item) => this.containsString(item, needle));
        }
        return false;
    }

    private static isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null;
    }

    private static isSerializedNode(value: unknown): value is Record<string, unknown> {
        if (!this.isObject(value)) {
            return false;
        }
        return value.__type__ === "cc.Node" || value.__type__ === "cc.Scene";
    }
}
