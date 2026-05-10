export type LatexDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface LatexDiagnostic {
  severity: LatexDiagnosticSeverity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
}

const uniqueKey = (diagnostic: LatexDiagnostic): string => (
  `${diagnostic.severity}|${diagnostic.file || ''}|${diagnostic.line || ''}|${diagnostic.code || ''}|${diagnostic.message}`
);

const pushUnique = (items: LatexDiagnostic[], seen: Set<string>, diagnostic: LatexDiagnostic) => {
  const key = uniqueKey(diagnostic);
  if (seen.has(key)) return;
  seen.add(key);
  items.push(diagnostic);
};

export const detectMissingLatexPackage = (output: string): string | null => {
  const packagePatterns = [
    /! LaTeX Error: File `([^']+\.sty)' not found/,
    /! Package .* Error:.*package `([^']+)'/,
    /LaTeX Error: File `([^']+\.sty)' not found/,
    /Cannot find file `([^']+\.sty)'/
  ];

  for (const pattern of packagePatterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      return match[1].replace(/\.sty$/, '');
    }
  }
  return null;
};

export const parseLatexDiagnostics = (output: string, texFilePath?: string): LatexDiagnostic[] => {
  const normalized = output.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const diagnostics: LatexDiagnostic[] = [];
  const seen = new Set<string>();

  const missingPackage = detectMissingLatexPackage(output);
  if (missingPackage) {
    pushUnique(diagnostics, seen, {
      severity: 'error',
      message: `Missing LaTeX package: ${missingPackage}`,
      file: texFilePath,
      code: 'missing-package'
    });
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const fileLine = line.match(/^(.+?\.tex):(\d+):\s*(.+)$/i);
    if (fileLine) {
      pushUnique(diagnostics, seen, {
        severity: /warning/i.test(fileLine[3]) ? 'warning' : 'error',
        file: fileLine[1],
        line: Number(fileLine[2]),
        message: fileLine[3].trim(),
        code: 'latex-file-line'
      });
      continue;
    }

    const missingImage = line.match(/LaTeX Warning: File `([^']+)' not found on input line (\d+)/i);
    if (missingImage) {
      pushUnique(diagnostics, seen, {
        severity: 'error',
        file: texFilePath,
        line: Number(missingImage[2]),
        message: `Missing image or input file: ${missingImage[1]}`,
        code: 'missing-file'
      });
      continue;
    }

    const citation = line.match(/LaTeX Warning: Citation `([^']+)' .*undefined on input line (\d+)/i);
    if (citation) {
      pushUnique(diagnostics, seen, {
        severity: 'warning',
        file: texFilePath,
        line: Number(citation[2]),
        message: `Undefined citation: ${citation[1]}`,
        code: 'undefined-citation'
      });
      continue;
    }

    const reference = line.match(/LaTeX Warning: Reference `([^']+)' .*undefined on input line (\d+)/i);
    if (reference) {
      pushUnique(diagnostics, seen, {
        severity: 'warning',
        file: texFilePath,
        line: Number(reference[2]),
        message: `Undefined reference: ${reference[1]}`,
        code: 'undefined-reference'
      });
      continue;
    }

    if (/^! LaTeX Error:/i.test(line) || /^! Package .* Error:/i.test(line) || /^! Undefined control sequence/i.test(line) || /^! Emergency stop/i.test(line)) {
      pushUnique(diagnostics, seen, {
        severity: 'error',
        file: texFilePath,
        message: line.replace(/^!\s*/, ''),
        code: 'latex-error'
      });
    }
  }

  return diagnostics;
};

export const summarizeLatexError = (output: string, texFilePath?: string): string => {
  const diagnostics = parseLatexDiagnostics(output, texFilePath);
  const firstError = diagnostics.find(diagnostic => diagnostic.severity === 'error') || diagnostics[0];

  if (firstError) {
    const location = firstError.line ? `${firstError.file || texFilePath || 'LaTeX'}:${firstError.line}: ` : '';
    return `${location}${firstError.message}`;
  }

  const normalized = output.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  const fatal = lines.find(line => /^! /i.test(line));
  if (fatal) {
    return fatal.replace(/^!\s*/, '');
  }

  return 'Compilation failed. See the full log for details.';
};

