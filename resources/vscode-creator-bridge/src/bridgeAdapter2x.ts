import type { BridgeAdapter, LocateResult, OpenAssetPayload, OpenAssetResult } from "./bridgeAdapter";

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
        let opened = false;
        let message = "";
        const isPrefab = resolvedAssetUrl.endsWith(".prefab");
        const isScene = resolvedAssetUrl.endsWith(".fire") || resolvedAssetUrl.endsWith(".scene");
        const kind: "prefab" | "scene" | "other" = isPrefab ? "prefab" : isScene ? "scene" : "other";
        try {
            if (isScene && Editor.Panel && typeof Editor.Panel.open === "function") {
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
        const method = "assets:hint(uuid)";
        if (!Editor || !Editor.Ipc || typeof Editor.Ipc.sendToAll !== "function") {
            return {
                located: false,
            };
        }
        try {
            Editor.Ipc.sendToAll("assets:hint", locateUuid);
            return {
                located: true,
                locateMethod: method,
            };
        } catch (e: any) {
            const reason = e?.message || "unknown error";
            return {
                located: false,
            };
        }
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
}
