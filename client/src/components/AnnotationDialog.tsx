import React, { useEffect, useMemo, useState } from 'react';
import { FiCheck, FiX, FiTrash2 } from 'react-icons/fi';
import { DEFAULT_HIGHLIGHT_COLORS } from '../types/annotations';
import '../styles/AnnotationDialog.css';

interface AnnotationDialogProps {
  isOpen: boolean;
  title: string;
  snippet?: string;
  initialColor: string;
  initialComment?: string;
  confirmLabel?: string;
  deleteLabel?: string;
  onConfirm: (result: { color: string; comment: string }) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

const normalizeSnippet = (snippet?: string) => {
  if (!snippet) return '';
  const condensed = snippet.replace(/\s+/g, ' ').trim();
  if (condensed.length <= 120) {
    return condensed;
  }
  return `${condensed.slice(0, 117)}...`;
};

const AnnotationDialog: React.FC<AnnotationDialogProps> = ({
  isOpen,
  title,
  snippet,
  initialColor,
  initialComment = '',
  confirmLabel = 'Save Highlight',
  deleteLabel = 'Delete Highlight',
  onConfirm,
  onCancel,
  onDelete,
}) => {
  const [color, setColor] = useState(initialColor);
  const [comment, setComment] = useState(initialComment);
  const normalizedSnippet = useMemo(() => normalizeSnippet(snippet), [snippet]);

  useEffect(() => {
    if (isOpen) {
      setColor(initialColor);
      setComment(initialComment);
    }
  }, [initialColor, initialComment, isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onConfirm({ color, comment });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      onConfirm({ color, comment });
    }
  };

  return (
    <div className="annotation-dialog-overlay" onClick={onCancel}>
      <div className="annotation-dialog" onClick={event => event.stopPropagation()}>
        <div className="annotation-dialog-header">
          <h3>{title}</h3>
          <button type="button" className="annotation-dialog-close" onClick={onCancel} aria-label="Close">
            <FiX size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="annotation-dialog-body">
            {normalizedSnippet && (
              <div className="annotation-snippet">
                <span className="snippet-label">Selected text</span>
                <span className="snippet-text">{normalizedSnippet}</span>
              </div>
            )}
            <div className="annotation-color-section">
              <label className="annotation-field-label">Highlight color</label>
              <div className="annotation-color-grid">
                {DEFAULT_HIGHLIGHT_COLORS.map(preset => {
                  const isSelected = preset.toLowerCase() === color.toLowerCase();
                  return (
                    <button
                      type="button"
                      key={preset}
                      className={`color-swatch ${isSelected ? 'selected' : ''}`}
                      style={{ backgroundColor: preset }}
                      onClick={() => setColor(preset)}
                      aria-label={`Use ${preset} as highlight color`}
                    >
                      {isSelected && <FiCheck size={16} />}
                    </button>
                  );
                })}
                <label className="color-picker">
                  <span className="sr-only">Custom highlight color</span>
                  <input
                    type="color"
                    value={color}
                    onChange={event => setColor(event.target.value)}
                    aria-label="Choose a custom highlight color"
                  />
                </label>
              </div>
            </div>
            <div className="annotation-comment-section">
              <label className="annotation-field-label" htmlFor="annotation-comment">
                Comment <span className="optional-label">(optional)</span>
              </label>
              <textarea
                id="annotation-comment"
                value={comment}
                onChange={event => setComment(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add notes, questions, or reminders for this highlight"
                rows={4}
              />
              <span className="dialog-hint">Press Ctrl/Cmd + Enter to save quickly.</span>
            </div>
          </div>
          <div className="annotation-dialog-footer">
            {onDelete && (
              <button type="button" className="btn-delete" onClick={onDelete}>
                <FiTrash2 size={14} />
                <span>{deleteLabel}</span>
              </button>
            )}
            <div className="footer-actions">
              <button type="button" className="btn-cancel" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="btn-confirm">
                {confirmLabel}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AnnotationDialog;
