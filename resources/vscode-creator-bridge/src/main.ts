import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type { BridgeAdapter, OpenAssetPayload, OpenAssetResult } from "./bridgeAdapter";
import { BridgeAdapter2x } from "./bridgeAdapter2x";
import { BridgeAdapter3x } from "./bridgeAdapter3x";

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
let activeCreatorMajor = 3;
let activeAdapter: BridgeAdapter | null = null;

function bridgeLog(message: string): void {
    // 仅调试用
    return;
    if (Editor && typeof Editor.log === "function") {
        Editor.log(`[${PACKAGE_NAME}] ${message}`);
        return;
    }
    console.log(`[${PACKAGE_NAME}] ${message}`);
}

function detectCreatorMajor(): number {
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

function createProjectId(projectPath: string): string {
    const content = path.resolve(projectPath).replace(/\\/g, "/").toLowerCase();
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
    try {
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
    } catch (e: any) {
        bridgeLog(`save settings failed: ${e?.message || "unknown error"}`);
    }
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
    try {
        const electron = require("electron");
        const BrowserWindow = electron?.BrowserWindow;
        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== "function") {
            return false;
        }
        const windows = BrowserWindow.getAllWindows();
        const scored = (windows || [])
            .map((item: any) => {
                let score = 0;
                const title = typeof item?.getTitle === "function" ? String(item.getTitle() || "") : "";
                const titleLower = title.toLowerCase();
                const url = item?.webContents && typeof item.webContents.getURL === "function" ? String(item.webContents.getURL() || "") : "";
                const urlLower = url.toLowerCase();
                if (typeof item?.isDestroyed === "function" && item.isDestroyed()) {
                    score -= 1000;
                }
                if (typeof item?.isVisible === "function" && item.isVisible()) {
                    score += 50;
                }
                if (typeof item?.isFocused === "function" && item.isFocused()) {
                    score += 20;
                }
                if (titleLower.includes("cocos") || titleLower.includes("creator")) {
                    score += 80;
                }
                if (titleLower.includes("worker") || titleLower.includes("build")) {
                    score -= 200;
                }
                if (urlLower.includes("worker") || urlLower.includes("build")) {
                    score -= 120;
                }
                return { item, score };
            })
            .sort((a: any, b: any) => b.score - a.score);
        const win = scored.length > 0 ? scored[0].item : undefined;
        if (!win) {
            return false;
        }
        if (typeof win.isMinimized === "function" && win.isMinimized() && typeof win.restore === "function") {
            win.restore();
        }
        if (typeof win.show === "function") {
            win.show();
        }
        if (electron?.app && typeof electron.app.focus === "function") {
            electron.app.focus();
        }
        if (typeof win.moveTop === "function") {
            win.moveTop();
        }
        if (typeof win.setAlwaysOnTop === "function") {
            const wasAlwaysOnTop = typeof win.isAlwaysOnTop === "function" ? !!win.isAlwaysOnTop() : false;
            win.setAlwaysOnTop(true);
            if (typeof win.focus === "function") {
                win.focus();
            }
            win.setAlwaysOnTop(wasAlwaysOnTop);
            return true;
        }
        if (typeof win.focus === "function") {
            win.focus();
        }
        return true;
    } catch {
        return false;
    }
}

async function openAsset(uuid: string | null, assetUrl: string | null): Promise<OpenAssetResult> {
    if (!activeAdapter) {
        return {
            ok: false,
            opened: false,
            located: false,
            assetUrl: assetUrl || "",
            message: "adapter is not initialized",
        };
    }
    const openedResult = await activeAdapter.openAsset(uuid, assetUrl);
    if (!openedResult.opened) {
        return openedResult;
    }
    // 成功打开资源后聚焦窗口
    focusCreatorWindow();
    // 成功打开资源后定位资源管理器
    const locateResult = await activeAdapter.locateAssetInBrowser(uuid, openedResult.assetUrl || assetUrl);
    const merged: OpenAssetResult = {
        ...openedResult,
        ok: openedResult.opened,
        located: locateResult.located,
        locateMethod: locateResult.locateMethod,
    };
    bridgeLog(`openAsset opened=${merged.opened} assetUrl=${merged.assetUrl || "<none>"}`);
    return merged;
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
            if (!activeAdapter) {
                res.statusCode = 500;
                res.end(JSON.stringify({ ok: false, message: "bridge adapter is not initialized" }));
                return;
            }
            const assetUrl = normalizeAssetUrl(payload.assetPath);
            const uuid = await activeAdapter.resolveUuid(payload, assetUrl || null);
            if (!uuid && !assetUrl) {
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, message: "invalid assetPath/uuid" }));
                return;
            }
            const result = await openAsset(uuid, assetUrl || null);
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
        bridgeLog("load start");
        try {
            const projectPath = Editor && Editor.Project ? (Editor.Project.path as string) : "";
            if (!projectPath) {
                bridgeLog("load aborted: Editor.Project.path is empty");
                return;
            }
            currentProjectPath = projectPath;
            currentProjectId = createProjectId(currentProjectPath);
            activeCreatorMajor = detectCreatorMajor();
            if (activeCreatorMajor >= 3) {
                activeAdapter = new BridgeAdapter3x();
            } else {
                activeAdapter = new BridgeAdapter2x();
            }
            bridgeLog(`adapter initialized for creator major ${activeCreatorMajor}`);
            currentPort = readSavedPort();
            bridgeLog(`start server with initial port ${currentPort}`);
            startServer(currentPort);
        } catch (e: any) {
            bridgeLog(`load failed: ${e?.message || "unknown error"}`);
        }
    },
    unload() {
        stopServer();
    },
    messages: {},
    methods: {},
};
