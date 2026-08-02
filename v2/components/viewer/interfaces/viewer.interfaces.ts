import type { FileKind } from "../../special-file-opener/enums/file.enums";

export interface ViewerPage {
  label?: string;
  content: string;
}

export interface ViewerSlide {
  label?: string;
  content: string;
}

export interface ViewerDocument {
  name: string;
  kind: FileKind;
  location?: string;
  sourceUrl?: string;
  content?: string;
  pages?: ViewerPage[];
  slides?: ViewerSlide[];
  selection?: string[];
}

export interface ViewerProps {
  document: ViewerDocument;
  onClose: () => void;
  onOpenLocation?: (location: string) => void;
  onOpenInApp?: (document: ViewerDocument) => void;
}
