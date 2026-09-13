import { AppWindow, CircleX } from "lucide-react";
import { FileSystemIcon } from "./FileSystemIcon";
import "./association-program-icon.css";

export function AssociationProgramIcon({ path, exists }: { path: string; exists?: boolean }) {
  // The shared icon gateway identifies Windows local paths by backslash separators.
  const iconPath = path.replaceAll("/", "\\");
  const invalid = !!path && exists === false;
  return (
    <span className="association-program-icon" title={invalid ? "程序不存在或无法访问" : undefined}>
      {invalid ? <CircleX className="association-program-icon__invalid" size={16} role="img"
        aria-label="程序不存在或无法访问" aria-hidden={false} />
        : path && exists === true ? <FileSystemIcon key={iconPath} kind="file" path={iconPath} size={16} imageList="small" />
        : <AppWindow size={16} aria-hidden="true" />}
    </span>
  );
}
