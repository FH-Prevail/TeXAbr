import React from 'react';
import { FiCheckCircle, FiAlertCircle, FiX } from 'react-icons/fi';
import '../styles/NotificationDialog.css';

interface NotificationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  type?: 'success' | 'error' | 'info';
  onClose: () => void;
}

const NotificationDialog: React.FC<NotificationDialogProps> = ({
  isOpen,
  title,
  message,
  type = 'info',
  onClose,
}) => {
  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      onClose();
    }
  };

  const getIcon = () => {
    switch (type) {
      case 'success':
        return <FiCheckCircle className="icon-success" size={20} />;
      case 'error':
        return <FiAlertCircle className="icon-error" size={20} />;
      default:
        return <FiAlertCircle className="icon-info" size={20} />;
    }
  };

  return (
    <div className="notification-dialog-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="notification-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="notification-dialog-header">
          <div className="notification-dialog-title">
            {getIcon()}
            <h3>{title}</h3>
          </div>
          <button className="notification-dialog-close" onClick={onClose}>
            <FiX size={20} />
          </button>
        </div>
        <div className="notification-dialog-body">
          <p>{message}</p>
        </div>
        <div className="notification-dialog-footer">
          <button type="button" className="btn-ok" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
};

export default NotificationDialog;
