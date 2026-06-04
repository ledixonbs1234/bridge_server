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
  '.sh': 'shell', '.bash': 'shell',
  '.cs': 'csharp',
  '.go': 'go',
  '.php': 'php',
  '.rs': 'rust',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp'
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
      case 'csharp':
        return validateCSharp(filePath);
      case 'go':
        return validateGo(filePath);
      case 'php':
        return validatePHP(filePath);
      case 'rust':
        return validateRust(filePath);
      case 'c':
      case 'cpp':
        return validateCpp(filePath, language === 'cpp');
      default:
        return { valid: true, language, skipped: true };
    }
  } catch (err) {
    return { valid: false, language, error: err.message };
  }
}

// Helper: Kiểm tra nhanh xem lệnh hệ thống có sẵn sàng không
function isCommandAvailable(cmd) {
  try {
    const testCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(testCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 1. Kiểm tra C# (.cs)
function validateCSharp(filePath) {
  if (!isCommandAvailable('dotnet')) {
    return { valid: true, language: 'csharp', skipped: true, reason: 'dotnet CLI not found' };
  }
  try {
    const dir = path.dirname(filePath);
    // Chạy compile-only target để phân tích tĩnh cú pháp toàn bộ tệp mà không tạo file nhị phân
    execSync(`dotnet build /t:Compile /p:GeneratePackageOnBuild=false`, {
      cwd: dir,
      stdio: 'pipe',
      timeout: 15000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });
    return { valid: true, language: 'csharp' };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    const stdout = err.stdout?.toString() || '';
    const fullError = `${stdout}\n${stderr}`.trim();
    return { valid: false, language: 'csharp', error: cleanDotnetError(fullError) };
  }
}

function cleanDotnetError(output) {
  const lines = output.split('\n');
  const errorLines = lines.filter(l => l.includes('error CS') || l.includes('Build FAILED'));
  return errorLines.join('\n').trim() || output.substring(0, 1000);
}

// 2. Kiểm tra Go (.go)
function validateGo(filePath) {
  if (!isCommandAvailable('go')) {
    return { valid: true, language: 'go', skipped: true, reason: 'go compiler not found' };
  }
  try {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    execSync(`go vet "${fileName}"`, {
      cwd: dir,
      stdio: 'pipe',
      timeout: 10000
    });
    return { valid: true, language: 'go' };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    return { valid: false, language: 'go', error: stderr.trim() };
  }
}

// 3. Kiểm tra PHP (.php)
function validatePHP(filePath) {
  if (!isCommandAvailable('php')) {
    return { valid: true, language: 'php', skipped: true, reason: 'php binary not found' };
  }
  try {
    execSync(`php -l "${filePath}"`, {
      stdio: 'pipe',
      timeout: 5000
    });
    return { valid: true, language: 'php' };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    return { valid: false, language: 'php', error: stderr.trim() };
  }
}

// 4. Kiểm tra Rust (.rs)
function validateRust(filePath) {
  if (!isCommandAvailable('cargo')) {
    return { valid: true, language: 'rust', skipped: true, reason: 'cargo not found' };
  }
  try {
    const dir = path.dirname(filePath);
    execSync(`cargo check`, {
      cwd: dir,
      stdio: 'pipe',
      timeout: 20000
    });
    return { valid: true, language: 'rust' };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    return { valid: false, language: 'rust', error: stderr.trim() };
  }
}

// 5. Kiểm tra C/C++ (.c, .cpp)
function validateCpp(filePath, isCpp = false) {
  const compiler = isCommandAvailable('g++') ? 'g++' : (isCommandAvailable('gcc') ? 'gcc' : (isCommandAvailable('clang') ? 'clang' : null));
  if (!compiler) {
    return { valid: true, language: isCpp ? 'cpp' : 'c', skipped: true, reason: 'no C/C++ compiler found' };
  }
  try {
    execSync(`${compiler} -fsyntax-only "${filePath}"`, {
      stdio: 'pipe',
      timeout: 10000
    });
    return { valid: true, language: isCpp ? 'cpp' : 'c' };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    return { valid: false, language: isCpp ? 'cpp' : 'c', error: stderr.trim() };
  }
}

// --- Các hàm kiểm tra cú pháp JS/TS/Python gốc ---

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
  const tempDir = os.tmpdir();
  const randName = crypto.randomBytes(8).toString('hex');
  const tmpFile = path.join(tempDir, `syntax_check_${randName}.py`);

  try {
    fs.writeFileSync(tmpFile, content, 'utf8');
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    execSync(`${pythonCmd} -c "import ast; ast.parse(open(r'${tmpFile}', encoding='utf-8').read())"`, {
      stdio: 'pipe',
      timeout: 10000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    });
    return { valid: true, language: 'python' };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    return { valid: false, language: 'python', error: extractPythonError(stderr) };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { }
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