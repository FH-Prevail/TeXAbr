import React, { useRef, useState, forwardRef, useImperativeHandle, useEffect, useCallback } from 'react';
import MonacoEditor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import type { Awareness } from 'y-protocols/awareness';
import { Annotation, AnnotationRange } from '../types/annotations';
import '../styles/Editor.css';

// Configure Monaco to use local files instead of CDN
loader.config({ monaco });

// Core LaTeX snippets for quicker authoring
const latexSnippets = [
  {
    label: 'figure',
    detail: 'Figure environment with placeholder image',
    documentation: 'Insert a figure with centering, caption, and label.',
    insertText: [
      '\\begin{figure}[ht]',
      '\\centering',
      '\\includegraphics[width=\\linewidth]{${1:image.png}}',
      '\\caption{${2:Caption text}}',
      '\\label{fig:${3:label}}',
      '\\end{figure}',
    ].join('\\n'),
  },
  {
    label: 'table',
    detail: 'Table with tabular and caption',
    documentation: 'Insert a basic table with two columns.',
    insertText: [
      '\\begin{table}[ht]',
      '\\centering',
      '\\begin{tabular}{${1:ll}}',
      '\\toprule',
      '${2:Column A} & ${3:Column B} \\\\',
      '\\midrule',
      '${4:Value 1} & ${5:Value 2} \\\\',
      '\\bottomrule',
      '\\end{tabular}',
      '\\caption{${6:Caption text}}',
      '\\label{tab:${7:label}}',
      '\\end{table}',
    ].join('\\n'),
  },
  {
    label: 'align',
    detail: 'Aligned equations',
    documentation: 'Multi-line aligned equations with labels.',
    insertText: [
      '\\begin{align}',
      '  ${1:a} &= ${2:b} \\\\',
      '  ${3:c} &= ${4:d}',
      '\\label{eq:${5:label}}',
      '\\end{align}',
    ].join('\\n'),
  },
  {
    label: 'equation',
    detail: 'Single equation',
    documentation: 'Equation environment with label.',
    insertText: [
      '\\begin{equation}',
      '  ${1:E = mc^2}',
      '\\label{eq:${2:label}}',
      '\\end{equation}',
    ].join('\\n'),
  },
  {
    label: 'itemize',
    detail: 'Itemize list',
    documentation: 'Bulleted list with three items.',
    insertText: [
      '\\begin{itemize}',
      '  \\item ${1:First item}',
      '  \\item ${2:Second item}',
      '  \\item ${3:Third item}',
      '\\end{itemize}',
    ].join('\\n'),
  },
  {
    label: 'enumerate',
    detail: 'Enumerated list',
    documentation: 'Numbered list with three items.',
    insertText: [
      '\\begin{enumerate}',
      '  \\item ${1:First item}',
      '  \\item ${2:Second item}',
      '  \\item ${3:Third item}',
      '\\end{enumerate}',
    ].join('\\n'),
  },
  {
    label: 'theorem',
    detail: 'Theorem environment',
    documentation: 'Basic theorem statement with label.',
    insertText: [
      '\\begin{theorem}',
      '  ${1:Statement of the theorem.}',
      '\\label{thm:${2:label}}',
      '\\end{theorem}',
    ].join('\\n'),
  },
  {
    label: 'proof',
    detail: 'Proof environment',
    documentation: 'Proof with placeholder text.',
    insertText: [
      '\\begin{proof}',
      '  ${1:Proof details go here.}',
      '\\end{proof}',
    ].join('\\n'),
  },
  {
    label: 'figure*',
    detail: 'Wide figure',
    documentation: 'Full-width figure for two-column layouts.',
    insertText: [
      '\\begin{figure*}[t]',
      '\\centering',
      '\\includegraphics[width=\\textwidth]{${1:image.png}}',
      '\\caption{${2:Caption text}}',
      '\\label{fig:${3:label}}',
      '\\end{figure*}',
    ].join('\\n'),
  },
];

