import path from "path";

export function buildReferencesHtml(activeFileName: string, references: string[]): string {
    const title = escapeHtml(activeFileName);
    const items = references
        .map((reference, index) => {
            const baseName = escapeHtml(path.basename(reference));
            const fullPath = escapeHtml(reference);
            return `<li class="item"><button class="open-btn" data-index="${index}" title="${fullPath}">${baseName}</button><div class="path" title="${fullPath}">${fullPath}</div><div class="status" id="status-${index}"></div></li>`;
        })
        .join("");
    const empty = references.length <= 0 ? `<div class="empty">未找到引用资源，请确认脚本中包含有效 uuid。</div>` : "";
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px; }
.header { margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
.title { font-size: 13px; font-weight: 600; margin-bottom: 4px; line-height: 1.4; }
.count { font-size: 12px; color: var(--vscode-descriptionForeground); }
.list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.item { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; background: var(--vscode-editorWidget-background); transition: border-color 0.15s ease, background-color 0.15s ease; }
.item:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
.open-btn { width: 100%; text-align: left; font-size: 13px; font-weight: 600; background: transparent; color: var(--vscode-textLink-foreground); border: none; cursor: pointer; padding: 0; line-height: 1.45; }
.open-btn:hover { text-decoration: underline; }
.open-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; border-radius: 4px; }
.open-btn:disabled { cursor: wait; opacity: 0.65; text-decoration: none; }
.path { margin-top: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { margin-top: 6px; min-height: 18px; font-size: 12px; font-weight: 500; }
.status-main { line-height: 1.4; }
.status-hint { margin-top: 2px; font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
.ok { color: var(--vscode-testing-iconPassed); }
.err { color: var(--vscode-testing-iconFailed); }
.empty { font-size: 12px; color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border); border-radius: 8px; padding: 12px; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="header">
<div class="title">Cocos 资源引用：${title}</div>
<div class="count">共 ${references.length} 个引用文件</div>
</div>
${empty}
<ul class="list">${items}</ul>
<script>
const vscodeApi = acquireVsCodeApi();
const buttons = document.querySelectorAll(".open-btn");
function escapeHtmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function setStatus(statusEl, className, mainText, hintText) {
  statusEl.className = className;
  const main = '<div class="status-main">' + escapeHtmlText(mainText) + '</div>';
  const hint = hintText ? '<div class="status-hint">' + escapeHtmlText(hintText) + '</div>' : "";
  statusEl.innerHTML = main + hint;
}
buttons.forEach((button) => {
  button.addEventListener("click", () => {
    const index = Number(button.dataset.index);
    if (Number.isNaN(index)) return;
    button.disabled = true;
    const statusEl = document.getElementById("status-" + index);
    if (statusEl) {
      setStatus(statusEl, "status", "⏳ 正在通知 Creator...");
    }
    vscodeApi.postMessage({ type: "openAsset", index });
  });
});
window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.type !== "openResult") return;
  const index = Number(message.index);
  if (Number.isNaN(index)) return;
  const button = document.querySelector('.open-btn[data-index="' + index + '"]');
  if (button) button.disabled = false;
  const statusEl = document.getElementById("status-" + index);
  if (!statusEl) return;
  if (message.success) {
    setStatus(statusEl, "status ok", "✅ 已通知 Creator 打开");
  } else {
    const detail = message.error ? "详情：" + message.error : "";
    const hint = "请检查 Creator 是否已正常开启，并确认当前项目已打开且桥接插件可用。" + (detail ? " " + detail : "");
    setStatus(statusEl, "status err", "❌ 通知失败", hint);
  }
});
</script>
</body>
</html>`;
}

function escapeHtml(content: string): string {
    return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
