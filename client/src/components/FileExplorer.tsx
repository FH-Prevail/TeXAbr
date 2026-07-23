import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FiFile,
  FiFolder,
  FiChevronRight,
  FiChevronDown,
  FiPlus,
  FiTrash2,
  FiEdit2,
  FiFolderPlus,
  FiArchive,
  FiClock,
  FiUpload,
  FiUploadCloud,
  FiDownload,
} from 'react-icons/fi';
import InputDialog from './InputDialog';
import ConfirmDialog from './ConfirmDialog';
import ImagePreviewDialog from './ImagePreviewDialog';
import '../styles/FileExplorer.css';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  expanded?: boolean;
}

interface FileExplorerProps {
  onFileSelect: (file: FileNode) => void;
  projectPath: string;
  onZipFolder: (folderPath: string) => void;
  onVersionFreeze: (file: FileNode) => void;
  refreshTrigger?: number;
  readOnly?: boolean;
}

const FileExplorer: React.FC<FileExplorerProps> = ({ onFileSelect, projectPath, onZipFolder, onVersionFreeze, refreshTrigger, readOnly = false }) => {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    target: FileNode | null;
    directoryPath: string;
    parentPath: string;
  } | null>(null);
  const [inputDialog, setInputDialog] = useState<{
    isOpen: boolean;
    title: string;
    label: string;
    placeholder: string;
    defaultValue: string;
    onConfirm: (value: string) => void;
  }>({
    isOpen: false,
    title: '',
    label: '',
    placeholder: '',
    defaultValue: '',
    onConfirm: () => {},
  });
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });
  const [imagePreview, setImagePreview] = useState<{
    isOpen: boolean;
    name: string;
    dataUrl: string;
  }>({
    isOpen: false,
    name: '',
    dataUrl: '',
  });
  const [dragDestination, setDragDestination] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // "Show build files" checkbox state. Default false = build artifacts hidden.
  // Persisted to localStorage so the user's preference survives reloads.
  const [showBuildFiles, setShowBuildFiles] = useState<boolean>(() => {
    try { return localStorage.getItem('texabr.showBuildFiles') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('texabr.showBuildFiles', showBuildFiles ? '1' : '0'); } catch { /* private mode */ }
  }, [showBuildFiles]);
  const reloadTimeoutRef = useRef<number | null>(null);
  // Two hidden inputs so the toolbar buttons can trigger a file-picker (any
  // number of files) and a directory-picker (preserves the folder structure
  // via `webkitRelativePath`).
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  // Destination for the next picker open. Set right before .click() so the
  // change handler knows where to drop the files (project root by default,
  // or a specific folder when launched from the context menu).
  const pickerDestinationRef = useRef<string | null>(null);

  const loadDirectory = useCallback(async (dirPath: string, parentNode?: FileNode) => {
    const result = await (window as any).api.readDirectory(dirPath);

    if (result.success) {
      const fileNodes: FileNode[] = result.files
        .filter((file: any) => {
          // Filter out metadata files and local sidecar backup/session folders.
          if (file.name.endsWith('.metadata')) return false;
          if (file.name === '.openotex-session.yml') return false;
          if (file.name.startsWith('.openotex-')) return false;
          if (file.name.endsWith('_backups_') || file.name.endsWith('_timeline_')) return false;
          return true;
        })
        .sort((a: any, b: any) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        })
        .map((file: any) => ({
          name: file.name,
          path: file.path,
          isDirectory: file.isDirectory,
          children: file.isDirectory ? [] : undefined,
          expanded: false
        }));

      if (parentNode) {
        setFiles(prevFiles => updateNodeChildren(prevFiles, parentNode.path, fileNodes));
      } else {
        setFiles(fileNodes);
      }
    }
  }, []);

  useEffect(() => {
    if (projectPath) {
      loadDirectory(projectPath);
    }
  }, [projectPath, loadDirectory]);

  // Refresh when refreshTrigger changes (e.g., after version freeze)
  useEffect(() => {
    if (projectPath && refreshTrigger && refreshTrigger > 0) {
      loadDirectory(projectPath);
    }
  }, [refreshTrigger, projectPath, loadDirectory]);

  useEffect(() => {
    const api = (window as any).api;
    if (!projectPath || !api?.onFilesystemEvent) {
      return;
    }

    const dispose = api.onFilesystemEvent((payload: { root?: string; path?: string }) => {
      if (!payload || payload.root !== projectPath) {
        return;
      }

      if (reloadTimeoutRef.current) {
        return;
      }
      reloadTimeoutRef.current = window.setTimeout(() => {
        reloadTimeoutRef.current = null;
        loadDirectory(projectPath);
      }, 200);
    });

    return () => {
      if (reloadTimeoutRef.current) {
        window.clearTimeout(reloadTimeoutRef.current);
        reloadTimeoutRef.current = null;
      }
      dispose?.();
    };
  }, [projectPath, loadDirectory]);

  const updateNodeChildren = (
    nodes: FileNode[],
    targetPath: string,
    children: FileNode[]
  ): FileNode[] => {
    return nodes.map(node => {
      if (node.path === targetPath) {
        return { ...node, children, expanded: true };
      }
      if (node.children) {
        return { ...node, children: updateNodeChildren(node.children, targetPath, children) };
      }
      return node;
    });
  };

  const handleFileClick = (file: FileNode) => {
    setSelectedFile(file);
    if (!file.isDirectory && !isImageFile(file.name)) {
      onFileSelect(file);
    } else if (file.children && file.children.length === 0) {
      loadDirectory(file.path, file);
    } else {
      toggleExpand(file);
    }
  };

  const toggleExpand = (file: FileNode) => {
    setFiles(prevFiles => toggleNodeExpansion(prevFiles, file.path));
  };

  const toggleNodeExpansion = (nodes: FileNode[], targetPath: string): FileNode[] => {
    return nodes.map(node => {
      if (node.path === targetPath) {
        return { ...node, expanded: !node.expanded };
      }
      if (node.children) {
        return { ...node, children: toggleNodeExpansion(node.children, targetPath) };
      }
      return node;
    });
  };

  const findNodeByPath = (nodes: FileNode[], targetPath: string): FileNode | null => {
    for (const node of nodes) {
      if (node.path === targetPath) {
        return node;
      }
      if (node.children) {
        const found = findNodeByPath(node.children, targetPath);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };

  const refreshDirectory = (dirPath: string) => {
    if (!dirPath) return;
    if (!projectPath) return;

    if (dirPath === projectPath) {
      loadDirectory(projectPath);
      return;
    }

    const parentNode = findNodeByPath(files, dirPath);
    if (parentNode) {
      loadDirectory(dirPath, parentNode);
    } else {
      loadDirectory(projectPath);
    }
  };

  // Walk a FileSystemEntry tree (returned by DataTransferItem.webkitGetAsEntry)
  // into a flat list of (File, relPath-inside-the-dropped-bundle) pairs.
  // For a single dropped file, relPath is just file.name. For a dropped
  // folder, relPath is "folder/sub/file.tex" preserving the source layout.
  type UploadItem = { file: File; relPath: string };

  const readAllEntries = (reader: any): Promise<any[]> => {
    return new Promise((resolve, reject) => {
      const all: any[] = [];
      const pump = () => {
        reader.readEntries((batch: any[]) => {
          if (!batch.length) return resolve(all);
          all.push(...batch);
          pump();
        }, reject);
      };
      pump();
    });
  };

  const walkEntry = async (entry: any, prefix: string, out: UploadItem[]) => {
    if (entry.isFile) {
      const file: File = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, relPath: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await readAllEntries(reader);
      const nextPrefix = prefix + entry.name + '/';
      for (const child of children) {
        await walkEntry(child, nextPrefix, out);
      }
    }
  };

  const collectFromDropEvent = async (event: React.DragEvent): Promise<UploadItem[]> => {
    const out: UploadItem[] = [];
    const items = Array.from(event.dataTransfer?.items ?? []);
    // Prefer webkitGetAsEntry — it's the only way to get folder contents.
    // Fall back to .files for browsers that don't expose entries.
    const usedEntries = items.some(it => typeof (it as any).webkitGetAsEntry === 'function');
    if (usedEntries) {
      for (const it of items) {
        if (it.kind !== 'file') continue;
        const entry = (it as any).webkitGetAsEntry?.();
        if (entry) {
          await walkEntry(entry, '', out);
        } else {
          const file = it.getAsFile();
          if (file) out.push({ file, relPath: file.name });
        }
      }
    } else {
      for (const file of Array.from(event.dataTransfer?.files ?? [])) {
        out.push({ file, relPath: file.name });
      }
    }
    return out;
  };

  // Files from a hidden <input type="file"> picker. When the input has
  // `webkitdirectory`, every file's `webkitRelativePath` already encodes the
  // folder path; use it verbatim. Otherwise drop straight into the
  // destination using just the file name.
  const collectFromInput = (files: FileList | null, asFolder: boolean): UploadItem[] => {
    if (!files) return [];
    const out: UploadItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const relPath = asFolder && f.webkitRelativePath ? f.webkitRelativePath : f.name;
      out.push({ file: f, relPath });
    }
    return out;
  };

  const uploadIntoDirectory = async (items: UploadItem[], destination: string) => {
    if (readOnly) {
      alert('This project is read-only for your account.');
      return;
    }
    if (!destination || items.length === 0) {
      return;
    }

    setUploading(true);
    try {
      const result = await (window as any).api.uploadFiles(items, destination);
      refreshDirectory(destination);
      if (result?.errors?.length) {
        const summary = result.errors
          .slice(0, 5)
          .map((e: { path: string; error: string }) => `  - ${e.path}: ${e.error}`)
          .join('\n');
        const more = result.errors.length > 5 ? `\n  ...and ${result.errors.length - 5} more` : '';
        alert(
          `${result.uploaded} file${result.uploaded === 1 ? '' : 's'} uploaded, ` +
          `${result.errors.length} failed:\n${summary}${more}`,
        );
      }
    } catch (error) {
      console.error('Error uploading files:', error);
      alert(`Failed to upload: ${(error as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  // Open the hidden picker, remembering where to drop the result.
  const openFilePicker = (destination: string) => {
    if (readOnly) return;
    pickerDestinationRef.current = destination;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };
  const openFolderPicker = (destination: string) => {
    if (readOnly) return;
    pickerDestinationRef.current = destination;
    if (folderInputRef.current) {
      folderInputRef.current.value = '';
      folderInputRef.current.click();
    }
  };

  const onFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>, asFolder: boolean) => {
    const dest = pickerDestinationRef.current ?? projectPath;
    const items = collectFromInput(e.target.files, asFolder);
    pickerDestinationRef.current = null;
    if (!items.length || !dest) return;
    await uploadIntoDirectory(items, dest);
  };

  const handleDragOverNode = (event: React.DragEvent<HTMLDivElement>, node: FileNode) => {
    if (!node.isDirectory) {
      return;
    }

    if (!event.dataTransfer?.types?.includes('Files')) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDragDestination(node.path);
  };

  const handleDragEnterNode = (event: React.DragEvent<HTMLDivElement>, node: FileNode) => {
    event.stopPropagation();
    handleDragOverNode(event, node);
  };

  const handleDragLeaveNode = (event: React.DragEvent<HTMLDivElement>, node: FileNode) => {
    if (dragDestination !== node.path) {
      return;
    }

    const related = event.relatedTarget as Node | null;
    if (!related || !event.currentTarget.contains(related)) {
      setDragDestination(prev => (prev === node.path ? null : prev));
    }
    event.stopPropagation();
  };

  const handleDropOnNode = async (event: React.DragEvent<HTMLDivElement>, node: FileNode) => {
    if (!node.isDirectory) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDragDestination(null);
    const items = await collectFromDropEvent(event);
    if (items.length === 0) {
      return;
    }
    await uploadIntoDirectory(items, node.path);
  };

  const handleRootDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!projectPath) {
      return;
    }

    if (!event.dataTransfer?.types?.includes('Files')) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDragDestination(projectPath);
  };

  const handleRootDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (dragDestination !== projectPath) {
      return;
    }

    const related = event.relatedTarget as Node | null;
    if (!related || !event.currentTarget.contains(related)) {
      setDragDestination(prev => (prev === projectPath ? null : prev));
    }
    event.stopPropagation();
  };

  const handleRootDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    if (!projectPath) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDragDestination(null);
    const items = await collectFromDropEvent(event);
    if (items.length === 0) {
      return;
    }
    await uploadIntoDirectory(items, projectPath);
  };

  const handleContextMenu = (e: React.MouseEvent, file: FileNode) => {
    e.preventDefault();
    e.stopPropagation();

    const pathModule = (window as any).api.path;
    let directoryPath = file.isDirectory ? file.path : pathModule.dirname(file.path);
    let parentPath = file.isDirectory ? pathModule.dirname(file.path) : directoryPath;

    if (!parentPath || parentPath === '.' || parentPath === '') {
      parentPath = projectPath || directoryPath;
    }
    if (!directoryPath || directoryPath === '.' || directoryPath === '') {
      directoryPath = projectPath || '';
    }

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      target: file,
      directoryPath,
      parentPath,
    });
  };

  const handleEmptyContextMenu = (e: React.MouseEvent) => {
    if (!projectPath) return;
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      target: null,
      directoryPath: projectPath,
      parentPath: projectPath,
    });
  };

  const isImageFile = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (!ext) return false;
    return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'].includes(ext);
  };

  const getMimeType = (fileName: string) => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'bmp':
        return 'image/bmp';
      case 'svg':
        return 'image/svg+xml';
      case 'webp':
        return 'image/webp';
      default:
        return 'image/*';
    }
  };

  const handleCreateFile = async () => {
    if (readOnly) return;
    if (!contextMenu) return;
    const parentPath = contextMenu.directoryPath;

    setContextMenu(null);

    setInputDialog({
      isOpen: true,
      title: 'Create New File',
      label: 'File name:',
      placeholder: 'document.tex',
      defaultValue: '',
      onConfirm: async (fileName: string) => {
        const path = (window as any).api.path;
        const newFilePath = path.join(parentPath, fileName);
        const result = await (window as any).api.createFile(newFilePath);

        if (result.success) {
          refreshDirectory(parentPath);
        } else {
          alert(`Error creating file: ${result.error}`);
        }
        setInputDialog({ ...inputDialog, isOpen: false });
      },
    });
  };

  const handleDownloadFile = async () => {
    if (!contextMenu || !contextMenu.target || contextMenu.target.isDirectory) {
      return;
    }
    const target = contextMenu.target;
    setContextMenu(null);
    const result = await (window as any).api.downloadFile(target.path);
    if (!result.success) {
      alert(`Failed to download file: ${result.error}`);
    }
  };

  const handleZipFolder = () => {
    if (!contextMenu || !contextMenu.target || !contextMenu.target.isDirectory) {
      return;
    }
    onZipFolder(contextMenu.target.path);
    setContextMenu(null);
  };

  const handleCreateFolder = async () => {
    if (readOnly) return;
    if (!contextMenu) return;
    const parentPath = contextMenu.directoryPath;

    setContextMenu(null);

    setInputDialog({
      isOpen: true,
      title: 'Create New Folder',
      label: 'Folder name:',
      placeholder: 'my-folder',
      defaultValue: '',
      onConfirm: async (folderName: string) => {
        const path = (window as any).api.path;
        const newFolderPath = path.join(parentPath, folderName);
        const result = await (window as any).api.createDirectory(newFolderPath);

        if (result.success) {
          refreshDirectory(parentPath);
        } else {
          alert(`Error creating folder: ${result.error}`);
        }
        setInputDialog({ ...inputDialog, isOpen: false });
      },
    });
  };

  const handleDelete = () => {
    if (readOnly) return;
    if (!contextMenu || !contextMenu.target) return;
    const fileToDelete = contextMenu.target;
    const isDirectory = fileToDelete.isDirectory;
    const { directoryPath, parentPath, target } = contextMenu;
    const refreshTarget = target?.isDirectory ? (parentPath || projectPath) : directoryPath;
    setContextMenu(null);

    setConfirmDialog({
      isOpen: true,
      title: isDirectory ? 'Delete Folder' : 'Delete File',
      message: `Are you sure you want to delete the ${isDirectory ? 'folder' : 'file'} "${fileToDelete.name}"? This action cannot be undone.`,
      onConfirm: async () => {
      const result = await (window as any).api.deletePath(fileToDelete.path);

        if (result.success) {
          if (refreshTarget) {
            refreshDirectory(refreshTarget);
          } else if (projectPath) {
            refreshDirectory(projectPath);
          }
        } else {
          setConfirmDialog({
            isOpen: true,
            title: 'Error',
            message: `Failed to delete ${isDirectory ? 'folder' : 'file'}: ${result.error}`,
            onConfirm: () => setConfirmDialog({ ...confirmDialog, isOpen: false }),
          });
        }
        setConfirmDialog({ ...confirmDialog, isOpen: false });
      },
    });
  };

  const handleRename = () => {
    if (readOnly) return;
    if (!contextMenu || !contextMenu.target) return;
    const fileToRename = contextMenu.target;
    const parentDirectory = contextMenu.parentPath || projectPath;
    setContextMenu(null);

    setInputDialog({
      isOpen: true,
      title: 'Rename',
      label: 'New name:',
      placeholder: fileToRename.name,
      defaultValue: fileToRename.name,
      onConfirm: async (newName: string) => {
        const path = (window as any).api.path;
        const actualParentPath = path.dirname(fileToRename.path);
        const newPath = path.join(actualParentPath, newName);

        const result = await (window as any).api.renamePath(fileToRename.path, newPath);

        if (result.success) {
          refreshDirectory(parentDirectory || actualParentPath);
        } else {
          alert(`Error renaming: ${result.error}`);
        }
        setInputDialog({ ...inputDialog, isOpen: false });
      },
    });
  };

  const handleVersionFreezeFile = () => {
    if (readOnly) return;
    if (!contextMenu || !contextMenu.target) return;
    const fileToFreeze = contextMenu.target;
    setContextMenu(null);

    if (!fileToFreeze.isDirectory) {
      onVersionFreeze(fileToFreeze);
    }
  };

  const handleFileDoubleClick = async (file: FileNode) => {
    if (file.isDirectory) {
      return;
    }

    if (isImageFile(file.name)) {
      try {
        const result = await (window as any).api.readBinaryFile(file.path);
        if (result.success) {
          const mimeType = getMimeType(file.name);
          setImagePreview({
            isOpen: true,
            name: file.name,
            dataUrl: `data:${mimeType};base64,${result.data}`,
          });
        } else {
          alert(`Error opening image: ${result.error}`);
        }
      } catch (error: any) {
        alert(`Error opening image: ${error.message}`);
      }
      return;
    }

    onFileSelect(file);
  };

  // Files we treat as build artifacts when "Show build files" is off. The
  // list covers what pdflatex / xelatex / lualatex / latexmk / biber / makeindex
  // / glossaries / hyperref typically emit. Source files (.tex, .cls, .sty, .bib)
  // are NEVER filtered. Directories aren't filtered either, even an "out/"
  // folder created by a Makefile stays visible — only individual files match.
  const BUILD_FILE_RE = /\.(aux|log|out|toc|lof|lot|bbl|blg|bcf|run\.xml|synctex\.gz|synctex|fls|fdb_latexmk|nav|snm|vrb|idx|ind|ilg|glo|gls|glg|acn|acr|alg|xdy|xdv|brf|loa|ist|maf|mtc(\d+)?|ptc|los|stc|figlist|tablist)$/i;
  const isBuildArtifact = (name: string): boolean => BUILD_FILE_RE.test(name);

  const filterTree = (nodes: FileNode[]): FileNode[] => {
    if (showBuildFiles) return nodes;
    return nodes
      .filter(n => n.isDirectory || !isBuildArtifact(n.name))
      .map(n => n.isDirectory && n.children ? { ...n, children: filterTree(n.children) } : n);
  };

  const renderFileTree = (nodes: FileNode[], depth: number = 0) => {
    return nodes.map(node => (
      <div key={node.path}>
        <div
          className={`file-item ${selectedFile?.path === node.path ? 'selected' : ''} ${dragDestination === node.path ? 'drop-target' : ''}`}
          data-path={node.path}
          data-is-directory={node.isDirectory}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => handleFileClick(node)}
          onDoubleClick={() => handleFileDoubleClick(node)}
          onContextMenu={e => handleContextMenu(e, node)}
          onDragOver={event => handleDragOverNode(event, node)}
          onDragEnter={event => handleDragEnterNode(event, node)}
          onDragLeave={event => handleDragLeaveNode(event, node)}
          onDrop={event => handleDropOnNode(event, node)}
        >
          {node.isDirectory && (
            <span className="expand-icon">
              {node.expanded ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
            </span>
          )}
          <span className="file-icon">
            {node.isDirectory ? <FiFolder size={16} /> : <FiFile size={16} />}
          </span>
          <span className="file-name">{node.name}</span>
        </div>
        {node.isDirectory && node.expanded && node.children && (
          <div className="file-children">
            {renderFileTree(node.children, depth + 1)}
          </div>
        )}
      </div>
    ));
  };

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const handleZipProject = () => {
    if (!projectPath) return;
    onZipFolder(projectPath);
  };

  const getProjectFolderName = () => {
    if (!projectPath) return null;
    const pathModule = (window as any).api.path;
    return pathModule.basename(projectPath);
  };

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <div className="header-title-container">
          <h3>Files</h3>
          {projectPath && (
            <span className="project-folder-name" title={projectPath}>
              {getProjectFolderName()}
            </span>
          )}
        </div>
        {projectPath && !readOnly && (
          <>
            <button
              className="header-action-btn"
              onClick={() => openFilePicker(projectPath)}
              disabled={uploading}
              title="Upload file(s) into project root"
            >
              <FiUpload size={16} />
            </button>
            <button
              className="header-action-btn"
              onClick={() => openFolderPicker(projectPath)}
              disabled={uploading}
              title="Upload folder into project root"
            >
              <FiUploadCloud size={16} />
            </button>
          </>
        )}
        {projectPath && (
          <button
            className="header-action-btn"
            onClick={handleZipProject}
            title="Save Project as ZIP"
          >
            <FiArchive size={16} />
          </button>
        )}
      </div>
      {/* Hidden file inputs driven by the toolbar / context-menu actions. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => onFileInputChange(e, false)}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => onFileInputChange(e, true)}
        // webkitdirectory / directory aren't in the React DOM type list yet
        // but every modern browser respects them on a file input.
        {...{ webkitdirectory: '', directory: '' } as Record<string, string>}
      />
      {projectPath && (
        <label
          className="file-tree-toggle"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            fontSize: 12,
            color: 'var(--text-muted, #9ca3af)',
            borderBottom: '1px solid var(--border, #2b2b2b)',
            cursor: 'pointer',
            userSelect: 'none',
          }}
          title="LaTeX produces helper files (.aux, .log, .out, .bbl, …) while compiling. They reappear on every build."
        >
          <input
            type="checkbox"
            checked={showBuildFiles}
            onChange={(e) => setShowBuildFiles(e.target.checked)}
          />
          Show build files
        </label>
      )}
      <div
        className={`file-tree ${dragDestination === projectPath ? 'drop-target' : ''}`}
        onContextMenu={handleEmptyContextMenu}
        onDragOver={handleRootDragOver}
        onDragEnter={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
      >
        {files.length === 0 ? (
          <div className="empty-state">
            <p>No project opened</p>
          </div>
        ) : (
          renderFileTree(filterTree(files))
        )}
      </div>

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.target?.isDirectory && (
            <>
              <div className="context-menu-item" onClick={handleZipFolder}>
                <FiArchive size={14} />
                <span>Save Folder as ZIP</span>
              </div>
              <div className="context-menu-separator" />
            </>
          )}
          {contextMenu.target && !contextMenu.target.isDirectory && (
            <>
              <div className="context-menu-item" onClick={handleDownloadFile}>
                <FiDownload size={14} />
                <span>Download File</span>
              </div>
              <div className="context-menu-separator" />
            </>
          )}
          {!readOnly && (
            <>
              <div className="context-menu-item" onClick={handleCreateFile}>
                <FiPlus size={14} />
                <span>New File</span>
              </div>
              <div className="context-menu-item" onClick={handleCreateFolder}>
                <FiFolderPlus size={14} />
                <span>New Folder</span>
              </div>
              <div
                className="context-menu-item"
                onClick={() => {
                  const dest = contextMenu?.directoryPath || projectPath;
                  setContextMenu(null);
                  openFilePicker(dest);
                }}
              >
                <FiUpload size={14} />
                <span>Upload File…</span>
              </div>
              <div
                className="context-menu-item"
                onClick={() => {
                  const dest = contextMenu?.directoryPath || projectPath;
                  setContextMenu(null);
                  openFolderPicker(dest);
                }}
              >
                <FiUploadCloud size={14} />
                <span>Upload Folder…</span>
              </div>
            </>
          )}
          {contextMenu.target && (
            <>
              {!readOnly && (
                <>
                  <div className="context-menu-separator" />
                  {!contextMenu.target.isDirectory && (
                    <div className="context-menu-item" onClick={handleVersionFreezeFile}>
                      <FiClock size={14} />
                      <span>Instant Backup</span>
                    </div>
                  )}
                  <div className="context-menu-item" onClick={handleRename}>
                    <FiEdit2 size={14} />
                    <span>Rename</span>
                  </div>
                  <div className="context-menu-item danger" onClick={handleDelete}>
                    <FiTrash2 size={14} />
                    <span>Delete</span>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      <InputDialog
        isOpen={inputDialog.isOpen}
        title={inputDialog.title}
        label={inputDialog.label}
        placeholder={inputDialog.placeholder}
        defaultValue={inputDialog.defaultValue}
        onConfirm={inputDialog.onConfirm}
        onCancel={() => setInputDialog({ ...inputDialog, isOpen: false })}
      />

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger={true}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog({ ...confirmDialog, isOpen: false })}
      />
      <ImagePreviewDialog
        isOpen={imagePreview.isOpen}
        name={imagePreview.name}
        dataUrl={imagePreview.dataUrl}
        onClose={() => setImagePreview({ isOpen: false, name: '', dataUrl: '' })}
      />
    </div>
  );
};

export default FileExplorer;
