import { useEffect, useRef, useState } from "react";
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
  onChange: (value: string | null) => void;
  onValidityChange: (key: string, valid: boolean) => void;
  onDraftDirtyChange: (key: string, dirty: boolean) => void;
  resetToken: string | number;
};

/**
 * 单个颜色通道控件：色块 + 十六进制输入 + 清除按钮 + 弹出选色器。
 * 选色器支持点击外部关闭与 Escape 关闭，且不会改动未选中规则。
 */
export function ColorRuleColorControl({
  controlKey,
  label,
  value,
  disabled,
  onChange,
  onValidityChange,
  onDraftDirtyChange,
  resetToken
}: ColorRuleColorControlProps) {
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState(value ?? "");
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
    setOpen(false);
  }, [resetToken]);
  useEffect(() => () => {
    onValidityChange(controlKey, true);
    onDraftDirtyChange(controlKey, false);
  }, [controlKey]);
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && controlRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);
  return (
    <div className="color-rule-color-control" ref={controlRef}>
      <button
        type="button"
        className="color-rule-swatch"
        aria-label={`${label}：${value ?? "未设置"}`}
        title={`选择${label}`}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span style={{ backgroundColor: value ?? "transparent" }} />
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
      {open ? (
        <div className="color-rule-picker" role="dialog" aria-label={`${label}选择器`}>
          <HexColorPicker color={pickerValue} onChange={(nextValue) => {
            setDraftValue(nextValue);
            onValidityChange(controlKey, true);
            onDraftDirtyChange(controlKey, nextValue !== (value ?? ""));
            onChange(nextValue);
          }} />
        </div>
      ) : null}
      {invalid ? (
        <span id={diagnosticId} className="color-rule-color-diagnostic" role="status">
          颜色必须使用 #RRGGBB 格式。
        </span>
      ) : null}
    </div>
  );
}
