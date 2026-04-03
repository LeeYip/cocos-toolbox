import * as fs from "fs";
import path from "path";
import * as vscode from "vscode";

type CreatorBridgeProfile = {
    name: string;
    matchVersion: (version: string) => boolean;
    installSubDir: "packages" | "extensions";
};

/** Cocos项目文件状态 */
type CocosProjectFilesState = {
    /** 是否有assets目录 */
    hasAssetsDir: boolean;
    /** 是否有project.json */
    hasProjectJson: boolean;
    /** 是否有package.json */
    hasPackageJson: boolean;
    /** project.json路径 */
    projectJsonPath: string;
    /** package.json路径 */
    packageJsonPath: string;
};

const BRIDGE_PACKAGE_NAME = "vscode-creator-bridge";
const BRIDGE_TEMPLATE_REL_PATH = path.join("resources", BRIDGE_PACKAGE_NAME);
const BRIDGE_SYNC_ENTRIES = ["package.json", "dist"];
const PROFILES: CreatorBridgeProfile[] = [
    {
        name: "2.x",
        matchVersion: (version: string) => /^2\./.test(version),
        installSubDir: "packages",
    },
    {
        name: "3.x",
        matchVersion: (version: string) => /^3\./.test(version),
        installSubDir: "extensions",
    },
];
const INSTALL_LOCKS: Map<string, Promise<void>> = new Map();

/**
 * 确保Creator扩展vscode-creator-bridge已安装，且为最新版本
 */
export async function ensureCreatorBridgeReady(extensionPath: string, referencePath: string): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(referencePath));
    if (!workspaceFolder) {
        return;
    }
    const projectRoot = workspaceFolder.uri.fsPath;
    const running = INSTALL_LOCKS.get(projectRoot);
    if (running) {
        await running;
        return;
    }
    const task = (async () => {
        const state = await readCocosProjectFilesState(projectRoot);
        if (!isCocosProject(state)) {
            return;
        }

        const version = await resolveCreatorVersion(state);
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
    })();
    INSTALL_LOCKS.set(projectRoot, task);
    try {
        await task;
    } finally {
        if (INSTALL_LOCKS.get(projectRoot) === task) {
            INSTALL_LOCKS.delete(projectRoot);
        }
    }
}

function isCocosProject(state: CocosProjectFilesState): boolean {
    if (!state.hasAssetsDir) {
        return false;
    }
    return state.hasProjectJson || state.hasPackageJson;
}

async function resolveCreatorVersion(state: CocosProjectFilesState): Promise<string | undefined> {
    if (!state.hasAssetsDir) {
        return undefined;
    }

    if (state.hasProjectJson) {
        const versionFromProjectJson = await readVersionFromProjectJson(state.projectJsonPath);
        if (versionFromProjectJson && /^2\./.test(versionFromProjectJson)) {
            return versionFromProjectJson;
        }
    }

    if (state.hasPackageJson) {
        const versionFromPackageJson = await readVersionFromPackageJson(state.packageJsonPath);
        if (versionFromPackageJson && /^3\./.test(versionFromPackageJson)) {
            return versionFromPackageJson;
        }
    }

    return undefined;
}

async function readCocosProjectFilesState(projectRoot: string): Promise<CocosProjectFilesState> {
    const projectJsonPath = path.join(projectRoot, "project.json");
    const packageJsonPath = path.join(projectRoot, "package.json");
    const [hasAssetsDir, hasProjectJson, hasPackageJson] = await Promise.all([checkPath(path.join(projectRoot, "assets")), checkPath(projectJsonPath), checkPath(packageJsonPath)]);
    return {
        hasAssetsDir,
        hasProjectJson,
        hasPackageJson,
        projectJsonPath,
        packageJsonPath,
    };
}

async function readVersionFromProjectJson(projectPath: string): Promise<string | undefined> {
    try {
        const raw = await fs.promises.readFile(projectPath, { encoding: "utf8" });
        const parsed = JSON.parse(raw) as { version?: string };
        const version = typeof parsed.version === "string" ? parsed.version : undefined;
        if (version && /\d+\.\d+/.test(version)) {
            return version;
        }
    } catch { }
    return undefined;
}

async function readVersionFromPackageJson(packagePath: string): Promise<string | undefined> {
    try {
        const raw = await fs.promises.readFile(packagePath, { encoding: "utf8" });
        const parsed = JSON.parse(raw) as { version?: string; creator?: { version?: string } };
        const creatorVersion = parsed.creator && typeof parsed.creator.version === "string" ? parsed.creator.version : undefined;
        if (creatorVersion && /\d+\.\d+/.test(creatorVersion)) {
            return creatorVersion;
        }
        const version = typeof parsed.version === "string" ? parsed.version : undefined;
        if (version && /\d+\.\d+/.test(version)) {
            return version;
        }
    } catch { }
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
