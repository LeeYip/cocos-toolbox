import type { BridgeAdapter, LocateResult, OpenAssetPayload, OpenAssetResult } from "./bridgeAdapter";

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
        const method = "Editor.Selection.clear+select(asset,uuid)";
        if (!Editor || !Editor.Selection || typeof Editor.Selection.select !== "function" || typeof Editor.Selection.clear !== "function") {
            return {
                located: false,
            };
        }
        let located = false;
        try {
            Editor.Selection.clear("asset");
            Editor.Selection.select("asset", uuid);
            located = true;
        } catch { }
        return {
            located,
            locateMethod: located ? method : undefined,
        };
    }

    private async getAssetUrlByUuid(uuid: string): Promise<string> {
        if (Editor && Editor.Message && typeof Editor.Message.request === "function") {
            try {
                const urlByRequest = await Editor.Message.request("asset-db", "query-url-by-uuid", uuid);
                if (typeof urlByRequest === "string") {
                    return urlByRequest;
                }
                if (urlByRequest && typeof urlByRequest.url === "string") {
                    return urlByRequest.url;
                }
            } catch { }
        }
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
