import React from 'react';
import { FiX } from 'react-icons/fi';
import '../styles/TabBar.css';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  content?: string;
}

interface TabBarProps {
  openTabs: FileNode[];
  activeTab: FileNode | null;
  onTabClick: (file: FileNode) => void;
  onTabClose: (file: FileNode, event: React.MouseEvent) => void;
}

const TabBar: React.FC<TabBarProps> = ({ openTabs, activeTab, onTabClick, onTabClose }) => {
  if (openTabs.length === 0) {
    return null;
  }

  return (
    <div className="tab-bar">
      {openTabs.map((tab) => (
        <div
          key={tab.path}
          className={`tab ${activeTab?.path === tab.path ? 'active' : ''}`}
          onClick={() => onTabClick(tab)}
        >
          <span className="tab-name">{tab.name}</span>
          <button
            className="tab-close"
            onClick={(e) => onTabClose(tab, e)}
            title="Close"
          >
            <FiX size={14} />
          </button>
        </div>
      ))}
    </div>
  );
};

export default TabBar;
