import * as fs from "fs";
import * as http from "http";
import * as path from "path";

type OpenAssetPayload = {
    projectId?: string;
    uuid?: string;
    assetPath?: string;
};

type OpenAssetResult = {
    ok: boolean;
    focused: boolean;
    opened: boolean;
    assetUrl: string;
    message: string;
    kind?: "prefab" | "scene" | "other";
};

type BridgeState = {
    projectId: string;
    projectPath: string;
    port: number;
    running: boolean;
};

const DEFAULT_PORT = 8456;
const PACKAGE_NAME = "vscode-creator-bridge";
const SETTINGS_FILE = "vscode-creator-bridge.json";

let server: http.Server | null = null;
let currentPort = DEFAULT_PORT;
let currentProjectPath = "";
let currentProjectId = "";

function getEditor(): any {
    return (global as any).Editor;
}

function bridgeLog(message: string): void {
    const Editor = getEditor();
    if (Editor && typeof Editor.log === "function") {
        Editor.log(`[${PACKAGE_NAME}] ${message}`);
        return;
    }
    console.log(`[${PACKAGE_NAME}] ${message}`);
}

function detectCreatorMajor(): number {
    const Editor = getEditor();
    if (Editor && Editor.Message && typeof Editor.Message.request === "function") {
        return 3;
    }
    return 2;
}

function getSettingsPath(): string {
    const localDir = path.join(currentProjectPath, "local");
    if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
    }
    return path.join(localDir, SETTINGS_FILE);
}

function normalizeProjectPath(projectPath: string): string {
    return path.resolve(projectPath).replace(/\\/g, "/").toLowerCase();
}

