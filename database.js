// database.js - Phiên bản đầy đủ
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const memoryDir = path.join(__dirname, '.agent_memory');
if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

const dbPath = path.join(memoryDir, 'agent_state.json');

// =================================================================
// 💾 DATABASE STORAGE - Cấu trúc đầy đủ cho tất cả các bảng
// =================================================================
let dbData = {
  memories: [],
  pipelines: [],
  agent_states: [],
  traces: [],
  trace_spans: [],
  tool_telemetry: []
};

// Auto-increment counters
let autoIncrements = {
  memories: 1,
  pipelines: 1,
  agent_states: 1,
  traces: 1,
  trace_spans: 1,
  tool_telemetry: 1
};

function loadDb() {
  try {
    if (fs.existsSync(dbPath)) {
      const loaded = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      dbData = { ...dbData, ...loaded };
      // Khôi phục auto-increment từ ID lớn nhất
      for (const table of Object.keys(autoIncrements)) {
        if (Array.isArray(dbData[table]) && dbData[table].length > 0) {
          const maxId = Math.max(...dbData[table]
            .map(r => typeof r.id === 'number' ? r.id : 0)
            .filter(n => !isNaN(n)));
          if (maxId >= autoIncrements[table]) {
            autoIncrements[table] = maxId + 1;
          }
        }
      }
    }
  } catch (e) {
    console.warn('[DB] Load error:', e.message);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(dbData, null, 2), 'utf8');
  } catch (e) {
    console.error('[DB] Save error:', e.message);
  }
}

loadDb();

// =================================================================
// 🔍 SQL PARSER - Phân tích câu lệnh SQL đơn giản
// =================================================================

/**
 * Parse mệnh đề WHERE thành hàm filter
 * Hỗ trợ: =, !=, <, >, <=, >=, AND
 */
