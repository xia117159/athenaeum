import { SettingsGroupHeader, SettingsRow } from "./SettingsPrimitives";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HexAlphaColorPicker } from "react-colorful";
import type { SettingsSurfaceProps } from "./SettingsSurface";
import { DEFAULT_THEME, type HoverColorKey } from "./workspaceTheme";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const HEX_BASE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function normalizeRenderableThemeColor(value: string, fallback: string) {
  const trimmed = value.trim();
  if (HEX_COLOR_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return fallback;
}

function clampOpacityPercent(value: number) {
  if (!Number.isFinite(value)) {
    return 100;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

function getThemeColorBase(value: string, fallback: string) {
  return normalizeRenderableThemeColor(value, fallback).slice(0, 7);
}

function getThemeColorOpacityPercent(value: string, fallback: string) {
  const normalized = normalizeRenderableThemeColor(value, fallback);
  if (normalized.length !== 9) {
    return 100;
  }
  return clampOpacityPercent((Number.parseInt(normalized.slice(7, 9), 16) / 255) * 100);
}

function formatThemeColor(baseColor: string, opacityPercent: number) {
  const normalizedBase = HEX_BASE_COLOR_PATTERN.test(baseColor.trim()) ? baseColor.trim().toLowerCase() : "#0f6cbd";
  const alpha = Math.round((clampOpacityPercent(opacityPercent) / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${normalizedBase}${alpha}`;
}

function ThemeColorControl({
  value,
  fallback,
  settingId,
  disabled,
  isOpen,
  onOpenChange,
  onUpdate
}: {
  value: string;
  fallback: string;
  settingId: string;
  disabled: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: (color: string) => void;
}) {
  const normalizedColor = normalizeRenderableThemeColor(value, fallback);
  const colorBase = getThemeColorBase(value, fallback);
  const opacity = getThemeColorOpacityPercent(value, fallback);
  const [hexDraft, setHexDraft] = useState(normalizedColor);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPosition, setPanelPosition] = useState<{ top: number; left: number; maxHeight: number }>();
  const panelId = `${settingId}-color-panel`;

  useLayoutEffect(() => {
    if (!isOpen) { setPanelPosition(undefined); return; }
    const control = controlRef.current;
    const panel = panelRef.current;
    const page = control?.closest<HTMLElement>(".settings-page");
    if (!control || !panel || !page) return;
    const place = () => {
      const bounds = page.getBoundingClientRect();
      if (!bounds.height) return;
      const anchor = control.getBoundingClientRect();
      const popup = panel.getBoundingClientRect();
      const maxHeight = Math.max(0, bounds.height - 8);
      const height = Math.min(popup.height, maxHeight);
      const below = anchor.bottom + 4;
      const top = below + height <= bounds.bottom - 4 ? below : Math.max(bounds.top + 4, anchor.top - height - 4);
      const left = Math.max(bounds.left + 4, Math.min(anchor.right - popup.width, bounds.right - popup.width - 4));
      setPanelPosition({ top: top - anchor.top, left: left - anchor.left, maxHeight });
    };
    place();
    page.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    return () => { page.removeEventListener("scroll", place); window.removeEventListener("resize", place); };
  }, [isOpen]);

  useEffect(() => {
    setHexDraft(normalizedColor);
  }, [normalizedColor]);

  useEffect(() => {
    if (disabled && isOpen) {
      onOpenChange(false);
    }
  }, [disabled, isOpen, onOpenChange]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && controlRef.current?.contains(target)) {
        return;
      }
      onOpenChange(false);
    };

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };

    document.addEventListener("mousedown", handleDocumentMouseDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [isOpen, onOpenChange]);

  const handlePickerChange = (color: string) => {
    if (disabled) {
      return;
    }
    onUpdate(normalizeRenderableThemeColor(color, fallback));
  };

  const handleHexInput = (nextValue: string) => {
    setHexDraft(nextValue);
    const trimmed = nextValue.trim();
    if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) {
      onUpdate(trimmed.toLowerCase());
      return;
    }
    if (HEX_BASE_COLOR_PATTERN.test(trimmed)) {
      onUpdate(formatThemeColor(trimmed, opacity));
    }
  };

  const handleHexBlur = () => {
    if (!HEX_COLOR_PATTERN.test(hexDraft.trim()) && !HEX_BASE_COLOR_PATTERN.test(hexDraft.trim())) {
      setHexDraft(normalizedColor);
    }
  };

  return (
    <div className={isOpen ? "theme-color-control is-open" : "theme-color-control"} ref={controlRef}>
      <button
        type="button"
        className="theme-color-control__trigger"
        data-setting-id={settingId}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        onClick={() => {
          if (!disabled) {
            onOpenChange(!isOpen);
          }
        }}
        disabled={disabled}
      >
        <span className="theme-color-control__swatch-frame" aria-hidden="true">
          <span className="theme-color-control__swatch" style={{ backgroundColor: normalizedColor }} />
        </span>
        <span className="theme-color-control__value">{normalizedColor}</span>
      </button>
      {isOpen ? (
        <div ref={panelRef} className="theme-color-control__panel" id={panelId} role="dialog" aria-label="Color picker" style={panelPosition}>
          <HexAlphaColorPicker
            color={normalizedColor}
            onChange={handlePickerChange}
            className="theme-color-control__picker"
          />
          <div className="theme-color-control__fields">
            <label>
              <span>HEX</span>
              <input
                type="text"
                value={hexDraft}
                data-setting-id={`${settingId}-hex`}
                spellCheck={false}
                onInput={(event) => handleHexInput(event.currentTarget.value)}
                onBlur={handleHexBlur}
              />
            </label>
            <label>
              <span>Alpha</span>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={String(opacity)}
                data-setting-id={`${settingId}-opacity`}
                onInput={(event) => onUpdate(formatThemeColor(colorBase, Number(event.currentTarget.value)))}
              />
            </label>
            <span className="theme-color-control__panel-value">{normalizedColor}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AppearancePage({
  panelFocusAccent,
  activeTabBackground,
  dropHighlightFill,
  dropHighlightBorder,
  sizeBarLow,
  sizeBarHigh,
  onUpdateSizeBarColor,
  hoverTheme,
  onUpdateHoverColor,
  tabMinWidth,
  disabled,
  onUpdatePanelFocusAccent,
  onUpdateActiveTabBackground,
  onUpdateDropHighlightFill,
  onUpdateDropHighlightBorder,
  onUpdateTabMinWidth
}: {
  panelFocusAccent: string;
  activeTabBackground: string;
  dropHighlightFill: string;
  dropHighlightBorder: string;
  sizeBarLow: string;
  sizeBarHigh: string;
  onUpdateSizeBarColor?: SettingsSurfaceProps["onUpdateSizeBarColor"];
  hoverTheme: Pick<typeof DEFAULT_THEME, HoverColorKey>;
  onUpdateHoverColor?: SettingsSurfaceProps["onUpdateHoverColor"];
  tabMinWidth: number;
  disabled: boolean;
  onUpdatePanelFocusAccent: (color: string) => void;
  onUpdateActiveTabBackground: (color: string) => void;
  onUpdateDropHighlightFill: (color: string) => void;
  onUpdateDropHighlightBorder: (color: string) => void;
  onUpdateTabMinWidth: (value: number) => void;
}) {
  const [openThemeColorId, setOpenThemeColorId] = useState<string | null>(null);
  const setThemeColorOpen = useCallback((settingId: string, open: boolean) => {
    setOpenThemeColorId(open ? settingId : null);
  }, []);

  return (
    <div className="settings-page">
      <section className="settings-group">
        <SettingsGroupHeader title="鼠标悬停" description="应用内菜单和文件列表的悬停颜色。Windows 原生菜单使用系统外观。" />
        <div className="settings-group__fields">
          {([
            { key: "menuHoverBackground", id: "menu-hover-background", label: "菜单悬停背景色" },
            { key: "menuHoverText", id: "menu-hover-text", label: "菜单悬停文字色" },
            { key: "fileHoverBorder", id: "file-hover-border", label: "文件列表悬停边框色" }
          ] as const).map(color => (
            <SettingsRow title={color.label} description={color.key === "fileHoverBorder" ? "仅显示边框，保留文件原有颜色。" : "同时用于鼠标悬停和键盘选择。"} key={color.id}>
              <ThemeColorControl value={hoverTheme[color.key]} fallback={DEFAULT_THEME[color.key]} settingId={color.id}
                disabled={disabled || !onUpdateHoverColor} isOpen={openThemeColorId === color.id}
                onOpenChange={open => setThemeColorOpen(color.id, open)} onUpdate={value => onUpdateHoverColor?.(color.key, value)} />
            </SettingsRow>
          ))}
        </div>
      </section>
      <section className="settings-group">
        <SettingsGroupHeader title="面板" description="控制当前焦点面板的强调色。" />
        <div className="settings-group__fields">
          <SettingsRow title="焦点强调色" description="用于活动面板顶部强调线。">
            <ThemeColorControl
              value={panelFocusAccent}
              fallback="#0f6cbd"
              settingId="panel-focus-accent"
              disabled={disabled}
              isOpen={openThemeColorId === "panel-focus-accent"}
              onOpenChange={(open) => setThemeColorOpen("panel-focus-accent", open)}
              onUpdate={onUpdatePanelFocusAccent}
            />
          </SettingsRow>
          <SettingsRow title="活动选项卡背景色" description="与焦点强调色配对，用于当前焦点面板的活动选项卡背景。">
            <ThemeColorControl
              value={activeTabBackground}
              fallback="#ffffff"
              settingId="active-tab-background"
              disabled={disabled}
              isOpen={openThemeColorId === "active-tab-background"}
              onOpenChange={(open) => setThemeColorOpen("active-tab-background", open)}
              onUpdate={onUpdateActiveTabBackground}
            />
          </SettingsRow>
          <SettingsRow title="拖拽填充色" description="用于列表、文件夹行和标签页的拖拽高亮底色。">
            <ThemeColorControl
              value={dropHighlightFill}
              fallback="#0f6cbd"
              settingId="drop-highlight-fill"
              disabled={disabled}
              isOpen={openThemeColorId === "drop-highlight-fill"}
              onOpenChange={(open) => setThemeColorOpen("drop-highlight-fill", open)}
              onUpdate={onUpdateDropHighlightFill}
            />
          </SettingsRow>
          <SettingsRow title="拖拽描边色" description="用于拖拽目标边框和强调线。">
            <ThemeColorControl
              value={dropHighlightBorder}
              fallback="#0f6cbd"
              settingId="drop-highlight-border"
              disabled={disabled}
              isOpen={openThemeColorId === "drop-highlight-border"}
              onOpenChange={(open) => setThemeColorOpen("drop-highlight-border", open)}
              onUpdate={onUpdateDropHighlightBorder}
            />
          </SettingsRow>
        </div>
      </section>

      <section className="settings-group">
        <SettingsGroupHeader title="大小比例" description="详细信息列表中，占比越大越接近较大占比颜色；不改变文字颜色。" />
        <div className="settings-group__fields">
          {([
            { endpoint: "sizeBarLow", id: "size-bar-low", label: "较小占比颜色", value: sizeBarLow, fallback: "#dceaf7" },
            { endpoint: "sizeBarHigh", id: "size-bar-high", label: "较大占比颜色", value: sizeBarHigh, fallback: "#3979b7" }
          ] as const).map((color) => (
            <SettingsRow title={color.label} description="支持颜色和不透明度。" key={color.id}>
              <ThemeColorControl value={color.value} fallback={color.fallback} settingId={color.id}
                disabled={disabled || !onUpdateSizeBarColor} isOpen={openThemeColorId === color.id}
                onOpenChange={(open) => setThemeColorOpen(color.id, open)} onUpdate={(value) => onUpdateSizeBarColor?.(color.endpoint, value)} />
            </SettingsRow>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <SettingsGroupHeader title="标签页" description="控制标签页最小宽度。" />
        <div className="settings-group__fields">
          <SettingsRow title="最小宽度" description="最低 1px">
            <label className="settings-control-inline">
              <input
                type="number"
                min={1}
                step={1}
                value={String(tabMinWidth)}
                data-setting-id="tab-min-width"
                aria-label="标签页最小宽度"
                onInput={(event) => onUpdateTabMinWidth(Number(event.currentTarget.value))}
                disabled={disabled}
              />
              <span>px</span>
            </label>
          </SettingsRow>
        </div>
      </section>
    </div>
  );
}
