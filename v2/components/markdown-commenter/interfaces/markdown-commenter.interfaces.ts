export interface MarkdownLineComment {
  line: number;
  quote: string;
  comment: string;
}

export interface MarkdownCommenterProps {
  content: string;
  title?: string;
  initialComments?: MarkdownLineComment[];
  onCommentsChange?: (comments: MarkdownLineComment[]) => void;
}
