import React from 'react';
import { FiExternalLink, FiX } from 'react-icons/fi';
import { api } from '../api/client';
import { APP_NAME, APP_VERSION_LABEL } from '../shared/appInfo';
import '../styles/AboutDialog.css';

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const DOCS_URL = 'https://github.com/FH-Prevail/TeXAbr';

const AboutDialog: React.FC<AboutDialogProps> = ({ isOpen, onClose }) => {
  const [serverVersion, setServerVersion] = React.useState<string>(APP_VERSION_LABEL);

  React.useEffect(() => {
    if (!isOpen) return;
    void api.meta()
      .then(meta => setServerVersion(meta.version))
      .catch(() => setServerVersion(APP_VERSION_LABEL));
  }, [isOpen]);

  if (!isOpen) return null;

  // Try the Electron-style shim first so this component still works inside
  // Openotex; fall back to a plain new-tab open in the TeXAbr browser build.
  const openDocs = () => {
    const electronApi = (window as { api?: { openExternal?: (url: string) => unknown } }).api;
    if (electronApi?.openExternal) {
      void electronApi.openExternal(DOCS_URL);
    } else {
      window.open(DOCS_URL, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="about-overlay" onClick={onClose}>
      <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="about-header">
          <h2>About {APP_NAME}</h2>
          <button className="about-close" onClick={onClose} title="Close">
            <FiX size={20} />
          </button>
        </div>
        <div className="about-content">
          <div className="about-logo">
            <img
              src="/logo.png"
              alt={`${APP_NAME} logo`}
              className="logo-image"
            />
          </div>
          <h3 className="about-title">{APP_NAME}</h3>
          <p className="about-version">Server version {serverVersion}</p>
          <p className="about-description">
            A self-hosted, multi-user LaTeX editor served from your Linux server.
          </p>
          <button className="check-update-button" onClick={openDocs}>
            <FiExternalLink size={14} />
            Install and upgrade docs
          </button>

          <div className="about-section">
            <h4>Features</h4>
            <ul>
              <li>Browser-based editor with the Openotex editing experience</li>
              <li>Server-side TeX Live compilation</li>
              <li>Per-user accounts and project storage</li>
              <li>Annotations, auto-save, auto-compile, and project ZIP export</li>
            </ul>
          </div>

          <div className="about-section">
            <h4>Keyboard Shortcuts</h4>
            <ul className="shortcut-list">
              <li><kbd>Ctrl</kbd>+<kbd>S</kbd> Save current file</li>
              <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> Save all files</li>
              <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> Compile LaTeX</li>
              <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> Create instant backup</li>
              <li><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> Highlight source line in PDF</li>
              <li><kbd>Ctrl</kbd>+click PDF Jump back to source</li>
            </ul>
          </div>

          <div className="about-disclaimer">
            <h4>Disclaimer</h4>
            <p>
              This application is <strong>free to use</strong> and comes with <strong>no warranty</strong>.
            </p>
          </div>

          <div className="about-footer">
            <p>&copy; 2026 TeXAbr team.</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AboutDialog;
