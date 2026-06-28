declare global {
    const Editor: any;
}

export type OpenAssetPayload = {
    projectId?: string;
    uuid?: string;
    assetPath?: string;
    nodeUuid?: string;
    nodePath?: string;
};

export type OpenAssetResult = {
    ok: boolean;
    opened: boolean;
    located: boolean;
    assetUrl: string;
    message: string;
    kind?: "prefab" | "scene" | "other";
    locateMethod?: string;
};

export type LocateResult = {
    located: boolean;
    locateMethod?: string;
};

export type LocateNodeResult = {
    selected: boolean;
    locateMethod?: string;
    message: string;
    nodeUuid?: string;
    nodePath?: string;
    nodeUrl?: string;
    queryError?: string;
    sceneWalkError?: string;
    sceneWalkMatchedPath?: string;
};

export type RequestStatus = {
    ok: boolean;
    result?: any;
    error?: string;
};

export interface BridgeAdapter {
    resolveUuid(payload: OpenAssetPayload, assetUrl: string | null): Promise<string | null>;
    openAsset(uuid: string | null, assetUrl: string | null): Promise<OpenAssetResult>;
    locateAssetInBrowser(uuid: string | null, assetUrl: string | null): Promise<LocateResult>;
    locateNode(nodeUuid: string | undefined, assetUuid: string | null, assetUrl: string | null, nodePath?: string): Promise<LocateNodeResult>;
}
