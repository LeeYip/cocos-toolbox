import * as fs from "fs";
import path from "path";
import * as vscode from "vscode";

type CreatorBridgeProfile = {
    name: string;
    matchVersion: (version: string) => boolean;
    installSubDir: "packages" | "extensions";
};

const BRIDGE_PACKAGE_NAME = "vscode-creator-bridge";
const BRIDGE_TEMPLATE_REL_PATH = path.join("resources", BRIDGE_PACKAGE_NAME);
const BRIDGE_SYNC_ENTRIES = ["package.json", "dist"];
const PROFILES: CreatorBridgeProfile[] = [
    {
        name: "2.4.x",
        matchVersion: (version: string) => /^2\.4(\.|$)/.test(version),
        installSubDir: "packages",
    },
    {
        name: "3.x",
        matchVersion: (version: string) => /^3\./.test(version),
        installSubDir: "extensions",
    },
];

/**
 * 确保Creator扩展vscode-creator-bridge已安装，且为最新版本
 */
export async function ensureCreatorBridgeReady(extensionPath: string, referencePath: string): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(referencePath));
    if (!workspaceFolder) {
        return;
    }
    const projectRoot = workspaceFolder.uri.fsPath;
    if (!(await isCocosProject(projectRoot))) {
        return;
    }

    const version = await resolveCreatorVersion(projectRoot);
    if (!version) {
        return;
    }
    const profile = resolveProfile(version);
    if (!profile) {
        return;
    }

    const bridgeTemplatePath = await resolveBridgeTemplatePath(extensionPath);
    if (!bridgeTemplatePath) {
        return;
    }

    const targetPath = path.join(projectRoot, profile.installSubDir, BRIDGE_PACKAGE_NAME);
    const legacyInstallSubDir = profile.installSubDir === "packages" ? "extensions" : "packages";
    const legacyPath = path.join(projectRoot, legacyInstallSubDir, BRIDGE_PACKAGE_NAME);
    const hasLegacyBridge = await checkPath(legacyPath);
    const sourceVersion = await readPackageVersion(path.join(bridgeTemplatePath, "package.json"));
    const targetVersion = await readPackageVersion(path.join(targetPath, "package.json"));
    const targetHealthy = await checkTargetBridgeHealthy(targetPath);
    const shouldSync = hasLegacyBridge || !targetVersion || sourceVersion !== targetVersion || !targetHealthy;
    if (!shouldSync) {
        return;
    }

    if (hasLegacyBridge) {
        await removePathCompatible(legacyPath);
    }
    await syncBridgeTemplate(bridgeTemplatePath, targetPath);
}

async function isCocosProject(projectRoot: string): Promise<boolean> {
    const hasAssetsDir = await checkPath(path.join(projectRoot, "assets"));
    if (!hasAssetsDir) {
        return false;
    }
    const hasSettingsProject = await checkPath(path.join(projectRoot, "settings", "project.json"));
    const hasProjectJson = await checkPath(path.join(projectRoot, "project.json"));
    const creatorVersionFromPackage = await readCreatorVersionFromPackage(projectRoot);
    return hasSettingsProject || hasProjectJson || !!creatorVersionFromPackage;
}

async function resolveCreatorVersion(projectRoot: string): Promise<string | undefined> {
    const creatorVersionFromPackage = await readCreatorVersionFromPackage(projectRoot);
    if (creatorVersionFromPackage) {
        return creatorVersionFromPackage;
    }
    const candidates = [path.join(projectRoot, "settings", "project.json"), path.join(projectRoot, "project.json")];
    for (const candidate of candidates) {
        try {
            const raw = await fs.promises.readFile(candidate, { encoding: "utf8" });
            const parsed = JSON.parse(raw);
            const fromKnownKeys = findVersionFromKnownKeys(parsed);
            if (fromKnownKeys) {
                return fromKnownKeys;
            }
            const fromScan = findVersionByScan(parsed);
            if (fromScan) {
                return fromScan;
            }
        } catch {}
    }
    return undefined;
}

