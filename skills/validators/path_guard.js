// =================================================================
// 🛡️ PATH GUARD - Bảo vệ chống Path Traversal & truy cập file nhạy cảm
// =================================================================
import path from 'path';
import os from 'os';
import fs from 'fs';
import chalk from 'chalk';

/**
 * Danh sách WHITELIST - Các thư mục AI được phép truy cập
 */
const ALLOWED_ROOTS = [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Pictures'),
  path.join(os.homedir(), 'Videos'),
  path.join(os.homedir(), 'Music'),
  path.join(os.homedir()),
  process.cwd(),
  path.join(os.homedir(), 'tmp'),
  path.join(os.homedir(), '.tmp'),
];

/**
 * Danh sách BLACKLIST - Các thư mục hệ thống TUYỆT ĐỐI KHÔNG cho phép
 */
const FORBIDDEN_PATHS = [
  'C:/Windows',
  'C:/Program Files',
  'C:/Program Files (x86)',
  'C:/ProgramData',
  'C:/$Recycle.Bin',
  'C:/System Volume Information',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/sys',
  '/proc',
  '/boot',
  '/dev',
  '/lib',
  '/lib64',
  '/root',
  '/tmp',
  '/System',
  '/Library',
  '/Applications',
  '/private',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/hosts',
  'C:/Windows/System32/config/SAM',
];

const FORBIDDEN_EXTENSIONS = [
  '.pem', '.key', '.p12', '.pfx',
  '.keystore', '.jks',
  'id_rsa', 'id_dsa', 'id_ed25519',
  '.env.local', '.env.production',
  'credentials.json',
  '.aws/credentials',
  'authorized_keys',
];

function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

function isPathInside(childPath, parentPath) {
  const normalizedChild = normalizePath(childPath);
  const normalizedParent = normalizePath(parentPath);
  return normalizedChild === normalizedParent ||
    normalizedChild.startsWith(normalizedParent + '/');
}

/**
 * Phân tích và validate path
 */
export function validatePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return {
      allowed: false,
      level: 'danger',
      reason: 'Path không hợp lệ (rỗng hoặc không phải string)'
    };
  }

  const desktopPath = path.join(os.homedir(), 'Desktop');

  // Xử lý shortcut "desktop"
  if (inputPath.toLowerCase() === 'desktop') {
    return { allowed: true, resolved: normalizePath(desktopPath), level: 'safe' };
  }

  // Resolve về absolute path
  let resolved;
  try {
    // CHỈNH SỬA: Nếu là relative path, tự động resolve từ thư mục Desktop thay vì process.cwd()
    resolved = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(desktopPath, inputPath);
  } catch (e) {
    return {
      allowed: false,
      level: 'danger',
      reason: `Không thể resolve path: ${e.message}`
    };
  }

  const normalizedResolved = normalizePath(resolved);

  // 1. Check BLACKLIST exact paths
  for (const forbidden of FORBIDDEN_PATHS) {
    const normalizedForbidden = normalizePath(forbidden);
    if (normalizedResolved === normalizedForbidden ||
      normalizedResolved.startsWith(normalizedForbidden + '/')) {
      return {
        allowed: false,
        level: 'danger',
        reason: `Path nằm trong vùng cấm hệ thống: ${forbidden}`,
        resolved: normalizedResolved
      };
    }
  }

  // 2. Check BLACKLIST file extensions/names
  const fileName = path.basename(normalizedResolved).toLowerCase();
  for (const forbiddenExt of FORBIDDEN_EXTENSIONS) {
    if (fileName.endsWith(forbiddenExt.toLowerCase()) ||
      fileName === forbiddenExt.toLowerCase()) {
      return {
        allowed: false,
        level: 'warn',
        reason: `File nhạy cảm không được phép truy cập: ${fileName}`,
        resolved: normalizedResolved
      };
    }
  }

  // 3. Check WHITELIST - path phải nằm trong một allowed root
  const isAllowed = ALLOWED_ROOTS.some(root => isPathInside(resolved, root));

  if (!isAllowed) {
    return {
      allowed: false,
      level: 'warn',
      reason: `Path nằm ngoài vùng cho phép. Các thư mục được phép:\n  - ${ALLOWED_ROOTS.join('\n  - ')}`,
      resolved: normalizedResolved
    };
  }

  return {
    allowed: true,
    resolved: normalizedResolved,
    level: 'safe'
  };
}

export function printPathWarning(validation, inputPath) {
  if (validation.level === 'danger') {
    console.log(chalk.red.bold(`
╔══════════════════════════════════════════════════════════╗`));
    console.log(chalk.red.bold(`║  🚨 BLOCKED: PATH BỊ CHẶN VÌ LÝ DO BẢO MẬT              ║`));
    console.log(chalk.red.bold(`╚══════════════════════════════════════════════════════════╝`));
    console.log(chalk.yellow(`Input:   `) + chalk.white(inputPath));
    console.log(chalk.yellow(`Resolved:`) + chalk.white(validation.resolved || 'N/A'));
    console.log(chalk.yellow(`Lý do:   `) + chalk.red(validation.reason));
  } else if (validation.level === 'warn') {
    console.log(chalk.yellow(`
⚠️  Path bị chặn: ${chalk.white(inputPath)}`));
    console.log(chalk.gray(`   Lý do: ${validation.reason}`));
  }
}

export function addAllowedRoot(newRoot) {
  const normalized = normalizePath(newRoot);
  if (!ALLOWED_ROOTS.includes(normalized)) {
    ALLOWED_ROOTS.push(normalized);
    console.log(chalk.green(`[PathGuard] ✅ Đã thêm vào whitelist: ${normalized}`));
  }
}

export function getAllowedRoots() {
  return [...ALLOWED_ROOTS];
}

export default {
  validatePath,
  printPathWarning,
  addAllowedRoot,
  getAllowedRoots,
  ALLOWED_ROOTS,
  FORBIDDEN_PATHS,
  FORBIDDEN_EXTENSIONS
};