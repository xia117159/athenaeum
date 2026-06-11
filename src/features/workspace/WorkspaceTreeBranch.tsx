import { type CSSProperties } from "react";
import { Minus, Plus } from "lucide-react";
import { FileSystemIcon } from "./FileSystemIcon";
import type { DirectoryNode } from "./types";

function isPathWithinScope(path: string, scopePath: string) {
  if (path === scopePath) {
    return true;
  }

  if (scopePath.startsWith("sftp://") || scopePath.startsWith("ftp://")) {
    return path.startsWith(scopePath.endsWith("/") ? scopePath : `${scopePath}/`);
  }

  return path.startsWith(scopePath.endsWith("\\") ? scopePath : `${scopePath}\\`);
}

export function WorkspaceTreeBranch({
  node,
  depth,
  activePath,
  expandedNodePaths,
  onToggle,
  onNavigate
}: {
  node: DirectoryNode;
  depth: number;
  activePath: string;
  expandedNodePaths: string[];
  onToggle: (path: string) => void;
  onNavigate: (node: DirectoryNode) => void;
}) {
  const isExpanded = expandedNodePaths.includes(node.path);
  const isActive = isPathWithinScope(activePath, node.path);
  const branchStyle = { "--tree-depth": String(depth) } as CSSProperties;

  return (
    <div className="tree-node" style={branchStyle}>
      <div className={`tree-node__row${isActive ? " is-active" : ""}`}>
        <button
          type="button"
          className={`tree-node__toggle${isExpanded ? " is-expanded" : " is-collapsed"}`}
          aria-label={isExpanded ? `collapse ${node.label}` : `expand ${node.label}`}
          aria-expanded={node.expandable ? isExpanded : undefined}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle(node.path);
          }}
          disabled={!node.expandable}
        >
          {node.expandable ? (
            isExpanded ? (
              <Minus className="tree-node__toggle-icon" size={10} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Plus className="tree-node__toggle-icon" size={10} strokeWidth={2} aria-hidden="true" />
            )
          ) : null}
        </button>
        <button
          type="button"
          className="tree-node__label"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onNavigate(node);
          }}
        >
          <FileSystemIcon kind={node.kind} path={node.path} className="tree-node__icon" size={18} imageList="sys-small" />
          <span>{node.label}</span>
        </button>
      </div>
      {isExpanded && node.children.length > 0 ? (
        <div className="tree-node__children">
          {node.children.map((childNode) => (
            <WorkspaceTreeBranch
              key={childNode.id}
              node={childNode}
              depth={depth + 1}
              activePath={activePath}
              expandedNodePaths={expandedNodePaths}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
