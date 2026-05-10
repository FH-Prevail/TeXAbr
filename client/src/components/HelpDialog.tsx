import React from 'react';
import { FiX, FiZoomIn, FiZoomOut, FiRefreshCw, FiDownload, FiArchive, FiPlay, FiClock, FiMap } from 'react-icons/fi';
import { APP_NAME } from '../shared/appInfo';
import '../styles/HelpDialog.css';

interface HelpDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const HelpDialog: React.FC<HelpDialogProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="help-header">
          <h2>{APP_NAME} - Quick Guide</h2>
          <button className="help-close-btn" onClick={onClose}>
            <FiX size={20} />
          </button>
        </div>

        <div className="help-content">
          <section className="help-section">
            <h3>What Each Button Does</h3>
            <div className="button-grid">
              <div className="button-item">
                <FiPlay size={18} color="#4ec9b0" />
                <div>
                  <strong>Compile</strong>
                  <p>Runs pdfLaTeX to generate PDF from your LaTeX code</p>
                </div>
              </div>
              <div className="button-item">
                <FiRefreshCw size={18} color="#d4d4d4" />
                <div>
                  <strong>Refresh</strong>
                  <p>Re-compiles the document manually</p>
                </div>
              </div>
              <div className="button-item">
                <FiZoomIn size={18} color="#d4d4d4" />
                <div>
                  <strong>Zoom In</strong>
                  <p>Makes the PDF preview larger (up to 200%)</p>
                </div>
              </div>
              <div className="button-item">
                <FiZoomOut size={18} color="#d4d4d4" />
                <div>
                  <strong>Zoom Out</strong>
                  <p>Makes the PDF preview smaller (down to 50%)</p>
                </div>
              </div>
              <div className="button-item">
                <FiDownload size={18} color="#4ec9b0" />
                <div>
                  <strong>Export PDF</strong>
                  <p>Downloads the compiled PDF file</p>
                </div>
              </div>
              <div className="button-item">
                <FiArchive size={18} color="#d4d4d4" />
                <div>
                  <strong>Save as ZIP</strong>
                  <p>Exports entire project folder as ZIP archive</p>
                </div>
              </div>
              <div className="button-item">
                <FiClock size={18} color="#d4d4d4" />
                <div>
                  <strong>Instant Backup</strong>
                  <p>Saves a timestamped copy of the current file on the server</p>
                </div>
              </div>
              <div className="button-item">
                <FiMap size={18} color="#d4d4d4" />
                <div>
                  <strong>Structure Map</strong>
                  <p>Shows a clickable outline for LaTeX documents</p>
                </div>
              </div>
            </div>
          </section>

          <section className="help-section">
            <h3>Keyboard Shortcuts</h3>
            <div className="shortcut-grid">
              <div className="shortcut-item">
                <kbd>Ctrl</kbd> + <kbd>S</kbd>
                <span>Save file (auto-save is always on)</span>
              </div>
              <div className="shortcut-item">
                <kbd>Ctrl</kbd> + <kbd>Space</kbd>
                <span>Trigger LaTeX autocomplete</span>
              </div>
              <div className="shortcut-item">
                <kbd>Ctrl</kbd> + <kbd>/</kbd>
                <span>Toggle comment</span>
              </div>
              <div className="shortcut-item">
                <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>C</kbd>
                <span>Compile the current LaTeX file</span>
              </div>
              <div className="shortcut-item">
                <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd>
                <span>Create an instant backup</span>
              </div>
              <div className="shortcut-item">
                <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>J</kbd>
                <span>Highlight the matching PDF location</span>
              </div>
              <div className="shortcut-item">
                <kbd>Ctrl</kbd> + <kbd>Click</kbd>
                <span>Jump from PDF preview to the matching source line</span>
              </div>
              <div className="shortcut-item">
                <kbd>Right-click</kbd>
                <span>Choose Highlight in PDF from the editor context menu</span>
              </div>
            </div>
          </section>

          <section className="help-section">
            <h3>Panel Resizing</h3>
            <p className="help-info">
              Hover between panels to see the resize handle (turns <span className="highlight">green</span>)
            </p>
            <p className="help-info">
              Click and drag to make any panel wider or narrower
            </p>
          </section>

          <section className="help-section">
            <h3>Auto-Compilation</h3>
            <p className="help-info">
              Your document automatically compiles <strong>3 seconds</strong> after you stop typing
            </p>
            <p className="help-info">
              You can also click the <span className="highlight">Compile</span> button to compile immediately
            </p>
          </section>

          <section className="help-section">
            <h3>File Operations</h3>
            <p className="help-info">
              <strong>Right-click</strong> in the file explorer to:
            </p>
            <ul className="help-list">
              <li>Create new files</li>
              <li>Create new folders</li>
              <li>Rename items</li>
              <li>Delete items</li>
              <li>Create instant backups</li>
            </ul>
          </section>
        </div>

        <div className="help-footer">
          <p>Use the help button in the toolbar to open this dialog.</p>
        </div>
      </div>
    </div>
  );
};

export default HelpDialog;
