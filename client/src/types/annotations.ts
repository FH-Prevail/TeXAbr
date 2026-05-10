export interface AnnotationRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface Annotation {
  id: string;
  range: AnnotationRange;
  color: string;
  comment?: string;
  text: string;
  createdAt: number;
}

export const DEFAULT_HIGHLIGHT_COLORS = [
  '#f8e71c', // soft yellow
  '#ff9f43', // orange
  '#4ec9b0', // teal
  '#569cd6', // blue
  '#c586c0', // purple
  '#f44747', // red
  '#7fba00', // green
];
