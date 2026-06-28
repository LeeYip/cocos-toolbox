import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as vscode from "vscode";
import Config from "../config";
import type { ReferenceNode } from "./findReferencesTypes";

const BRIDGE_SETTINGS_REL_PATH = path.join("local", "vscode-creator-bridge.json");

type CreatorBridgeRuntime = {
    port?: number;
    projectId?: string;
};

type CreatorTarget = {
    requestUrl: string;
    projectId?: string;
    workspacePath: string;
};

type CreatorBridgeEndpoint = "/open-asset" | "/reveal-asset" | "/open-node";

export async function openAssetInCreator(filePath: string): Promise<{ success: boolean; error?: string }> {
    return await postAssetToCreator(filePath, "/open-asset");
}

export async function openNodeInCreator(filePath: string, node: ReferenceNode): Promise<{ success: boolean; error?: string }> {
    return await postAssetToCreator(filePath, "/open-node", {
        nodeUuid: node.uuid,
        nodePath: node.path,
    });
}

export async function revealAssetInCreator(filePath: string): Promise<{ success: boolean; error?: string }> {
    return await postAssetToCreator(filePath, "/reveal-asset");
}

export function toCreatorAssetPath(filePath: string, workspacePath?: string): string | undefined {
    if (!workspacePath) {
        return undefined;
    }

    const relativePath = path.relative(workspacePath, filePath).replace(/\\/g, "/");
    const lower = relativePath.toLowerCase();
    if (lower === "assets") {
        return "assets";
    }
    if (lower.startsWith("assets/")) {
        return `assets/${relativePath.slice(7)}`;
    }
    if (lower.startsWith("../") || path.isAbsolute(relativePath)) {
        return undefined;
    }
    return undefined;
}

async function postAssetToCreator(filePath: string, endpoint: CreatorBridgeEndpoint, extraPayload?: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
    const target = await resolveCreatorTarget(filePath, endpoint);
    if (!target) {
        return { success: false, error: "未找到当前项目桥接信息，请先打开 Creator 项目并确保 local/vscode-creator-bridge.json 存在" };
    }
    const assetPath = toCreatorAssetPath(filePath, target.workspacePath);
    if (!assetPath) {
        return { success: false, error: "资源路径转换失败" };
    }

    const result = await requestCreator(target, assetPath, extraPayload);
    if (!result.success) {
        return { success: false, error: `项目桥接请求失败: ${result.error}` };
    }
    return { success: true };
}

async function resolveCreatorTarget(filePath: string, endpoint: CreatorBridgeEndpoint): Promise<CreatorTarget | undefined> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (workspaceFolder) {
        const runtimePath = path.join(workspaceFolder.uri.fsPath, BRIDGE_SETTINGS_REL_PATH);
        try {
            const raw = await fs.promises.readFile(runtimePath, { encoding: "utf8" });
            const runtime = JSON.parse(raw) as CreatorBridgeRuntime;
            const runtimePort = Number(runtime.port);
            if (Number.isInteger(runtimePort) && runtimePort > 0 && runtimePort <= 65535 && runtime.projectId) {
                return {
                    requestUrl: `http://127.0.0.1:${runtimePort}${endpoint}`,
                    projectId: String(runtime.projectId),
                    workspacePath: workspaceFolder.uri.fsPath,
                };
            }
        } catch { }
    }
    return undefined;
}

async function requestCreator(target: CreatorTarget, assetPath: string, extraPayload?: Record<string, unknown>): Promise<{ success: boolean; error: string }> {
    try {
        const requestUrl = target.requestUrl;
        const targetUrl = new URL(requestUrl);
        const payload = JSON.stringify({
            assetPath,
            projectId: target.projectId,
            ...extraPayload,
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
                    const detail = readResponseMessage(body);
                    safeResolve({ success: false, error: `${requestUrl} 返回状态 ${statusCode}${detail ? `: ${detail}` : ""}` });
                });
            });
            request.on("error", (error) => {
                safeResolve({ success: false, error: `${requestUrl} 请求异常: ${error.message}` });
            });
            request.setTimeout(Config.creatorBridgeRequestTimeout, () => {
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

function readResponseMessage(body: string): string {
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
