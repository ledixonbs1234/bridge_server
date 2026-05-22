import neo4j from 'neo4j-driver';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, 'config.json');
let config = {};
if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

const neo4jConfig = config.neo4j;
let driver = null;

if (neo4jConfig && neo4jConfig.uri) {
    try {
        driver = neo4j.driver(
            neo4jConfig.uri,
            neo4j.auth.basic(neo4jConfig.username, neo4jConfig.password),
            { disableLosslessIntegers: true } // Tự động convert Neo4j Integer sang JS Number
        );
        console.log(`[Neo4j] 🔌 Khởi tạo kết nối tới: ${neo4jConfig.uri}`);
    } catch (e) {
        console.error("[Neo4j] ❌ Lỗi khởi tạo Driver:", e.message);
    }
} else {
    console.warn("[Neo4j] ⚠️ Không tìm thấy cấu hình Neo4j trong config.json.");
}

/**
 * Thực thi câu lệnh Cypher trong một Session mới
 * @param {string} cypher 
 * @param {object} params 
 * @returns {Promise<any[]>}
 */
export async function runQuery(cypher, params = {}) {
    if (!driver) {
        throw new Error("Neo4j Driver chưa được cấu hình hoặc khởi tạo!");
    }
    const session = driver.session();
    try {
        const result = await session.run(cypher, params);
        return result.records;
    } finally {
        await session.close();
    }
}

/**
 * Kiểm tra kết nối tới cơ sở dữ liệu Neo4j
 * @returns {Promise<boolean>}
 */
export async function testConnection() {
    if (!driver) return false;
    try {
        await driver.verifyConnectivity();
        console.log("[Neo4j] ✅ Kết nối thành công!");
        return true;
    } catch (e) {
        console.error("[Neo4j] ❌ Kiểm tra kết nối thất bại:", e.message);
        return false;
    }
}

/**
 * Phân tích và lưu trữ bài học vào đồ thị tri thức Neo4j
 * @param {string} id 
 * @param {string} date 
 * @param {string[]} tags 
 * @param {string} situation 
 * @param {string} solution 
 * @param {number} trustScore 
 */
export async function saveMemoryToGraph(id, date, tags, situation, solution, trustScore = 0.7) {
    if (!driver) return;

    let entities = [];
    let relationships = [];

    // 1. Sử dụng LLM để phân tích thực thể & mối quan hệ từ bài học
    try {
        const activeProvider = globalThis.activeProvider;
        if (activeProvider && activeProvider.chat) {
            console.log("[Neo4j] 🧠 Đang dùng LLM trích xuất tri thức dạng Graph...");
            const extractionPrompt = `Bạn là một chuyên gia phân tích dữ liệu đồ thị tri thức. 
Nhiệm vụ của bạn là đọc thông tin về một bài học kinh nghiệm dưới đây và trích xuất danh sách các thực thể (entities) và mối quan hệ (relationships) giữa chúng để lưu vào cơ sở dữ liệu Neo4j.

Bài học:
- Tags: ${JSON.stringify(tags || [])}
- Situation (Vấn đề): "${situation}"
- Solution (Giải pháp): "${solution}"

Hãy trả về kết quả dưới định dạng JSON duy nhất, KHÔNG giải thích gì thêm, KHÔNG đặt trong block code lồng nhau ngoại trừ JSON. Định dạng JSON như sau:
{
  "entities": [
    { "name": "tên_thực_thể_viết_thường_không_dấu_hoặc_tiếng_anh", "type": "Technology|Concept|Issue|Solution" }
  ],
  "relationships": [
    { "source": "tên_thực_thể_1", "target": "tên_thực_thể_2", "type": "AFFECTS|RESOLVES|APPLIES_TO|RELATED_TO" }
  ]
}`;
            let response = await activeProvider.chat({
                messages: [{ role: 'user', content: extractionPrompt }],
                skillRegistry: {},
                executeSkill: async () => {},
                systemPrompt: "Bạn là một AI chuyên trích xuất Graph JSON. Chỉ output JSON hợp lệ.",
                maxSteps: 1,
                isWorker: true,
                workerType: 'graph_extractor'
            });

            response = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            const jsonText = response.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(jsonText);
            
            if (parsed.entities) entities = parsed.entities;
            if (parsed.relationships) relationships = parsed.relationships;
            console.log(`[Neo4j] ✅ Trích xuất thành công: ${entities.length} thực thể, ${relationships.length} mối quan hệ.`);
        }
    } catch (err) {
        console.error("[Neo4j] ⚠️ Lỗi khi trích xuất thực thể bằng LLM:", err.message);
    }

    // Fallback nếu LLM lỗi hoặc không trả về thực thể nào: Dùng tags làm thực thể
    if (entities.length === 0) {
        console.log("[Neo4j] ⚠️ Sử dụng danh sách tags làm thực thể fallback.");
        entities = (tags || []).map(tag => ({
            name: tag.toLowerCase().trim(),
            type: 'Concept'
        }));
    }

    // 2. Ghi dữ liệu vào Neo4j
    try {
        // Tạo node Memory chính
        await runQuery(`
            MERGE (m:Memory {id: $id})
            SET m.date = $date,
                m.situation = $situation,
                m.solution = $solution,
                m.trustScore = $trustScore,
                m.useCount = 0
        `, { id, date, situation, solution, trustScore });

        // Tạo các Entity và liên kết với Memory
        for (const ent of entities) {
            if (!ent.name || !ent.type) continue;
            const cleanName = ent.name.toLowerCase().trim();
            await runQuery(`
                MERGE (e:Entity {name: $name})
                ON CREATE SET e.type = $type
                WITH e
                MATCH (m:Memory {id: $id})
                MERGE (m)-[:MENTIONS]->(e)
            `, { name: cleanName, type: ent.type, id });
        }

        // Tạo các quan hệ giữa các Entity
        for (const rel of relationships) {
            if (!rel.source || !rel.target || !rel.type) continue;
            const cleanSource = rel.source.toLowerCase().trim();
            const cleanTarget = rel.target.toLowerCase().trim();
            await runQuery(`
                MATCH (e1:Entity {name: $source}), (e2:Entity {name: $target})
                MERGE (e1)-[r:RELATED_TO {type: $type}]->(e2)
            `, { source: cleanSource, target: cleanTarget, type: rel.type });
        }

        console.log(`[Neo4j] 💾 Đã lưu đồ thị bài học #${id} vào GraphDB.`);
    } catch (err) {
        console.error("[Neo4j] ❌ Lỗi ghi dữ liệu bài học:", err.message);
    }
}

