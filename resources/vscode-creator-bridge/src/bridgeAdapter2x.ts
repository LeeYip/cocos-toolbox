import type { BridgeAdapter, LocateNodeResult, LocateResult, OpenAssetPayload, OpenAssetResult } from "./bridgeAdapter";
import Utils from "./utils";

type SceneHierarchyNode = {
    name?: unknown;
    id?: unknown;
    uuid?: unknown;
    children?: unknown;
};

const NODE_LOCATE_POLL_TIMEOUT_MS = 2500;
const NODE_LOCATE_POLL_INTERVAL_MS = 100;
const PREFAB_NODE_LOCATE_MIN_READY_MS = 400;
const PREFAB_NODE_LOCATE_STABLE_MATCH_COUNT = 2;
const QUERY_HIERARCHY_TIMEOUT_MS = 500;

export class BridgeAdapter2x implements BridgeAdapter {
    async resolveUuid(payload: OpenAssetPayload, assetUrl: string | null): Promise<string | null> {
        if (payload.uuid) {
            return payload.uuid;
        }
        if (!assetUrl) {
            return null;
        }
        if (!Editor || !Editor.assetdb || typeof Editor.assetdb.urlToUuid !== "function") {
            return null;
        }
        try {
            const uuid = Editor.assetdb.urlToUuid(assetUrl);
            return uuid || null;
        } catch {
            return null;
        }
    }

    async openAsset(uuid: string | null, assetUrl: string | null): Promise<OpenAssetResult> {
        const resolvedAssetUrl = uuid ? this.getAssetUrlByUuid(uuid) : assetUrl || "";
        if (!uuid) {
            return { ok: false, opened: false, located: false, assetUrl: resolvedAssetUrl, kind: "other", message: "uuid is empty" };
        }

        // 判断当前是否已打开对应的场景与预制体，避免重复打开
        // 注：2.x暂未找到能判断当前预制体的方法，scene:query-hierarchy 对预制体来说uuid是动态的，而非记录在prefab文件中的uuid
        const hierarchyResult = await this.queryHierarchy();
        if (!hierarchyResult.error && hierarchyResult.uuid === uuid) {
            Editor.log(`asset already opened. uuid=${uuid}`);
            return { ok: true, opened: true, located: false, assetUrl: resolvedAssetUrl, kind: "other", message: "asset already opened" };
        }

        let opened = false;
        let message = "";
        const isPrefab = resolvedAssetUrl.endsWith(".prefab");
        const isScene = resolvedAssetUrl.endsWith(".fire") || resolvedAssetUrl.endsWith(".scene");
        const kind: "prefab" | "scene" | "other" = isPrefab ? "prefab" : isScene ? "scene" : "other";
        try {
            if (!opened && isScene && Editor.Panel && typeof Editor.Panel.open === "function") {
                Editor.Panel.open("scene", { uuid });
                opened = true;
                message = "opened by scene panel";
            }
            if (!opened && isPrefab && Editor.Ipc && typeof Editor.Ipc.sendToAll === "function") {
                Editor.Ipc.sendToAll("scene:enter-prefab-edit-mode", uuid);
                opened = true;
                message = "opened by prefab mode";
            }
        } catch { }
        if (!opened) {
            message = `failed to open asset. uuid=${uuid}`;
        }
        return {
            ok: opened,
            opened,
            located: false,
            assetUrl: resolvedAssetUrl,
            kind,
            message,
        };
    }

    async locateAssetInBrowser(uuid: string | null, assetUrl: string | null): Promise<LocateResult> {
        const locateUuid = this.resolveLocateUuid(uuid, assetUrl);
        if (!locateUuid) {
            return {
                located: false,
            };
        }
        const methods: string[] = [];
        try {
            if (Editor && Editor.Selection && typeof Editor.Selection.select === "function" && typeof Editor.Selection.clear === "function") {
                Editor.Selection.clear("asset");
                Editor.Selection.select("asset", locateUuid);
                methods.push("Editor.Selection.clear+select(asset,uuid)");
            }
        } catch { }

        const hintMethod = "assets:hint(uuid)";
        try {
            if (Editor && Editor.Ipc && typeof Editor.Ipc.sendToAll === "function") {
                Editor.Ipc.sendToAll("assets:hint", locateUuid);
                methods.push(hintMethod);
            }
        } catch { }

        if (methods.length === 0) {
            return {
                located: false,
            };
        }
        return {
            located: true,
            locateMethod: methods.join("+"),
        };
    }