async function readCreatorVersionFromPackage(projectRoot: string): Promise<string | undefined> {
    const packagePath = path.join(projectRoot, "package.json");
    try {
        const raw = await fs.promises.readFile(packagePath, { encoding: "utf8" });
        const parsed = JSON.parse(raw) as { creator?: { version?: string } };
        const version = parsed.creator && typeof parsed.creator.version === "string" ? parsed.creator.version : undefined;
        if (version && /\d+\.\d+/.test(version)) {
            return version;
        }
    } catch {}
    return undefined;
}

function findVersionFromKnownKeys(value: unknown): string | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const objectValue = value as Record<string, unknown>;
    const keys = ["engineVersion", "version", "creatorVersion", "editorVersion"];
    for (const key of keys) {
        const keyValue = objectValue[key];
        if (typeof keyValue === "string" && /\d+\.\d+/.test(keyValue)) {
            return keyValue;
        }
    }
    return undefined;
}

function findVersionByScan(value: unknown): string | undefined {
    if (typeof value === "string") {
        const match = value.match(/\b\d+\.\d+\.\d+\b/);
        return match ? match[0] : undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findVersionByScan(item);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
    if (value && typeof value === "object") {
        const objectValue = value as Record<string, unknown>;
        for (const key of Object.keys(objectValue)) {
            const found = findVersionByScan(objectValue[key]);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

function resolveProfile(version: string): CreatorBridgeProfile | undefined {
    return PROFILES.find((profile) => profile.matchVersion(version));
}

async function resolveBridgeTemplatePath(extensionPath: string): Promise<string | undefined> {
    const candidatePath = path.join(extensionPath, BRIDGE_TEMPLATE_REL_PATH);
    if (!(await checkPath(candidatePath))) {
        return undefined;
    }
    return candidatePath;
}

async function readPackageVersion(packagePath: string): Promise<string | undefined> {
    try {
        const raw = await fs.promises.readFile(packagePath, { encoding: "utf8" });
        const parsed = JSON.parse(raw) as { version?: string };
        return parsed.version;
    } catch {
        return undefined;
    }
}

async function checkTargetBridgeHealthy(targetPath: string): Promise<boolean> {
    const requiredFiles = [path.join(targetPath, "package.json"), path.join(targetPath, "dist", "main.js")];
    for (const file of requiredFiles) {
        if (!(await checkPath(file))) {
            return false;
        }
    }
    return true;
}

async function checkPath(pathValue: string): Promise<boolean> {
    try {
        await fs.promises.access(pathValue);
        return true;
    } catch {
        return false;
    }
}

async function syncBridgeTemplate(sourceRoot: string, targetRoot: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(targetRoot), { recursive: true });
    await removePathCompatible(targetRoot);
    await fs.promises.mkdir(targetRoot, { recursive: true });
    for (const entry of BRIDGE_SYNC_ENTRIES) {
        const sourcePath = path.join(sourceRoot, entry);
        if (!(await checkPath(sourcePath))) {
            continue;
        }
        const targetPath = path.join(targetRoot, entry);
        await copyPathRecursive(sourcePath, targetPath);
    }
}

async function removePathCompatible(pathValue: string): Promise<void> {
    if (!(await checkPath(pathValue))) {
        return;
    }
    const stat = await fs.promises.lstat(pathValue);
    if (!stat.isDirectory()) {
        await fs.promises.unlink(pathValue);
        return;
    }
    const entries = await fs.promises.readdir(pathValue);
    for (const entry of entries) {
        await removePathCompatible(path.join(pathValue, entry));
    }
    await fs.promises.rmdir(pathValue);
}

async function copyPathRecursive(sourcePath: string, targetPath: string): Promise<void> {
    const stat = await fs.promises.lstat(sourcePath);
    if (!stat.isDirectory()) {
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.copyFile(sourcePath, targetPath);
        return;
    }
    await fs.promises.mkdir(targetPath, { recursive: true });
    const entries = await fs.promises.readdir(sourcePath);
    for (const entry of entries) {
        await copyPathRecursive(path.join(sourcePath, entry), path.join(targetPath, entry));
    }
}
