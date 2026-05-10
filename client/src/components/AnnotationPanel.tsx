import React from 'react';
import { FiTrash2, FiEye, FiInfo, FiChevronDown } from 'react-icons/fi';
import { Annotation, DEFAULT_HIGHLIGHT_COLORS } from '../types/annotations';
import '../styles/AnnotationPanel.css';

interface AnnotationPanelProps {
  selectedColor: string;
  onColorChange: (color: string) => void;
  onAddHighlight: () => void;
  annotations: Annotation[];
  onRemoveAnnotation: (id: string) => void;
  onEditAnnotation: (annotation: Annotation) => void;
  onFocusAnnotation: (annotation: Annotation) => void;
  canAnnotate: boolean;
  annotationsHidden: boolean;
  onToggleVisibility: () => void;
  onRequestHide?: () => void;
}

const formatSnippet = (text: string) => {
  const condensed = text.replace(/\s+/g, ' ').trim();
  if (condensed.length <= 80) return condensed;
  return `${condensed.slice(0, 77)}...`;
};

const AnnotationPanel: React.FC<AnnotationPanelProps> = ({
  selectedColor,
  onColorChange,
  onAddHighlight,
  annotations,
  onRemoveAnnotation,
  onEditAnnotation,
  onFocusAnnotation,
  canAnnotate,
  annotationsHidden,
  onToggleVisibility,
  onRequestHide,
}) => {
  const hasAnnotations = annotations.length > 0;

  return (
    <div className="annotation-panel">
      <div className="annotation-panel-header">
        <h4>Annotations</h4>
        {onRequestHide && (
          <button
            type="button"
            className="annotation-panel-toggle"
            onClick={onRequestHide}
            title="Hide annotations panel"
            aria-label="Hide annotations panel"
          >
            <FiChevronDown size={16} />
          </button>
        )}
      </div>
      <div className="annotation-panel-controls">
        <label className="color-picker-label">
          <span>Highlight Color</span>
          <div className="color-preset-row" role="list">
            {DEFAULT_HIGHLIGHT_COLORS.map(color => {
              const isActive = color.toLowerCase() === selectedColor.toLowerCase();
              return (
                <button
                  key={color}
                  type="button"
                  role="listitem"
                  className={`color-preset ${isActive ? 'active' : ''}`}
                  style={{ backgroundColor: color }}
                  onClick={() => onColorChange(color)}
                  aria-label={`Switch to ${color} highlight`}
                />
              );
            })}
          </div>
          <input
            type="color"
            value={selectedColor}
            onChange={event => onColorChange(event.target.value)}
            aria-label="Highlight color"
          />
        </label>
        <div className="annotation-buttons">
          <button
            type="button"
            onClick={onAddHighlight}
            className="annotation-btn primary"
            disabled={!canAnnotate}
          >
            Highlight Section...
          </button>
          <button
            type="button"
            onClick={onToggleVisibility}
            className="annotation-btn"
            disabled={!hasAnnotations}
          >
            {annotationsHidden ? 'Show Highlights' : 'Hide Highlights'}
          </button>
        </div>
      </div>
      <div className="annotation-list">
        {annotationsHidden && hasAnnotations && (
          <div className="annotation-visibility-note">
            Highlights are currently hidden in the editor.
          </div>
        )}
        {hasAnnotations ? (
          annotations
            .slice()
            .sort((a, b) => a.createdAt - b.createdAt)
            .map(annotation => {
              const hasComment = Boolean(annotation.comment && annotation.comment.trim().length > 0);
              return (
                <div className="annotation-item" key={annotation.id}>
                  <div className="annotation-item-header">
                    <div className="annotation-color" style={{ backgroundColor: annotation.color }} />
                    <div className="annotation-snippet">
                      <span className="annotation-text">{formatSnippet(annotation.text)}</span>
                      <span className="annotation-range">
                        L{annotation.range.startLineNumber}:{annotation.range.startColumn}
                        {' -> '}
                        L{annotation.range.endLineNumber}:{annotation.range.endColumn}
                      </span>
                      <span
                        className={`annotation-comment-preview ${hasComment ? 'with-comment' : 'muted'}`}
                      >
                        {hasComment ? annotation.comment : 'No comment added'}
                      </span>
                    </div>
                  </div>
                  <div className="annotation-actions">
                    <button
                      type="button"
                      className="annotation-icon-btn"
                      onClick={() => onFocusAnnotation(annotation)}
                      title="Reveal in editor"
                      aria-label="Reveal in editor"
                    >
                      <FiEye size={14} />
                    </button>
                    <button
                      type="button"
                      className="annotation-icon-btn"
                      onClick={() => onEditAnnotation(annotation)}
                      title="View or edit highlight"
                      aria-label="View or edit highlight"
                    >
                      <FiInfo size={14} />
                    </button>
                    <button
                      type="button"
                      className="annotation-icon-btn"
                      onClick={() => onRemoveAnnotation(annotation.id)}
                      title="Remove highlight"
                      aria-label="Remove highlight"
                    >
                      <FiTrash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })
        ) : (
          <div className="annotation-empty">
            <p>No highlights yet</p>
            <p className="hint">Select text in the editor to highlight and annotate</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AnnotationPanel;