interface EditorProps {
  content: string;
  onChange: (content: string) => void;
  currentFile: any;
  annotations: Annotation[];
  annotationsHidden: boolean;
  onAnnotate?: () => void;
  onRemoveAnnotation?: (id: string) => void;
  onEditAnnotation?: (annotation: Annotation) => void;
  onCursorChange?: (position: { lineNumber: number; column: number }) => void;
  onSyncTexForwardSearch?: () => void;
  theme: 'dark' | 'light';
  readOnly?: boolean;
  // When set, bind Monaco to the Y.Text via MonacoBinding instead of the
  // local `content` string. `content` is then ignored as the source of truth
  // (Y.Text owns it), and `onChange` still fires on every doc update so the
  // surrounding app can keep its own snapshot up to date.
  yText?: Y.Text | null;
  yAwareness?: Awareness | null;
}

export interface EditorHandle {
  triggerFind: () => void;
  triggerReplace: () => void;
  focus: () => void;
  getSelection: () => {
    text: string;
    range: AnnotationRange;
  } | null;
  getCursorPosition: () => { lineNumber: number; column: number } | null;
  revealRange: (range: AnnotationRange) => void;
  setCursorPosition: (position: { lineNumber: number; column: number }) => void;
  jumpToLine: (lineNumber: number) => void;
  refreshAnnotations: () => void;
}

