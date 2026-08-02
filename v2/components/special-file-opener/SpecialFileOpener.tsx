import React, { useState } from "react";
import type { SpecialFileOpenerProps } from "./interfaces/file.interfaces";
import { fileKindIcon, fileKindLabel, formatFileSize } from "./models/file.models";
import { Viewer } from "../viewer/Viewer";
import "./special-file-opener.css";

export function SpecialFileOpener({ file, onOpen, onOpenLocation, onOpenInApp, className = "" }: SpecialFileOpenerProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const open = () => { onOpen?.(file); setViewerOpen(true); };
  return <>
    <button type="button" className={`special-file-opener ${className}`} onClick={open} aria-label={`Open ${file.name}`}>
      <span className="special-file-opener-thumbnail">
        {file.thumbnailUrl && file.kind === "image" ? <img src={file.thumbnailUrl} alt="" /> : <span aria-hidden="true">{fileKindIcon(file.kind)}</span>}
      </span>
      <span className="special-file-opener-details"><strong>{file.name}</strong><small>{fileKindLabel(file.kind)}{file.size === undefined ? "" : ` · ${formatFileSize(file.size)}`}</small></span>
      <span className="special-file-opener-action" aria-hidden="true">↗</span>
    </button>
    {viewerOpen && <Viewer document={file} onClose={() => setViewerOpen(false)} onOpenLocation={(location) => onOpenLocation?.(location)} onOpenInApp={() => onOpenInApp?.(file)} />}
  </>;
}
