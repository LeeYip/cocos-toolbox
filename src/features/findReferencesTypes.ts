export type ReferenceNode = {
    name: string;
    path: string;
    displayPath?: string;
    uuid?: string;
};

export type ReferenceAsset = {
    filePath: string;
    creatorAssetPath: string;
    nodes?: ReferenceNode[];
    nodesLoaded: boolean;
    nodesLoading?: boolean;
    nodesError?: string;
};
