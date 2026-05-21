# 🔄 LUỒNG HOẠT ĐỘNG BRIDGE SERVER - WEB CHAT WORKFLOW

## 📋 TỔNG QUAN KIẾN TRÚC

```
┌─────────────────────────────────────────────────────────────────┐
│                    FRONTEND (Web Browser)                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ public/index.html + public/app.js                        │   │
│  │ - Dashboard UI (Telemetry, Memory, Sessions, Traces)     │   │
│  │ - Web Terminal Chat Interface                            │   │
│  │ - Real-time SSE (Server-Sent Events) Streaming           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↓ HTTP/SSE
┌─────────────────────────────────────────────────────────────────┐
│                    BACKEND (Node.js Express)                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ server.js - Main API Server (Port 54321)                 │   │
│  │ - POST /api/dashboard/chat (Web Terminal Endpoint)       │   │
│  │ - GET /api/dashboard/* (Dashboard Data APIs)             │   │
│  │ - POST /api/dashboard/permission/respond (HITL)          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ CORE PROCESSING PIPELINE                                 │   │
│  │ ┌────────────────────────────────────────────────────┐   │   │
│  │ │ 1. Message Reformulation (reformulateQuery)        │   │   │
│  │ │    - AI tự động viết lại câu hỏi rõ ràng hơn      │   │   │
│  │ │    - Thêm ngữ cảnh, loại bỏ ambiguity             │   │   │
│  │ └────────────────────────────────────────────────────┘   │   │
│  │ ┌────────────────────────────────────────────────────┐   │   │
│  │ │ 2. Memory Recall (recallMemory)                    │   │   │
│  │ │    - Hybrid Search: Semantic + Keyword             │   │   │
│  │ │    - Vector embedding search (Gemini API)          │   │   │
│  │ │    - SQLite FTS (Full-Text Search)                 │   │   │
│  │ │    - Inject bài học từ quá khứ vào context         │   │   │
│  │ └────────────────────────────────────────────────────┘   │   │
│  │ ┌────────────────────────────────────────────────────┐   │   │
│  │ │ 3. Intent Classification (classifyIntent)          │   │   │
│  │ │    - Phân loại: chat / code / research / complex   │   │   │
│  │ │    - Lọc skills phù hợp (filterSkillsByIntent)     │   │   │
│  │ └────────────────────────────────────────────────────┘   │   │
│  │ ┌────────────────────────────────────────────────────┐   │   │
│  │ │ 4. AI Chat with Failover (chatWithFailover)        │   │   │
│  │ │    - Gọi activeProvider.chat()                     │   │   │
│  │ │    - Nếu fail → chuyển sang provider tiếp theo     │   │   │
│  │ │    - Streaming chunks về frontend qua SSE          │   │   │
│  │ └────────────────────────────────────────────────────┘   │   │
│  │ ┌────────────────────────────────────────────────────┐   │   │
│  │ │ 5. Skill Execution (executeSkillForProvider)       │   │   │
│  │ │    - Gọi các tools (read_file, terminal, etc)      │   │   │
│  │ │    - Ghi log chi tiết vào logBuffer                │   │   │
│  │ │    - Gửi permission request nếu cần HITL           │   │   │
│  │ └────────────────────────────────────────────────────┘   │   │
│  │ ┌────────────────────────────────────────────────────┐   │   │
│  │ │ 6. Session Management (saveSession)                │   │   │
│  │ │    - Lưu chat history vào .agent_memory/sessions   │   │   │
│  │ │    - Lưu persistent goal                           │   │   │
│  │ └────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ EXTERNAL SERVICES                                        │   │
│  │ - AI Providers (DeepSeek, Gemini, OpenAI, Claude, etc)  │   │
│  │ - Gemini API (Embedding for semantic search)            │   │
│  │ - SQLite Database (.agent_memory/agent_state.db)        │   │
│  │ - File System (.agent_memory/rules, sessions)           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 CHI TIẾT LUỒNG CHAT QUA WEB

### **BƯỚC 1: User gửi tin nhắn từ Web UI**

**File:** `public/app.js` (dòng 597-731)

```javascript
async function sendChat() {
    const msg = chatInput.value.trim();
    // 1. Hiển thị tin nhắn user
    appendMsg('user', msg);
    
    // 2. Gửi POST request tới backend
    const response = await fetch(API + '/api/dashboard/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            message: msg, 
            history: webChatHistory, 
            stream: true  // ← Bật streaming SSE
        }),
        signal: abortController.signal
    });
    
    // 3. Đọc SSE stream từ server
    const reader = response.body.getReader();
    while (true) {
        const { value, done } = await reader.read();
        // Parse từng dòng SSE và cập nhật UI
    }
}
```

**Dữ liệu gửi lên:**
- `message`: Tin nhắn người dùng
- `history`: Toàn bộ lịch sử chat (mảng messages)
- `stream`: `true` để bật SSE streaming

---

### **BƯỚC 2: Backend nhận request tại `/api/dashboard/chat`**

**File:** `server.js` (dòng 800-946)

```javascript
app.post('/api/dashboard/chat', async (req, res) => {
    const { message, stream, history = [] } = req.body;
    
    // Bước 2.1: Thiết lập SSE headers
    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        activeWebSession.res = res;  // ← Lưu response object để gửi permission requests
    }
    
    // Bước 2.2: Xử lý tin nhắn
    const currentHistory = [...history];
    
    // Bước 2.3: Reformulate query (viết lại câu hỏi)
    const reformulatedText = await reformulateQuery(message);
    currentHistory.push({ role: 'user', content: reformulatedText });
    
    // Bước 2.4: Auto-compress context nếu quá dài
    if (currentHistory.length > 15) {
        // Tóm tắt 10 tin nhắn đầu tiên bằng AI
        // Thay thế bằng 1 system message tóm tắt
    }
    
    // Bước 2.5: Recall memory (tìm bài học từ quá khứ)
    const injectedMemory = await recallMemory(message);
    const enrichedMessages = JSON.parse(JSON.stringify(currentHistory));
    if (injectedMemory) {
        enrichedMessages[enrichedMessages.length - 1].content += injectedMemory;
    }
    
    // Bước 2.6: Chuẩn bị system prompt
    let systemPrompt = fs.readFileSync(promptPath, 'utf8');
    systemPrompt = `[TỰ ĐỘNG CUNG CẤP NGỮ CẢNH HỆ THỐNG]\n- OS Platform: ${process.platform}\n...` + systemPrompt;
    
    if (persistentGoal) {
        systemPrompt = `[🎯 MỤC TIÊU KHÓA CỨNG]: "${persistentGoal}"\n...` + systemPrompt;
    }
    
    // Bước 2.7: Phân loại intent và lọc skills
    const apiIntent = classifyIntent(message);
    const filteredSkills = filterSkillsByIntent(apiIntent, SKILL_REGISTRY);
    
    // Bước 2.8: Gọi AI provider với failover
    const result = await chatWithFailover({
        messages: enrichedMessages,
        skillRegistry: filteredSkills,
        executeSkill: async (funcName, args) => {
            // Gửi action event qua SSE
            res.write(`data: ${JSON.stringify({ type: 'action', tool: funcName })}\n\n`);
            
            // Thực thi skill
            const toolResult = await executeSkillForProvider(funcName, args);
            return toolResult;
        },
        systemPrompt,
        maxSteps: 15,
        onStreamChunk: (chunk) => {
            // Gửi từng chunk text qua SSE
            res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
        }
    });
    
    // Bước 2.9: Lưu session và gửi response
    currentHistory.push({ role: 'assistant', content: clean });
    saveSession(currentHistory, persistentGoal);
    
    res.write(`data: ${JSON.stringify({ type: 'done', response: clean, history: currentHistory })}\n\n`);
    res.end();
});
```

---

### **BƯỚC 3: Reformulate Query**

**File:** `server.js` (dòng 1725-1754)

**Mục đích:** Viết lại câu hỏi của user để rõ ràng, đầy đủ ngữ cảnh hơn

```
User: "fix lỗi này"
         ↓
