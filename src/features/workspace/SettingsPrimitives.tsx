import { useId, type ReactNode } from "react";
import "./settings-primitives.css";

/** Descriptions stay available to assistive technology and the settings tooltip layer. */
export function settingsHint(description?: string) {
  return { "data-settings-description": description, "aria-description": description };
}

export function SettingsRow({ title, description, children, wide = false }: {
  title: string; description?: string; children: ReactNode; wide?: boolean;
}) {
  const labelId = useId();
  return <div className={`settings-row${wide ? " settings-row--wide" : ""}`} role="group" aria-labelledby={labelId} {...settingsHint(description)}>
    <div className="settings-row__label"><strong id={labelId}>{title}</strong></div>
    <div className="settings-row__control">{children}</div>
  </div>;
}

export function SettingsGroupHeader({ title, description }: { title: string; description?: string }) {
  return <header className="settings-group__header" {...settingsHint(description)}>
    <strong tabIndex={description ? 0 : undefined}>{title}</strong>
  </header>;
}
