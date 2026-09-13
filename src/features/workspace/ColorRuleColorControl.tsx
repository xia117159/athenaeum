import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { HexColorPicker } from "react-colorful";

function normalizeHex(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

type ColorRuleColorControlProps = {
  controlKey: string;
  label: string;
  value: string | null;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string | null) => void;
  onValidityChange: (key: string, valid: boolean) => void;
  onDraftDirtyChange: (key: string, dirty: boolean) => void;
  resetToken: string | number;
};

/**
 * 单个颜色通道控件：双层棋盘格色块触发钮 + 十六进制输入 + 清除按钮 + 弹出选色器。
 * 弹层展开状态由父级受控（同页多个颜色控件互斥展开）；
 * 弹层通过 Portal 渲染到 body 顶层、按触发钮位置 fixed 定位，
 * 避免在右栏滚动容器内撑出滚动条；支持点击外部关闭与 Escape 关闭。
 */
export function ColorRuleColorControl({
  controlKey,
  label,
  value,
  disabled,
  open,
  onOpenChange,
  onChange,
  onValidityChange,
  onDraftDirtyChange,
  resetToken
}: ColorRuleColorControlProps) {
  const [draftValue, setDraftValue] = useState(value ?? "");
  const [pickerPosition, setPickerPosition] = useState<{ top: number; left: number } | null>(null);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const pickerValue = value ?? "#ffffff";
  const invalid = draftValue.length > 0 && !normalizeHex(draftValue);
  const diagnosticId = `color-rule-color-error-${controlKey}`;
  // 草稿同步刻意收窄依赖到 [value, resetToken]：onChange/onValidityChange/onDraftDirtyChange
  // 是父级语义稳定的 setter 透传，若未来控制器改为捕获变化的闭包，需先改为经 ref 读取。
  useEffect(() => {
    setDraftValue(value ?? "");
    onValidityChange(controlKey, true);
    onDraftDirtyChange(controlKey, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, resetToken]);
  // 权威重置（重载/覆盖保存）时关闭弹出的选色器。
  useEffect(() => {
    onOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);
  useEffect(() => () => {
    onValidityChange(controlKey, true);
    onDraftDirtyChange(controlKey, false);
  }, [controlKey]);
  useEffect(() => {
    if (disabled && open) {
      onOpenChange(false);
    }
  }, [disabled, open, onOpenChange]);
  // 打开时按触发钮的视口位置计算 fixed 坐标；窗口滚动/缩放时收进视口并保持锚定。
  // 弹层宽度与 color-rules.css 中 .color-rule-picker 的 width: 230px 保持一致（共享注释约定）；
  // 高度按 230 上界估算，仅用于翻转判断，偏大只会让翻转略早发生。
  useEffect(() => {
    if (!open) {
      setPickerPosition(null);
      return undefined;
    }
    const anchor = controlRef.current?.querySelector(".color-rule-swatch");
    const updatePosition = () => {
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const panelWidth = 230;
      const panelHeight = 230;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
      const below = rect.bottom + 4;
      let top = below + panelHeight > window.innerHeight && rect.top - panelHeight - 4 >= 0
        ? rect.top - panelHeight - 4
        : below;
      // 极矮窗口下的兜底：面板永远不得越过视口底缘。
      top = Math.min(top, Math.max(8, window.innerHeight - panelHeight - 8));
      setPickerPosition({ top, left });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && controlRef.current?.contains(event.target)) {
        return;
      }
      if (event.target instanceof Node && (event.target as Element).closest?.(".color-rule-picker")) {
        return;
      }
      onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onOpenChange]);
  return (
    <div className={open ? "color-rule-color-control is-open" : "color-rule-color-control"} ref={controlRef}>
      <button
        type="button"
        className="color-rule-swatch"
        aria-label={`${label}：${value ?? "未设置"}`}
        title={`选择${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <span className="color-rule-swatch__frame" aria-hidden="true">
          <span className="color-rule-swatch__fill" style={{ backgroundColor: value ?? "transparent" }} />
        </span>
      </button>
      <input
        aria-label={`${label}十六进制值`}
        aria-describedby={invalid ? diagnosticId : undefined}
        aria-invalid={invalid}
        value={draftValue}
        placeholder="未设置"
        disabled={disabled}
        onInput={(event) => {
          const nextValue = event.currentTarget.value;
          setDraftValue(nextValue);
          onDraftDirtyChange(controlKey, nextValue !== (value ?? ""));
          const normalized = normalizeHex(nextValue);
          onValidityChange(controlKey, Boolean(normalized) || !nextValue);
          if (normalized) {
            onChange(normalized);
          } else if (!nextValue) {
            onChange(null);
          }
        }}
      />
      <button
        type="button"
        className="color-rule-icon-button"
        aria-label={`清除${label}`}
        title={`清除${label}`}
        disabled={disabled || !draftValue}
        onClick={() => {
          setDraftValue("");
          onValidityChange(controlKey, true);
          onDraftDirtyChange(controlKey, Boolean(value));
          onChange(null);
        }}
      >
        <X size={14} aria-hidden="true" />
      </button>
      {open && pickerPosition && pickerPosition.top >= 0 && pickerPosition.left >= 0
        ? createPortal(
            <div
              className="color-rule-picker color-rule-picker--anchored"
              role="dialog"
              aria-label={`${label}选择器`}
              style={{ position: "fixed", top: pickerPosition.top, left: pickerPosition.left }}
            >
              <HexColorPicker color={pickerValue} onChange={(nextValue) => {
                setDraftValue(nextValue);
                onValidityChange(controlKey, true);
                onDraftDirtyChange(controlKey, nextValue !== (value ?? ""));
                onChange(nextValue);
              }} />
              <span className="color-rule-picker__value">{value ?? "未设置"}</span>
            </div>,
            document.body
          )
        : null}
      {invalid ? (
        <span id={diagnosticId} className="color-rule-color-diagnostic" role="status">
          颜色必须使用 #RRGGBB 格式。
        </span>
      ) : null}
    </div>
  );
}
