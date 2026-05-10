export interface StructureNode {
  id: string;
  title: string;
  level: number;
  type: 'title' | 'chapter' | 'section' | 'subsection' | 'subsubsection';
  children: StructureNode[];
  lineNumber: number;
}

export interface ParseResult {
  isValid: boolean;
  structure: StructureNode | null;
  error?: string;
}

/**
 * Parse LaTeX content to extract document structure
 */
export function parseLatexStructure(content: string): ParseResult {
  if (!content || content.trim().length === 0) {
    return {
      isValid: false,
      structure: null,
      error: 'Empty document'
    };
  }

  // Check if it's a valid LaTeX document
  if (!content.includes('\\documentclass') && !content.includes('\\begin{document}')) {
    return {
      isValid: false,
      structure: null,
      error: 'Not a valid LaTeX document'
    };
  }

  const lines = content.split('\n');
  const root: StructureNode = {
    id: 'root',
    title: 'Document',
    level: 0,
    type: 'title',
    children: [],
    lineNumber: 0
  };

  // Extract title if exists
  const titleMatch = content.match(/\\title\{([^}]+)\}/);
  if (titleMatch) {
    root.title = cleanLatexText(titleMatch[1]);
  }

  // Extract author if exists (optional, can be used for subtitle)
  const authorMatch = content.match(/\\author\{([^}]+)\}/);
  if (authorMatch) {
    const authorNode: StructureNode = {
      id: 'author',
      title: `By: ${cleanLatexText(authorMatch[1])}`,
      level: 1,
      type: 'section',
      children: [],
      lineNumber: 0
    };
    root.children.push(authorNode);
  }

  // Stack to maintain hierarchy
  const stack: StructureNode[] = [root];
  let nodeIdCounter = 0;

  // Regex patterns for different levels
  const patterns = [
    { regex: /\\chapter\{([^}]+)\}/,         type: 'chapter' as const,        level: 1 },
    { regex: /\\section\{([^}]+)\}/,         type: 'section' as const,        level: 2 },
    { regex: /\\subsection\{([^}]+)\}/,      type: 'subsection' as const,     level: 3 },
    { regex: /\\subsubsection\{([^}]+)\}/,   type: 'subsubsection' as const,  level: 4 }
  ];

  lines.forEach((line, lineIndex) => {
    const trimmedLine = line.trim();

    // Skip comments
    if (trimmedLine.startsWith('%')) {
      return;
    }

    // Check each pattern
    for (const pattern of patterns) {
      const match = trimmedLine.match(pattern.regex);
      if (match) {
        const title = cleanLatexText(match[1]);
        const node: StructureNode = {
          id: `node-${nodeIdCounter++}`,
          title,
          level: pattern.level,
          type: pattern.type,
          children: [],
          lineNumber: lineIndex + 1
        };

        // Find the correct parent in the stack
        while (stack.length > 0 && stack[stack.length - 1].level >= pattern.level) {
          stack.pop();
        }

        // Add to parent
        if (stack.length > 0) {
          stack[stack.length - 1].children.push(node);
        }

        // Push current node to stack
        stack.push(node);
        break;
      }
    }
  });

  // Check if we found any structure
  if (root.children.length === 0) {
    return {
      isValid: false,
      structure: null,
      error: 'No document structure found (no sections/chapters)'
    };
  }

  return {
    isValid: true,
    structure: root
  };
}

/**
 * Clean LaTeX text by removing common commands
 */
function cleanLatexText(text: string): string {
  return text
    // Remove common formatting commands
    .replace(/\\textbf\{([^}]+)\}/g, '$1')
    .replace(/\\textit\{([^}]+)\}/g, '$1')
    .replace(/\\emph\{([^}]+)\}/g, '$1')
    .replace(/\\texttt\{([^}]+)\}/g, '$1')
    // Remove citations and references
    .replace(/\\cite\{[^}]+\}/g, '')
    .replace(/\\ref\{[^}]+\}/g, '')
    .replace(/\\label\{[^}]+\}/g, '')
    // Remove math mode
    .replace(/\$([^$]+)\$/g, '$1')
    // Remove other common commands
    .replace(/\\[a-zA-Z]+\{([^}]+)\}/g, '$1')
    // Clean up whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Count total nodes in the structure
 */
export function countNodes(node: StructureNode): number {
  let count = 1;
  node.children.forEach(child => {
    count += countNodes(child);
  });
  return count;
}

/**
 * Get maximum depth of the structure
 */
export function getMaxDepth(node: StructureNode, currentDepth: number = 0): number {
  if (node.children.length === 0) {
    return currentDepth;
  }
  const childDepths = node.children.map(child => getMaxDepth(child, currentDepth + 1));
  return Math.max(...childDepths);
}
