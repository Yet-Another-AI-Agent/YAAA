import type { FileKind } from "../enums/file.enums";

export interface SpecialFile {
  name: string;
  kind: FileKind;
  mimeType?: string;
  size?: number;
  location?: string;
  thumbnailUrl?: string;
  sourceUrl?: string;
  content?: string;
  pages?: Array<{ label?: string; content: string }>;
  slides?: Array<{ label?: string; content: string }>;
  selection?: string[];
}

export interface SpecialFileOpenerProps {
  file: SpecialFile;
  onOpen?: (file: SpecialFile) => void;
  onOpenLocation?: (location: string) => void;
  onOpenInApp?: (file: SpecialFile) => void;
  className?: string;
}
