import type { BridgeAdapter, LocateNodeResult, LocateResult, OpenAssetPayload, OpenAssetResult } from "./bridgeAdapter";
import Utils from "./utils";

type SceneHierarchyNode = {
    name?: unknown;
    uuid?: unknown;
    path?: unknown;
    children?: unknown;
};

const NODE_LOCATE_POLL_TIMEOUT_MS = 2500;
const NODE_LOCATE_POLL_INTERVAL_MS = 100;

export class BridgeAdapter3x implements BridgeAdapter {
    async resolveUuid(payload: OpenAssetPayload, assetUrl: string | null): Promise<string | null> {
        if (payload.uuid) {
            return payload.uuid;
        }
        if (!assetUrl) {
            return null;
        }
        if (!Editor || !Editor.Message || typeof Editor.Message.request !== "function") {
            return null;
        }
        try {
            const assetInfo = await Editor.Message.request("asset-db", "query-asset-info", assetUrl);
            if (assetInfo && typeof assetInfo.uuid === "string") {
                return assetInfo.uuid;
            }
        } catch { }
        if (Editor.assetdb && typeof Editor.assetdb.urlToUuid === "function") {
            try {
                return Editor.assetdb.urlToUuid(assetUrl) || null;
            } catch {
                return null;
            }
        }
        return null;
    }

    async openAsset(uuid: string | null, assetUrl: string | null): Promise<OpenAssetResult> {
        const resolvedAssetUrl = uuid ? await this.getAssetUrlByUuid(uuid) : assetUrl || "";
        let opened = false;
        let message = "";
        if (uuid) {
            // 判断当前是否已打开对应的场景与预制体，避免重复打开
            const currentSceneResult = await Editor.Message.request("scene", "query-current-scene");
            if (currentSceneResult === uuid) {
                return {
                    ok: true,
                    opened: true,
                    located: false,
                    assetUrl: resolvedAssetUrl,
                    message: "asset already opened",
                };
            }

            if (Editor && Editor.Message && typeof Editor.Message.request === "function") {
                try {
                    await Editor.Message.request("asset-db", "open-asset", uuid);
                    opened = true;
                    message = "opened by uuid";
                } catch { }
            }
        }
        if (!opened) {
            message = `failed to open asset. uuid=${uuid || "<none>"} assetUrl=${resolvedAssetUrl || "<none>"}`;
        }
        return {
            ok: opened,
            opened,
            located: false,
            assetUrl: resolvedAssetUrl,
            message,
        };
    }

    async locateAssetInBrowser(uuid: string | null, assetUrl: string | null): Promise<LocateResult> {
        if (!uuid) {
            return {
                located: false,
            };
        }
        const methods: string[] = [];
        try {
            if (Editor && Editor.Selection && typeof Editor.Selection.select === "function" && typeof Editor.Selection.clear === "function") {
                Editor.Selection.clear("asset");
                Editor.Selection.select("asset", uuid);
                methods.push("Editor.Selection.clear+select(asset,uuid)");
            }
            if (Editor && Editor.Message && typeof Editor.Message.send === "function") {
                Editor.Message.send("assets", "twinkle", uuid);
                methods.push("Editor.Message.send(assets,twinkle,uuid)");
            }
        } catch { }

        const located = methods.length > 0;
        return {
            located,
            locateMethod: located ? methods.join("+") : undefined,
        };
    }

