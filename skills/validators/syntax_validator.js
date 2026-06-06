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

// Cấu hình LSP Servers tĩnh tiêu chuẩn cho các ngôn ngữ khác
const LSP_SERVERS = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    languageId: 'typescript'
  },
  javascript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    languageId: 'javascript'
  },
  tsx: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    languageId: 'typescriptreact'
  },
  jsx: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    languageId: 'javascriptreact'
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    languageId: 'python'
  },
  go: {
    command: 'gopls',
    args: [],
    languageId: 'go'
  },
  rust: {
    command: 'rust-analyzer',
    args: [],
    languageId: 'rust'
  },
  cpp: {
    command: 'clangd',
    args: [],
    languageId: 'cpp'
  },
  c: {
    command: 'clangd',
    args: [],
    languageId: 'c'
  }
};

/**
 * Tự động dò quét thư mục VS Code extension để định vị C# Roslyn Language Server (LTM)
 */
function findCSharpLspPath() {
  try {
    const homeDir = os.homedir();
    const extensionsDir = path.join(homeDir, '.vscode/extensions');
    if (!fs.existsSync(extensionsDir)) return null;

    const dirs = fs.readdirSync(extensionsDir);
    // Tìm kiếm thư mục của extension ms-dotnettools.csharp
    const csharpExtDirs = dirs.filter(d => d.startsWith('ms-dotnettools.csharp-'));
    if (csharpExtDirs.length === 0) return null;

    // Sắp xếp ngược để lấy phiên bản mới nhất
    csharpExtDirs.sort().reverse();

    for (const extDir of csharpExtDirs) {
      const isWin = process.platform === 'win32';
      const executableName = isWin ? 'Microsoft.CodeAnalysis.LanguageServer.exe' : 'Microsoft.CodeAnalysis.LanguageServer';
      const fullPath = path.join(extensionsDir, extDir, '.roslyn', executableName);

      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  } catch (e) {
    // Thầm lặng bỏ qua lỗi tìm kiếm
  }
  return null;
}

/**
 * Chuyển đổi đường dẫn tuyệt đối sang chuẩn URI file:// tương thích LSP
 */
function filePathToUri(filePath) {
  let resolvedPath = path.resolve(filePath).replace(/\\/g, '/');
  if (!resolvedPath.startsWith('/')) {
    resolvedPath = '/' + resolvedPath;
  }
  return 'file://' + encodeURI(resolvedPath);
}

/**
 * Lớp điều khiển giao tiếp LSP stdio dạng nhẹ (JSON-RPC 2.0)
 */
class StdioLspClient {
  constructor(command, args, rootPath) {
    this.command = command;
    this.args = args;
    this.rootPath = rootPath;
    this.child = null;
    this.messageId = 1;
    this.pendingRequests = new Map();
    this.diagnosticsCallback = null;
    this.buffer = Buffer.alloc(0);
  }

  async start() {
    const { spawn } = await import('child_process');
    return new Promise((resolve, reject) => {
      try {
        this.child = spawn(this.command, this.args, {
          cwd: this.rootPath,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        });

        this.child.on('error', (err) => {
          reject(err);
        });

        this.child.stdout.on('data', (chunk) => {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          this.parseIncomingBuffer();
        });

        if (this.child.pid) {
          resolve();
        } else {
          reject(new Error(`Failed to spawn LSP process: ${this.command}`));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  parseIncomingBuffer() {
    while (true) {
      const str = this.buffer.toString('utf8');
      const contentLengthIndex = str.indexOf('Content-Length:');
      if (contentLengthIndex === -1) break;

      const endOfHeadersIndex = str.indexOf('\r\n\r\n', contentLengthIndex);
      if (endOfHeadersIndex === -1) break;

      const headers = str.substring(contentLengthIndex, endOfHeadersIndex);
      const match = headers.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(endOfHeadersIndex + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const headerBytesLength = Buffer.byteLength(str.substring(0, endOfHeadersIndex + 4), 'utf8');
      const totalLength = headerBytesLength + contentLength;

      if (this.buffer.length < totalLength) {
        break; // Chờ cho đến khi gom đủ byte
      }

      const payloadBytes = this.buffer.slice(headerBytesLength, totalLength);
      const payloadStr = payloadBytes.toString('utf8');

      this.buffer = this.buffer.slice(totalLength);

      try {
        const message = JSON.parse(payloadStr);
        this.handleMessage(message);
      } catch (err) {
        // Thầm lặng bỏ qua lỗi parse tạm thời
      }
    }
  }

  handleMessage(message) {
    if (message.id !== undefined) {
      const resolve = this.pendingRequests.get(message.id);
      if (resolve) {
        this.pendingRequests.delete(message.id);
        resolve(message);
      }
    } else if (message.method === 'textDocument/publishDiagnostics') {
      if (this.diagnosticsCallback) {
        this.diagnosticsCallback(message.params);
      }
    }
  }

  async send(method, params, isNotification = false) {
    const message = {
      jsonrpc: '2.0',
      method,
      params
    };

    let id;
    if (!isNotification) {
      id = this.messageId++;
      message.id = id;
    }

    const payload = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;

    if (this.child && !this.child.killed && this.child.stdin.writable) {
      this.child.stdin.write(header + payload);
    }

    if (!isNotification) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP Request Timeout: ${method}`));
        }, 5000);

        this.pendingRequests.set(id, (res) => {
          clearTimeout(timeout);
          resolve(res);
        });
      });
    }
  }

  async initialize() {
    const rootUri = filePathToUri(this.rootPath);
    const initParams = {
      processId: process.pid,
      rootUri: rootUri,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true
          }
        }
      }
    };

    await this.send('initialize', initParams);
    await this.send('initialized', {}, true);
  }

  async checkFile(filePath, languageId, content) {
    const fileUri = filePathToUri(filePath);

    return new Promise(async (resolve) => {
      let timer;

      this.diagnosticsCallback = (params) => {
        const receivedUri = decodeURI(params.uri).toLowerCase();
        const expectedUri = decodeURI(fileUri).toLowerCase();

        if (receivedUri === expectedUri) {
          clearTimeout(timer);
          this.diagnosticsCallback = null;
          resolve(params.diagnostics || []);
        }
      };

      try {
        await this.send('textDocument/didOpen', {
          textDocument: {
            uri: fileUri,
            languageId: languageId,
            version: 1,
            text: content
          }
        }, true);
      } catch (err) {
        resolve([]);
      }

      timer = setTimeout(() => {
        this.diagnosticsCallback = null;
        resolve([]);
      }, 5000);
    });
  }

  async stop() {
    if (this.child) {
      try {
        await this.send('shutdown', {});
        await this.send('exit', {}, true);
      } catch (e) {
        // ignore
      }
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          try {
            this.child.kill();
          } catch (e) { }
        }
      }, 500);
    }
  }
}

/**
 * Hàm điều phối chính thực hiện xác thực cú pháp (bản mới hỗ trợ async LSP)
 */
export async function validateSyntax(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const language = EXT_MAP[ext] || 'unknown';

  // 1. KIỂM TRA BẰNG CƠ CHẾ LSP NẾU SẴN SÀNG
  let lspConfig = LSP_SERVERS[language];
  let isLspAvailable = false;

  // Giải quyết động đường dẫn nếu là C#
  if (language === 'csharp') {
    const csharpLspPath = findCSharpLspPath();
    if (csharpLspPath) {
      lspConfig = {
        command: csharpLspPath,
        args: ['--stdio'],
        languageId: 'csharp'
      };
      isLspAvailable = true;
    }
  } else if (lspConfig && isCommandAvailable(lspConfig.command)) {
    isLspAvailable = true;
  }

  if (isLspAvailable && lspConfig) {
    try {
      console.log(chalk.blue(`[LSP Checker] 🚀 Dò thấy LSP "${path.basename(lspConfig.command)}" khả dụng. Đang tiến hành phân tích...`));
      const workspace = globalThis.activeWorkspace || process.cwd();
      const client = new StdioLspClient(lspConfig.command, lspConfig.args, workspace);

      await client.start();
      await client.initialize();
      const diagnostics = await client.checkFile(filePath, lspConfig.languageId, content);
      await client.stop();

      // Lọc các lỗi nghiêm trọng (severity 1 = Error)
      const errors = diagnostics.filter(d => d.severity === 1);

      if (errors.length > 0) {
        const formattedErrors = errors.map(e => {
          const line = e.range ? e.range.start.line + 1 : '?';
          const char = e.range ? e.range.start.character + 1 : '?';
          return `[Dòng ${line}:${char}] ${e.message} (LSP Code: ${e.code || 'unknown'})`;
        }).join('\n');

        return {
          valid: false,
          language,
          error: formattedErrors,
          provider: 'lsp'
        };
      }

      console.log(chalk.green(`[LSP Checker] ✅ Hoàn tất phân tích tĩnh qua LSP. Không phát hiện lỗi cú pháp.`));
      return { valid: true, language, provider: 'lsp' };

    } catch (lspErr) {
      console.warn(chalk.yellow(`[LSP Checker] ⚠️ LSP gặp sự cố: ${lspErr.message}. Chuyển hướng sang compiler thô...`));
    }
  }

  // 2. PHƯƠNG ÁN DỰ PHÒNG TRUYỀN THỐNG (FALLBACK)
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

// 1. Kiểm tra C# (.cs) dọn dẹp kiểu build thông thường
function validateCSharp(filePath) {
  if (!isCommandAvailable('dotnet')) {
    return { valid: true, language: 'csharp', skipped: true, reason: 'dotnet CLI not found' };
  }
  try {
    const dir = path.dirname(filePath);
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