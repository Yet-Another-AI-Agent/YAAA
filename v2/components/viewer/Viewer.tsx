import React from "react";
import type { ViewerProps } from "./interfaces/viewer.interfaces";
import { useViewerViewModel } from "./viewmodels/useViewerViewModel";
import "./viewer.css";

export function Viewer({ document, onClose, onOpenLocation, onOpenInApp }: ViewerProps) {
  const viewModel = useViewerViewModel(document);
  const isImage = document.kind === "image";
  const isPdf = document.kind === "pdf";
  const isPpt = document.kind === "ppt";
  const isWord = document.kind === "word";
  const currentPage = viewModel.currentPage?.content ?? document.content ?? "No preview available.";
  const currentSlide = viewModel.currentSlide?.content ?? "No slide preview available.";

  return <div className="v2-viewer-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="v2-viewer-panel" role="dialog" aria-modal="true" aria-label={`${document.name} viewer`}>
      <header className="v2-viewer-header"><div><strong>{document.name}</strong><small>{document.kind.toUpperCase()} preview</small></div><button type="button" aria-label="Close viewer" onClick={onClose}>×</button></header>
      <div className="v2-viewer-toolbar">
        {isImage && <><button type="button" onClick={viewModel.zoomOut} aria-label="Zoom out">−</button><span aria-label="Zoom level">{Math.round(viewModel.zoom * 100)}%</span><button type="button" onClick={viewModel.zoomIn} aria-label="Zoom in">＋</button><button type="button" onClick={viewModel.resetZoom}>Reset</button></>}
        {isPdf && <label className="v2-viewer-page-select">Page <select aria-label="PDF page" value={viewModel.page} onChange={(event) => viewModel.selectPage(Number(event.target.value))}>{(document.pages ?? [{ content: "" }]).map((item, index) => <option value={index} key={index}>{item.label ?? index + 1}</option>)}</select> of {viewModel.pageCount || 1}</label>}
        {isPpt && <><button type="button" onClick={viewModel.previousSlide} disabled={viewModel.slide === 0}>Previous slide</button><span>Slide {viewModel.slide + 1} of {viewModel.slideCount || 1}</span><button type="button" onClick={viewModel.nextSlide} disabled={viewModel.slide >= viewModel.slideCount - 1}>Next slide</button></>}
        {isWord && document.selection?.map((item) => <button type="button" className={viewModel.selection === item ? "is-selected" : ""} key={item} onClick={() => viewModel.setSelection(item)}>{item}</button>)}
        <span className="v2-viewer-toolbar-spacer" />
        {document.location && <button type="button" onClick={() => onOpenLocation?.(document.location!)}>Go to file</button>}
        {isWord && <button type="button" onClick={() => onOpenInApp?.(document)}>Open in app</button>}
      </div>
      <div className={`v2-viewer-body v2-viewer-${document.kind}`}>
        {isImage && (document.sourceUrl ? <img src={document.sourceUrl} alt={document.name} style={{ transform: `scale(${viewModel.zoom})` }} /> : <div className="v2-viewer-placeholder">Image source unavailable</div>)}
        {isPdf && <article className="v2-viewer-page"><h3>{viewModel.currentPage?.label ?? `Page ${viewModel.page + 1}`}</h3><p>{currentPage}</p></article>}
        {isPpt && <article className="v2-viewer-slide"><span>{viewModel.currentSlide?.label ?? `Slide ${viewModel.slide + 1}`}</span><p>{currentSlide}</p></article>}
        {isWord && <article className="v2-viewer-document"><p>{currentPage}</p>{viewModel.selection && <small>Selected section: {viewModel.selection}</small>}</article>}
        {!isImage && !isPdf && !isPpt && !isWord && <pre>{currentPage}</pre>}
      </div>
    </section>
  </div>;
}