const Editor = forwardRef<EditorHandle, EditorProps>(({
  content,
  onChange,
  currentFile,
  annotations,
  annotationsHidden,
  onAnnotate,
  onRemoveAnnotation,
  onEditAnnotation,
  onCursorChange,
  onSyncTexForwardSearch,
  theme,
  readOnly = false,
  yText,
  yAwareness,
}, ref) => {
  const editorRef = useRef<any>(null);
  // State copy of the Monaco editor instance. The MonacoBinding effect
  // depends on this so it actually re-runs once Monaco finishes mounting
  // and gives us the editor — otherwise the effect runs once on first
  // render with editorRef.current === null and never fires again.
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const yBindingRef = useRef<MonacoBinding | null>(null);
  const cursorListenerRef = useRef<any>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const colorClassMapRef = useRef<Map<string, string>>(new Map());
  const annotationsRef = useRef<Annotation[]>(annotations);
  const lastContextMenuPositionRef = useRef<{ lineNumber: number; column: number } | null>(null);
  const onSyncTexForwardSearchRef = useRef(onSyncTexForwardSearch);
  // Stable ref to onChange so the MonacoBinding effect below doesn't tear
  // down and rebuild the binding on every parent re-render (the parent's
  // onChange is recreated on each render in EditorApp). Rebuilding the
  // binding repeatedly leaks Yjs observer wiring and Monaco model state —
  // tab grew from 119 MB to 1.4 GB over an idle hour before this was fixed.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  // Keep annotations ref up to date
  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  // Bind Monaco to the Y.Text when one is provided. The binding takes over
  // the model — Monaco's text becomes a view of the CRDT. Remote edits land
  // here automatically; local edits propagate over y-websocket to peers.
  // Re-runs when yText changes (e.g. user switched files) so we tear down
  // the previous binding cleanly first.
  //
  // Side mirror: keep the parent's `content` snapshot in sync via onChange
  // on every Y.Text change. The compile flow, preview, and structure map
  // still read content from the snapshot, so they need to see what Yjs
  // currently holds — including edits that came from remote peers.
  useEffect(() => {
    if (yBindingRef.current) {
      try { yBindingRef.current.destroy(); } catch { /* already gone */ }
      yBindingRef.current = null;
    }
    if (!yText || !editorInstance) return;
    const model = editorInstance.getModel?.();
    if (!model) return;
    const editors = new Set<monaco.editor.IStandaloneCodeEditor>([editorInstance]);
    yBindingRef.current = new MonacoBinding(yText, model, editors, yAwareness ?? null);

    const syncSnapshot = () => onChangeRef.current(yText.toString());
    yText.observe(syncSnapshot);
    // Push an initial snapshot too in case the doc was already populated
    // from a remote peer before the binding attached.
    syncSnapshot();

    return () => {
      try { yText.unobserve(syncSnapshot); } catch { /* doc destroyed */ }
      if (yBindingRef.current) {
        try { yBindingRef.current.destroy(); } catch { /* already gone */ }
        yBindingRef.current = null;
      }
    };
  }, [yText, yAwareness, editorInstance]);

  useEffect(() => {
    onSyncTexForwardSearchRef.current = onSyncTexForwardSearch;
  }, [onSyncTexForwardSearch]);

  // Register LaTeX snippets once
  useEffect(() => {
    const disposable = monaco.languages.registerCompletionItemProvider('latex', {
      triggerCharacters: ['\\'],
      provideCompletionItems: (model, position) => {
        const linePrefix = model.getValueInRange(new monaco.Range(
          position.lineNumber,
          1,
          position.lineNumber,
          position.column
        ));
        const match = linePrefix.match(/\\([a-zA-Z]*)$/);
        const prefix = match ? match[1].toLowerCase() : '';
        const startColumn = Math.max(1, position.column - (prefix.length + 1));

        const suggestions = latexSnippets
          .filter(snippet => !prefix || snippet.label.toLowerCase().includes(prefix))
          .map(snippet => ({
            label: snippet.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            documentation: snippet.documentation,
            detail: snippet.detail,
            insertText: snippet.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range: new monaco.Range(position.lineNumber, startColumn, position.lineNumber, position.column),
          }));

        return { suggestions };
      },
    });

    return () => disposable?.dispose();
  }, []);

  useEffect(() => {
    if (!editorRef.current) {
      return;
    }

    if (cursorListenerRef.current && typeof cursorListenerRef.current.dispose === 'function') {
      cursorListenerRef.current.dispose();
      cursorListenerRef.current = null;
    }

    if (!onCursorChange) {
      return;
    }

    const editorInstance = editorRef.current;
    const initialPosition = editorInstance.getPosition();
    if (initialPosition) {
      onCursorChange({
        lineNumber: initialPosition.lineNumber,
        column: initialPosition.column,
      });
    }

    cursorListenerRef.current = editorInstance.onDidChangeCursorPosition((event: any) => {
      onCursorChange({
        lineNumber: event.position.lineNumber,
        column: event.position.column,
      });
    });

    return () => {
      if (cursorListenerRef.current && typeof cursorListenerRef.current.dispose === 'function') {
        cursorListenerRef.current.dispose();
        cursorListenerRef.current = null;
      }
    };
  }, [onCursorChange]);

  const registerCursorListener = useCallback(() => {
    if (!editorRef.current || !onCursorChange) {
      return;
    }

    if (cursorListenerRef.current && typeof cursorListenerRef.current.dispose === 'function') {
      cursorListenerRef.current.dispose();
      cursorListenerRef.current = null;
    }

    const editorInstance = editorRef.current;
    const initialPosition = editorInstance.getPosition();
    if (initialPosition) {
      onCursorChange({
        lineNumber: initialPosition.lineNumber,
        column: initialPosition.column,
      });
    }

    cursorListenerRef.current = editorInstance.onDidChangeCursorPosition((event: any) => {
      onCursorChange({
        lineNumber: event.position.lineNumber,
        column: event.position.column,
      });
    });
  }, [onCursorChange]);

  const ensureHighlightClass = (color: string) => {
    if (colorClassMapRef.current.has(color)) {
      return colorClassMapRef.current.get(color)!;
    }

    const safeId = color.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    const className = `annotation-highlight-${safeId || 'color'}-${colorClassMapRef.current.size}`;

    const toRgba = (value: string, alpha: number) => {
      if (/^#([0-9a-fA-F]{6})$/.test(value)) {
        const r = parseInt(value.slice(1, 3), 16);
        const g = parseInt(value.slice(3, 5), 16);
        const b = parseInt(value.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
      return value;
    };

    const style = document.createElement('style');
    style.id = `style-${className}`;
    style.innerHTML = `
      .${className} {
        background-color: ${toRgba(color, 0.28)};
        border-bottom: 1px solid ${color};
        border-radius: 2px;
      }
    `;
    document.head.appendChild(style);
    colorClassMapRef.current.set(color, className);
    return className;
  };

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    setEditorInstance(editor);
    registerCursorListener();
    // Add click handler for glyph margin to remove annotations
    editor.onMouseDown((e: any) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const lineNumber = e.target.position?.lineNumber;
        if (!lineNumber) return;

        // Find annotation at this line using the ref to get latest annotations
        const annotation = annotationsRef.current.find(
          ann => ann.range.startLineNumber === lineNumber
        );
        if (annotation) {
          if (onEditAnnotation) {
            onEditAnnotation(annotation);
          } else if (onRemoveAnnotation) {
            onRemoveAnnotation(annotation.id);
          }
        }
      }
    });

    editor.onContextMenu((event: any) => {
      const position = event.target?.position || editor.getPosition();
      if (!position) return;
      lastContextMenuPositionRef.current = {
        lineNumber: position.lineNumber,
        column: position.column,
      };
    });

    // Register context menu actions
    if (onAnnotate) {
      editor.addAction({
        id: 'annotate-selection',
        label: 'Highlight Section...',
        contextMenuGroupId: 'annotation',
        contextMenuOrder: 1,
        run: () => {
          onAnnotate();
        }
      });
    }

    if (onSyncTexForwardSearch) {
      editor.addAction({
        id: 'synctex-forward-search',
        label: 'Highlight in PDF',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1,
        run: () => {
          const position = lastContextMenuPositionRef.current || editor.getPosition();
          if (position) {
            editor.setPosition(position);
            onCursorChange?.({
              lineNumber: position.lineNumber,
              column: position.column,
            });
          }
          onSyncTexForwardSearchRef.current?.();
        }
      });
    }

    // Register LaTeX language if not already registered
    const languages = monaco.languages.getLanguages();
    const latexLang = languages.find((lang: any) => lang.id === 'latex');

    if (!latexLang) {
      monaco.languages.register({ id: 'latex' });

      // Configure LaTeX syntax highlighting
      monaco.languages.setMonarchTokensProvider('latex', {
        tokenizer: {
          root: [
            [/\\[a-zA-Z@]+/, 'keyword'],
            [/\\[^a-zA-Z@]/, 'keyword'],
            [/%.*$/, 'comment'],
            [/\{/, 'delimiter.curly'],
            [/\}/, 'delimiter.curly'],
            [/\[/, 'delimiter.square'],
            [/\]/, 'delimiter.square'],
            [/\$\$/, 'string.math.display'],
            [/\$/, 'string.math.inline'],
          ],
        },
      });

      // LaTeX autocompletion
      monaco.languages.registerCompletionItemProvider('latex', {
        provideCompletionItems: () => {
          const suggestions = [
            {
              label: '\\documentclass',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: '\\documentclass{${1:article}}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Document class declaration',
            },
            {
              label: '\\usepackage',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: '\\usepackage{${1:package}}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Use a package',
            },
            {
              label: '\\begin',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: '\\begin{${1:environment}}\n\t$0\n\\\\end{${1:environment}}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Begin-end environment',
            },
            {
              label: '\\section',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: '\\section{${1:title}}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Section',
            },
            {
              label: '\\subsection',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: '\\subsection{${1:title}}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Subsection',
            },
            {
              label: '\\textbf',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: '\\textbf{${1:text}}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Bold text',
            },
            {
              label: '\\textit',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: '\\textit{${1:text}}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Italic text',
            },
            {
              label: '\\item',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: '\\item ${1:text}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'List item',
            },
          ];
          return { suggestions };
        },
      });
    }
  };

  const handleEditorChange = (value: string | undefined) => {
    if (!readOnly && value !== undefined) {
      onChange(value);
    }
  };

  useImperativeHandle(ref, () => ({
    triggerFind: () => {
      if (!editorRef.current) return;
      editorRef.current.getAction('actions.find')?.run();
    },
    triggerReplace: () => {
      if (!editorRef.current) return;
      editorRef.current.getAction('editor.action.startFindReplaceAction')?.run();
    },
    focus: () => {
      editorRef.current?.focus();
    },
    getSelection: () => {
      if (!editorRef.current) return null;
      const selection = editorRef.current.getSelection();
      const model = editorRef.current.getModel();
      if (!selection || !model) return null;
      const text = model.getValueInRange(selection);
      return {
        text,
        range: {
          startLineNumber: selection.startLineNumber,
          startColumn: selection.startColumn,
          endLineNumber: selection.endLineNumber,
          endColumn: selection.endColumn,
        },
      };
    },
    getCursorPosition: () => {
      const position = editorRef.current?.getPosition();
      if (!position) return null;
      return {
        lineNumber: position.lineNumber,
        column: position.column,
      };
    },
    revealRange: (range: AnnotationRange) => {
      if (!editorRef.current) return;
      const targetRange = new monaco.Range(
        range.startLineNumber,
        range.startColumn,
        range.endLineNumber,
        range.endColumn
      );
      editorRef.current.revealRangeInCenter(targetRange, monaco.editor.ScrollType.Smooth);
      editorRef.current.setSelection(targetRange);
      editorRef.current.focus();
    },
    setCursorPosition: (position: { lineNumber: number; column: number }) => {
      if (!editorRef.current) return;
      editorRef.current.setPosition({
        lineNumber: position.lineNumber,
        column: position.column,
      });
      editorRef.current.revealPositionInCenter(
        {
          lineNumber: position.lineNumber,
          column: position.column,
        },
        monaco.editor.ScrollType.Smooth
      );
    },
    jumpToLine: (lineNumber: number) => {
      if (!editorRef.current) return;
      editorRef.current.revealLineInCenter(lineNumber, monaco.editor.ScrollType.Smooth);
      editorRef.current.setPosition({
        lineNumber: lineNumber,
        column: 1,
      });
      editorRef.current.focus();
    },
    refreshAnnotations: () => {
      if (!editorRef.current || annotationsHidden) {
        return;
      }

      const decorations: monaco.editor.IModelDeltaDecoration[] = [];

      annotationsRef.current.forEach(annotation => {
        const className = ensureHighlightClass(annotation.color);

        const mainOptions: monaco.editor.IModelDecorationOptions = {
          inlineClassName: className,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        };

        if (annotation.comment) {
          mainOptions.hoverMessage = [
            { value: `**Comment:** ${annotation.comment.replace(/\r?\n/g, '  \n')}` },
          ];
        }

        decorations.push({
          range: new monaco.Range(
            annotation.range.startLineNumber,
            annotation.range.startColumn,
            annotation.range.endLineNumber,
            annotation.range.endColumn
          ),
          options: mainOptions,
        });

        const glyphOptions: monaco.editor.IModelDecorationOptions = {
          glyphMarginClassName: 'annotation-info-glyph',
          glyphMarginHoverMessage: annotation.comment
            ? { value: `**Comment:** ${annotation.comment.replace(/\r?\n/g, '  \n')}\n\n*Click to view or edit highlight*` }
            : { value: 'Click to view highlight options' },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        };

        decorations.push({
          range: new monaco.Range(
            annotation.range.startLineNumber,
            1,
            annotation.range.startLineNumber,
            1
          ),
          options: glyphOptions,
        });
      });

      decorationIdsRef.current = editorRef.current.deltaDecorations(
        decorationIdsRef.current,
        decorations
      );
    }
  }));

  useEffect(() => {
    if (!editorRef.current) return;

    if (annotationsHidden) {
      decorationIdsRef.current = editorRef.current.deltaDecorations(
        decorationIdsRef.current,
        []
      );
      return;
    }

    // Create a glyph class for annotation info icons if it doesn't exist
    if (!document.getElementById('annotation-glyph-style')) {
      const glyphStyle = document.createElement('style');
      glyphStyle.id = 'annotation-glyph-style';
      glyphStyle.innerHTML = `
        .annotation-info-glyph {
          cursor: pointer !important;
          background: rgba(70, 130, 255, 0.85) !important;
          color: white !important;
          border-radius: 3px;
          width: 16px !important;
          height: 16px !important;
          display: flex !important;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          font-weight: bold;
          margin-left: 2px;
        }
        .annotation-info-glyph:hover {
          background: rgba(60, 115, 230, 1) !important;
        }
        .annotation-info-glyph::before {
          content: 'i';
        }
      `;
      document.head.appendChild(glyphStyle);
    }

    if (!annotations || annotations.length === 0) {
      decorationIdsRef.current = editorRef.current.deltaDecorations(
        decorationIdsRef.current,
        []
      );
      return;
    }

    const decorations: any[] = [];

    annotations.forEach(annotation => {
      const className = ensureHighlightClass(annotation.color);

      // Main decoration for highlighting (entire range)
      const mainOptions: monaco.editor.IModelDecorationOptions = {
        inlineClassName: className,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      };

      if (annotation.comment) {
        mainOptions.hoverMessage = [
          { value: `**Comment:** ${annotation.comment.replace(/\r?\n/g, '  \n')}` },
        ];
      }

      decorations.push({
        range: new monaco.Range(
          annotation.range.startLineNumber,
          annotation.range.startColumn,
          annotation.range.endLineNumber,
          annotation.range.endColumn
        ),
        options: mainOptions,
      });

      // Glyph margin decoration (only on first line)
      const glyphOptions: monaco.editor.IModelDecorationOptions = {
        glyphMarginClassName: 'annotation-info-glyph',
        glyphMarginHoverMessage: annotation.comment
          ? { value: `**Comment:** ${annotation.comment.replace(/\r?\n/g, '  \n')}\n\n*Click to view or edit highlight*` }
          : { value: 'Click to view highlight options' },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      };

      decorations.push({
        range: new monaco.Range(
          annotation.range.startLineNumber,
          1,
          annotation.range.startLineNumber,
          1
        ),
        options: glyphOptions,
      });
    });

    decorationIdsRef.current = editorRef.current.deltaDecorations(
      decorationIdsRef.current,
      decorations
    );
  }, [annotations, annotationsHidden]);

  const getLanguage = () => {
    if (!currentFile) return 'plaintext';
    const ext = currentFile.name.split('.').pop()?.toLowerCase();
    if (ext === 'tex' || ext === 'latex') return 'latex';
    if (ext === 'bib') return 'plaintext';
    if (ext === 'md') return 'markdown';
    if (ext === 'json') return 'json';
    return 'plaintext';
  };

  return (
    <div className="editor-container">
      <div className="editor-header">
        <span className="editor-title">
          {currentFile ? currentFile.name : 'No file selected'}
        </span>
      </div>
      <div className="editor-wrapper">
        {currentFile ? (
          <MonacoEditor
            height="100%"
            language={getLanguage()}
            // When MonacoBinding owns the model, leaving `value` set would
            // fight the CRDT (every re-render of the parent would try to
            // overwrite the text). Drop it for the realtime path.
            value={yText ? undefined : content}
            onChange={handleEditorChange}
            onMount={handleEditorDidMount}
            theme={theme === 'dark' ? 'vs-dark' : 'vs-light'}
            options={{
              fontSize: 14,
              minimap: { enabled: true },
              wordWrap: 'on',
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              glyphMargin: true,
              fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, monospace',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              formatOnPaste: true,
              formatOnType: true,
              readOnly,
              domReadOnly: readOnly,
            }}
          />
        ) : (
          <div className="editor-empty">
            <p>Select a file to start editing</p>
          </div>
        )}
      </div>
    </div>
  );
});

Editor.displayName = 'Editor';

export default Editor;