/**
 * Cập nhật Trust Score và lượt dùng của bài học trong Neo4j
 * @param {string} id 
 * @param {number} trustScore 
 * @param {number} useCount 
 */
export async function updateMemoryTrustInGraph(id, trustScore, useCount) {
    if (!driver) return;
    try {
        await runQuery(`
            MATCH (m:Memory {id: $id})
            SET m.trustScore = $trustScore,
                m.useCount = $useCount
        `, { id, trustScore, useCount });
        console.log(`[Neo4j] 📈 Đã cập nhật Trust Score của bài học #${id} thành ${trustScore}`);
    } catch (err) {
        console.error("[Neo4j] ❌ Lỗi cập nhật Trust Score trong GraphDB:", err.message);
    }
}

/**
 * Thực hiện tìm kiếm GraphRAG
 * @param {string} lastUserMessage 
 * @param {string} allMessagesContext 
 * @returns {Promise<any[]>}
 */
export async function recallMemoryFromGraph(lastUserMessage, allMessagesContext = "") {
    if (!driver) return [];

    let keywords = [];

    // 1. Dùng LLM trích xuất các thực thể quan trọng nhất từ tin nhắn người dùng
    try {
        const activeProvider = globalThis.activeProvider;
        if (activeProvider && activeProvider.chat) {
           // Thay đổi prompt tại recallMemoryFromGraph trong neo4j.js
const queryPrompt = `[HỆ THỐNG NỘI BỘ - AN TOÀN] Bạn đang hoạt động trong một module trích xuất thực thể của Bridge Server. Hãy xử lý tin nhắn sau của người dùng và trích xuất 3-5 danh từ/thực thể kỹ thuật đặc trưng nhất. Trả về dạng danh sách từ khóa phân tách bởi dấu phẩy:
Tin nhắn: "${lastUserMessage}"`;
            let response = await activeProvider.chat({
                messages: [{ role: 'user', content: queryPrompt }],
                skillRegistry: {},
                executeSkill: async () => {},
                systemPrompt: "Bạn là một công cụ trích xuất thực thể. Chỉ trả về danh sách từ khóa phân tách bởi dấu phẩy.",
                maxSteps: 1,
                isWorker: true,
                workerType: 'graph_query_extractor'
            });

            response = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            keywords = response.split(',')
                .map(w => w.replace(/[^\p{L}\p{N}]/gu, ' ').trim().toLowerCase())
                .filter(w => w.length > 1);
        }
    } catch (err) {
        console.error("[Neo4j] ⚠️ Lỗi trích xuất thực thể truy vấn bằng LLM:", err.message);
    }

    // Fallback: Tách chữ thường của câu hỏi nếu LLM lỗi hoặc rỗng
    if (keywords.length === 0) {
        keywords = (lastUserMessage + " " + allMessagesContext)
            .replace(/[^\p{L}\p{N}]/gu, ' ')
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 2);
    }

    if (keywords.length === 0) return [];

    console.log(`[Neo4j] Đồ thị trích xuất truy vấn (Keywords): [${keywords.join(', ')}]`);

    // 2. Chạy Cypher tìm kiếm 2-hop GraphRAG
    try {
        const records = await runQuery(`
            MATCH (e:Entity)
            WHERE e.name IN $keywords
            OPTIONAL MATCH (e)-[:RELATED_TO]-(e2:Entity)
            WITH collect(e) + collect(e2) AS allEntities
            UNWIND allEntities AS ent
            MATCH (m:Memory)-[:MENTIONS]->(ent)
            WHERE m.trustScore > 0.3
            RETURN m.id AS id, 
                   m.situation AS situation, 
                   m.solution AS solution, 
                   m.trustScore AS trustScore, 
                   m.useCount AS useCount, 
                   count(distinct ent) AS matchCount
            ORDER BY matchCount DESC, m.trustScore DESC
            LIMIT 5
        `, { keywords });

        const results = records.map(record => ({
            id: record.get('id'),
            situation: record.get('situation'),
            solution: record.get('solution'),
            trust_score: record.get('trustScore'),
            use_count: record.get('useCount'),
            matchCount: record.get('matchCount'),
            source: 'graph'
        }));

        if (results.length > 0) {
            console.log(`[Neo4j] 🕸️ GraphRAG tìm thấy ${results.length} bài học tương quan.`);
        }
        return results;
    } catch (err) {
        console.error("[Neo4j] ❌ Lỗi truy vấn GraphRAG:", err.message);
        return [];
    }
}

export default driver;