    async locateNode(nodeUuid: string | undefined, _assetUuid: string | null, assetUrl: string | null, nodePath?: string): Promise<LocateNodeResult> {
        const isPrefab = !!assetUrl && assetUrl.endsWith(".prefab");
        const isScene = !!assetUrl && (assetUrl.endsWith(".fire") || assetUrl.endsWith(".scene"));
        if (!nodeUuid && !nodePath) {
            return {
                selected: false,
                message: "node uuid is empty",
            };
        }
        const methods: string[] = [];
        if (isScene && nodeUuid) {
            methods.push("scene direct select");
            const selected = this.selectNode(nodeUuid, methods);
            this.hintNode(nodeUuid, methods);
            return {
                selected,
                nodeUuid,
                nodePath,
                locateMethod: methods.join("+"),
                message: selected ? "node selected" : `failed to select node. nodeUuid=${nodeUuid}`,
            };
        }

        let sceneWalkError: string | undefined;
        if (nodePath) {
            const pollResult = await this.pollNodeInHierarchy(nodePath, methods, isPrefab);
            const matchedNode = pollResult.matched;
            if (matchedNode?.uuid) {
                const selected = this.selectNode(matchedNode.uuid, methods);
                this.hintNode(matchedNode.uuid, methods);
                return {
                    selected,
                    nodeUuid: matchedNode.uuid,
                    nodePath,
                    sceneWalkMatchedPath: matchedNode.path,
                    locateMethod: methods.join("+"),
                    message: selected ? "node selected" : `failed to select node. nodeUuid=${matchedNode.uuid}`,
                };
            }
            if (matchedNode && !matchedNode.uuid) {
                return {
                    selected: false,
                    nodePath,
                    sceneWalkMatchedPath: matchedNode.path,
                    locateMethod: methods.join("+"),
                    message: "matched node has no uuid",
                };
            }
            sceneWalkError = pollResult.error || "node path not found in scene hierarchy";
            methods.push("node path not found in scene hierarchy");
        }

        if (!nodeUuid) {
            return {
                selected: false,
                nodePath,
                locateMethod: methods.join("+"),
                sceneWalkError,
                message: isPrefab ? "prefab opened but node path not found in scene hierarchy" : "node path not found in scene hierarchy",
            };
        }

        methods.push(nodePath ? "polling timeout+fallback direct select" : "direct select");
        const locateUuid = nodeUuid;
        const selected = this.selectNode(locateUuid, methods);
        this.hintNode(locateUuid, methods);

        return {
            selected,
            nodeUuid: locateUuid,
            nodePath,
            locateMethod: methods.length > 0 ? methods.join("+") : undefined,
            sceneWalkError: nodePath && !selected ? sceneWalkError : undefined,
            message: selected ? "node selected" : `failed to select node. nodeUuid=${locateUuid}`,
        };
    }

    private selectNode(uuid: string, methods: string[]): boolean {
        let selected = false;
        try {
            Editor.Selection.clear("node");
            Editor.Selection.select("node", uuid, true, true);
            methods.push("Editor.Selection.clear+select(node,uuid,true,true)");
            selected = true;
        } catch { }
        return selected;
    }

    private hintNode(uuid: string, methods: string[]): void {
        try {
            Editor.Ipc.sendToAll("scene:hint-node", uuid);
            methods.push("Editor.Ipc.sendToAll(scene:hint-node,uuid)");
        } catch { }
    }

    private getAssetUrlByUuid(uuid: string): string {
        if (!Editor || !Editor.assetdb || typeof Editor.assetdb.uuidToUrl !== "function") {
            return "";
        }
        try {
            return Editor.assetdb.uuidToUrl(uuid) || "";
        } catch {
            return "";
        }
    }

