import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const EXT_MAP = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx',
  '.py': 'python', '.json': 'json', '.md': 'markdown',
  '.html': 'html', '.css': 'css', '.yml': 'yaml', '.yaml': 'yaml',
  '.sh': 'shell', '.bash': 'shell'
};

export function validateSyntax(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const language = EXT_MAP[ext] || 'unknown';

  try {
    switch (language) {
      case 'javascript':
      case 'jsx':
        return validateJavaScript(content, language === 'jsx');
      case 'typescript':
      case 'tsx':
        return validateTypeScript(content, language === 'tsx');
      case 'json':
        return validateJSON(content);
      case 'python':
        return validatePython(filePath, content);
      case 'yaml':
        return validateYAML(content);
      default:
        return { valid: true, language, skipped: true };
    }
  } catch (err) {
    return { valid: false, language, error: err.message };
  }
}

function validateJavaScript(code, jsx = false) {
  try {
    const acorn = tryRequire('acorn');
    const acornJsx = tryRequire('acorn-jsx');
    
    if (acorn) {
      const parser = jsx && acornJsx 
        ? acorn.Parser.extend(acornJsx())
        : acorn.Parser;
      parser.parse(code, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        allowImportExportEverywhere: true,
        allowReturnOutsideFunction: true
      });
      return { valid: true, language: jsx ? 'jsx' : 'javascript' };
    }
    
    new Function(code);
    return { valid: true, language: 'javascript', fallback: true };
  } catch (err) {
    return { 
      valid: false, 
      language: jsx ? 'jsx' : 'javascript',
      error: extractSyntaxError(err.message)
    };
  }
}

function validateTypeScript(code, tsx = false) {
  try {
    const ts = tryRequire('typescript');
    if (!ts) return { valid: true, language: 'typescript', skipped: true };
    
    const result = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
        jsx: tsx ? ts.JsxEmit.React : undefined,
        noEmit: false
      },
      reportDiagnostics: true
    });
    
    if (result.diagnostics && result.diagnostics.length > 0) {
      const errors = result.diagnostics
        .filter(d => d.category === ts.DiagnosticCategory.Error)
        .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      if (errors.length > 0) {
        return { valid: false, language: 'typescript', error: errors.join('\n') };
      }
    }
    return { valid: true, language: 'typescript' };
  } catch (err) {
    return { valid: false, language: 'typescript', error: err.message };
  }
}

function validateJSON(code) {
  try {
    JSON.parse(code);
    return { valid: true, language: 'json' };
  } catch (err) {
    return { valid: false, language: 'json', error: err.message };
  }
}

function validatePython(filePath, content) {
  // SỬA LỖI: Ghi tệp tạm vào thư mục tạm của hệ điều hành để tránh kích hoạt file watcher của dự án
  const tempDir = os.tmpdir();
  const randName = crypto.randomBytes(8).toString('hex');
  const tmpFile = path.join(tempDir, `syntax_check_${randName}.py`);
  
  try {
    fs.writeFileSync(tmpFile, content, 'utf8');
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    
    // SỬA LỖI: Dùng ast.parse để kiểm tra cú pháp trong bộ nhớ, hoàn toàn không sinh tệp compiled (.pyc) gây ô nhiễm
    execSync(`${pythonCmd} -c "import ast; ast.parse(open(r'${tmpFile}', encoding='utf-8').read())"`, { 
      stdio: 'pipe',
      timeout: 10000 
    });
    return { valid: true, language: 'python' };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    return { valid: false, language: 'python', error: extractPythonError(stderr) };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function validateYAML(code) {
  try {
    const yaml = tryRequire('js-yaml');
    if (yaml) yaml.load(code);
    return { valid: true, language: 'yaml' };
  } catch (err) {
    return { valid: false, language: 'yaml', error: err.message };
  }
}

function tryRequire(pkg) {
  try { return require(pkg); } catch { return null; }
}

function extractSyntaxError(msg) {
  const match = msg.match(/Unexpected token.*?(\(\d+:\d+\))/);
  return match ? match[0] : msg.split('\n')[0];
}

function extractPythonError(stderr) {
  const lines = stderr.split('\n').filter(l => l.trim());
  const syntaxLine = lines.reverse().find(l => l.includes('SyntaxError') || l.includes('Error'));
  return syntaxLine || lines[0] || stderr;
}

export default { validateSyntax };