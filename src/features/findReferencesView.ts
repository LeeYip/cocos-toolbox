import * as path from "path";
import type { ReferenceAsset } from "./findReferencesTypes";

export function buildReferencesHtml(activeFileName: string, references: ReferenceAsset[]): string {
    const title = escapeHtml(activeFileName);
    const items = references
        .map((reference, index) => {
            const baseName = escapeHtml(path.basename(reference.filePath));
            const fullPath = escapeHtml(reference.filePath);
            return `<li class="item" data-index="${index}">
<div class="item-head">
<button class="open-btn" data-index="${index}" title="${fullPath}">${baseName}</button>
<span class="item-status" id="status-${index}"></span>
<button class="load-btn" data-index="${index}" title="展开引用节点">节点</button>
</div>
<div class="path" title="${fullPath}">${fullPath}</div>
<div class="nodes" id="nodes-${index}"></div>
<div class="status-detail" id="status-detail-${index}"></div>
</li>`;
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
.item-head { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center; }
.open-btn { min-width: 0; text-align: left; font-size: 13px; font-weight: 600; background: transparent; color: var(--vscode-textLink-foreground); border: none; cursor: pointer; padding: 0; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-status { min-width: 42px; text-align: right; font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; white-space: nowrap; opacity: 0; transition: opacity 0.12s ease; }
.item-status.pending, .item-status.ok, .item-status.err { opacity: 1; }
.item-status.pending { color: var(--vscode-descriptionForeground); }
.item-status.ok { color: var(--vscode-testing-iconPassed); }
.item-status.err { color: var(--vscode-testing-iconFailed); }
.load-btn { flex: none; font-size: 11px; background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer; padding: 2px 7px; line-height: 1.4; }
.open-btn:hover, .node-btn:hover { text-decoration: underline; }
.load-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
.open-btn:focus-visible, .load-btn:focus-visible, .node-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; border-radius: 4px; }
.open-btn:disabled, .load-btn:disabled, .node-btn:disabled { cursor: default; opacity: 0.65; text-decoration: none; }
.path { margin-top: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nodes { margin-top: 8px; }
.node-list { list-style: none; padding: 4px 0 0 10px; margin: 0; display: flex; flex-direction: column; gap: 2px; border-left: 1px solid var(--vscode-panel-border); }
.node-item { min-width: 0; }
.node-btn { width: 100%; text-align: left; font-size: 12px; background: transparent; color: var(--vscode-foreground); border: none; border-radius: 4px; cursor: pointer; padding: 3px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-btn:hover { background: var(--vscode-list-hoverBackground); }
.node-btn.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); text-decoration: none; }
.node-msg { font-size: 12px; color: var(--vscode-descriptionForeground); border-left: 1px solid var(--vscode-panel-border); padding: 5px 0 1px 10px; line-height: 1.4; }
.node-msg.err { color: var(--vscode-testing-iconFailed); }
.status-detail { display: none; margin-top: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.45; white-space: pre-wrap; }
.status-detail.err { display: block; color: var(--vscode-testing-iconFailed); }
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
const loadButtons = document.querySelectorAll(".load-btn");
const statusTimers = new Map();
const pendingTimers = new Map();
const expandedIndexes = new Set();
function escapeHtmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function setItemStatus(index, state, text, detailText, autoClear) {
  const statusEl = document.getElementById("status-" + index);
  const detailEl = document.getElementById("status-detail-" + index);
  if (statusTimers.has(index)) {
    clearTimeout(statusTimers.get(index));
    statusTimers.delete(index);
  }
  if (statusEl) {
    statusEl.className = state ? "item-status " + state : "item-status";
    statusEl.textContent = text || "";
  }
  if (detailEl) {
    detailEl.className = detailText ? "status-detail err" : "status-detail";
    detailEl.textContent = detailText || "";
  }
  if (autoClear && state !== "err") {
    statusTimers.set(index, setTimeout(() => {
      if (statusEl) {
        statusEl.className = "item-status";
        statusEl.textContent = "";
      }
      statusTimers.delete(index);
    }, 1800));
  }
}
function clearActiveNode(index) {
  document.querySelectorAll('.node-btn[data-index="' + index + '"].active').forEach((nodeButton) => {
    nodeButton.classList.remove("active");
  });
}
function setNodesExpanded(index, expanded) {
  const nodesEl = document.getElementById("nodes-" + index);
  const button = document.querySelector('.load-btn[data-index="' + index + '"]');
  if (nodesEl) {
    nodesEl.style.display = expanded ? "" : "none";
  }
  if (button) {
    button.textContent = expanded ? "收起" : "节点";
    button.title = expanded ? "收起引用节点" : "展开引用节点";
  }
  if (expanded) {
    expandedIndexes.add(index);
  } else {
    expandedIndexes.delete(index);
  }
}
function setPendingButton(button, key, timeoutText) {
  button.disabled = true;
  if (pendingTimers.has(key)) {
    clearTimeout(pendingTimers.get(key));
  }
  pendingTimers.set(key, setTimeout(() => {
    button.disabled = false;
    pendingTimers.delete(key);
    if (typeof timeoutText === "string" && timeoutText) {
      const index = Number(button.dataset.index);
      if (!Number.isNaN(index)) {
        setItemStatus(index, "err", timeoutText, "错误详情：操作等待超时，请确认 Cocos Creator 是否已完成响应。", false);
      }
    }
  }, 8000));
}
function clearPendingButton(key) {
  if (!pendingTimers.has(key)) return;
  clearTimeout(pendingTimers.get(key));
  pendingTimers.delete(key);
}
buttons.forEach((button) => {
  button.addEventListener("click", () => {
    const index = Number(button.dataset.index);
    if (Number.isNaN(index)) return;
    setPendingButton(button, "open:" + index, "打开超时");
    setItemStatus(index, "pending", "打开中...", "", false);
    clearActiveNode(index);
    vscodeApi.postMessage({ type: "openAsset", index });
  });
});
loadButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const index = Number(button.dataset.index);
    if (Number.isNaN(index)) return;
    const nodesEl = document.getElementById("nodes-" + index);
    if (expandedIndexes.has(index)) {
      setNodesExpanded(index, false);
      return;
    }
    if (nodesEl && nodesEl.innerHTML.trim()) {
      setNodesExpanded(index, true);
      return;
    }
    setPendingButton(button, "load:" + index, "解析超时");
    button.textContent = "...";
    setItemStatus(index, "pending", "解析中...", "", false);
    if (nodesEl) {
      nodesEl.style.display = "";
      nodesEl.innerHTML = '<div class="node-msg">正在解析节点...</div>';
    }
    vscodeApi.postMessage({ type: "loadNodes", index });
  });
});
function renderNodes(index, nodes, error) {
  const nodesEl = document.getElementById("nodes-" + index);
  if (!nodesEl) return;
  if (error) {
    nodesEl.innerHTML = '<div class="node-msg err">' + escapeHtmlText("节点解析失败：" + error) + '</div>';
    return;
  }
  if (!Array.isArray(nodes) || nodes.length <= 0) {
    nodesEl.innerHTML = '<div class="node-msg">未解析到可定位节点</div>';
    return;
  }
  nodesEl.innerHTML = '<ul class="node-list">' + nodes.map((node, nodeIndex) => {
    const nodePath = escapeHtmlText(node.displayPath || node.path || node.name || node.uuid);
    return '<li class="node-item"><button class="node-btn" data-index="' + index + '" data-node-index="' + nodeIndex + '" title="' + nodePath + '">' + nodePath + '</button></li>';
  }).join("") + '</ul>';
  nodesEl.querySelectorAll(".node-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const itemIndex = Number(button.dataset.index);
      const nodeIndex = Number(button.dataset.nodeIndex);
      if (Number.isNaN(itemIndex) || Number.isNaN(nodeIndex)) return;
      setPendingButton(button, "node:" + itemIndex + ":" + nodeIndex, "定位超时");
      clearActiveNode(itemIndex);
      setItemStatus(itemIndex, "pending", "定位中...", "", false);
      vscodeApi.postMessage({ type: "openNode", index: itemIndex, nodeIndex });
    });
  });
}
window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message) return;
  const index = Number(message.index);
  if (Number.isNaN(index)) return;
  if (message.type === "nodesLoading") {
    return;
  }
  if (message.type === "nodesLoaded") {
    const button = document.querySelector('.load-btn[data-index="' + index + '"]');
    clearPendingButton("load:" + index);
    if (button) {
      button.disabled = false;
    }
    renderNodes(index, message.nodes, message.error);
    setNodesExpanded(index, true);
    if (message.error) {
      setItemStatus(index, "err", "解析失败", "错误详情：" + message.error, false);
    } else {
      setItemStatus(index, "ok", "已展开", "", true);
    }
    return;
  }
  if (message.type !== "openResult") return;
  const hasNodeIndex = typeof message.nodeIndex === "number";
  const nodeIndex = Number(message.nodeIndex);
  const button = hasNodeIndex
    ? document.querySelector('.node-btn[data-index="' + index + '"][data-node-index="' + nodeIndex + '"]')
    : document.querySelector('.open-btn[data-index="' + index + '"]');
  clearPendingButton(hasNodeIndex ? "node:" + index + ":" + nodeIndex : "open:" + index);
  if (button) button.disabled = false;
  if (message.success) {
    if (hasNodeIndex && button) {
      clearActiveNode(index);
      button.classList.add("active");
      setTimeout(() => {
        button.classList.remove("active");
      }, 1800);
    }
    setItemStatus(index, "ok", hasNodeIndex ? "已定位" : "已打开", "", true);
  } else {
    const detail = message.error ? "错误详情：" + message.error : "错误详情：未知错误";
    const hint = "1. 请检查 Cocos Creator 是否已正常打开当前项目。\\n2. 若首次启用引用查找功能，会自动安装桥接插件 vscode-creator-bridge；安装完成后请重启 Cocos Creator，使桥接插件生效。\\n" + detail;
    setItemStatus(index, "err", "通知失败", hint, false);
  }
});
</script>
</body>
</html>`;
}

function escapeHtml(content: string): string {
    return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
