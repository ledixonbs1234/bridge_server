// filepath: bridge_server/database.js
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const memoryDir = path.join(__dirname, '.agent_memory');
if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

const dbPath = path.join(memoryDir, 'agent_state.json');

// =================================================================
// 💾 DATABASE STORAGE - Cấu trúc bộ nhớ
// =================================================================
let dbData = {
  memories: [],
  memory_edges: [],
  pipelines: [],
  agent_states: [],
  traces: [],
  trace_spans: [],
  tool_telemetry: [],
  agent_templates: [] // Thêm thực thể lưu trữ Agent mẫu
};

// Đếm ID tự tăng
let autoIncrements = {
  memories: 1,
  memory_edges: 1,
  pipelines: 1,
  agent_states: 1,
  traces: 1,
  trace_spans: 1,
  tool_telemetry: 1,
  agent_templates: 1 // Khởi tạo ID tự tăng cho template
};

function loadDb() {
  try {
    if (fs.existsSync(dbPath)) {
      const loaded = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      dbData = { ...dbData, ...loaded };
      if (!dbData.memory_edges) dbData.memory_edges = [];
      if (!dbData.memories) dbData.memories = [];
      if (!dbData.agent_templates) dbData.agent_templates = [];

      // TỰ ĐỘNG DỌN DẸP: Lọc bỏ toàn bộ các bản ghi bộ nhớ bị lỗi/rỗng trường thông tin chính
      dbData.memories = dbData.memories.filter(m => {
        const hasSituation = m.situation && m.situation !== '—' && m.situation.trim() !== '';
        const hasSolution = m.solution && m.solution.trim() !== '';
        return hasSituation && hasSolution;
      });

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

      // Ghi lại tệp sạch sau khi dọn dẹp
      saveDb();
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
// 🔍 SQL PARSER
// =================================================================
function parseWhere(whereClause, params, paramOffset) {
  if (!whereClause || !whereClause.trim()) {
    return { filter: () => true, paramCount: 0 };
  }

  const conditions = [];
  let idx = paramOffset;
  const parts = whereClause.split(/\s+and\s+/i);

  for (const part of parts) {
    const trimmed = part.trim();
    const match = trimmed.match(/^(\w+)\s*(=|!=|<>|<=|>=|<|>)\s*\?$/i);
    if (match) {
      const [, column, operator] = match;
      const value = params[idx++];
      conditions.push({ column, operator, value });
      continue;
    }

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

function parseSet(setClause, params, paramOffset) {
  const updates = [];
  let idx = paramOffset;
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
    const placeholderMatch = part.match(/^(\w+)\s*=\s*\?$/);
    if (placeholderMatch) {
      updates.push({ column: placeholderMatch[1], type: 'param', paramIndex: idx++ });
      continue;
    }

    const incrementMatch = part.match(/^(\w+)\s*=\s*([+-])\s*(\d+(?:\.\d+)?)$/);
    if (incrementMatch) {
      updates.push({
        column: incrementMatch[1],
        type: 'increment',
        delta: (incrementMatch[2] === '+' ? 1 : -1) * parseFloat(incrementMatch[3])
      });
      continue;
    }

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

const db = {
  exec(sql) {
    return;
  },

  prepare(sql) {
    const sqlNorm = sql.replace(/\s+/g, ' ').trim();
    const sqlLower = sqlNorm.toLowerCase();

    return {
      run(...params) {
        try {
          if (sqlLower.startsWith('insert into memory_edges')) {
            const [source_id, target_id, type, weight] = params;
            const existingIdx = dbData.memory_edges.findIndex(
              e => e.source_id === source_id && e.target_id === target_id
            );
            const record = {
              source_id, target_id, type, weight,
              updated_at: new Date().toISOString()
            };
            if (existingIdx >= 0) {
              dbData.memory_edges[existingIdx] = { ...dbData.memory_edges[existingIdx], ...record };
            } else {
              record.id = autoIncrements.memory_edges++;
              dbData.memory_edges.push(record);
            }
            saveDb();
            return { changes: 1 };
          }

          if (sqlLower.startsWith('delete from pipelines')) {
            const whereMatch = sqlNorm.match(/where\s+(.+)$/i);
            if (whereMatch) {
              const { filter } = parseWhere(whereMatch[1], params, 0);
              const initialLength = dbData.pipelines.length;
              dbData.pipelines = dbData.pipelines.filter(row => !filter(row));
              const changes = initialLength - dbData.pipelines.length;
              if (changes > 0) saveDb();
              return { changes };
            } else {
              const changes = dbData.pipelines.length;
              dbData.pipelines = [];
              if (changes > 0) saveDb();
              return { changes };
            }
          }

          if (sqlLower.startsWith('delete from agent_states')) {
            const whereMatch = sqlNorm.match(/where\s+(.+)$/i);
            if (whereMatch) {
              const { filter } = parseWhere(whereMatch[1], params, 0);
              const initialLength = dbData.agent_states.length;
              dbData.agent_states = dbData.agent_states.filter(row => !filter(row));
              const changes = initialLength - dbData.agent_states.length;
              if (changes > 0) saveDb();
              return { changes };
            } else {
              const changes = dbData.agent_states.length;
              dbData.agent_states = [];
              if (changes > 0) saveDb();
              return { changes };
            }
          }

          if (sqlLower.startsWith('delete from memories')) {
            const whereMatch = sqlNorm.match(/where\s+(.+)$/i);
            if (whereMatch) {
              const { filter } = parseWhere(whereMatch[1], params, 0);
              const initialLength = dbData.memories.length;
              dbData.memories = dbData.memories.filter(row => !filter(row));
              const changes = initialLength - dbData.memories.length;
              if (changes > 0) saveDb();
              return { changes };
            } else {
              const changes = dbData.memories.length;
              dbData.memories = [];
              if (changes > 0) saveDb();
              return { changes };
            }
          }

          // SQLite Simulator: Xử lý xóa mẫu Agent
          if (sqlLower.startsWith('delete from agent_templates')) {
            const whereMatch = sqlNorm.match(/where\s+(.+)$/i);
            if (whereMatch) {
              const { filter } = parseWhere(whereMatch[1], params, 0);
              const initialLength = dbData.agent_templates.length;
              dbData.agent_templates = dbData.agent_templates.filter(row => !filter(row));
              const changes = initialLength - dbData.agent_templates.length;
              if (changes > 0) saveDb();
              return { changes };
            } else {
              const changes = dbData.agent_templates.length;
              dbData.agent_templates = [];
              if (changes > 0) saveDb();
              return { changes };
            }
          }

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

          // SQLite Simulator: Xử lý thêm/ghi đè mẫu Agent
          if (sqlLower.includes('insert or replace into agent_templates')) {
            const [name, system_prompt, tools, model_mode] = params;
            const existingIdx = dbData.agent_templates.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
            const record = {
              name, system_prompt,
              tools: typeof tools === 'string' ? JSON.parse(tools) : tools,
              model_mode,
              updated_at: new Date().toISOString()
            };
            if (existingIdx >= 0) {
              dbData.agent_templates[existingIdx] = { ...dbData.agent_templates[existingIdx], ...record, id: dbData.agent_templates[existingIdx].id };
            } else {
              record.id = autoIncrements.agent_templates++;
              dbData.agent_templates.push(record);
            }
            saveDb();
            return { changes: 1 };
          }

          if (sqlLower.startsWith('insert into traces')) {
            const [id, name, pipeline_id, status, created_at] = params;
            dbData.traces.push({ id, name, pipeline_id, status, created_at });
            saveDb();
            return { changes: 1 };
          }

          if (sqlLower.startsWith('insert into trace_spans')) {
            const [id, trace_id, parent_span_id, name, type, status, started_at, input] = params;
            dbData.trace_spans.push({ id, trace_id, parent_span_id, name, type, status, started_at, input });
            saveDb();
            return { changes: 1 };
          }

          if (sqlLower.startsWith('insert into memories')) {
            const [id, date, tags, situation, solution, trust_score, use_count, memory_type = 'episodic'] = params;
            dbData.memories.push({
              id: id || autoIncrements.memories++,
              date, tags, situation, solution, trust_score, use_count,
              type: memory_type
            });
            saveDb();
            return { changes: 1, lastInsertRowid: dbData.memories.length };
          }

          if (sqlLower.startsWith('insert into tool_telemetry')) {
            const [tool_name, timestamp, success, duration_ms, error_message] = params;
            dbData.tool_telemetry.push({
              id: autoIncrements.tool_telemetry++,
              tool_name, timestamp, success, duration_ms, error_message
            });
            saveDb();
            return { changes: 1, lastInsertRowid: dbData.tool_telemetry.length };
          }

          if (sqlLower.startsWith('update memories')) {
            const setMatch = sqlNorm.match(/set\s+(.+?)\s+where\s+(.+)$/i);
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

          if (sqlLower.startsWith('update pipelines')) {
            const setMatch = sqlNorm.match(/set\s+(.+?)\s+where\s+(.+)$/i);
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

          if (sqlLower.startsWith('update agent_states')) {
            const setMatch = sqlNorm.match(/set\s+(.+?)\s+where\s+(.+)$/i);
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

          if (sqlLower.startsWith('update traces')) {
            const setMatch = sqlNorm.match(/set\s+(.+?)\s+where\s+(.+)$/i);
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

          if (sqlLower.startsWith('update trace_spans')) {
            const setMatch = sqlNorm.match(/set\s+(.+?)\s+where\s+(.+)$/i);
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

          return { changes: 0 };
        } catch (err) {
          console.error('[DB] RUN error:', err.message, '\nSQL:', sqlNorm);
          return { changes: 0 };
        }
      },

      get(...params) {
        try {
          if (sqlLower.includes('from agent_states') && sqlLower.includes('where pipeline_id')) {
            let pipelineId = params[0];
            let stepKey = params[1];
            if (pipelineId === undefined) {
              const match = sqlNorm.match(/pipeline_id\s*=\s*(?:'([^']*)'|"([^"]*)")/i);
              if (match) pipelineId = match[1] || match[2];
            }
            if (stepKey === undefined) {
              const match = sqlNorm.match(/step_key\s*=\s*(?:'([^']*)'|"([^"]*)")/i);
              if (match) stepKey = match[1] || match[2];
            }
            return dbData.agent_states.find(s => s.pipeline_id === pipelineId && s.step_key === stepKey);
          }

          if (sqlLower.includes('from pipelines') && sqlLower.includes('where')) {
            const whereMatch = sqlNorm.match(/where\s+(.+)$/i);
            if (!whereMatch) return undefined;
            const { filter } = parseWhere(whereMatch[1], params, 0);
            return dbData.pipelines.find(filter);
          }

          if (sqlLower.includes('from traces') && !sqlLower.includes('trace_spans') && sqlLower.includes('id =')) {
            const traceId = params[0];
            const found = dbData.traces.find(t => t.id === traceId);
            if (sqlLower.includes('select created_at')) {
              return found ? { created_at: found.created_at } : undefined;
            }
            return found || undefined;
          }

          if (sqlLower.includes('from trace_spans') && sqlLower.includes('id =')) {
            const spanId = params[0];
            const found = dbData.trace_spans.find(s => s.id === spanId);
            return found || undefined;
          }

          if (sqlLower.includes('from memories') && sqlLower.includes('where id')) {
            const [id] = params;
            return dbData.memories.find(m => m.id === id);
          }

          return undefined;
        } catch (err) {
          console.error('[DB] GET error:', err.message, '\nSQL:', sqlNorm);
          return undefined;
        }
      },

      all(...params) {
        try {
          if (sqlLower.includes('from memory_edges')) {
            return dbData.memory_edges;
          }

          // SQLite Simulator: Truy xuất tất cả Agent templates
          if (sqlLower.includes('from agent_templates')) {
            return dbData.agent_templates;
          }

          if (sqlLower.includes('from traces') && sqlLower.includes('order by') && sqlLower.includes('limit')) {
            const [limit] = params;
            let rows = [...dbData.traces];
            if (sqlLower.includes('order by t.created_at desc') || sqlLower.includes('order by created_at desc')) {
              rows = rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
            }
            rows = rows.map(t => ({
              ...t,
              span_count: dbData.trace_spans.filter(s => s.trace_id === t.id).length
            }));
            if (typeof limit === 'number') rows = rows.slice(0, limit);
            return rows;
          }

          if (sqlLower.includes('from trace_spans') && sqlLower.includes('where trace_id')) {
            const [traceId] = params;
            let rows = dbData.trace_spans.filter(s => s.trace_id === traceId);
            if (sqlLower.includes('order by started_at asc')) {
              rows = rows.sort((a, b) => (a.started_at || '').localeCompare(b.started_at || ''));
            }
            return rows;
          }

          if (sqlLower.includes('from agent_states') && sqlLower.includes('where pipeline_id')) {
            const [pipelineId] = params;
            return dbData.agent_states.filter(s => s.pipeline_id === pipelineId);
          }

          if (sqlLower.includes('from memories')) {
            if (sqlLower.includes('trust_score') && sqlLower.includes('order by trust_score desc')) {
              const limitMatch = sqlLower.match(/limit\s+(\d+)/);
              const limit = limitMatch ? parseInt(limitMatch[1]) : 100;
              return dbData.memories
                .filter(m => (m.trust_score ?? 0.7) > 0.1)
                .sort((a, b) => (b.trust_score || 0) - (a.trust_score || 0) || (b.use_count || 0) - (a.use_count || 0))
                .slice(0, limit);
            }
            return dbData.memories.filter(m => (m.trust_score ?? 0.7) > 0.1);
          }

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