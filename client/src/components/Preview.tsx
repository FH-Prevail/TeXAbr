import React, { useState, useEffect, useRef, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import ReactMarkdown from 'react-markdown';
import { FiRefreshCw, FiZoomIn, FiZoomOut, FiDownload, FiAlertCircle, FiHelpCircle } from 'react-icons/fi';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// Vite resolves this `?url` import to a hashed asset URL at build time, which
// replaces Openotex's webpack-copy approach.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import NotificationDialog from './NotificationDialog';
import { api } from '../api/client';
import type { LatexDiagnostic } from '../shared/latexDiagnostics';
import '../styles/Preview.css';
import '../styles/Preview-addon.css';

(pdfjsLib as any).GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type SynctexRect = { page: number; h: number; v: number; W: number; H: number };

export interface PreviewHandle {
  forwardSearch: (line: number, column?: number) => Promise<void>;
}

interface PreviewProps {
  content: string;
  compileNonce: number;
  currentFileExtension: string | null;
  currentFilePath: string | null;
  latexEngine?: 'pdflatex' | 'xelatex' | 'lualatex';
  onMissingPackages?: (packages: string[]) => void;
  onSyncTexJump?: (target: { file: string; line: number; column: number }) => void;
  // For the "Revert to last good compile" button shown in the error panel.
  // projectId can be null when not in a server project (no recovery possible).
  // canRevert mirrors the editor/owner check from the project access role.
  projectId?: number | null;
  canRevert?: boolean;
}

const Preview = forwardRef<PreviewHandle, PreviewProps>(({
  content,
  compileNonce,
  currentFileExtension,
  currentFilePath,
  latexEngine = 'pdflatex',
  onMissingPackages,
  onSyncTexJump,
  projectId = null,
  canRevert = false,
}, ref) => {
  const [pdfData, setPdfData] = useState<string>('');
  const [pdfPath, setPdfPath] = useState<string>('');
  const [isCompiling, setIsCompiling] = useState(false);
  const [compilationStatus, setCompilationStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [compilationLog, setCompilationLog] = useState<string>('');
  const [diagnostics, setDiagnostics] = useState<LatexDiagnostic[]>([]);
  // Last successful compile's commit, fetched whenever the current compile
  // fails so the error panel can offer a 1-click revert. null = no good
  // compile recorded yet (= revert button hidden).
  const [lastGood, setLastGood] = useState<{ shortHash: string; author: string; timestamp: number; subject: string; isCurrentHead: boolean } | null>(null);
  const [reverting, setReverting] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [latexInstalled, setLatexInstalled] = useState<boolean | null>(null);
  const [latexVersion, setLatexVersion] = useState<string>('');
  const [notification, setNotification] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: 'success' | 'error' | 'info';
  }>({
    isOpen: false,
    title: '',
    message: '',
    type: 'info',
  });

  const fileExtension = useMemo(
    () => (currentFileExtension ? currentFileExtension.toLowerCase() : ''),
    [currentFileExtension]
  );

  // Pull the last-good-compile pointer whenever the current compile fails.
  // We don't fetch it on success: nothing to recover from then, and a
  // successful compile is what just refreshed the tag anyway.
  useEffect(() => {
    if (!error || !projectId || !canRevert) { setLastGood(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.projects.lastGoodCompile(projectId);
        if (!cancelled) setLastGood(r.lastGood);
      } catch {
        if (!cancelled) setLastGood(null);
      }
    })();
    return () => { cancelled = true; };
  }, [error, projectId, canRevert]);

  const handleRevertToLastGood = useCallback(async () => {
    if (!projectId || !lastGood) return;
    const ts = new Date(lastGood.timestamp).toLocaleString();
    const ok = confirm(
      `Revert the project to the last successful compile?\n\n` +
      `Target: ${lastGood.shortHash} by ${lastGood.author} (${ts})\n\n` +
      `Anything edited since then will be removed from the working tree. ` +
      `The current state is preserved as a "pre-revert" tag in git, so this is recoverable.`,
    );
    if (!ok) return;
    setReverting(true);
    try {
      const r = await api.projects.revertToLastGoodCompile(projectId);
      alert(`Reverted. Safety tag: ${r.safetyTag}\nClosing ${r.evicted.rooms} live editor sessions; reloading.`);
      window.location.reload();
    } catch (err) {
      alert(`Revert failed: ${(err as Error).message}`);
      setReverting(false);
    }
  }, [projectId, lastGood]);
  const isLatexFile = fileExtension === 'tex' || fileExtension === 'latex';
  const isMarkdownFile = fileExtension === 'md' || fileExtension === 'markdown';
  const engineSuggestion = useMemo(() => {
    if (!isLatexFile || latexEngine === 'pdflatex') return '';
    if (/\\documentclass(?:\[[^\]]*\])?\{IEEEtran\}/i.test(content)) {
      return 'IEEEtran templates are normally compiled with pdfLaTeX. Switch engines if you do not need Unicode or system fonts.';
    }
    return '';
  }, [content, isLatexFile, latexEngine]);

  const latestCompileRequestRef = useRef(0);
  const lastSuccessfulSourcePathRef = useRef<string | null>(null);

  // pdfjs state
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Scroll position to restore after re-render (pixels, saved before each render)
  const savedScrollRef = useRef(0);
  // Monotonically increasing counter; incremented on each render start so that
  // a superseded render can detect it has been cancelled.
  const renderVersionRef = useRef(0);
  // Previous zoom level, used to scale the saved scroll position proportionally.
  const prevZoomRef = useRef(zoom);
  // SyncTeX: per-page wrapper elements, indexed by pageNum (1-based).
  const pageWrappersRef = useRef<Array<HTMLDivElement | null>>([]);
  // Mirror of the current zoom so imperative handle doesn't need stale closures.
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  // Most-recent pdfPath, used inside click handlers.
  const pdfPathRef = useRef(pdfPath);
  useEffect(() => { pdfPathRef.current = pdfPath; }, [pdfPath]);
  const onSyncTexJumpRef = useRef(onSyncTexJump);
  useEffect(() => { onSyncTexJumpRef.current = onSyncTexJump; }, [onSyncTexJump]);

  useEffect(() => {
    checkLatexInstallation();
  }, []);

  useEffect(() => {
    const dispose = (window as any).api.onCompilationStatus((status: { stage: string; message: string }) => {
      setCompilationStatus(status.message);
      if (status.stage === 'font-installation' || status.stage === 'package-installation') {
        setNotification({ isOpen: true, title: 'Installing Dependencies', message: status.message, type: 'info' });
      } else if (status.stage === 'retry') {
        setNotification({ isOpen: true, title: 'Retrying Compilation', message: status.message, type: 'success' });
      }
    });
    return () => { dispose?.(); };
  }, []);

  const checkLatexInstallation = async () => {
    try {
      const result = await (window as any).api.checkLatexInstallation();
      if (result.success) {
        setLatexInstalled(result.installed);
        if (result.installed) {
          setLatexVersion(result.version);
        }
      }
    } catch (err) {
      console.error('Error checking LaTeX installation:', err);
      setLatexInstalled(false);
    }
  };

  const detectMissingPackages = (errorLog: string): string[] => {
    const packages: Set<string> = new Set();
    const pattern1 = /File `([^']+)\.sty' not found/gi;
    let match;
    while ((match = pattern1.exec(errorLog)) !== null) {
      packages.add(match[1]);
    }
    const pattern2 = /Missing \\usepackage\{([^}]+)\}/gi;
    while ((match = pattern2.exec(errorLog)) !== null) {
      packages.add(match[1]);
    }
    const pattern3 = /Package ([a-zA-Z0-9\-]+) not found/gi;
    while ((match = pattern3.exec(errorLog)) !== null) {
      packages.add(match[1]);
    }
    return Array.from(packages);
  };

  // Render all pages of `doc` at the given zoom level into containerRef.
  // Saves the current scroll position before clearing, then restores it after
  // all pages are appended so the user's reading position is preserved.
  const renderAllPages = useCallback(async (doc: PDFDocumentProxy, zoomLevel: number) => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const scrollToRestore = savedScrollRef.current;

    // Stamp this render; if it changes before we finish, we were superseded.
    const version = ++renderVersionRef.current;
    container.innerHTML = '';
    pageWrappersRef.current = [];

    const scale = zoomLevel / 100;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      if (renderVersionRef.current !== version) return;

      const page = await doc.getPage(pageNum);
      if (renderVersionRef.current !== version) {
        page.cleanup();
        return;
      }

      const viewport = page.getViewport({ scale });

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper synctex-enabled';
      wrapper.dataset.pageNum = String(pageNum);
      wrapper.style.width = `${viewport.width}px`;
      wrapper.style.height = `${viewport.height}px`;

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className = 'pdf-page-canvas';
      wrapper.appendChild(canvas);
      container.appendChild(wrapper);
      pageWrappersRef.current[pageNum] = wrapper;

      const ctx = canvas.getContext('2d');
      if (!ctx) { page.cleanup(); continue; }

      try {
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch {
        // Render was cancelled (new render started or zoom changed).
        page.cleanup();
        return;
      }
      page.cleanup();
    }

    // All pages are in the DOM — restore scroll position.
    if (renderVersionRef.current === version) {
      container.scrollTop = scrollToRestore;
    }
  }, []);

  // Load (or unload) the PDF document whenever the compiled pdfData changes.
  useEffect(() => {
    if (!pdfData) {
      pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
      renderVersionRef.current++; // cancel any ongoing render
      if (containerRef.current) containerRef.current.innerHTML = '';
      return;
    }

    // Save the current scroll position before we start re-rendering.
    if (containerRef.current) {
      savedScrollRef.current = containerRef.current.scrollTop;
    }

    const bytes = atob(pdfData);
    const data = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) data[i] = bytes.charCodeAt(i);

    const loadingTask = pdfjsLib.getDocument({ data });
    loadingTask.promise
      .then(doc => {
        pdfDocRef.current?.destroy();
        pdfDocRef.current = doc;
        renderAllPages(doc, zoom);
      })
      .catch(err => console.error('Failed to load PDF:', err));

    return () => { loadingTask.destroy().catch(() => {}); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfData, renderAllPages]);
  // Note: `zoom` is intentionally omitted — zoom changes are handled by the
  // separate effect below so we don't reload the document on every zoom.

  useEffect(() => {
    if (isLatexFile && currentFilePath && lastSuccessfulSourcePathRef.current !== currentFilePath) {
      setPdfData('');
      setPdfPath('');
      setError('');
      setCompilationLog('');
      setDiagnostics([]);
    }
  }, [currentFilePath, isLatexFile]);

  // Re-render at the new zoom level whenever the user zooms in/out.
  useEffect(() => {
    const doc = pdfDocRef.current;
    if (!doc) {
      prevZoomRef.current = zoom;
      return;
    }

    // Scale the saved scroll position proportionally so the same document
    // region stays visible after the canvas sizes change.
    if (containerRef.current) {
      const ratio = zoom / (prevZoomRef.current || zoom);
      savedScrollRef.current = containerRef.current.scrollTop * ratio;
    }
    prevZoomRef.current = zoom;

    renderAllPages(doc, zoom);
  }, [zoom, renderAllPages]);

  const compileLatex = useCallback(async () => {
    if (!isLatexFile || !currentFilePath) {
      return;
    }

    const api = (window as any).api;
    const requestId = latestCompileRequestRef.current + 1;
    latestCompileRequestRef.current = requestId;

    setIsCompiling(true);
    setError('');
    setCompilationLog('');
    setCompilationStatus('Compiling...');

    try {
      const result = await api.compileLatex(currentFilePath, latexEngine);

      if (latestCompileRequestRef.current !== requestId) {
        return;
      }

      if (result.success) {
        setPdfData(result.pdfData);
        setPdfPath(result.pdfPath || '');
        setCompilationLog([result.log, result.warnings].filter(Boolean).join('\n'));
        setDiagnostics(result.diagnostics || []);
        setError('');
        setCompilationStatus('Compilation successful');
        lastSuccessfulSourcePathRef.current = currentFilePath;
      } else {
        setError(result.error || 'Compilation failed');
        const fullLog = [result.log, result.details].filter(Boolean).join('\n');
        setCompilationLog(fullLog);
        setDiagnostics(result.diagnostics || []);
        if (lastSuccessfulSourcePathRef.current !== currentFilePath) {
          setPdfData('');
          setPdfPath('');
        }
        setCompilationStatus('');

        const missing = detectMissingPackages(fullLog);
        if (missing.length > 0 && onMissingPackages) {
          onMissingPackages(missing);
        }
      }
    } catch (err: any) {
      if (latestCompileRequestRef.current !== requestId) {
        return;
      }
      setError(`Compilation Error: ${err.message}`);
      console.error('Error compiling LaTeX:', err);
      setDiagnostics([]);
      if (lastSuccessfulSourcePathRef.current !== currentFilePath) {
        setPdfData('');
        setPdfPath('');
      }
      setCompilationStatus('');
    } finally {
      if (latestCompileRequestRef.current === requestId) {
        setIsCompiling(false);
      }
    }
  }, [isLatexFile, currentFilePath, latexEngine, onMissingPackages]);

  useEffect(() => {
    if (isLatexFile && latexInstalled && compileNonce > 0) {
      compileLatex();
    } else if (!isLatexFile) {
      latestCompileRequestRef.current += 1;
      setIsCompiling(false);
      setCompilationStatus('');
      setError('');
      setCompilationLog('');
      setDiagnostics([]);
      setPdfData('');
      setPdfPath('');
      lastSuccessfulSourcePathRef.current = null;
    }
  }, [compileNonce, latexInstalled, isLatexFile, latexEngine, compileLatex]);

  // Flash a pulsing rectangle overlay on the given pages. Auto-removed after animation.
  const flashSynctexRects = useCallback((rects: SynctexRect[]) => {
    if (!rects.length) return;
    const scale = zoomRef.current / 100;
    const createdEls: HTMLDivElement[] = [];
    let firstEl: HTMLDivElement | null = null;

    rects.forEach(rect => {
      const wrapper = pageWrappersRef.current[rect.page];
      if (!wrapper) return;
      const el = document.createElement('div');
      el.className = 'pdf-synctex-highlight';
      // Pad a little so the highlight doesn't sit flush against the text.
      const pad = 2;
      el.style.left = `${Math.max(0, rect.h * scale - pad)}px`;
      el.style.top = `${Math.max(0, rect.v * scale - rect.H * scale - pad)}px`;
      el.style.width = `${Math.max(4, rect.W * scale + pad * 2)}px`;
      el.style.height = `${Math.max(4, rect.H * scale + pad * 2)}px`;
      wrapper.appendChild(el);
      createdEls.push(el);
      if (!firstEl) firstEl = el;
    });

    if (firstEl) {
      (firstEl as HTMLDivElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    window.setTimeout(() => {
      createdEls.forEach(el => { try { el.remove(); } catch {} });
    }, 2000);
  }, []);

  // Ctrl/Cmd + click on the PDF → inverse search (jump to source).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleClick = async (ev: MouseEvent) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      const wrapper = target.closest('.pdf-page-wrapper') as HTMLDivElement | null;
      if (!wrapper) return;
      const pageNumStr = wrapper.dataset.pageNum;
      const pageNum = pageNumStr ? parseInt(pageNumStr, 10) : NaN;
      if (!Number.isFinite(pageNum) || pageNum <= 0) return;
      const currentPdfPath = pdfPathRef.current;
      if (!currentPdfPath) return;

      ev.preventDefault();
      ev.stopPropagation();

      const canvas = wrapper.querySelector('canvas') as HTMLCanvasElement | null;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scale = zoomRef.current / 100;
      const h = (ev.clientX - rect.left) / scale;
      const v = (ev.clientY - rect.top) / scale;

      try {
        const api = (window as any).api;
        const result = await api.synctex.inverse(currentPdfPath, pageNum, h, v);
        if (result?.success && result.file && result.line) {
          onSyncTexJumpRef.current?.({
            file: result.file,
            line: result.line,
            column: result.column || 1,
          });
        } else if (result?.error) {
          console.warn('SyncTeX inverse search failed:', result.error);
        }
      } catch (err) {
        console.error('SyncTeX inverse search error:', err);
      }
    };

    container.addEventListener('click', handleClick);
    return () => container.removeEventListener('click', handleClick);
  }, [pdfData]);

  useImperativeHandle(ref, () => ({
    forwardSearch: async (line: number, column?: number) => {
      if (!currentFilePath) return;
      try {
        const api = (window as any).api;
        const result = await api.synctex.forward(currentFilePath, line, column ?? 1, pdfPathRef.current || undefined);
        if (result?.success && result.rects && result.rects.length > 0) {
          flashSynctexRects(result.rects);
        } else if (result?.error) {
          setNotification({
            isOpen: true,
            title: 'SyncTeX Forward Search',
            message: result.error,
            type: 'info',
          });
        }
      } catch (err: any) {
        console.error('SyncTeX forward search error:', err);
        setNotification({
          isOpen: true,
          title: 'SyncTeX Forward Search',
          message: err?.message || 'Forward search failed.',
          type: 'error',
        });
      }
    },
  }), [currentFilePath, flashSynctexRects]);

  const handleZoomIn = () => {
    setZoom(prev => Math.min(prev + 10, 200));
  };

  const handleZoomOut = () => {
    setZoom(prev => Math.max(prev - 10, 50));
  };

  const handleRefresh = () => {
    if (latexInstalled && isLatexFile) {
      compileLatex();
    }
  };

  const handleExportPDF = async () => {
    if (!pdfData) {
      setNotification({
        isOpen: true,
        title: 'No PDF Available',
        message: 'Please compile your LaTeX document first before exporting.',
        type: 'info',
      });
      return;
    }

    try {
      const binary = atob(pdfData);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        array[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([array], { type: 'application/pdf' });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'document.pdf';
      a.click();
      URL.revokeObjectURL(url);

      setNotification({
        isOpen: true,
        title: 'Export Successful',
        message: 'PDF exported successfully!',
        type: 'success',
      });
    } catch (exportError) {
      console.error('PDF export error:', exportError);
      setNotification({
        isOpen: true,
        title: 'Export Failed',
        message: 'Failed to export PDF. Please try again.',
        type: 'error',
      });
    }
  };

  const handleDiagnosticClick = (diagnostic: LatexDiagnostic) => {
    if (!diagnostic.line) return;
    const file = diagnostic.file || currentFilePath;
    if (!file) return;
    onSyncTexJumpRef.current?.({
      file,
      line: diagnostic.line,
      column: diagnostic.column || 1,
    });
  };

  if (isMarkdownFile) {
    return (
      <div className="preview markdown-preview">
        <div className="markdown-header">
          <span>Markdown Preview</span>
        </div>
        <div className="markdown-body">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      </div>
    );
  }

  if (!isLatexFile) {
    return (
      <div className="preview placeholder-preview">
        <div className="placeholder-message">
          <FiAlertCircle size={20} />
          <span>Select a LaTeX or Markdown file to see a preview.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="preview">
      <div className="preview-header">
        <div className="preview-status">
          <span className="preview-title">
            Preview {latexVersion ? `(${latexVersion})` : ''}
          </span>
          {isCompiling && (
            <span className="preview-status-indicator">
              {compilationStatus || 'Compiling…'}
            </span>
          )}
        </div>
        <div className="preview-controls">
          <button type="button" title="Refresh" onClick={handleRefresh} disabled={isCompiling}>
            <FiRefreshCw size={16} />
          </button>
          <button type="button" title="Zoom In" onClick={handleZoomIn}>
            <FiZoomIn size={16} />
          </button>
          <button type="button" title="Zoom Out" onClick={handleZoomOut}>
            <FiZoomOut size={16} />
          </button>
          <span className="preview-zoom">{zoom}%</span>
          <button
            type="button"
            title={'SyncTeX shortcuts:\n  • Ctrl+Click in PDF -> jump to source\n  • Ctrl+Alt+J in editor -> jump to PDF'}
            onClick={() => setNotification({
              isOpen: true,
              title: 'SyncTeX Shortcuts',
              message:
                'Ctrl+Click on the PDF to jump to the matching source line.\n\n' +
                'Place the cursor in the editor and press Ctrl+Alt+J to jump to the matching location in the PDF.',
              type: 'info',
            })}
          >
            <FiHelpCircle size={16} />
          </button>
          <button type="button" title="Export PDF" onClick={handleExportPDF}>
            <FiDownload size={16} />
          </button>
        </div>
      </div>
      {engineSuggestion && (
        <div className="preview-engine-warning">
          <FiAlertCircle size={14} />
          <span>{engineSuggestion}</span>
        </div>
      )}
      <div className="preview-body">
        {pdfData ? (
          <div ref={containerRef} className="pdf-canvas-container" />
        ) : (
          <div className="preview-empty">
            <p>No PDF compiled yet.</p>
          </div>
        )}
      </div>
      {error && (
        <div className="preview-error">
          <h4>Compilation Error</h4>
          {lastGood && !lastGood.isCurrentHead && (
            <div className="preview-last-good">
              <div className="preview-last-good-text">
                <strong>Last successful compile:</strong>{' '}
                <span className="mono">{lastGood.shortHash}</span> by {lastGood.author}
                {' · '}
                {new Date(lastGood.timestamp).toLocaleString()}
              </div>
              <button
                type="button"
                className="preview-last-good-btn"
                onClick={handleRevertToLastGood}
                disabled={reverting}
                title="Reset every file to its state at the last successful compile. Recoverable via a safety tag in git."
              >
                {reverting ? 'Reverting…' : 'Revert to last good compile'}
              </button>
            </div>
          )}
          <pre>{error}</pre>
          {diagnostics.length > 0 && (
            <div className="preview-diagnostics">
              {diagnostics.map((diagnostic, index) => {
                const canJump = Boolean(diagnostic.line);
                const location = diagnostic.line ? `${diagnostic.file ? diagnostic.file.split(/[\\/]/).pop() : 'Source'}:${diagnostic.line}` : '';
                return (
                  <button
                    type="button"
                    key={`${diagnostic.severity}-${diagnostic.line || index}-${diagnostic.message}`}
                    className={`preview-diagnostic preview-diagnostic-${diagnostic.severity}`}
                    onClick={() => handleDiagnosticClick(diagnostic)}
                    disabled={!canJump}
                    title={canJump ? 'Jump to source line' : undefined}
                  >
                    <span className="preview-diagnostic-severity">{diagnostic.severity}</span>
                    {location && <span className="preview-diagnostic-location">{location}</span>}
                    <span className="preview-diagnostic-message">{diagnostic.message}</span>
                  </button>
                );
              })}
            </div>
          )}
          <details>
            <summary>View Full Log</summary>
            <pre>{compilationLog}</pre>
          </details>
        </div>
      )}
      <NotificationDialog
        isOpen={notification.isOpen}
        title={notification.title}
        message={notification.message}
        type={notification.type}
        onClose={() => setNotification(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
});

Preview.displayName = 'Preview';

export default Preview;