Reformulator AI
         ↓
Optimized: "Hãy giúp tôi fix lỗi 'Cannot find module' khi chạy npm start 
            trong dự án React. Lỗi xảy ra ở file src/index.js dòng 5."
```

**Quy trình:**
1. Gọi `activeProvider.chat()` với system prompt "Bạn là Prompt Engineer"
2. AI đọc tin nhắn gốc và viết lại thành prompt rõ ràng
3. Trả về tin nhắn đã được tối ưu hóa

---

### **BƯỚC 4: Recall Memory (Hybrid Search)**

**File:** `server.js` (dòng 1583-1723)

**Mục đích:** Tìm kiếm bài học từ quá khứ để inject vào context

**Quy trình:**

#### **4.1 Đọc Global Rules**
```
.agent_memory/rules/rules_global.md
    ↓
Inject vào context nếu tồn tại
```

#### **4.2 Đọc Keyword-based Rules**
```
.agent_memory/rules/*.md
    ↓
Kiểm tra nếu keyword xuất hiện trong tin nhắn
    ↓
Inject file tương ứng
```

#### **4.3 AI Keyword Extraction**
```
User message: "Tôi gặp lỗi Out of Memory khi build React"
    ↓
Gọi AI: "Trích xuất 2-3 từ khóa kỹ thuật"
    ↓
AI trả về: "out of memory react build"
    ↓
Format thành SQLite FTS query: "out"* OR "memory"* OR "react"*
```

#### **4.4 Semantic Search (Vector)**
```
User message
    ↓
embedText() → Gemini API → Vector embedding
    ↓
Query tất cả memories có embedding
    ↓
Tính cosine similarity
    ↓
Lọc similarity > 0.5
    ↓
Top 3 kết quả
```

#### **4.5 Keyword Search (FTS)**
```
SQLite Full-Text Search
    ↓
Query: memories_fts MATCH "out"* OR "memory"* OR "react"*
    ↓
Lọc trust_score > 0.3
    ↓
Top 3 kết quả
```

#### **4.6 Kết hợp & Loại bỏ trùng lặp**
```
Semantic results + Keyword results
    ↓
Loại bỏ trùng lặp theo ID
    ↓
Top 5 kết quả cuối cùng
    ↓
Format thành markdown inject vào context
```

**Ví dụ output:**
```
--- BÀI HỌC TỪ LỖI TRONG QUÁ KHỨ (Hybrid Search) ---
- [🧠 Semantic | Trust: 0.85 | ID: M_123] 
  Vấn đề: "Build React bị Out of Memory" 
  → Xử lý: "Thêm --max-old-space-size=4096 vào package.json"
- [🔤 Keyword | Trust: 0.92 | ID: M_456]
  Vấn đề: "npm run dev treo vô thời hạn"
  → Xử lý: "Dùng is_background: true khi chạy server"
```

---

### **BƯỚC 5: Intent Classification & Skill Filtering**

**File:** `server.js` (dòng 67-86)

```javascript
function classifyIntent(userMessage) {
    const msg = userMessage.toLowerCase();
    
    if (msg.match(/^(giải thích|tại sao|là gì|what is|explain)/)) 
        return 'chat';  // Chỉ cần chat, không cần tools
    
    if (msg.match(/(tìm trên|search|đọc trang|http:|https:)/)) 
        return 'research';  // Cần web tools
    
    if (msg.match(/(tạo file|sửa file|viết code|fix|build|deploy|npm |git )/)) 
        return 'code';  // Cần file/terminal tools
    
    return 'complex';  // Dùng tất cả tools
}

function filterSkillsByIntent(intent, fullRegistry) {
    if (intent === 'complex') return fullRegistry;  // Tất cả tools
    if (intent === 'chat') return {};  // Không có tools
    
    const SKILL_GROUPS = {
        code: ['read_file', 'write_file', 'execute_terminal_command', ...],
        research: ['web_markdown_reader', 'graphify_query', ...]
    };
    
    // Lọc chỉ tools phù hợp
    return filtered;
}
```

**Lợi ích:**
- Giảm số lượng tools AI phải xem xét
- Tăng tốc độ xử lý
- Giảm hallucination (AI gọi tool không cần thiết)

---

### **BƯỚC 6: AI Chat with Failover**

**File:** `server.js` (dòng 218-243)

```javascript
async function chatWithFailover(options) {
    const chain = getFailoverChain();  // [DeepSeek, Gemini, OpenAI, ...]
    
    for (const providerName of chain) {
        const provider = getProviderInstance(providerName);
        
        try {
            console.log(`[Failover] Đang dùng: ${provider.getDisplayName()}`);
            const result = await provider.chat(options);
            return result;
        } catch (err) {
            console.warn(`[Failover] ❌ ${provider.getDisplayName()} lỗi`);
            // Chuyển sang provider tiếp theo
        }
    }
    
    throw new Error('Tất cả provider đều lỗi!');
}
```

**Failover Chain:**
```
DeepSeek (Primary)
    ↓ (nếu fail)
Gemini Studio
    ↓ (nếu fail)
OpenAI
    ↓ (nếu fail)
Claude
    ↓ (nếu fail)
Ollama (Local)
```

---

### **BƯỚC 7: Skill Execution & Permission Handling**

**File:** `server.js` (dòng 1520-1581)

```javascript
async function executeSkillForProvider(functionName, funcArgs) {
    const skill = SKILL_REGISTRY[functionName];
    
    // Bước 7.1: Bắt đầu ghi log chi tiết
    if (activeWebSession && activeWebSession.res) {
        logBuffer = [];
        console.log = (...args) => {
            originalConsoleLog(...args);
            logBuffer.push(args.join(' '));  // ← Ghi vào buffer
        };
    }
    
    try {
        // Bước 7.2: Thực thi skill
        const result = await skill.handler(funcArgs);
        
        // Bước 7.3: Ghi telemetry
        telemetry.recordToolExecution(functionName, true, durationMs);
        
        // Bước 7.4: Ghi session log (cho Critic Agent)
        currentSessionLog.push({
            tool: functionName, 
            args: funcArgs, 
            success: true, 
            durationMs
        });
        
        return JSON.stringify({ status: "success", data: result });
    } catch (error) {
        // Ghi lỗi
        telemetry.recordToolExecution(functionName, false, durationMs, error.message);
        currentSessionLog.push({
            tool: functionName, 
            success: false, 
            errorMessage: error.message
        });
        
        return JSON.stringify({ status: "error", error_message: error.message });
    } finally {
        // Khôi phục console.log
        console.log = originalConsoleLog;
    }
}
```

---

### **BƯỚC 8: Permission Request (HITL - Human-In-The-Loop)**

**File:** `server.js` (dòng 451-487)

**Khi AI muốn thực thi một skill nguy hiểm (xóa file, chạy lệnh, etc):**

```javascript
global.askPermission = async function (query) {
    const cleanQuery = query.replace(/\x1b\[[0-9;]*m/g, '');  // Loại bỏ ANSI color
    
    if (activeWebSession && activeWebSession.res) {
        const permId = 'perm_' + Math.random().toString(36).substring(2, 9);
        
        // Trích xuất log chi tiết từ buffer
        const cleanDetails = logBuffer.map(line => 
            line.replace(/\x1b\[[0-9;]*m/g, '')
        ).join('\n');
        logBuffer = [];
        
        // Gửi permission request qua SSE
        activeWebSession.res.write(`data: ${JSON.stringify({ 
            type: 'ask_permission', 
            id: permId, 
            query: cleanQuery,
            details: cleanDetails  // ← Mã nguồn, đường dẫn file, etc
        })}\n\n`);
        
        // Chờ user phản hồi
        return new Promise((resolve) => {
            pendingPermissions.set(permId, resolve);
        });
    }
};
```

**Frontend nhận permission request:**

```javascript
// app.js (dòng 690-692)
else if (parsed.type === 'ask_permission') {
    appendPermissionCard(parsed.id, parsed.query, parsed.details);
}

// User click nút "Đồng ý" hoặc "Từ chối"
window.respondPermission = async function(permId, value, buttonEl) {
    await fetch(API + '/api/dashboard/permission/respond', {
        method: 'POST',
        body: JSON.stringify({ id: permId, response: value })
    });
};
```

**Backend nhận phản hồi:**

```javascript
// server.js (dòng 700-713)
app.post('/api/dashboard/permission/respond', (req, res) => {
    const { id, response } = req.body;
    
    if (pendingPermissions.has(id)) {
        const resolve = pendingPermissions.get(id);
        pendingPermissions.delete(id);
        resolve(response.toLowerCase().trim());  // ← Trả về 'y', 'n', 'a', etc
        res.json({ success: true });
    }
});
```

---

### **BƯỚC 9: SSE Streaming Response**

**File:** `app.js` (dòng 631-717)

**Frontend nhận các loại SSE events:**

```javascript
const reader = response.body.getReader();
const decoder = new TextDecoder('utf-8');

while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    
    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        
        const parsed = JSON.parse(line.substring(6));
        
        // Xử lý từng loại event
        if (parsed.type === 'action') {
            // AI đang kích hoạt skill
            botBubble.innerHTML = `⚡ AI đang kích hoạt Skill: ${parsed.tool}...`;
        }
        else if (parsed.type === 'chunk') {
            // Nhận text chunk từ AI
            accumulatedText += parsed.content;
            botBubble.innerHTML = marked.parse(accumulatedText);
        }
        else if (parsed.type === 'system') {
            // System message
            appendSystemMessage(parsed.content);
        }
        else if (parsed.type === 'ask_permission') {
            // Permission request
            appendPermissionCard(parsed.id, parsed.query, parsed.details);
        }
        else if (parsed.type === 'done') {
            // Chat hoàn tất
            botBubble.innerHTML = marked.parse(parsed.response);
            webChatHistory = parsed.history;
        }
        else if (parsed.type === 'error') {
            // Lỗi xảy ra
            botBubble.textContent = '❌ Lỗi: ' + parsed.error;
        }
    }
}
```

---

### **BƯỚC 10: Session Save & Dashboard Update**

**File:** `server.js` (dòng 94-101)

```javascript
function saveSession(chatHistory, goalText) {
    if (chatHistory.length === 0) return;
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filePath = path.join(SESSION_DIR, `session_${timestamp}.jsonl`);
    
    // Format: JSONL (JSON Lines)
    const meta = { 
        _type: 'meta', 
        goal: goalText, 
        provider: activeProvider?.getDisplayName(), 
        savedAt: new Date().toISOString() 
    };
    
    const lines = [
        JSON.stringify(meta),
        ...chatHistory.map(m => JSON.stringify(m))
    ];
    
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}
```

**File được lưu:**
```
.agent_memory/sessions/session_2025-01-15T10-30-45.jsonl

Nội dung:
{"_type":"meta","goal":"Build React app","provider":"DeepSeek","savedAt":"2025-01-15T10:30:45.000Z"}
{"role":"user","content":"Tạo một React component..."}
{"role":"assistant","content":"Dưới đây là component..."}
{"role":"user","content":"Thêm styling..."}
{"role":"assistant","content":"Tôi sẽ thêm Tailwind CSS..."}
```

---

## 📊 DASHBOARD REAL-TIME UPDATES

**File:** `public/app.js` (dòng 734-745)

```javascript
async function loadAll() {
    await Promise.all([
        loadTelemetry(),      // Dữ liệu tool reliability
        loadMemories(),       // Bộ nhớ & trust scores
        loadSessions(),       // Danh sách sessions
        loadCommands(),       // CLI commands & API endpoints
        loadTraces()          // Execution traces
    ]);
}

// Cập nhật mỗi 15 giây
loadAll();
setInterval(loadAll, 15000);
```

**Các API được gọi:**
- `GET /api/dashboard/telemetry` → Biểu đồ tool reliability
- `GET /api/dashboard/memories` → Bảng memories & trust distribution
- `GET /api/dashboard/sessions` → Danh sách sessions
- `GET /api/dashboard/commands` → CLI commands & API endpoints
- `GET /api/dashboard/traces` → Execution traces

---

## 🔐 SECURITY & ERROR HANDLING

### **Uncaught Exception Handler**

**File:** `server.js` (dòng 26-32)

```javascript
process.on('unhandledRejection', (reason) => {
    if (reason && (reason.name === 'ExitPromptError' || 
        reason.message?.includes('force closed'))) {
        console.log(chalk.gray('\nGoodbye! 👋\n'));
        process.exit(0);
    }
    console.error('Unhandled Rejection:', reason);
});
```

### **Permission System**

- Tất cả file operations, terminal commands, etc đều yêu cầu permission
- User có thể chọn: Yes / Yes to All / No
- Workflow Engine có thể retry / skip / cancel

### **Telemetry & Monitoring**

- Ghi lại mỗi tool execution (success/fail, duration)
- Tính reliability score cho mỗi tool
- Critic Agent tự động phân tích lỗi sau mỗi phiên

---

## 🎯 KEY TAKEAWAYS

| Thành phần | Chức năng | File |
|-----------|----------|------|
| **Frontend** | Web UI + SSE streaming | `public/app.js`, `public/index.html` |
| **Backend API** | Express server, routing | `server.js` (dòng 800-946) |
| **Message Processing** | Reformulate + Memory recall | `server.js` (dòng 1725-1723) |
| **AI Integration** | Provider failover, streaming | `server.js` (dòng 218-243) |
| **Skill Execution** | Tool calling + permission | `server.js` (dòng 1520-1581) |
| **Session Management** | Save/restore chat history | `server.js` (dòng 94-144) |
| **Monitoring** | Telemetry + traces | `telemetry.js`, `tracer.js` |
| **Memory System** | Hybrid search + embedding | `server.js` (dòng 1583-1723) |

---

## 🚀 PERFORMANCE OPTIMIZATIONS

1. **Intent Classification** → Giảm số tools từ 50+ xuống 5-10
2. **Context Compression** → Tóm tắt 10 tin nhắn cũ thành 1 system message
3. **Hybrid Search** → Kết hợp semantic + keyword để tìm bài học nhanh
4. **Provider Failover** → Tự động chuyển sang provider khác nếu fail
5. **Streaming Response** → Gửi text chunks real-time thay vì chờ hoàn tất
6. **Session Caching** → Lưu session gần nhất để khôi phục nhanh