function parseWhere(whereClause, params, paramOffset) {
  if (!whereClause || !whereClause.trim()) {
    return { filter: () => true, paramCount: 0 };
  }

  const conditions = [];
  let idx = paramOffset;
  
  // Tách theo AND
  const parts = whereClause.split(/\s+AND\s+/i);
  
  for (const part of parts) {
    const trimmed = part.trim();
    
    // Match: column operator ?
    const match = trimmed.match(/^(\w+)\s*(=|!=|<>|<=|>=|<|>)\s*\?$/i);
    if (match) {
      const [, column, operator] = match;
      const value = params[idx++];
      conditions.push({ column, operator, value });
      continue;
    }
    
    // Match: column operator literal (string hoặc number)
    const literalMatch = trimmed.match(/^(\w+)\s*(=|!=|<>|<=|>=|<|>)\s*('([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))$/i);
    if (literalMatch) {
      const [, column, operator, , strVal1, strVal2, numVal] = literalMatch;
      const value = strVal1 !== undefined ? strVal1 : (strVal2 !== undefined ? strVal2 : parseFloat(numVal));
      conditions.push({ column, operator, value });
      continue;
    }
  }
  
  const filter = (row) => {
    return conditions.every(({ column, operator, value }) => {
      const rowVal = row[column];
      switch (operator) {
        case '=': return rowVal == value;
        case '!=': case '<>': return rowVal != value;
        case '<': return rowVal < value;
        case '>': return rowVal > value;
        case '<=': return rowVal <= value;
        case '>=': return rowVal >= value;
        default: return true;
      }
    });
  };
  
  return { filter, paramCount: idx - paramOffset };
}

/**
 * Parse mệnh đề SET của UPDATE
 * Hỗ trợ: column = ?, column = column + 1, column = literal
 */
function parseSet(setClause, params, paramOffset) {
  const updates = [];
  let idx = paramOffset;
  
  // Tách các assignments bởi dấu phẩy (cẩn thận với string có dấu phẩy)
  const parts = [];
  let current = '';
  let depth = 0;
  for (const char of setClause) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  
  for (const part of parts) {
    // column = ?
    const placeholderMatch = part.match(/^(\w+)\s*=\s*\?$/);
    if (placeholderMatch) {
      updates.push({ column: placeholderMatch[1], type: 'param', paramIndex: idx++ });
      continue;
    }
    
    // column = column + N hoặc column = column - N
    const incrementMatch = part.match(/^(\w+)\s*=\s*\1\s*([+-])\s*(\d+(?:\.\d+)?)$/);
    if (incrementMatch) {
      updates.push({ 
        column: incrementMatch[1], 
        type: 'increment', 
        delta: (incrementMatch[2] === '+' ? 1 : -1) * parseFloat(incrementMatch[3]) 
      });
      continue;
    }
    
    // column = 'literal' hoặc column = number
    const literalMatch = part.match(/^(\w+)\s*=\s*('([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))$/);
    if (literalMatch) {
      const [, column, , strVal1, strVal2, numVal] = literalMatch;
      const value = strVal1 !== undefined ? strVal1 : (strVal2 !== undefined ? strVal2 : parseFloat(numVal));
      updates.push({ column, type: 'literal', value });
      continue;
    }
  }
  
  return { updates, paramCount: idx - paramOffset };
}

// =================================================================
// 🗄️ DATABASE INTERFACE - Chuẩn bị statement
// =================================================================

const db = {
  exec(sql) {
    // CREATE TABLE / CREATE INDEX - chỉ log, không cần làm gì với JSON
    return;
  },
  
  prepare(sql) {
    const sqlLower = sql.toLowerCase().trim();
    const sqlNorm = sql.replace(/\s+/g, ' ').trim();
    
    return {
      // ============ RUN (INSERT / UPDATE / DELETE) ============
      run(...params) {
        try {
          // -------- INSERT OR REPLACE INTO pipelines --------
          if (sqlLower.includes('insert or replace into pipelines')) {
            const [id, name, status, data] = params;
            const existingIdx = dbData.pipelines.findIndex(p => p.id === id);
            const record = {
              id, name, status, data,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            };
            if (existingIdx >= 0) {
              dbData.pipelines[existingIdx] = { ...dbData.pipelines[existingIdx], ...record };
            } else {
              dbData.pipelines.push(record);
            }
            saveDb();
            return { changes: 1 };
          }
          
          // -------- INSERT OR REPLACE INTO agent_states --------
          if (sqlLower.includes('insert or replace into agent_states')) {
            const [pipeline_id, step_key, state, retry_count, error_history, updated_at] = params;
            const existingIdx = dbData.agent_states.findIndex(
              s => s.pipeline_id === pipeline_id && s.step_key === step_key
            );
            const record = {
              pipeline_id, step_key, state, retry_count, error_history, updated_at,
              summary: null,
              last_executor_output: null
            };
            if (existingIdx >= 0) {
              dbData.agent_states[existingIdx] = { ...dbData.agent_states[existingIdx], ...record };
            } else {
              record.id = autoIncrements.agent_states++;
              dbData.agent_states.push(record);
            }
            saveDb();
            return { changes: 1 };
          }
          
          // -------- INSERT INTO traces --------
          if (sqlLower.startsWith('insert into traces')) {
            const [id, name, pipeline_id, status, created_at] = params;
            dbData.traces.push({ id, name, pipeline_id, status, created_at });
            saveDb();
            return { changes: 1 };
          }
          
          // -------- INSERT INTO trace_spans --------
          if (sqlLower.startsWith('insert into trace_spans')) {
            const [id, trace_id, parent_span_id, name, type, status, started_at, input] = params;
            dbData.trace_spans.push({ id, trace_id, parent_span_id, name, type, status, started_at, input });
            saveDb();
            return { changes: 1 };
          }
          
          // -------- INSERT INTO memories --------
          if (sqlLower.startsWith('insert into memories')) {
            const [id, date, tags, situation, solution, trust_score, use_count] = params;
            dbData.memories.push({ 
              id: id || autoIncrements.memories++, 
              date, tags, situation, solution, trust_score, use_count 
            });
            saveDb();
            return { changes: 1, lastInsertRowid: dbData.memories.length };
          }
          
          // -------- INSERT INTO tool_telemetry --------
          if (sqlLower.startsWith('insert into tool_telemetry')) {
            const [tool_name, timestamp, success, duration_ms, error_message] = params;
            dbData.tool_telemetry.push({
              id: autoIncrements.tool_telemetry++,
              tool_name, timestamp, success, duration_ms, error_message
            });
            saveDb();
            return { changes: 1, lastInsertRowid: dbData.tool_telemetry.length };
          }
          
          // -------- UPDATE pipelines --------
          if (sqlLower.startsWith('update pipelines')) {
            // UPDATE pipelines SET data = ?, status = ? WHERE id = ?
            const setMatch = sqlNorm.match(/SET\s+(.+?)\s+WHERE\s+(.+)$/i);
            if (!setMatch) return { changes: 0 };
            
            const { updates, paramCount: setParamCount } = parseSet(setMatch[1], params, 0);
            const { filter } = parseWhere(setMatch[2], params, setParamCount);
            
            let changes = 0;
            for (const row of dbData.pipelines) {
              if (filter(row)) {
                for (const upd of updates) {
                  if (upd.type === 'param') row[upd.column] = params[upd.paramIndex];
                  else if (upd.type === 'literal') row[upd.column] = upd.value;
                  else if (upd.type === 'increment') row[upd.column] = (row[upd.column] || 0) + upd.delta;
                }
                changes++;
              }
            }
            if (changes > 0) saveDb();
            return { changes };
          }
          
          // -------- UPDATE agent_states --------
          if (sqlLower.startsWith('update agent_states')) {
            const setMatch = sqlNorm.match(/SET\s+(.+?)\s+WHERE\s+(.+)$/i);
            if (!setMatch) return { changes: 0 };
            
            const { updates, paramCount: setParamCount } = parseSet(setMatch[1], params, 0);
            const { filter } = parseWhere(setMatch[2], params, setParamCount);
            
            let changes = 0;
            for (const row of dbData.agent_states) {
              if (filter(row)) {
                for (const upd of updates) {
                  if (upd.type === 'param') row[upd.column] = params[upd.paramIndex];
                  else if (upd.type === 'literal') row[upd.column] = upd.value;
                  else if (upd.type === 'increment') row[upd.column] = (row[upd.column] || 0) + upd.delta;
                }
                changes++;
              }
            }
            if (changes > 0) saveDb();
            return { changes };
          }
          
          // -------- UPDATE traces --------
          if (sqlLower.startsWith('update traces')) {
            const setMatch = sqlNorm.match(/SET\s+(.+?)\s+WHERE\s+(.+)$/i);
            if (!setMatch) return { changes: 0 };
            
            const { updates, paramCount: setParamCount } = parseSet(setMatch[1], params, 0);
            const { filter } = parseWhere(setMatch[2], params, setParamCount);
            
            let changes = 0;
            for (const row of dbData.traces) {
              if (filter(row)) {
                for (const upd of updates) {
                  if (upd.type === 'param') row[upd.column] = params[upd.paramIndex];
                  else if (upd.type === 'literal') row[upd.column] = upd.value;
                  else if (upd.type === 'increment') row[upd.column] = (row[upd.column] || 0) + upd.delta;
                }
                changes++;
              }
            }
            if (changes > 0) saveDb();
            return { changes };
          }
          
          // -------- UPDATE trace_spans --------
          if (sqlLower.startsWith('update trace_spans')) {
            const setMatch = sqlNorm.match(/SET\s+(.+?)\s+WHERE\s+(.+)$/i);
            if (!setMatch) return { changes: 0 };
            
            const { updates, paramCount: setParamCount } = parseSet(setMatch[1], params, 0);
            const { filter } = parseWhere(setMatch[2], params, setParamCount);
            
            let changes = 0;
            for (const row of dbData.trace_spans) {
              if (filter(row)) {
                for (const upd of updates) {
                  if (upd.type === 'param') row[upd.column] = params[upd.paramIndex];
                  else if (upd.type === 'literal') row[upd.column] = upd.value;
                  else if (upd.type === 'increment') row[upd.column] = (row[upd.column] || 0) + upd.delta;
                }
                changes++;
              }
            }
            if (changes > 0) saveDb();
            return { changes };
          }
          
          // -------- UPDATE memories --------
          if (sqlLower.startsWith('update memories')) {
            const setMatch = sqlNorm.match(/SET\s+(.+?)\s+WHERE\s+(.+)$/i);
            if (!setMatch) return { changes: 0 };
            
            const { updates, paramCount: setParamCount } = parseSet(setMatch[1], params, 0);
            const { filter } = parseWhere(setMatch[2], params, setParamCount);
            
            let changes = 0;
            for (const row of dbData.memories) {
              if (filter(row)) {
                for (const upd of updates) {
                  if (upd.type === 'param') row[upd.column] = params[upd.paramIndex];
                  else if (upd.type === 'literal') row[upd.column] = upd.value;
                  else if (upd.type === 'increment') row[upd.column] = (row[upd.column] || 0) + upd.delta;
                }
                changes++;
              }
            }
            if (changes > 0) saveDb();
            return { changes };
          }
          
          return { changes: 0 };
        } catch (err) {
          console.error('[DB] RUN error:', err.message, '\nSQL:', sqlNorm);
          return { changes: 0 };
        }
      },
      
      // ============ GET (SELECT single row) ============
      get(...params) {
        try {
          // SELECT * FROM agent_states WHERE pipeline_id = ? AND step_key = ?
          if (sqlLower.includes('from agent_states') && sqlLower.includes('where')) {
            const whereMatch = sqlNorm.match(/WHERE\s+(.+)$/i);
            if (!whereMatch) return undefined;
            const { filter } = parseWhere(whereMatch[1], params, 0);
            return dbData.agent_states.find(filter) || undefined;
          }
          
          // SELECT data FROM pipelines WHERE id = ? AND status = ?
          if (sqlLower.includes('from pipelines') && sqlLower.includes('where')) {
            const whereMatch = sqlNorm.match(/WHERE\s+(.+)$/i);
            if (!whereMatch) return undefined;
            const { filter } = parseWhere(whereMatch[1], params, 0);
            return dbData.pipelines.find(filter) || undefined;
          }
          
          // SELECT * FROM traces WHERE id = ?
          if (sqlLower.includes('from traces') && !sqlLower.includes('trace_spans') && sqlLower.includes('where')) {
            const whereMatch = sqlNorm.match(/WHERE\s+(.+)$/i);
            if (!whereMatch) return undefined;
            const { filter } = parseWhere(whereMatch[1], params, 0);
            return dbData.traces.find(filter) || undefined;
          }
          
          // SELECT created_at FROM traces WHERE id = ?
          if (sqlLower.includes('select created_at from traces')) {
            const whereMatch = sqlNorm.match(/WHERE\s+(.+)$/i);
            if (!whereMatch) return undefined;
            const { filter } = parseWhere(whereMatch[1], params, 0);
            return dbData.traces.find(filter) || undefined;
          }
          
          // SELECT started_at FROM trace_spans WHERE id = ?
          if (sqlLower.includes('select started_at from trace_spans')) {
            const whereMatch = sqlNorm.match(/WHERE\s+(.+)$/i);
            if (!whereMatch) return undefined;
            const { filter } = parseWhere(whereMatch[1], params, 0);
            return dbData.trace_spans.find(filter) || undefined;
          }
          
          // SELECT * FROM memories WHERE id = ?
          if (sqlLower.includes('from memories') && sqlLower.includes('where id')) {
            const [id] = params;
            return dbData.memories.find(m => m.id === id) || undefined;
          }
          
          // SELECT ... FROM tool_telemetry WHERE tool_name = ?
          if (sqlLower.includes('from tool_telemetry') && sqlLower.includes('where tool_name')) {
            const [toolName] = params;
            const records = dbData.tool_telemetry?.filter(t => t.tool_name === toolName) || [];
            if (records.length === 0) return undefined;
            const total = records.length;
            const success_count = records.filter(r => r.success === 1).length;
            const fail_count = records.filter(r => r.success === 0).length;
            const avg_duration = records.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / total;
            return { total, success_count, fail_count, avg_duration };
          }
          
          return undefined;
        } catch (err) {
          console.error('[DB] GET error:', err.message, '\nSQL:', sqlNorm);
          return undefined;
        }
      },
      
      // ============ ALL (SELECT multiple rows) ============
      all(...params) {
        try {
          // SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC
          if (sqlLower.includes('from trace_spans') && sqlLower.includes('where trace_id')) {
            const [traceId] = params;
            let rows = dbData.trace_spans.filter(s => s.trace_id === traceId);
            if (sqlLower.includes('order by started_at asc')) {
              rows = rows.sort((a, b) => (a.started_at || '').localeCompare(b.started_at || ''));
            }
            return rows;
          }
          
          // SELECT t.*, (SELECT COUNT(*) ...) FROM traces t ORDER BY created_at DESC LIMIT ?
          if (sqlLower.includes('from traces') && sqlLower.includes('order by') && sqlLower.includes('limit')) {
            const [limit] = params;
            let rows = [...dbData.traces];
            if (sqlLower.includes('order by t.created_at desc') || sqlLower.includes('order by created_at desc')) {
              rows = rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
            }
            // Gắn span_count từ subquery
            rows = rows.map(t => ({
              ...t,
              span_count: dbData.trace_spans.filter(s => s.trace_id === t.id).length
            }));
            if (typeof limit === 'number') rows = rows.slice(0, limit);
            return rows;
          }
          
          // SELECT * FROM agent_states WHERE pipeline_id = ?
          if (sqlLower.includes('from agent_states') && sqlLower.includes('where pipeline_id')) {
            const [pipelineId] = params;
            return dbData.agent_states.filter(s => s.pipeline_id === pipelineId);
          }
          
          // SELECT ... FROM memories (với filter trust_score)
          if (sqlLower.includes('from memories')) {
            if (sqlLower.includes('trust_score') && sqlLower.includes('order by trust_score desc')) {
              // Top memories cho printTopMemories
              const limitMatch = sqlLower.match(/limit\s+(\d+)/);
              const limit = limitMatch ? parseInt(limitMatch[1]) : 100;
              return dbData.memories
                .filter(m => (m.trust_score ?? 0.7) > 0.3)
                .sort((a, b) => (b.trust_score || 0) - (a.trust_score || 0) || (b.use_count || 0) - (a.use_count || 0))
                .slice(0, limit);
            }
            return dbData.memories.filter(m => (m.trust_score ?? 0.7) > 0.3);
          }
          
          // SELECT ... FROM tool_telemetry GROUP BY tool_name
          if (sqlLower.includes('from tool_telemetry') && sqlLower.includes('group by tool_name')) {
            if (!dbData.tool_telemetry) return [];
            const grouped = {};
            for (const record of dbData.tool_telemetry) {
              const name = record.tool_name;
              if (!grouped[name]) {
                grouped[name] = { tool_name: name, total: 0, success_count: 0, fail_count: 0, sum_duration: 0 };
              }
              grouped[name].total++;
              if (record.success === 1) grouped[name].success_count++;
              else grouped[name].fail_count++;
              grouped[name].sum_duration += (record.duration_ms || 0);
            }
            return Object.values(grouped).map(g => ({
              tool_name: g.tool_name,
              total: g.total,
              success_count: g.success_count,
              fail_count: g.fail_count,
              avg_duration: g.total > 0 ? g.sum_duration / g.total : 0
            }));
          }
          
          return [];
        } catch (err) {
          console.error('[DB] ALL error:', err.message, '\nSQL:', sqlNorm);
          return [];
        }
      }
    };
  }
};

export default db;