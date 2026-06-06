// ridge_server/skills/validators/shadow_file.js
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const SHADOW_DIR = path.join(process.cwd(), '.agent_memory', 'shadows');

if (!fs.existsSync(SHADOW_DIR)) {
  fs.mkdirSync(SHADOW_DIR, { recursive: true });
}

/**
 * Chụp snapshot file trước khi sửa
 */
export function createShadow(originalPath) {
  const shadowId = randomUUID();
  const safeName = path.basename(originalPath).replace(/[^a-z0-9.-]/gi, '_');
  const shadowPath = path.join(SHADOW_DIR, `${shadowId}_${safeName}`);

  let hadOriginal = false;
  if (fs.existsSync(originalPath)) {
    fs.copyFileSync(originalPath, shadowPath);
    hadOriginal = true;
  }

  return {
    shadowId,
    shadowPath,
    hadOriginal,
    restore: () => {
      if (hadOriginal && fs.existsSync(shadowPath)) {
        fs.copyFileSync(shadowPath, originalPath);
        console.log(`[Shadow] ↩️  Đã khôi phục file về bản gốc: ${originalPath}`);
        return true;
      } else if (!hadOriginal && fs.existsSync(originalPath)) {
        fs.unlinkSync(originalPath);
        console.log(`[Shadow] 🗑️  Đã xóa file mới tạo khi rollback: ${originalPath}`);
        return true;
      }
      return false;
    },
    cleanup: () => {
      try {
        if (fs.existsSync(shadowPath)) {
          fs.unlinkSync(shadowPath);
        }
      } catch { }
    }
  };
}

/**
 * Tự động dọn các shadow cũ (>24h)
 */
export function cleanupOldShadows(maxAgeHours = 24) {
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  try {
    const files = fs.readdirSync(SHADOW_DIR);
    let cleaned = 0;
    for (const f of files) {
      const fp = path.join(SHADOW_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fp);
        cleaned++;
      }
    }
    return cleaned;
  } catch { return 0; }
}

/**
 * 🛡️ SHADOW TRANSACTION REGISTRY
 * Lưu giữ trạng thái gốc ban đầu (Trạng thái 0) phục vụ Rollback toàn phiên
 */
export const activeShadowRegistry = {
  shadows: new Map(),

  register(filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (this.shadows.has(normalizedPath)) {
      return; // Bản gốc đã được sao lưu từ trước, bỏ qua
    }

    const shadow = createShadow(normalizedPath);
    this.shadows.set(normalizedPath, shadow);
    console.log(`[ShadowRegistry] 🛡️ Đã tạo điểm khôi phục gốc cho: ${normalizedPath}`);
  },

  rollbackAll() {
    console.log(`[ShadowRegistry] ↩️  Tiến hành khôi phục toàn bộ mã nguồn về nguyên bản...`);
    for (const [filePath, shadow] of this.shadows.entries()) {
      try {
        shadow.restore();
        shadow.cleanup();
      } catch (err) {
        console.error(`[ShadowRegistry] Lỗi khi khôi phục ${filePath}:`, err.message);
      }
    }
    this.shadows.clear();
    console.log(`[ShadowRegistry] 🎉 Hoàn tất Rollback.`);
  },

  commitAll() {
    console.log(`[ShadowRegistry] 🧹 Đang giải phóng các file sao lưu tạm...`);
    for (const [filePath, shadow] of this.shadows.entries()) {
      shadow.cleanup();
    }
    this.shadows.clear();
    console.log(`[ShadowRegistry] 🎉 Hoàn tất dọn dẹp.`);
  }
};

/**
 * 🛡️ PENULTIMATE SHADOW REGISTRY
 * Lưu giữ trạng thái cận kề (Trạng thái N-1) phục vụ so sánh lượt sửa gần nhất
 */
export const penultimateShadowRegistry = {
  shadows: new Map(),

  register(filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    // Luôn ghi đè bản ghi mới nhất ngay trước khi ghi đè file
    if (this.shadows.has(normalizedPath)) {
      this.shadows.get(normalizedPath).cleanup();
    }
    const shadow = createShadow(normalizedPath);
    this.shadows.set(normalizedPath, shadow);
    console.log(`[PenultimateShadow] 🛡️ Đã cập nhật điểm khôi phục gần nhất cho: ${normalizedPath}`);
  },

  cleanupAll() {
    for (const shadow of this.shadows.values()) {
      shadow.cleanup();
    }
    this.shadows.clear();
  }
};