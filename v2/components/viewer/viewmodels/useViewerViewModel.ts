import { useState } from "react";
import type { ViewerDocument } from "../interfaces/viewer.interfaces";

export function useViewerViewModel(document: ViewerDocument) {
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(0);
  const [slide, setSlide] = useState(0);
  const [selection, setSelection] = useState<string | undefined>();
  const pages = document.pages ?? [];
  const slides = document.slides ?? [];

  return {
    zoom,
    page,
    slide,
    selection,
    pageCount: pages.length,
    slideCount: slides.length,
    currentPage: pages[page],
    currentSlide: slides[slide],
    zoomIn: () => setZoom((value) => Math.min(3, Number((value + 0.25).toFixed(2)))),
    zoomOut: () => setZoom((value) => Math.max(0.5, Number((value - 0.25).toFixed(2)))),
    resetZoom: () => setZoom(1),
    nextPage: () => setPage((value) => Math.min(pages.length - 1, value + 1)),
    previousPage: () => setPage((value) => Math.max(0, value - 1)),
    selectPage: (value: number) => setPage(Math.max(0, Math.min(pages.length - 1, value))),
    nextSlide: () => setSlide((value) => Math.min(slides.length - 1, value + 1)),
    previousSlide: () => setSlide((value) => Math.max(0, value - 1)),
    setSelection,
  };
}
