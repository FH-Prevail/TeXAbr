import React, { createContext, useContext, useMemo, useRef, useState } from 'react';
import { Annotation } from './types/annotations';

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  content?: string;
  children?: FileNode[];
}

export interface CursorPosition {
  lineNumber: number;
  column: number;
}

export interface PendingCursor {
  path: string;
  position: CursorPosition;
}

interface ProjectContextValue {
  projectPath: string;
  setProjectPath: React.Dispatch<React.SetStateAction<string>>;
  currentFile: FileNode | null;
  setCurrentFile: React.Dispatch<React.SetStateAction<FileNode | null>>;
  openTabs: FileNode[];
  setOpenTabs: React.Dispatch<React.SetStateAction<FileNode[]>>;
  tabContents: Map<string, string>;
  setTabContents: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  editorContent: string;
  setEditorContent: React.Dispatch<React.SetStateAction<string>>;
  tabAnnotations: Map<string, Annotation[]>;
  setTabAnnotations: React.Dispatch<React.SetStateAction<Map<string, Annotation[]>>>;
  annotations: Annotation[];
  setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>;
  annotationsHidden: boolean;
  setAnnotationsHidden: React.Dispatch<React.SetStateAction<boolean>>;
  fileExplorerRefreshTrigger: number;
  setFileExplorerRefreshTrigger: React.Dispatch<React.SetStateAction<number>>;
  cursorPositionsRef: React.MutableRefObject<Map<string, CursorPosition>>;
  pendingCursorRef: React.MutableRefObject<PendingCursor | null>;
  persistSessionTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>;
  restoredSessionProjectRef: React.MutableRefObject<string | null>;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [projectPath, setProjectPath] = useState('');
  const [currentFile, setCurrentFile] = useState<FileNode | null>(null);
  const [openTabs, setOpenTabs] = useState<FileNode[]>([]);
  const [tabContents, setTabContents] = useState<Map<string, string>>(new Map());
  const [editorContent, setEditorContent] = useState('');
  const [tabAnnotations, setTabAnnotations] = useState<Map<string, Annotation[]>>(new Map());
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationsHidden, setAnnotationsHidden] = useState<boolean>(true);
  const [fileExplorerRefreshTrigger, setFileExplorerRefreshTrigger] = useState<number>(0);

  const cursorPositionsRef = useRef<Map<string, CursorPosition>>(new Map());
  const pendingCursorRef = useRef<PendingCursor | null>(null);
  const persistSessionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const restoredSessionProjectRef = useRef<string | null>(null);

  const value = useMemo<ProjectContextValue>(() => ({
    projectPath,
    setProjectPath,
    currentFile,
    setCurrentFile,
    openTabs,
    setOpenTabs,
    tabContents,
    setTabContents,
    editorContent,
    setEditorContent,
    tabAnnotations,
    setTabAnnotations,
    annotations,
    setAnnotations,
    annotationsHidden,
    setAnnotationsHidden,
    fileExplorerRefreshTrigger,
    setFileExplorerRefreshTrigger,
    cursorPositionsRef,
    pendingCursorRef,
    persistSessionTimeoutRef,
    restoredSessionProjectRef,
  }), [
    projectPath,
    currentFile,
    openTabs,
    tabContents,
    editorContent,
    tabAnnotations,
    annotations,
    annotationsHidden,
    fileExplorerRefreshTrigger,
  ]);

  return (
    <ProjectContext.Provider value={value}>
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = (): ProjectContextValue => {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return ctx;
};