    async locateNode(nodeUuid: string | undefined, _assetUuid: string | null, _assetUrl: string | null, nodePath?: string): Promise<LocateNodeResult> {
        if (!nodeUuid && !nodePath) {
            return {
                selected: false,
                message: "node uuid is empty",
            };
        }
        const methods: string[] = [];
        let sceneWalkError: string | undefined;
        if (nodePath) {
            const pollResult = await this.pollNodeInHierarchy(nodePath, methods);
            const matchedNode = pollResult.matched;
            if (matchedNode?.uuid) {
                const selected = this.selectNode(matchedNode.uuid, methods);
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

        const locateUuid = nodeUuid || "";
        if (locateUuid) {
            methods.push(nodePath ? "polling timeout+fallback direct select" : "direct select");
        }
        const selected = locateUuid ? this.selectNode(locateUuid, methods) : false;
        return {
            selected,
            nodeUuid: locateUuid,
            nodePath,
            locateMethod: methods.length > 0 ? methods.join("+") : undefined,
            sceneWalkError: nodePath && !selected ? sceneWalkError : undefined,
            message: selected ? "node selected" : `failed to select node. nodeUuid=${locateUuid || "<none>"}`,
        };
    }

    private selectNode(uuid: string, methods: string[]): boolean {
        let selected = false;
        try {
            Editor.Selection.clear("node");
            Editor.Selection.select("node", uuid);
            methods.push("Editor.Selection.clear+select(node,uuid)");
            selected = true;
        } catch { }
        return selected;
    }

    private async queryHierarchy(): Promise<{ result?: unknown; error?: string }> {
        try {
            const result = await Editor.Message.request("scene", "query-node-tree");
            return { result };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }

    private async pollNodeInHierarchy(nodePath: string, methods: string[]): Promise<{ matched?: { uuid: string; path: string }; error?: string }> {
        const deadline = Date.now() + NODE_LOCATE_POLL_TIMEOUT_MS;
        let lastError = "";
        let matchedWithoutUuid: { uuid: string; path: string } | undefined;
        let attempt = 0;
        while (Date.now() <= deadline) {
            attempt += 1;
            const hierarchyResult = await this.queryHierarchy();
            methods.push(
                hierarchyResult.error
                    ? `Editor.Message.request(scene,query-node-tree) poll#${attempt} failed: ${hierarchyResult.error}`
                    : `Editor.Message.request(scene,query-node-tree) poll#${attempt}`,
            );
            if (!hierarchyResult.error) {
                const matchedNode = this.findNodeInHierarchy(hierarchyResult.result, nodePath);
                if (matchedNode?.uuid) {
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
        for (const root of this.asNodeArray(value)) {
            const rootPath = this.readNodePath(root);
            const targetPaths = this.createTargetPathCandidates(targetPath, rootPath);
            const matched = this.findNodeByPath(root, targetPaths, true);
            if (matched) {
                return matched;
            }
        }
        return undefined;
    }

    private findNodeByPath(node: SceneHierarchyNode, targetPaths: Set<string>, isRoot: boolean): { uuid: string; path: string } | undefined {
        const currentPath = this.readNodePath(node);
        const relativePath = isRoot ? "" : currentPath;
        if (targetPaths.has(currentPath) || targetPaths.has(relativePath)) {
            return {
                uuid: this.readNodeId(node),
                path: currentPath,
            };
        }
        for (const child of this.asNodeArray(node.children)) {
            const matched = this.findNodeByPath(child, targetPaths, false);
            if (matched) {
                return matched;
            }
        }
        if (isRoot) {
            for (const child of this.asNodeArray(node.children)) {
                const matched = this.findNodeByRelativePath(child, targetPaths);
                if (matched) {
                    return matched;
                }
            }
        }
        return undefined;
    }

    private findNodeByRelativePath(node: SceneHierarchyNode, targetPaths: Set<string>): { uuid: string; path: string } | undefined {
        const currentPath = this.readNodePath(node);
        if (targetPaths.has(currentPath)) {
            return {
                uuid: this.readNodeId(node),
                path: currentPath,
            };
        }
        for (const child of this.asNodeArray(node.children)) {
            const matched = this.findNodeByRelativePath(child, targetPaths);
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
        return typeof node.uuid === "string" && node.uuid ? node.uuid : "";
    }

    private readNodePath(node: SceneHierarchyNode): string {
        return this.normalizeNodePath(typeof node.path === "string" && node.path ? node.path : typeof node.name === "string" ? node.name : "");
    }

    private createTargetPathCandidates(targetPath: string, rootPath: string): Set<string> {
        const candidates = new Set<string>([targetPath]);
        if (rootPath && targetPath.startsWith(`${rootPath}/`)) {
            candidates.add(targetPath.slice(rootPath.length + 1));
        }
        const firstSeparatorIndex = targetPath.indexOf("/");
        if (firstSeparatorIndex >= 0) {
            candidates.add(targetPath.slice(firstSeparatorIndex + 1));
        }
        return candidates;
    }

    private normalizeNodePath(value: string): string {
        return value.split("/").map((item) => item.trim()).filter(Boolean).join("/");
    }

    private async getAssetUrlByUuid(uuid: string): Promise<string> {
        try {
            const urlByRequest = await Editor.Message.request("asset-db", "query-url-by-uuid", uuid);
            if (typeof urlByRequest === "string") {
                return urlByRequest;
            }
            if (urlByRequest && typeof urlByRequest.url === "string") {
                return urlByRequest.url;
            }
        } catch { }
        if (!Editor || !Editor.assetdb || typeof Editor.assetdb.uuidToUrl !== "function") {
            return "";
        }
        try {
            return Editor.assetdb.uuidToUrl(uuid) || "";
        } catch {
            return "";
        }
    }
}
