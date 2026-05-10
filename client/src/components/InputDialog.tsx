import React, { useState, useEffect, useRef } from 'react';
import { FiX } from 'react-icons/fi';
import '../styles/InputDialog.css';

interface InputDialogProps {
  isOpen: boolean;
  title: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  description?: React.ReactNode;
  multiline?: boolean;
  rows?: number;
  confirmLabel?: string;
  allowEmpty?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

const InputDialog: React.FC<InputDialogProps> = ({
  isOpen,
  title,
  label,
  placeholder,
  defaultValue = '',
  description,
  multiline = false,
  rows = 4,
  confirmLabel = 'OK',
  allowEmpty = false,
  onConfirm,
  onCancel,
}) => {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, defaultValue]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!allowEmpty && !trimmed) {
      return;
    }
    const finalValue = multiline ? value : trimmed;
    onConfirm(finalValue);
    setValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      onCancel();
      return;
    }
    if (multiline && (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <div className="input-dialog-overlay" onClick={onCancel}>
      <div className="input-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="input-dialog-header">
          <h3>{title}</h3>
          <button className="input-dialog-close" onClick={onCancel}>
            <FiX size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="input-dialog-body">
            <label>{label}</label>
            {description ? <div className="input-dialog-description">{description}</div> : null}
            {multiline ? (
              <textarea
                ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={placeholder}
                rows={rows}
                onKeyDown={handleKeyDown}
              />
            ) : (
              <input
                ref={inputRef as React.RefObject<HTMLInputElement>}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={placeholder}
                onKeyDown={handleKeyDown}
              />
            )}
          </div>
          <div className="input-dialog-footer">
            <button type="button" className="btn-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-confirm"
              disabled={!allowEmpty && !value.trim()}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default InputDialog;
