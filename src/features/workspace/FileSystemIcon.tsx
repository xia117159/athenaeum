import { useEffect, useState } from "react";
import { resolveSystemIcon, type FileSystemIconKind, type SystemIconImageList } from "./systemIconGateway";

export function FileSystemIcon({
  kind,
  className,
  path,
  extension,
  size = 16,
  imageList
}: {
  kind: FileSystemIconKind;
  className?: string;
  path?: string;
  extension?: string;
  size?: number;
  imageList?: SystemIconImageList;
}) {
  const [iconSrc, setIconSrc] = useState<string | null>(null);
  const classes = ["entry-icon", `entry-icon--${kind}`];
  if (className) {
    classes.push(className);
  }

  useEffect(() => {
    let disposed = false;

    setIconSrc(null);

    void resolveSystemIcon({ kind, path, extension, size, imageList }).then((resolvedIcon) => {
      if (!disposed) {
        setIconSrc(resolvedIcon);
      }
    });

    return () => {
      disposed = true;
    };
  }, [extension, imageList, kind, path, size]);

  return (
    <span className={classes.join(" ")} data-kind={kind} aria-hidden="true">
      {iconSrc ? <img className="entry-icon__img" src={iconSrc} alt="" draggable={false} /> : null}
      {kind === "folder" ? (
        <svg
          className="entry-icon__svg"
          viewBox="0 0 64 56"
          focusable="false"
          preserveAspectRatio="xMidYMid meet"
          style={{ display: iconSrc ? "none" : undefined }}
        >
          <path
            d="M8 11.5A4.5 4.5 0 0 1 12.5 7h12.7c2 0 3.9.8 5.3 2.3l2.9 3.2H51a5 5 0 0 1 5 5v3.5H8v-9.5Z"
            fill="#f4bf40"
          />
          <path
            d="M6.5 18h50.8a4.2 4.2 0 0 1 4.1 5L57 43.2a5.2 5.2 0 0 1-5.1 4.1H12.1A5.2 5.2 0 0 1 7 43.2L2.4 23A4.2 4.2 0 0 1 6.5 18Z"
            fill="#ffd56a"
            stroke="#d3a431"
            strokeWidth="1.6"
          />
          <path d="M8.9 20.8h47.3l-1 4.1H7.9l1-4.1Z" fill="#fff2b3" opacity="0.78" />
          <path d="M14 29.5h21.5" stroke="#e5b84a" strokeLinecap="round" strokeWidth="2.2" />
        </svg>
      ) : null}
      {kind === "file" ? (
        <svg
          className="entry-icon__svg"
          viewBox="0 0 48 56"
          focusable="false"
          preserveAspectRatio="xMidYMid meet"
          style={{ display: iconSrc ? "none" : undefined }}
        >
          <path
            d="M11 2.8h17.9L39.5 13v38.2A3.8 3.8 0 0 1 35.7 55H11.8A3.8 3.8 0 0 1 8 51.2V6.6a3.8 3.8 0 0 1 3-3.8Z"
            fill="#ffffff"
            stroke="#bfc9d8"
            strokeWidth="1.6"
          />
          <path d="M28.9 2.8V10a4 4 0 0 0 4 4h6.6L28.9 2.8Z" fill="#e8f1ff" />
          <path d="M16 23.5h15.6" stroke="#7aa7e8" strokeLinecap="round" strokeWidth="2.2" />
          <path d="M16 30.5h15.6" stroke="#9dbceb" strokeLinecap="round" strokeWidth="2.2" />
          <path d="M16 37.5h10.4" stroke="#bfd2ef" strokeLinecap="round" strokeWidth="2.2" />
        </svg>
      ) : null}
      {kind === "drive" || kind === "remote-root" ? (
        <svg
          className="entry-icon__svg"
          viewBox="0 0 64 44"
          focusable="false"
          preserveAspectRatio="xMidYMid meet"
          style={{ display: iconSrc ? "none" : undefined }}
        >
          <rect x="6" y="10" width="52" height="24" rx="5" fill="#dfe5ee" stroke="#9ba7b4" strokeWidth="1.6" />
          <rect x="10" y="14" width="44" height="8" rx="3" fill="#f8fafc" />
          <rect x="12" y="26" width="40" height="4" rx="2" fill="#aab6c2" />
          <circle cx="47" cy="28" r="2.3" fill={kind === "remote-root" ? "#0f6cbd" : "#6bb700"} />
          <circle cx="53" cy="28" r="2.3" fill="#f4bf40" />
        </svg>
      ) : null}
    </span>
  );
}
