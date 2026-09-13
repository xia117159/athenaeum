import type { SettingsModel, ShortcutBinding } from "./types";

export const DEFAULT_SHORTCUTS: SettingsModel["shortcuts"] = [
  {
    id: "focus-next-panel",
    action: "切换到下一个面板",
    scope: "workspace",
    binding: "Tab",
    description: "按顺序切换可见面板焦点。"
  },
  {
    id: "open-search",
    action: "打开搜索面板",
    scope: "workspace",
    binding: "Ctrl+F",
    description: "打开停靠式搜索面板。"
  },
  {
    id: "copy",
    action: "复制",
    scope: "listing",
    binding: "Ctrl+C",
    description: "复制当前选中项。"
  },
  {
    id: "copy-name",
    action: "复制名称",
    scope: "listing",
    binding: "Alt+Shift+N",
    description: "复制当前选中项的名称到系统剪贴板。"
  },
  {
    id: "copy-path",
    action: "复制路径",
    scope: "listing",
    binding: "Alt+Shift+P",
    description: "复制当前选中项的完整路径到系统剪贴板。"
  },
  {
    id: "paste",
    action: "粘贴",
    scope: "listing",
    binding: "Ctrl+V",
    description: "将剪贴板内容粘贴到当前目录。"
  },
  {
    id: "cut",
    action: "剪切",
    scope: "listing",
    binding: "Ctrl+X",
    description: "剪切当前选中项。"
  },
  {
    id: "drag-move",
    action: "拖放时移动",
    scope: "listing",
    binding: "Shift",
    description: "拖放文件或文件夹时执行移动而不是复制。"
  },
  {
    id: "context-menu-toggle",
    action: "右键菜单切换",
    scope: "context-menu",
    binding: "Shift",
    description: "右键时临时切换 Windows 系统菜单与软件自定义菜单。"
  },
  {
    id: "create-folder",
    action: "新建文件夹",
    scope: "listing",
    binding: "Ctrl+Shift+N",
    description: "在当前目录中新建文件夹。"
  },
  {
    id: "delete",
    action: "删除",
    scope: "listing",
    binding: "Delete",
    description: "删除当前选中项。"
  },
  {
    id: "rename",
    action: "重命名",
    scope: "listing",
    binding: "F2",
    description: "重命名当前选中项。"
  },
  {
    id: "refresh",
    action: "刷新",
    scope: "panel",
    binding: "F5",
    description: "刷新当前面板。"
  },
  {
    id: "navigate-up",
    action: "上一级",
    scope: "panel",
    binding: "Alt+Up",
    description: "打开当前文件夹的上一级。"
  },
  {
    id: "navigate-forward",
    action: "回到下一级",
    scope: "panel",
    binding: "Alt+Right",
    description: "回到历史中的下一级文件夹。"
  },
  {
    id: "new-tab",
    action: "新建标签页",
    scope: "panel",
    binding: "Ctrl+T",
    description: "在当前面板中新建标签页。"
  },
  {
    id: "close-tab",
    action: "关闭标签页",
    scope: "panel",
    binding: "Ctrl+W",
    description: "当存在多个标签页时关闭当前标签页。"
  },
  {
    id: "select-previous",
    action: "上一项",
    scope: "listing",
    binding: "Up",
    description: "在列表中单选上一项。"
  },
  {
    id: "select-next",
    action: "下一项",
    scope: "listing",
    binding: "Down",
    description: "在列表中单选下一项。"
  },
  {
    id: "select-first",
    action: "第一项",
    scope: "listing",
    binding: "Home",
    description: "单选列表第一项。"
  },
  {
    id: "select-last",
    action: "最后一项",
    scope: "listing",
    binding: "End",
    description: "单选列表最后一项。"
  },
  {
    id: "select-previous-page",
    action: "上一页",
    scope: "listing",
    binding: "PageUp",
    description: "在列表中向上翻页单选。"
  },
  {
    id: "select-next-page",
    action: "下一页",
    scope: "listing",
    binding: "PageDown",
    description: "在列表中向下翻页单选。"
  },
  {
    id: "select-previous-column",
    action: "上一列",
    scope: "listing",
    binding: "Left",
    description: "在图标/平铺/内容视图中单选左一列。"
  },
  {
    id: "select-next-column",
    action: "下一列",
    scope: "listing",
    binding: "Right",
    description: "在图标/平铺/内容视图中单选右一列。"
  },
  {
    id: "extend-previous",
    action: "扩展到上一项",
    scope: "listing",
    binding: "Shift+Up",
    description: "以当前选中项为起点，多选到上一项。"
  },
  {
    id: "extend-next",
    action: "扩展到下一项",
    scope: "listing",
    binding: "Shift+Down",
    description: "以当前选中项为起点，多选到下一项。"
  },
  {
    id: "extend-first",
    action: "扩展到第一项",
    scope: "listing",
    binding: "Shift+Home",
    description: "以当前选中项为起点，多选到列表顶。"
  },
  {
    id: "extend-last",
    action: "扩展到最后一项",
    scope: "listing",
    binding: "Shift+End",
    description: "以当前选中项为起点，多选到列表底。"
  },
  {
    id: "select-all",
    action: "全选",
    scope: "listing",
    binding: "Ctrl+A",
    description: "选中当前列表中的全部项。"
  },
  {
    id: "clear-selection",
    action: "清除选择",
    scope: "listing",
    binding: "Escape",
    description: "清除列表中的多选，恢复为无选中。"
  },
  {
    id: "open-entry",
    action: "打开",
    scope: "listing",
    binding: "Enter",
    description: "打开当前选中的文件夹或文件。"
  },
  {
    id: "open-with",
    action: "打开方式",
    scope: "listing",
    binding: "Ctrl+Alt+O",
    description: "选择当前文件匹配的自定义关联，或打开关联设置。"
  },
  {
    id: "batch-rename",
    action: "批量重命名",
    scope: "listing",
    binding: "Ctrl+M",
    description: "预览并批量重命名选中的本地项目，也适用于单个项目。"
  }
];

// Kept as a fallback until Undo has a configurable settings entry.
const undo: ShortcutBinding = { id: "undo", action: "撤销", description: "撤销最近的文件操作。", scope: "listing", binding: "Ctrl+Z" };
const byId = new Map([...DEFAULT_SHORTCUTS, undo].map(item => [item.id, item]));
const aliases: Record<string, string> = {
  "next panel": "focus-next-panel", "search drawer": "open-search", "new tab": "new-tab",
  "close tab": "close-tab", "navigate up": "navigate-up", "navigate forward": "navigate-forward",
  "drag move": "drag-move", "context menu toggle": "context-menu-toggle"
};

export function shortcutMetadata(id: string) {
  const key = id.toLowerCase();
  return byId.get(aliases[key] ?? key);
}
export function getLocalizedShortcutAction(shortcut: Pick<ShortcutBinding, "id" | "action">) {
  return (shortcutMetadata(shortcut.id) ?? shortcutMetadata(shortcut.action))?.action ?? shortcut.action;
}
export function localizeShortcutAction(action: string) { return shortcutMetadata(action)?.action ?? action; }
export function localizeShortcutDescription(action: string) { return shortcutMetadata(action)?.description ?? action; }
export const DEFAULT_SHORTCUT_BINDING_LABELS = new Map([...byId].map(([id, item]) => [id, item.binding]));
