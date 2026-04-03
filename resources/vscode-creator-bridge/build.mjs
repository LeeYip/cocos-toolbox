import { build } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

await build({
    entryPoints: [path.join(__dirname, "src", "main.ts")],
    outfile: path.join(distDir, "main.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2019",
    minify: true,
    legalComments: "none",
});
