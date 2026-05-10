import React from 'react';
import { FiX } from 'react-icons/fi';
import '../styles/ImagePreviewDialog.css';

interface ImagePreviewDialogProps {
  isOpen: boolean;
  name: string;
  dataUrl: string;
  onClose: () => void;
}

const ImagePreviewDialog: React.FC<ImagePreviewDialogProps> = ({
  isOpen,
  name,
  dataUrl,
  onClose,
}) => {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="image-preview-overlay" onClick={onClose}>
      <div className="image-preview-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="image-preview-header">
          <h3>{name}</h3>
          <button className="image-preview-close" onClick={onClose} aria-label="Close image preview">
            <FiX size={20} />
          </button>
        </div>
        <div className="image-preview-body">
          <img src={dataUrl} alt={name} />
        </div>
      </div>
    </div>
  );
};

export default ImagePreviewDialog;
