import React, { useEffect, useState } from 'react';
import {
  FiCheck,
  FiPlay,
  FiRepeat,
  FiSearch,
  FiSave,
} from 'react-icons/fi';
import '../styles/MenuBar.css';

interface MenuBarProps {
  onSave: () => void | Promise<void>;
  onSaveAll: () => void | Promise<void>;
  onCompile: () => void;
  canCompile: boolean;
  onFind: () => void;
  onReplace: () => void;
  onToggleAutoCompile: () => void;
  isAutoCompileEnabled: boolean;
  themePreference: 'system' | 'dark' | 'light';
  resolvedTheme: 'dark' | 'light';
  onThemeChange: (theme: 'system' | 'dark' | 'light') => void;
  onToggleAutoSave?: () => void;
  isAutoSaveEnabled?: boolean;
  onShowAbout?: () => void;
}

const MenuBar: React.FC<MenuBarProps> = ({
  onSave,
  onSaveAll,
  onCompile,
  canCompile,
  onFind,
  onReplace,
  onToggleAutoCompile,
  isAutoCompileEnabled,
  themePreference,
  resolvedTheme,
  onThemeChange,
  onToggleAutoSave,
  isAutoSaveEnabled = false,
  onShowAbout,
}) => {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);

  useEffect(() => {
    const handleGlobalClick = () => setActiveMenu(null);
    document.addEventListener('click', handleGlobalClick);
    return () => document.removeEventListener('click', handleGlobalClick);
  }, []);

  const toggleMenu = (menuKey: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveMenu(prev => (prev === menuKey ? null : menuKey));
  };

  const execute = (action: () => void | Promise<void>) => () => {
    const result = action();
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).finally(() => setActiveMenu(null));
    } else {
      setActiveMenu(null);
    }
  };

  const renderTick = (checked: boolean) => (
    <span className="menu-icon-slot">
      {checked ? <FiCheck size={14} /> : null}
    </span>
  );

  const renderMenuLabel = (label: string, shortcut?: string) => (
    <span className="menu-label">
      <span>{label}</span>
      {shortcut && <span className="menu-shortcut">{shortcut}</span>}
    </span>
  );

  return (
    <div className="menu-bar">
      <div className={`menu-root ${activeMenu === 'file' ? 'open' : ''}`}>
        <button className="menu-root-button" onClick={toggleMenu('file')}>
          File
        </button>
        {activeMenu === 'file' && (
          <div className="menu-dropdown" onClick={event => event.stopPropagation()}>
            <button className="menu-item" onClick={execute(onSave)}>
              <span className="menu-icon-slot">
                <FiSave size={14} />
              </span>
              {renderMenuLabel('Save', 'Ctrl+S')}
            </button>
            <button className="menu-item" onClick={execute(onSaveAll)}>
              <span className="menu-icon-slot">
                <FiSave size={14} />
              </span>
              {renderMenuLabel('Save All', 'Ctrl+Shift+S')}
            </button>
            <div className="menu-separator" />
            <button className="menu-item" onClick={execute(onFind)}>
              <span className="menu-icon-slot">
                <FiSearch size={14} />
              </span>
              {renderMenuLabel('Find...', 'Ctrl+F')}
            </button>
            <button className="menu-item" onClick={execute(onReplace)}>
              <span className="menu-icon-slot">
                <FiRepeat size={14} />
              </span>
              {renderMenuLabel('Replace...', 'Ctrl+H')}
            </button>
            <div className="menu-separator" />
            <button
              className="menu-item"
              onClick={execute(onCompile)}
              disabled={!canCompile}
              title={canCompile ? undefined : 'Compile available only for LaTeX files'}
            >
              <span className="menu-icon-slot">
                <FiPlay size={14} />
              </span>
              {renderMenuLabel('Compile', 'Ctrl+Shift+C')}
            </button>
          </div>
        )}
      </div>

      <div className={`menu-root ${activeMenu === 'edit' ? 'open' : ''}`}>
        <button className="menu-root-button" onClick={toggleMenu('edit')}>
          Edit
        </button>
        {activeMenu === 'edit' && (
          <div className="menu-dropdown" onClick={event => event.stopPropagation()}>
            <button className="menu-item" onClick={execute(onFind)}>
              <span className="menu-icon-slot">
                <FiSearch size={14} />
              </span>
              {renderMenuLabel('Find...', 'Ctrl+F')}
            </button>
            <button className="menu-item" onClick={execute(onReplace)}>
              <span className="menu-icon-slot">
                <FiRepeat size={14} />
              </span>
              {renderMenuLabel('Find & Replace...', 'Ctrl+H')}
            </button>
          </div>
        )}
      </div>

      <div className={`menu-root ${activeMenu === 'view' ? 'open' : ''}`}>
        <button className="menu-root-button" onClick={toggleMenu('view')}>
          View
        </button>
        {activeMenu === 'view' && (
          <div className="menu-dropdown" onClick={event => event.stopPropagation()}>
            <button className="menu-item" onClick={execute(onToggleAutoCompile)}>
              {renderTick(isAutoCompileEnabled)}
              {renderMenuLabel('Auto Compile')}
            </button>
            {onToggleAutoSave && (
              <button className="menu-item" onClick={execute(onToggleAutoSave)}>
                {renderTick(isAutoSaveEnabled)}
                {renderMenuLabel('Auto Save (1 min)')}
              </button>
            )}
          </div>
        )}
      </div>

      <div className={`menu-root ${activeMenu === 'theme' ? 'open' : ''}`}>
        <button className="menu-root-button" onClick={toggleMenu('theme')}>
          Theme
        </button>
        {activeMenu === 'theme' && (
          <div className="menu-dropdown" onClick={event => event.stopPropagation()}>
            <button className="menu-item" onClick={execute(() => onThemeChange('system'))}>
              {renderTick(themePreference === 'system')}
              {renderMenuLabel(`System (${resolvedTheme === 'dark' ? 'Dark' : 'Light'})`)}
            </button>
            <button className="menu-item" onClick={execute(() => onThemeChange('dark'))}>
              {renderTick(themePreference === 'dark')}
              {renderMenuLabel('Dark')}
            </button>
            <button className="menu-item" onClick={execute(() => onThemeChange('light'))}>
              {renderTick(themePreference === 'light')}
              {renderMenuLabel('Light')}
            </button>
          </div>
        )}
      </div>

      <div className={`menu-root ${activeMenu === 'help' ? 'open' : ''}`}>
        <button className="menu-root-button" onClick={toggleMenu('help')}>
          Help
        </button>
        {activeMenu === 'help' && (
          <div className="menu-dropdown" onClick={event => event.stopPropagation()}>
            {onShowAbout && (
              <button className="menu-item" onClick={execute(onShowAbout)}>
                <span className="menu-icon-slot" />
                {renderMenuLabel('About TeXAbr')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MenuBar;