    private resolveLocateUuid(uuid: string | null, assetUrl: string | null): string | null {
        if (uuid) {
            return uuid;
        }
        if (!assetUrl) {
            return null;
        }
        if (!Editor || !Editor.assetdb || typeof Editor.assetdb.urlToUuid !== "function") {
            return null;
        }
        try {
            return Editor.assetdb.urlToUuid(assetUrl) || null;
        } catch {
            return null;
        }
    }

    private async queryHierarchy(): Promise<{ uuid?: string; result?: unknown; error?: string }> {
        if (!Editor || !Editor.Ipc || typeof Editor.Ipc.sendToPanel !== "function") {
            return { error: "Editor.Ipc.sendToPanel is unavailable" };
        }
        return await new Promise<{ uuid?: string; result?: unknown; error?: string }>((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    resolve({ error: "timeout" });
                }
            }, QUERY_HIERARCHY_TIMEOUT_MS);
            try {
                Editor.Ipc.sendToPanel("scene", "scene:query-hierarchy", (...args: unknown[]) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    const error = args[0];
                    if (error) {
                        resolve({ error: String(error) });
                        return;
                    }
                    const uuid = args[1] as string;
                    const result = args[2];
                    resolve({ uuid, result });
                });
            } catch (error) {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve({ error: error instanceof Error ? error.message : String(error) });
            }
        });
    }

    private async pollNodeInHierarchy(nodePath: string, methods: string[], requireStableMatch: boolean): Promise<{ matched?: { uuid: string; path: string }; error?: string }> {
        const startedAt = Date.now();
        const deadline = Date.now() + NODE_LOCATE_POLL_TIMEOUT_MS;
        let lastError = "";
        let matchedWithoutUuid: { uuid: string; path: string } | undefined;
        let stableMatchKey = "";
        let stableMatchCount = 0;
        let attempt = 0;
        while (Date.now() <= deadline) {
            attempt += 1;
            const hierarchyResult = await this.queryHierarchy();
            methods.push(
                hierarchyResult.error
                    ? `Editor.Ipc.sendToPanel(scene,scene:query-hierarchy) poll#${attempt} failed: ${hierarchyResult.error}`
                    : `Editor.Ipc.sendToPanel(scene,scene:query-hierarchy) poll#${attempt}`,
            );
            if (!hierarchyResult.error) {
                const matchedNode = this.findNodeInHierarchy(hierarchyResult.result, nodePath);
                if (matchedNode?.uuid) {
                    if (requireStableMatch) {
                        const matchKey = `${matchedNode.path}\n${matchedNode.uuid}`;
                        if (matchKey === stableMatchKey) {
                            stableMatchCount += 1;
                        } else {
                            stableMatchKey = matchKey;
                            stableMatchCount = 1;
                        }
                        const readyElapsed = Date.now() - startedAt >= PREFAB_NODE_LOCATE_MIN_READY_MS;
                        if (!readyElapsed || stableMatchCount < PREFAB_NODE_LOCATE_STABLE_MATCH_COUNT) {
                            methods.push(`prefab hierarchy match pending stable=${stableMatchCount}/${PREFAB_NODE_LOCATE_STABLE_MATCH_COUNT}`);
                            matchedWithoutUuid = matchedNode;
                            if (Date.now() < deadline) {
                                await Utils.sleep(NODE_LOCATE_POLL_INTERVAL_MS);
                            }
                            continue;
                        }
                    }
                    return { matched: matchedNode };
                }
                if (matchedNode) {
                    matchedWithoutUuid = matchedNode;
                }
            } else {
                lastError = hierarchyResult.error;
            }
            if (Date.now() < deadline) {
                await Utils.sleep(NODE_LOCATE_POLL_INTERVAL_MS);
            }
        }
        if (lastError) {
            methods.push(`scene hierarchy query last error: ${lastError}`);
        }
        return { matched: matchedWithoutUuid, error: lastError || undefined };
    }

    private findNodeInHierarchy(value: unknown, nodePath: string): { uuid: string; path: string } | undefined {
        const targetPath = this.normalizeNodePath(nodePath);
        if (!targetPath) {
            return undefined;
        }
        const roots = this.asNodeArray(value);
        for (const root of roots) {
            const rootPath = this.readNodePath(root, []);
            const targetPaths = this.createTargetPathCandidates(targetPath, rootPath);
            const matched = this.findNodeByPath(root, [], targetPaths, true);
            if (matched) {
                return matched;
            }
        }
        return undefined;
    }

    private findNodeByPath(node: SceneHierarchyNode, parentParts: string[], targetPaths: Set<string>, isRoot: boolean): { uuid: string; path: string } | undefined {
        const name = typeof node.name === "string" ? node.name : "";
        const currentParts = name ? [...parentParts, name] : parentParts;
        const currentPath = this.normalizeNodePath(currentParts.join("/"));
        const relativePath = isRoot ? "" : currentPath;
        if (targetPaths.has(currentPath) || targetPaths.has(relativePath)) {
            return {
                uuid: this.readNodeId(node),
                path: currentPath,
            };
        }
        for (const child of this.asNodeArray(node.children)) {
            const matched = this.findNodeByPath(child, currentParts, targetPaths, false);
            if (matched) {
                return matched;
            }
        }
        if (isRoot && currentParts.length > 0) {
            for (const child of this.asNodeArray(node.children)) {
                const matched = this.findNodeByRelativePath(child, [], targetPaths);
                if (matched) {
                    return matched;
                }
            }
        }
        return undefined;
    }

    private findNodeByRelativePath(node: SceneHierarchyNode, parentParts: string[], targetPaths: Set<string>): { uuid: string; path: string } | undefined {
        const name = typeof node.name === "string" ? node.name : "";
        const currentParts = name ? [...parentParts, name] : parentParts;
        const currentPath = this.normalizeNodePath(currentParts.join("/"));
        if (targetPaths.has(currentPath)) {
            return {
                uuid: this.readNodeId(node),
                path: currentPath,
            };
        }
        for (const child of this.asNodeArray(node.children)) {
            const matched = this.findNodeByRelativePath(child, currentParts, targetPaths);
            if (matched) {
                return matched;
            }
        }
        return undefined;
    }

    private asNodeArray(value: unknown): SceneHierarchyNode[] {
        if (Array.isArray(value)) {
            return value.filter((item): item is SceneHierarchyNode => typeof item === "object" && item !== null);
        }
        if (typeof value === "object" && value !== null) {
            const record = value as Record<string, unknown>;
            if (Array.isArray(record.children)) {
                return record.children.filter((item): item is SceneHierarchyNode => typeof item === "object" && item !== null);
            }
            if (Array.isArray(record.nodes)) {
                return record.nodes.filter((item): item is SceneHierarchyNode => typeof item === "object" && item !== null);
            }
            if (Array.isArray(record.result)) {
                return record.result.filter((item): item is SceneHierarchyNode => typeof item === "object" && item !== null);
            }
            return [value as SceneHierarchyNode];
        }
        return [];
    }

    private readNodeId(node: SceneHierarchyNode): string {
        if (typeof node.id === "string" && node.id) {
            return node.id;
        }
        if (typeof node.uuid === "string" && node.uuid) {
            return node.uuid;
        }
        return "";
    }

    private readNodePath(node: SceneHierarchyNode, parentParts: string[]): string {
        const name = typeof node.name === "string" ? node.name : "";
        return this.normalizeNodePath((name ? [...parentParts, name] : parentParts).join("/"));
    }

    private createTargetPathCandidates(targetPath: string, rootPath: string): Set<string> {
        const candidates = new Set<string>([targetPath]);
        if (rootPath && targetPath.startsWith(`${rootPath}/`)) {
            candidates.add(targetPath.slice(rootPath.length + 1));
        }
        return candidates;
    }

    private normalizeNodePath(value: string): string {
        return value.split("/").map((item) => item.trim()).filter(Boolean).join("/");
    }
}
