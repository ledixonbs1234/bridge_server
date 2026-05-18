import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../database.js';
// Fix lỗi __dirname trong ES Module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
    "memorize_lesson": {
        description: "[QUAN TRỌNG] Gọi hàm này NGAY LẬP TỨC khi bạn vừa giải quyết xong một lỗi khó, hoặc khi người dùng nhắc nhở bạn một thói quen (VD: dùng pnpm thay vì npm). Khắc sâu bài học để lần sau không mắc lại.",
        parameters: {
            type: "object",
            properties: {
                tags: {
                    type: "array",
                    items: { type: "string" },
                    description: "3-5 từ khóa luôn ưu tiên TIẾNG VIỆT hoặc tiếng anh nếu đó là danh từ ví dụ react (VD: ['react', 'lỗi', 'tràn_bộ_nhớ'])"
                },
                situation: {
                    type: "string",
                    description: "Mô tả ngắn gọn vấn đề đã gặp (VD: 'Build dự án React bị lỗi Out of Memory')"
                },
                solution: {
                    type: "string",
                    description: "Cách bạn đã giải quyết, viết RẤT NGẮN GỌN (VD: 'Thêm cờ --max-old-space-size=4096 vào package.json')"
                }
            },
            required: ["tags", "situation", "solution"]
        },
        handler: async (args) => {
            const id = Date.now().toString();
            const date = new Date().toISOString();
            
            // Chuyển mảng tags thành chuỗi JSON để lưu vào DB
            const tagsJson = JSON.stringify(args.tags || []);

            // Lưu vào SQLite (với trust_score mặc định 0.7 — Hermes Trust Score)
            const stmt = db.prepare(`
                INSERT INTO memories (id, date, tags, situation, solution, trust_score, use_count) 
                VALUES (?, ?, ?, ?, ?, 0.7, 0)
            `);
            
            stmt.run(id, date, tagsJson, args.situation, args.solution);

            console.log(`\n[🧠 Memory] AI vừa ghi nhớ vào Database: [${(args.tags || []).join(', ')}] (Trust: 0.70)`);

            // 🧠 AUTO-EMBED: Tự động tạo vector embedding cho bài học (async, không block)
            (async () => {
                try {
                    // Dynamic import config để lấy Gemini API key
                    const configPath = path.join(__dirname, '..', 'config.json');
                    if (!fs.existsSync(configPath)) return;
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    const apiKey = config.providers?.['gemini-api']?.apiKey;
                    if (!apiKey) return;

                    const textToEmbed = `${args.situation} ${args.solution}`;
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            content: { parts: [{ text: textToEmbed }] },
                            taskType: 'RETRIEVAL_DOCUMENT'
                        })
                    });
                    if (!response.ok) return;
                    const data = await response.json();
                    const embedding = data.embedding?.values;
                    if (embedding) {
                        db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(JSON.stringify(embedding), id);
                        console.log(`[🧠 Memory] ✅ Đã tạo embedding vector (${embedding.length} dims) cho bài học #${id}`);
                    }
                } catch (e) {
                    // Embedding thất bại không ảnh hưởng đến việc lưu memory
                }
            })();

            return { status: "success", memory_id: id, message: "Đã khắc sâu vào Database cục bộ (Trust Score: 0.70)." };
        }
    },

    "rate_memory": {
        description: "[HỆ THỐNG NỘI BỘ] Đánh giá lại một bài học đã lưu. Nếu bài học đã GIÚP ÍCH (fix lỗi thành công), hãy gọi với outcome='success'. Nếu bài học SAI HƯỚNG (áp dụng mà vẫn lỗi), hãy gọi với outcome='fail'. Hệ thống sẽ tự điều chỉnh Trust Score.",
        parameters: {
            type: "object",
            properties: {
                memory_id: {
                    type: "string",
                    description: "ID của bài học cần đánh giá (lấy từ trường memory_id khi gọi memorize_lesson hoặc từ kết quả tìm kiếm bộ nhớ)."
                },
                outcome: {
                    type: "string",
                    enum: ["success", "fail"],
                    description: "'success' nếu bài học đã giúp fix lỗi. 'fail' nếu áp dụng bài học mà vẫn lỗi."
                }
            },
            required: ["memory_id", "outcome"]
        },
        handler: async (args) => {
            const { memory_id, outcome } = args;

            // Lấy memory hiện tại
            const row = db.prepare(`SELECT id, trust_score, use_count, situation FROM memories WHERE id = ?`).get(memory_id);
            if (!row) {
                return { status: "error", error_message: `Không tìm thấy bài học với ID: ${memory_id}` };
            }

            let newScore = row.trust_score ?? 0.7;
            let newCount = (row.use_count ?? 0) + 1;

            if (outcome === 'success') {
                newScore = Math.min(1.0, newScore + 0.1); // Tăng 0.1, max 1.0
            } else {
                newScore = Math.max(0.0, newScore - 0.15); // Giảm 0.15, min 0.0
            }

            // Round to 2 decimals
            newScore = Math.round(newScore * 100) / 100;

            db.prepare(`UPDATE memories SET trust_score = ?, use_count = ? WHERE id = ?`)
                .run(newScore, newCount, memory_id);

            const emoji = outcome === 'success' ? '📈' : '📉';
            console.log(`\n[🧠 Memory] ${emoji} Trust Score cập nhật: "${row.situation}" → ${newScore} (Dùng: ${newCount} lần)`);

            return {
                status: "success",
                memory_id,
                new_trust_score: newScore,
                use_count: newCount,
                message: `Đã ${outcome === 'success' ? 'tăng' : 'giảm'} Trust Score thành ${newScore}.`
            };
        }
    },

    "memorize_rule": {
        description: "[QUAN TRỌNG] Lưu lại một NGUYÊN TẮC, SỞ THÍCH hoặc QUY CHUẨN CODE của User (VD: 'Luôn dùng Tailwind', 'Chỉ dùng arrow function').",
        parameters: {
            type: "object",
            properties: {
                domain: { 
                    type: "string", 
                    description: "Phạm vi áp dụng. Ghi 'global' nếu là nguyên tắc chung. Nếu là công nghệ cụ thể, ghi tên công nghệ (VD: 'react', 'nodejs', 'sql', 'css')." 
                },
                rule: { 
                    type: "string", 
                    description: "Nội dung quy tắc cần nhớ (Viết ngắn gọn)." 
                }
            },
            required: ["domain", "rule"]
        },
        handler: async (args) => {
           const memoryDir = path.join(__dirname, '..', '.agent_memory');
            const rulesDir = path.join(memoryDir, 'rules');
            
            // Tạo thư mục rules/ nếu chưa có
            if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true });

            const safeDomain = args.domain.toLowerCase().replace(/[^a-z0-9]/g, '');
            const fileName = safeDomain === 'global' ? 'rules_global.md' : `${safeDomain}.md`;
            const filePath = path.join(rulesDir, fileName);

            let content = "";
            if (fs.existsSync(filePath)) content = fs.readFileSync(filePath, 'utf8') + "\n";
            content += `- ${args.rule}`;

            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`\n[🧠 Memory] AI vừa ghi nhớ quy tắc mới cho ngữ cảnh: \x1b[36m${args.domain.toUpperCase()}\x1b[0m`);
            return { status: "success", message: `Đã lưu quy tắc vĩnh viễn vào bộ nhớ (File: ${fileName}).` };
        }
    }
};