function createProjectId(projectPath: string): string {
    const content = normalizeProjectPath(projectPath);
    let hash = 2166136261;
    for (let i = 0; i < content.length; i++) {
        hash ^= content.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `p_${(hash >>> 0).toString(16)}`;
}

function readSavedPort(): number {
    try {
        const p = getSettingsPath();
        if (!fs.existsSync(p)) {
            return DEFAULT_PORT;
        }
        const raw = fs.readFileSync(p, "utf8");
        const data = JSON.parse(raw);
        const port = Number(data.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return DEFAULT_PORT;
        }
        return port;
    } catch {
        return DEFAULT_PORT;
    }
}

function savePort(port: number): void {
    const p = getSettingsPath();
    fs.writeFileSync(
        p,
        JSON.stringify(
            {
                port,
                projectId: currentProjectId,
                projectPath: currentProjectPath,
                updatedAt: Date.now(),
            },
            null,
            2,
        ),
        "utf8",
    );
}

function getBridgeState(): BridgeState {
    return {
        projectId: currentProjectId,
        projectPath: currentProjectPath,
        port: currentPort,
        running: !!server,
    };
}

function normalizeAssetUrl(rawPath?: string): string | null {
    if (!rawPath) {
        return null;
    }
    const p = rawPath.replace(/\\/g, "/").trim();
    if (!p) {
        return null;
    }
    if (p.startsWith("db://")) {
        return p;
    }
    if (p.startsWith("assets/")) {
        return `db://${p}`;
    }
    const absolute = path.isAbsolute(p) ? p.replace(/\\/g, "/") : path.join(currentProjectPath, p).replace(/\\/g, "/");
    const assetsRoot = `${currentProjectPath.replace(/\\/g, "/")}/assets/`;
    const compareAbsolute = absolute.toLowerCase();
    const compareAssetsRoot = assetsRoot.toLowerCase();
    if (compareAbsolute.startsWith(compareAssetsRoot)) {
        return `db://assets/${absolute.slice(assetsRoot.length)}`;
    }
    return null;
}

function focusCreatorWindow(): boolean {
    const Editor = getEditor();
    if (Editor && Editor.Window && typeof Editor.Window.focus === "function") {
        try {
            Editor.Window.focus();
            return true;
        } catch {
            return false;
        }
    }
    return false;
}

async function requestEditor(channel: string, method: string, ...args: any[]): Promise<any> {
    const Editor = getEditor();
    if (!Editor || !Editor.Message || typeof Editor.Message.request !== "function") {
        return undefined;
    }
    try {
        return await Editor.Message.request(channel, method, ...args);
    } catch {
        return undefined;
    }
}

function resolveUuidFor24(payload: OpenAssetPayload, assetUrl: string | null): string | null {
    if (payload.uuid) {
        return payload.uuid;
    }
    if (!assetUrl) {
        return null;
    }
    const Editor = getEditor();
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

async function resolveUuidFor3x(payload: OpenAssetPayload, assetUrl: string | null): Promise<string | null> {
    if (payload.uuid) {
        return payload.uuid;
    }
    if (!assetUrl) {
        return null;
    }
    const uuidByRequest = await requestEditor("asset-db", "query-uuid-by-url", assetUrl);
    if (typeof uuidByRequest === "string" && uuidByRequest) {
        return uuidByRequest;
    }
    if (uuidByRequest && typeof uuidByRequest.uuid === "string") {
        return uuidByRequest.uuid;
    }
    const assetInfo = await requestEditor("asset-db", "query-asset-info", assetUrl);
    if (assetInfo && typeof assetInfo.uuid === "string") {
        return assetInfo.uuid;
    }
    const assetMeta = await requestEditor("asset-db", "query-asset-meta", assetUrl);
    if (assetMeta && typeof assetMeta.uuid === "string") {
        return assetMeta.uuid;
    }
    const Editor = getEditor();
    if (Editor && Editor.assetdb && typeof Editor.assetdb.urlToUuid === "function") {
        try {
            const legacyUuid = Editor.assetdb.urlToUuid(assetUrl);
            return legacyUuid || null;
        } catch {
            return null;
        }
    }
    return null;
}

async function resolveUuid(payload: OpenAssetPayload, assetUrl: string | null, creatorMajor: number): Promise<string | null> {
    if (creatorMajor >= 3) {
        return await resolveUuidFor3x(payload, assetUrl);
    }
    return resolveUuidFor24(payload, assetUrl);
}

function getAssetUrlByUuidFor24(uuid: string): string {
    const Editor = getEditor();
    if (!Editor || !Editor.assetdb || typeof Editor.assetdb.uuidToUrl !== "function") {
        return "";
    }
    try {
        return Editor.assetdb.uuidToUrl(uuid) || "";
    } catch {
        return "";
    }
}

async function getAssetUrlByUuidFor3x(uuid: string): Promise<string> {
    const urlByRequest = await requestEditor("asset-db", "query-url-by-uuid", uuid);
    if (typeof urlByRequest === "string") {
        return urlByRequest;
    }
    if (urlByRequest && typeof urlByRequest.url === "string") {
        return urlByRequest.url;
    }
    return getAssetUrlByUuidFor24(uuid);
}

async function openAssetFor24(uuid: string | null, assetUrl: string | null, focused: boolean): Promise<OpenAssetResult> {
    const Editor = getEditor();
    const resolvedAssetUrl = uuid ? getAssetUrlByUuidFor24(uuid) : assetUrl || "";
    if (!uuid) {
        return { ok: false, focused, opened: false, assetUrl: resolvedAssetUrl, kind: "other", message: "uuid is empty" };
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
    } catch {}
    try {
        if (!opened && isPrefab && Editor.Ipc && typeof Editor.Ipc.sendToAll === "function") {
            Editor.Ipc.sendToAll("scene:enter-prefab-edit-mode", uuid);
            opened = true;
            message = "opened by prefab mode";
        }
    } catch {}
    try {
        if (!opened && Editor.assetdb && typeof Editor.assetdb.openAsset === "function") {
            Editor.assetdb.openAsset(uuid);
            opened = true;
            message = "opened by assetdb";
        }
    } catch {}
    if (!opened) {
        message = `failed to open asset. uuid=${uuid}`;
    }
    bridgeLog(`openAsset24 uuid=${uuid} kind=${kind} focused=${focused} opened=${opened} url=${resolvedAssetUrl || "<empty>"}`);
    return {
        ok: opened,
        focused,
        opened,
        assetUrl: resolvedAssetUrl,
        kind,
        message,
    };
}

async function tryOpenByRequest(method: string, ...args: any[]): Promise<boolean> {
    const Editor = getEditor();
    if (!Editor || !Editor.Message || typeof Editor.Message.request !== "function") {
        return false;
    }
    try {
        await Editor.Message.request("asset-db", method, ...args);
        return true;
    } catch {
        return false;
    }
}

async function openAssetFor3x(uuid: string | null, assetUrl: string | null, focused: boolean): Promise<OpenAssetResult> {
    const resolvedAssetUrl = uuid ? await getAssetUrlByUuidFor3x(uuid) : assetUrl || "";
    let opened = false;
    let message = "";
    if (uuid) {
        const openByUuid = await tryOpenByRequest("open-asset", uuid);
        if (openByUuid) {
            opened = true;
            message = "opened by uuid";
        }
    }
    if (!opened && resolvedAssetUrl) {
        const openByUrl = await tryOpenByRequest("open-asset", resolvedAssetUrl);
        if (openByUrl) {
            opened = true;
            message = "opened by asset url";
        }
    }
    if (!opened && uuid) {
        const Editor = getEditor();
        if (Editor && Editor.assetdb && typeof Editor.assetdb.openAsset === "function") {
            try {
                Editor.assetdb.openAsset(uuid);
                opened = true;
                message = "opened by legacy uuid";
            } catch {}
        }
    }
    if (!opened && resolvedAssetUrl) {
        const Editor = getEditor();
        if (Editor && Editor.assetdb && typeof Editor.assetdb.openAsset === "function") {
            try {
                Editor.assetdb.openAsset(resolvedAssetUrl);
                opened = true;
                message = "opened by legacy url";
            } catch {}
        }
    }
    if (!opened) {
        message = `failed to open asset. uuid=${uuid || "<none>"} assetUrl=${resolvedAssetUrl || "<none>"}`;
    }
    bridgeLog(`openAsset3x uuid=${uuid || "<none>"} focused=${focused} opened=${opened} url=${resolvedAssetUrl || "<empty>"}`);
    return {
        ok: opened,
        focused,
        opened,
        assetUrl: resolvedAssetUrl,
        message,
    };
}

async function openAsset(uuid: string | null, assetUrl: string | null, creatorMajor: number): Promise<OpenAssetResult> {
    const focused = focusCreatorWindow();
    if (creatorMajor >= 3) {
        return await openAssetFor3x(uuid, assetUrl, focused);
    }
    return await openAssetFor24(uuid, assetUrl, focused);
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = "";
        let rejected = false;
        req.on("data", (chunk) => {
            if (rejected) {
                return;
            }
            data += chunk.toString();
            if (data.length > 1024 * 1024) {
                rejected = true;
                req.destroy();
                reject(new Error("Payload too large"));
            }
        });
        req.on("end", () => {
            if (!rejected) {
                resolve(data);
            }
        });
        req.on("error", (error) => {
            if (!rejected) {
                reject(error);
            }
        });
    });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method || "").toUpperCase();
    const reqUrl = (req.url || "").split("?")[0];
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (method === "GET" && reqUrl === "/state") {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, state: getBridgeState() }));
        return;
    }
    if (method === "POST" && reqUrl === "/open-asset") {
        try {
            const raw = await readBody(req);
            const payload = raw ? (JSON.parse(raw) as OpenAssetPayload) : {};
            const projectIdHeader = String(req.headers["x-cocos-project-id"] || "").trim();
            const requestProjectId = String(payload.projectId || projectIdHeader).trim();
            if (!requestProjectId) {
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, message: "missing projectId" }));
                return;
            }
            if (requestProjectId !== currentProjectId) {
                res.statusCode = 409;
                res.end(JSON.stringify({ ok: false, message: "projectId mismatch", projectId: currentProjectId }));
                return;
            }
            const creatorMajor = detectCreatorMajor();
            const assetUrl = normalizeAssetUrl(payload.assetPath);
            const uuid = await resolveUuid(payload, assetUrl || null, creatorMajor);
            if (!uuid && !assetUrl) {
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, message: "invalid assetPath/uuid" }));
                return;
            }
            const result = await openAsset(uuid, assetUrl || null, creatorMajor);
            res.statusCode = result.ok ? 200 : 500;
            res.end(JSON.stringify({ ok: result.ok, uuid, ...result }));
            return;
        } catch (e: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, message: e?.message || "open failed" }));
            return;
        }
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, message: "not found" }));
}

function startServer(port: number): void {
    stopServer();
    server = http.createServer((req, res) => {
        handleRequest(req, res).catch((e) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, message: e?.message || "internal error" }));
        });
    });
    server.once("error", (error: any) => {
        if (error?.code === "EADDRINUSE" && port < 65535) {
            bridgeLog(`port ${port} in use, retry ${port + 1}`);
            startServer(port + 1);
            return;
        }
        bridgeLog(`start server failed: ${error?.message || error}`);
    });
    server.listen(port, "127.0.0.1", () => {
        const address = server?.address();
        if (address && typeof address === "object") {
            currentPort = Number(address.port || port);
        } else {
            currentPort = port;
        }
        savePort(currentPort);
        bridgeLog(`listening on 127.0.0.1:${currentPort} projectId=${currentProjectId}`);
    });
}

function stopServer(): void {
    if (!server) {
        return;
    }
    server.close();
    server = null;
}

module.exports = {
    load() {
        const Editor = getEditor();
        currentProjectPath = Editor.Project.path as string;
        currentProjectId = createProjectId(currentProjectPath);
        currentPort = readSavedPort();
        startServer(currentPort);
    },
    unload() {
        stopServer();
    },
    messages: {},
    methods: {},
};
