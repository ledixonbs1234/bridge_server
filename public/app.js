const API = window.location.origin;
let charts = {};
let webChatHistory = [];
let isFirstLoad = true;
let isGenerating = false;
let abortController = null;

// Cấu hình Markdown và Highlight.js nếu có sẵn
if (window.marked && window.hljs) {
    const renderer = new marked.Renderer();
    renderer.code = function(arg1, arg2) {
        const code = typeof arg1 === 'object' ? arg1.text : arg1;
        const language = typeof arg1 === 'object' ? arg1.lang : arg2;

        const validLanguage = (language && hljs.getLanguage(language)) ? language : 'plaintext';
        const highlighted = hljs.highlight(code, { language: validLanguage }).value;
        const base64Code = btoa(unescape(encodeURIComponent(code)));
        
        return `
            <div style="position: relative; background: #0d1117; border-radius: 8px; margin: 12px 0; border: 1px solid var(--border); overflow: hidden; font-family: sans-serif;">
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 16px; background: var(--surface2); border-bottom: 1px solid var(--border);">
                    <span style="font-size: 12px; color: var(--muted); font-family: monospace;">${language || 'code'}</span>
                    <button onclick="copyCode(this, '${base64Code}')" style="background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> 
                        <span>Copy</span>
                    </button>
                </div>
                <pre style="padding: 16px; margin: 0; overflow-x: auto; font-size: 13px;"><code class="hljs ${validLanguage}">${highlighted}</code></pre>
            </div>
        `;
    };
    marked.setOptions({ renderer: renderer });
}

window.copyCode = function(btn, base64Code) {
    const code = decodeURIComponent(escape(atob(base64Code)));
    navigator.clipboard.writeText(code).then(() => {
        const span = btn.querySelector('span');
        const originalText = span.innerText;
        span.innerText = "Copied!";
        btn.style.color = "var(--success)";
        setTimeout(() => { span.innerText = originalText; btn.style.color = "var(--muted)"; }, 2000);
    });
};
window.copyTraceData = function(btn, base64Text) {
    const text = decodeURIComponent(escape(atob(base64Text)));
    navigator.clipboard.writeText(text).then(() => {
        const span = btn.querySelector('span');
        const originalText = span.innerText;
        span.innerText = "Copied!";
        btn.style.color = "var(--success)";
        setTimeout(() => { 
            span.innerText = originalText; 
            btn.style.color = "var(--muted)"; 
        }, 2000);
    });
};

// Tabs Switcher
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    switchTab(t.dataset.panel);
}));

function switchTab(panelId) {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    
    const activeTab = document.querySelector(`.tab[data-panel="${panelId}"]`);
    const activePanel = document.getElementById('panel-' + panelId);
    
    if (activeTab && activePanel) {
        activeTab.classList.add('active');
        activePanel.classList.add('active');
        
        // Show chat messages container when switching to terminal tab
        if (panelId === 'terminal' && chatMessages && chatMessages.style.display === 'none') {
            chatMessages.style.display = 'flex';
        }
    }
}

function badgeFor(val) {
    const pct = Math.round(val * 100);
    const cls = pct >= 90 ? 'green' : pct >= 70 ? 'yellow' : 'red';
    return `<span class="badge ${cls}">${pct}%</span>`;
}

function trustBar(val) {
    const pct = Math.round((val || 0.7) * 100);
    const color = pct >= 70 ? 'var(--success)' : pct >= 40 ? 'var(--warn)' : 'var(--danger)';
    return `<span class="trust-bar"><span class="trust-bar-fill" style="width:${pct}%;background:${color}"></span></span><span class="mono">${(val||0.7).toFixed(2)}</span>`;
}

// Telemetry Loader
async function loadTelemetry() {
    try {
        const r = await fetch(API + '/api/dashboard/telemetry').then(r => r.json());
        const report = r.report || [];
        const totalCalls = report.reduce((s, x) => s + x.total, 0);
        const totalSuccess = report.reduce((s, x) => s + x.success, 0);
        const overallRel = totalCalls > 0 ? (totalSuccess / totalCalls) : 1;
        const avgDur = report.length > 0 ? Math.round(report.reduce((s, x) => s + x.avgDuration, 0) / report.length) : 0;

        document.getElementById('telemetry-stats').innerHTML = `
            <div class="card"><h3>Total Calls</h3><div class="value blue">${totalCalls}</div></div>
            <div class="card"><h3>Success Rate</h3><div class="value green">${Math.round(overallRel*100)}%</div></div>
            <div class="card"><h3>Unique Tools</h3><div class="value">${report.length}</div></div>
            <div class="card"><h3>Avg Duration</h3><div class="value yellow">${avgDur}ms</div></div>
        `;

        const tbody = document.querySelector('#telemetry-table tbody');
        tbody.innerHTML = report.map(r => `<tr>
            <td class="mono">${r.tool}</td><td>${r.total}</td>
            <td style="color:var(--success)">${r.success}</td><td style="color:var(--danger)">${r.fail}</td>
            <td>${badgeFor(r.reliability)}</td><td class="mono">${r.avgDuration}ms</td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty"><div class="icon">📊</div>Chưa có dữ liệu telemetry</td></tr>';

        const labels = report.map(r => r.tool.replace(/_/g, ' '));
        if (charts.rel) charts.rel.destroy();
        charts.rel = new Chart(document.getElementById('chartReliability'), {
            type: 'bar', data: {
                labels, datasets: [{
                    label: 'Reliability %', data: report.map(r => Math.round(r.reliability * 100)),
                    backgroundColor: report.map(r => r.reliability >= 0.9 ? 'rgba(16,185,129,0.6)' : r.reliability >= 0.7 ? 'rgba(245,158,11,0.6)' : 'rgba(239,68,68,0.6)'),
                    borderRadius: 6
                }]
            }, options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { max: 100, grid: { color: 'rgba(30,58,95,0.3)' }, ticks: { color: '#64748b' } }, x: { grid: { display: false }, ticks: { color: '#64748b', maxRotation: 45 } } } }
        });
        if (charts.dur) charts.dur.destroy();
        charts.dur = new Chart(document.getElementById('chartDuration'), {
            type: 'bar', data: {
                labels, datasets: [{ label: 'ms', data: report.map(r => r.avgDuration), backgroundColor: 'rgba(59,130,246,0.5)', borderRadius: 6 }]
            }, options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { grid: { color: 'rgba(30,58,95,0.3)' }, ticks: { color: '#64748b' } }, x: { grid: { display: false }, ticks: { color: '#64748b', maxRotation: 45 } } } }
        });
    } catch (e) { console.error('Load telemetry error:', e); }
}

// Memories Loader
async function loadMemories() {
    try {
        const r = await fetch(API + '/api/dashboard/memories').then(r => r.json());
        const mems = r.memories || [];
        const stats = r.stats || {};

        document.getElementById('memory-stats').innerHTML = `
            <div class="card"><h3>Total Memories</h3><div class="value blue">${stats.total || 0}</div></div>
            <div class="card"><h3>Avg Trust</h3><div class="value green">${(stats.avg_trust || 0).toFixed(2)}</div></div>
            <div class="card"><h3>Embedded</h3><div class="value">${stats.embedded_count || 0}<span style="font-size:14px;color:var(--muted)">/${stats.total||0}</span></div></div>
            <div class="card"><h3>High Trust (≥0.7)</h3><div class="value green">${mems.filter(m=>(m.trust_score||0)>=0.7).length}</div></div>
        `;

        const tbody = document.querySelector('#memory-table tbody');
        tbody.innerHTML = mems.map(m => {
            let tags = ''; try { tags = JSON.parse(m.tags||'[]').map(t=>`<span class="badge blue">${t}</span>`).join(' '); } catch {}
            return `<tr>
                <td>${trustBar(m.trust_score)}</td>
                <td style="max-width:280px">${m.situation||'-'}</td>
                <td style="max-width:280px;color:var(--muted)">${m.solution||'-'}</td>
                <td>${tags}</td>
                <td>${m.has_embedding ? '<span class="badge green">🧠 Yes</span>' : '<span class="badge" style="opacity:.4">No</span>'}</td>
                <td class="mono">${m.use_count||0}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="6" class="empty"><div class="icon">🧠</div>Chưa có memory nào</td></tr>';

        const buckets = [0,0,0,0,0];
        mems.forEach(m => { const t = m.trust_score||0.7; const i = Math.min(Math.floor(t*5),4); buckets[i]++; });
        if (charts.trust) charts.trust.destroy();
        charts.trust = new Chart(document.getElementById('chartTrust'), {
            type: 'doughnut', data: {
                labels: ['0-0.2','0.2-0.4','0.4-0.6','0.6-0.8','0.8-1.0'],
                datasets: [{ data: buckets, backgroundColor: ['#ef4444','#f97316','#f59e0b','#10b981','#3b82f6'], borderWidth: 0 }]
            }, options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#94a3b8', font: { size: 11 } } } } }
        });

        const byDate = {}; mems.forEach(m => { if (!m.date) return; const d = m.date.slice(0,10); byDate[d] = (byDate[d]||0)+1; });
        const dates = Object.keys(byDate).sort().slice(-14);
        if (charts.timeline) charts.timeline.destroy();
        charts.timeline = new Chart(document.getElementById('chartTimeline'), {
            type: 'line', data: {
                labels: dates, datasets: [{ label: 'New memories', data: dates.map(d=>byDate[d]), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.4, pointRadius: 4 }]
            }, options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: 'rgba(30,58,95,0.3)' }, ticks: { color: '#64748b' } }, x: { grid: { display: false }, ticks: { color: '#64748b' } } } }
        });
    } catch (e) { console.error('Load memories error:', e); }
}

// Goal Management Actions
window.editGoal = async function() {
    const currentGoal = document.getElementById('goalText').textContent;
    const newGoal = prompt("Nhập mục tiêu khóa cứng (persistent goal) mới cho Agent:", currentGoal || "");
    if (newGoal === null) return;
    
    try {
        const r = await fetch(API + '/api/dashboard/goal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ goal: newGoal })
        }).then(r => r.json());
        
        if (r.success) {
            updateGoalBar(r.goal);
            appendSystemMessage(`🎯 Đã cập nhật mục tiêu khóa cứng: "${r.goal || 'Trống'}"`);
        }
    } catch(e) { alert('Lỗi: ' + e.message); }
};

window.clearGoal = async function() {
    if (!confirm('Bạn có chắc muốn xóa mục tiêu khóa cứng?')) return;
    try {
        const r = await fetch(API + '/api/dashboard/goal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ goal: null })
        }).then(r => r.json());
        
        if (r.success) {
            updateGoalBar(null);
            appendSystemMessage('🎯 Đã xóa mục tiêu khóa cứng.');
        }
    } catch(e) { alert('Lỗi: ' + e.message); }
};

function updateGoalBar(goal) {
    const goalBar = document.getElementById('goalBar');
    const goalText = document.getElementById('goalText');
    if (goal) {
        goalBar.classList.add('active');
        goalText.textContent = goal;
    } else {
        goalBar.classList.remove('active');
        goalText.textContent = '';
    }
}

// Sessions Loader
async function loadSessions() {
    try {
        const r = await fetch(API + '/api/dashboard/sessions').then(r => r.json());
        updateGoalBar(r.currentGoal);

        const tbody = document.querySelector('#sessions-table tbody');
        tbody.innerHTML = (r.sessions||[]).map((s,i) => `<tr>
            <td>${i+1}</td>
            <td class="mono">${s.file}</td>
            <td>${s.messages}</td>
            <td>${s.goal !== '(không có)' ? '<span class="badge yellow">🎯 '+s.goal+'</span>' : '<span style="color:var(--muted)">—</span>'}</td>
            <td class="mono">${s.age} phút trước</td>
            <td>
                <button class="btn-session-restore" onclick="restoreSession('${s.file}')">💬 Khôi phục</button>
            </td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty"><div class="icon">💾</div>Chưa có session</td></tr>';
    } catch (e) { console.error('Load sessions error:', e); }
}

// Restore Session
window.restoreSession = async function(filename) {
    if (!confirm(`Bạn có muốn khôi phục lại hội thoại từ session "${filename}"?`)) return;
    try {
        const r = await fetch(API + `/api/dashboard/sessions/active`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        }).then(res => res.json());
        
        if (r.success) {
            chatMessages.innerHTML = '';
            webChatHistory = r.messages || [];
            updateGoalBar(r.meta?.goal || null);
            
            webChatHistory.forEach(m => {
                if (m.role === 'user') {
                    appendMsg('user', m.content);
                } else if (m.role === 'assistant') {
                    appendMsg('bot', m.content);
                } else if (m.role === 'system') {
                    appendSystemMessage(m.content);
                }
            });
            
            appendSystemMessage(`💾 Đã khôi phục hội thoại từ session: ${filename}`);
            switchTab('terminal');
            loadSessions();
        } else {
            alert('Khôi phục thất bại: ' + r.error);
        }
    } catch(e) { alert('Lỗi khôi phục session: ' + e.message); }
};

// Start New Web Session
window.startNewWebSession = async function() {
    if (!confirm("Bạn có chắc chắn muốn xóa lịch sử chat hiện tại và bắt đầu một cuộc hội thoại mới không?")) return;
    try {
        const r = await fetch(API + '/api/dashboard/sessions/active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: null })
        }).then(res => res.json());
        
        if (r.success) {
            // Show chat messages container when starting new session
            if (chatMessages.style.display === 'none') {
                chatMessages.style.display = 'flex';
            }
            chatMessages.innerHTML = '';
            webChatHistory = [];
            updateGoalBar(null);
            appendSystemMessage("✨ Đã tạo phiên chat mới thành công.");
            loadSessions();
        } else {
            alert("Không thể khởi tạo phiên mới: " + r.error);
        }
    } catch(e) {
        alert("Lỗi khi tạo phiên mới: " + e.message);
    }
};

// Load Active Session from Server
async function loadActiveSession() {
    try {
        const r = await fetch(API + '/api/dashboard/sessions/active').then(res => res.json());
        if (r.success && r.active) {
            chatMessages.innerHTML = '';
            webChatHistory = r.messages || [];
            updateGoalBar(r.goal || null);
            
            webChatHistory.forEach(m => {
                if (m.role === 'user') {
                    appendMsg('user', m.content);
                } else if (m.role === 'assistant') {
                    appendMsg('bot', m.content);
                } else if (m.role === 'system') {
                    appendSystemMessage(m.content);
                }
            });
            appendSystemMessage(`💾 Đã khôi phục phiên chat đang hoạt động: ${r.filename}`);
        }
    } catch(e) {
        console.error('Lỗi khi tải session đang hoạt động:', e);
    }
}

// Commands Loader
async function loadCommands() {
    try {
        const r = await fetch(API + '/api/dashboard/commands').then(r => r.json());
        
        const grouped = {};
        (r.cli||[]).forEach(c => { if(!grouped[c.category]) grouped[c.category]=[]; grouped[c.category].push(c); });
        const catIcons = { session:'💾', system:'⚙️', config:'🔧', info:'📊' };
        let cliHtml = '';
        for (const [cat, cmds] of Object.entries(grouped)) {
            cliHtml += `<div class="cat-label">${catIcons[cat]||'📌'} ${cat}</div>`;
            cmds.forEach(c => {
                cliHtml += `<div class="cmd-card"><span class="cmd-name">${c.cmd}</span><span class="cmd-desc">${c.desc}</span>${c.alias?`<span class="cmd-alias">alias: ${c.alias}</span>`:''}</div>`;
            });
        }
        document.getElementById('cli-commands-list').innerHTML = cliHtml;
        
        document.getElementById('api-endpoints-list').innerHTML = (r.api||[]).map(a => `<div class="cmd-card"><span class="api-method ${a.method.toLowerCase()}">${a.method}</span><span class="cmd-name" style="background:rgba(16,185,129,0.08);color:var(--success)">${a.path}</span><span class="cmd-desc">${a.desc}</span></div>`).join('');
        
        document.getElementById('skill-count').textContent = (r.skills||[]).length;
        document.getElementById('skills-list').innerHTML = (r.skills||[]).map(s => `<div class="skill-item"><div class="skill-name">${s.name}</div><div class="skill-desc">${s.desc}</div></div>`).join('') || '<div class="empty"><div class="icon">🧩</div>Chưa có skill nào</div>';
        
        if (r.provider) document.getElementById('chat-provider').textContent = r.provider.name || r.provider.active;
        
        document.getElementById('quick-tests').innerHTML = (r.api||[]).filter(a=>a.method==='GET').map(a=>`<button class="badge blue" style="cursor:pointer;padding:6px 12px;font-size:12px" onclick="quickTest('${a.path}')">${a.method} ${a.path}</button>`).join('');
    } catch(e) { console.error('Load commands error:', e); }
}

window.quickTest = async function(path) {
    const el = document.getElementById('api-result');
    el.style.display = 'block';
    el.textContent = 'Loading...';
    try {
        const r = await fetch(API + path).then(r=>r.json());
        el.textContent = JSON.stringify(r, null, 2);
    } catch(e) { el.textContent = 'Error: ' + e.message; }
};

// Traces Loader
let tracesData = [];
let currentTraceDetail = null;
let selectedSpanId = null;

async function loadTraces() {
    try {
        const r = await fetch(API + '/api/dashboard/traces').then(r=>r.json());
        tracesData = r.traces || [];
        document.getElementById('trace-count').textContent = tracesData.length;
        const container = document.getElementById('traces-items');
        if (tracesData.length === 0) {
            container.innerHTML = '<div class="empty" style="padding:40px"><div class="icon">📭</div>Chưa có trace nào.</div>';
            return;
        }
        container.innerHTML = tracesData.map(t => {
            const dur = t.total_duration_ms ? formatDuration(t.total_duration_ms) : 'running...';
            const time = t.created_at ? new Date(t.created_at).toLocaleString('vi-VN', {hour:'2-digit',minute:'2-digit',second:'2-digit',day:'2-digit',month:'2-digit'}) : '';
            return `<div class="trace-item" onclick="loadTraceDetail('${t.id}', this)">
                <span class="t-status ${t.status}"></span>
                <span class="t-name">${escHtml(t.name || 'Unnamed')}</span>
                <span class="t-meta">${t.span_count || 0} spans</span>
                <span class="t-meta">${dur}</span>
                <span class="t-meta" style="font-size:10px">${time}</span>
            </div>`;
        }).join('');
    } catch(e) { console.error('Load traces error:', e); }
}

function formatDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms/1000).toFixed(1) + 's';
    return (ms/60000).toFixed(1) + 'm';
}
function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

window.loadTraceDetail = async function(traceId, el) {
    document.querySelectorAll('.trace-item').forEach(x => x.classList.remove('active'));
    if (el) el.classList.add('active');
    selectedSpanId = null;

    try {
        const r = await fetch(API + '/api/dashboard/traces/' + traceId).then(r=>r.json());
        currentTraceDetail = r;
        renderTraceDetail(r);
    } catch(e) { console.error('Trace detail error:', e); }
};

function renderTraceDetail(data) {
    const { trace, spans } = data;
    const detail = document.getElementById('trace-detail');
    const maxDur = Math.max(...spans.map(s => s.duration_ms || 1), 1);
    
    const rootSpans = spans.filter(s => !s.parent_span_id);
    const childMap = {};
    spans.forEach(s => {
        if (s.parent_span_id) {
            if (!childMap[s.parent_span_id]) childMap[s.parent_span_id] = [];
            childMap[s.parent_span_id].push(s);
        }
    });

    function renderSpanTree(span, depth = 0) {
        const indent = depth * 24;
        const durPct = Math.max(((span.duration_ms || 0) / maxDur) * 100, 2);
        const barColor = span.status === 'failed' ? 'var(--danger)' : span.type === 'llm' ? 'var(--accent)' : span.type === 'agent' ? '#a78bfa' : 'var(--success)';
        const typeIcon = span.type === 'agent' ? '🤖' : span.type === 'llm' ? '🧠' : span.type === 'tool' ? '⚙️' : '📦';
        const dur = span.duration_ms ? formatDuration(span.duration_ms) : '...';
        
        let html = `<div class="span-row" data-span-id="${span.id}" onclick="selectSpan('${span.id}')">
            <span class="span-indent" style="width:${indent}px"></span>
            <span class="span-icon ${span.type}">${typeIcon}</span>
            <span class="span-name">${escHtml(span.name)}</span>
            <span class="span-dur">${dur}</span>
            <span class="span-bar-wrap"><span class="span-bar" style="width:${durPct}%;background:${barColor}"></span></span>
        </div>`;

        const children = childMap[span.id] || [];
        children.forEach(child => { html += renderSpanTree(child, depth + 1); });
        return html;
    }

    let treeHtml = '';
    if (rootSpans.length === 0 && spans.length > 0) {
        spans.forEach(s => { treeHtml += renderSpanTree(s, 0); });
    } else {
        rootSpans.forEach(s => { treeHtml += renderSpanTree(s, 0); });
    }

    const statusBadge = trace.status === 'completed' ? '<span class="badge green">completed</span>' : trace.status === 'failed' ? '<span class="badge red">failed</span>' : '<span class="badge blue">running</span>';
    const totalDur = trace.total_duration_ms ? formatDuration(trace.total_duration_ms) : 'running...';

    detail.innerHTML = `
    <div class="trace-detail-header">
        <h3>${escHtml(trace.name || 'Trace')}</h3>
        ${statusBadge}
        <span style="color:var(--muted);font-size:12px">${totalDur}</span>
        <span class="trace-id-badge">${trace.id}</span>
    </div>
    <div class="trace-detail-columns">
        <div class="span-tree-col">
            <div class="span-tree" id="span-tree">${treeHtml || '<div class="empty" style="padding:30px"><div class="icon">📭</div>Không có spans</div>'}</div>
        </div>
        <div class="span-detail-col" id="span-detail-container">
            <div class="empty" style="padding:80px 20px; text-align:center;">
                <div class="icon" style="font-size:32px; margin-bottom:8px;">🎯</div>
                Chọn một mốc (span) để xem thông tin chi tiết
            </div>
        </div>
    </div>
    `;
}

window.selectSpan = function(spanId) {
    selectedSpanId = spanId;
    document.querySelectorAll('.span-row').forEach(r => r.classList.remove('active'));
    const row = document.querySelector(`.span-row[data-span-id="${spanId}"]`);
    if (row) row.classList.add('active');

    const span = currentTraceDetail?.spans?.find(s => s.id === spanId);
    if (!span) return;

    const container = document.getElementById('span-detail-container');
    const statusBadge = span.status === 'completed' ? '<span class="badge green">completed</span>' : span.status === 'failed' ? '<span class="badge red">failed</span>' : '<span class="badge blue">running</span>';

    // Trích xuất thought process
    function extractThoughts(text) {
        if (!text) return null;
        const thinkRegex = /<think>([\s\S]*?)<\/think>/;
        const match = text.match(thinkRegex);
        if (match) {
            return {
                thoughts: match[1].trim(),
                cleanText: text.replace(thinkRegex, '').trim()
            };
        }
        return null;
    }

    // Tạo khối có cấu trúc Header và nút Copy chuẩn
    function renderCopyableBlock(title, rawText, isError = false) {
        if (!rawText) return '';
        const base64Text = btoa(unescape(encodeURIComponent(rawText)));
        const headerColor = isError ? 'color: var(--danger)' : 'color: var(--text)';
        return `
            <div class="trace-code-wrapper" style="margin-top: 16px;">
                <div class="trace-code-header">
                    <span style="font-size: 12px; font-weight: 600; ${headerColor}">${title}</span>
                    <button class="trace-copy-btn" onclick="copyTraceData(this, '${base64Text}')">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        <span>Copy</span>
                    </button>
                </div>
                <pre class="${isError ? 'error-text' : ''}">${escHtml(rawText)}</pre>
            </div>
        `;
    }

    // Tạo khối thought process có nút Copy tương ứng
    function renderThoughtBlock(title, rawText) {
        if (!rawText) return '';
        const base64Text = btoa(unescape(encodeURIComponent(rawText)));
        return `
            <div class="trace-code-wrapper" style="margin-top: 16px; border-color: rgba(245, 158, 11, 0.4);">
                <div class="trace-code-header" style="background: rgba(245, 158, 11, 0.08); border-bottom: 1px solid rgba(245, 158, 11, 0.2);">
                    <span style="font-size: 12px; font-weight: 600; color: var(--warn)">${title}</span>
                    <button class="trace-copy-btn" onclick="copyTraceData(this, '${base64Text}')">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        <span>Copy</span>
                    </button>
                </div>
                <div class="span-thought-box">${escHtml(rawText)}</div>
            </div>
        `;
    }

    let inputContentHtml = '';
    if (span.input) {
        let inputText = span.input;
        let parsedInput = null;
        try {
            parsedInput = JSON.parse(span.input);
            if (parsedInput && parsedInput.prompt) {
                inputText = parsedInput.prompt;
            } else if (parsedInput && typeof parsedInput === 'object') {
                inputText = JSON.stringify(parsedInput, null, 2);
            }
        } catch {}

        const inputExtracted = extractThoughts(inputText);
        if (inputExtracted) {
            inputContentHtml += renderThoughtBlock('💭 Input Thought Process', inputExtracted.thoughts);
            if (parsedInput && parsedInput.prompt) {
                parsedInput.prompt = inputExtracted.cleanText;
                inputContentHtml += renderCopyableBlock('📥 Input', JSON.stringify(parsedInput, null, 2));
            } else {
                inputContentHtml += renderCopyableBlock('📥 Input', inputExtracted.cleanText);
            }
        } else {
            if (parsedInput) {
                inputContentHtml += renderCopyableBlock('📥 Input', JSON.stringify(parsedInput, null, 2));
            } else {
                inputContentHtml += renderCopyableBlock('📥 Input', span.input);
            }
        }
    }

    let outputContentHtml = '';
    if (span.output) {
        let outputText = span.output;
        let parsedOutput = null;
        try {
            parsedOutput = JSON.parse(span.output);
            if (parsedOutput && parsedOutput.response) {
                outputText = parsedOutput.response;
            } else if (parsedOutput && parsedOutput.text) {
                outputText = parsedOutput.text;
            } else if (parsedOutput && typeof parsedOutput === 'object') {
                outputText = JSON.stringify(parsedOutput, null, 2);
            }
        } catch {}

        const outputExtracted = extractThoughts(outputText);
        if (outputExtracted) {
            outputContentHtml += renderThoughtBlock('💭 Model Thought Process (Tư duy của AI)', outputExtracted.thoughts);
            if (parsedOutput) {
                if (parsedOutput.response) parsedOutput.response = outputExtracted.cleanText;
                else if (parsedOutput.text) parsedOutput.text = outputExtracted.cleanText;
                outputContentHtml += renderCopyableBlock('📤 Output', JSON.stringify(parsedOutput, null, 2));
            } else {
                outputContentHtml += renderCopyableBlock('📤 Output', outputExtracted.cleanText);
            }
        } else {
            if (parsedOutput) {
                outputContentHtml += renderCopyableBlock('📤 Output', JSON.stringify(parsedOutput, null, 2));
            } else {
                outputContentHtml += renderCopyableBlock('📤 Output', span.output);
            }
        }
    }

    let errorContentHtml = '';
    if (span.error) {
        errorContentHtml = renderCopyableBlock('❌ Error (Lỗi hệ thống chi tiết)', span.error, true);
    }

    container.innerHTML = `<div class="span-detail-pane">
        <h4>${escHtml(span.name)}</h4>
        <div class="sdp-row"><span class="sdp-label">ID</span><span class="sdp-value mono" style="font-size:11px">${span.id}</span></div>
        <div class="sdp-row"><span class="sdp-label">Type</span><span class="sdp-value">${span.type}</span></div>
        <div class="sdp-row"><span class="sdp-label">Status</span><span class="sdp-value">${statusBadge}</span></div>
        <div class="sdp-row"><span class="sdp-label">Duration</span><span class="sdp-value">${span.duration_ms ? formatDuration(span.duration_ms) : 'running...'}</span></div>
        <div class="sdp-row"><span class="sdp-label">Started</span><span class="sdp-value">${span.started_at ? new Date(span.started_at).toLocaleString('vi-VN') : '-'}</span></div>
        <div class="sdp-row"><span class="sdp-label">Completed</span><span class="sdp-value">${span.completed_at ? new Date(span.completed_at).toLocaleString('vi-VN') : '-'}</span></div>
        ${inputContentHtml}
        ${outputContentHtml}
        ${errorContentHtml}
    </div>`;
};

// ===== WEB TERMINAL CHAT SYSTEM =====
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatLeftSidebar = document.getElementById('chat-left-sidebar');
const logStream = document.getElementById('log-stream');
const diffContainer = document.getElementById('diff-container');
const tabDifference = document.getElementById('tab-difference');
const tabLog = document.getElementById('tab-log');

// Store for file changes
let currentFileChanges = [];

// Initialize send button state on page load
if (chatSend) {
    updateSendButton();
}

// Tab switching functionality
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const tabName = btn.dataset.tab;
        if (tabName === 'difference') {
            tabDifference.style.display = 'block';
            tabLog.style.display = 'none';
        } else {
            tabDifference.style.display = 'none';
            tabLog.style.display = 'block';
        }
    });
});

// Helper to get current timestamp
function getCurrentTime() {
    const now = new Date();
    return now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Append user question to left sidebar

// Initialize chat with welcome message (only show when terminal tab is active)
function initChat() {
    // Show chat messages container for initial welcome message
    if (chatMessages && chatMessages.style.display === 'none') {
        chatMessages.style.display = 'flex';
    }
    appendMsg('bot', 'Xin chào! Hãy trò chuyện trực tiếp tại đây. Tất cả các yêu cầu cấp quyền chạy tool của Agent sẽ được tương tác trực tiếp trong khung chat này.');
}

// Initialize chat on page load
initChat();

function updateSendButton() {
    if (isGenerating) {
        chatSend.disabled = false;
        chatSend.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--danger)"><rect x="6" y="6" width="12" height="12"></rect></svg>`;
    } else {
        chatSend.disabled = chatInput.value.trim() === '';
        chatSend.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 2px;"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
    }
}

chatInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 128) + 'px';
    if (!isGenerating) updateSendButton();
});

chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (this.value.trim() !== '' && !isGenerating) sendChat();
    }
});

chatSend.addEventListener('click', () => {
    if (isGenerating) {
        if (abortController) abortController.abort();
    } else {
        sendChat();
    }
});

async function sendChat() {
    const msg = chatInput.value.trim();
    if (!msg) return;
    
    // Append user question to left sidebar (new UI)
    appendUserQuestion(msg);
    
    // Clear input
    chatInput.value = '';
    chatInput.style.height = 'auto';
    isGenerating = true;
    updateSendButton();

    // Show working status
    const workingStatusElement = appendWorkingStatus();
    
    // Log to right panel
    appendLogEntry(`📥 Received user request: ${msg}`, 'default');
    
    let accumulatedText = "";
    let currentToolName = null;
    abortController = new AbortController();

    try {
        const response = await fetch(API + '/api/dashboard/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, stream: true }),
            signal: abortController.signal
        });

        if (!response.body) {
            const r = await response.json();
            if (r.success) {
                // Remove working status and show completed
                removeWorkingStatus(workingStatusElement);
                appendCompletedCard(r.response.substring(0, 100) + '...');
                appendAIResponse(r.response);
                webChatHistory = r.history || [];
                
                // Log completion
                appendLogEntry('✅ Request completed successfully', 'tool-output');
            } else {
                removeWorkingStatus(workingStatusElement);
                appendLogEntry('❌ Error: ' + (r.error || 'Unknown error'), 'error');
            }
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const cleanLine = line.trim();
                if (!cleanLine.startsWith('data: ')) continue;
                try {
                    const parsed = JSON.parse(cleanLine.substring(6));
                    
                    if (parsed.type === 'action') {
                        // Log tool call to right panel
                        currentToolName = parsed.tool;
                        appendLogEntry(`⚙️ Activating Skill: ${parsed.tool}`, 'tool-call');
                        
                        // Update working status
                        if (workingStatusElement) {
                            workingStatusElement.innerHTML = `
                                <div class="status-bubble">
                                    <div class="status-header">
                                        <span class="status-icon">⚡</span>
                                        <span class="status-label">AI đang kích hoạt Skill: ${parsed.tool}</span>
                                        <span class="status-time">${getCurrentTimestamp()}</span>
                                    </div>
                                </div>
                            `;
                        }
                    } 
                    else if (parsed.type === 'chunk') {
                        const chunk = parsed.content;
                        accumulatedText += chunk;
                    } 
                    else if (parsed.type === 'system') {
                        appendLogEntry(parsed.content, 'thinking');
                    }
                    else if (parsed.type === 'log') {
                        appendLogEntry(parsed.content, 'default');
                    }
                    else if (parsed.type === 'ask_permission') {
                        appendLogEntry(`⚠️ Permission requested: ${parsed.query}`, 'thinking');
                    }
                    else if (parsed.type === 'tool_output') {
                        appendToolOutputLog(currentToolName || 'Unknown', parsed.output || parsed.content);
                    }
                    else if (parsed.type === 'done') {
                        // Remove working status
                        removeWorkingStatus(workingStatusElement);
                        
                        // Show completed card
                        appendCompletedCard('Task finished successfully');
                        
                        // Show AI response
                        appendAIResponse(parsed.response);
                        
                        // Store history
                        webChatHistory = parsed.history || [];
                        
                        // Log completion
                        appendLogEntry('✅ Work completed - All tasks finished', 'tool-output');
                        
                        // If there are file changes in the response, show Code Tool Record
                        if (parsed.fileChanges && parsed.fileChanges.length > 0) {
                            appendCodeToolRecord(parsed.fileChanges);
                        }
                    } 
                    else if (parsed.type === 'error') {
                        removeWorkingStatus(workingStatusElement);
                        appendLogEntry('❌ Error: ' + parsed.error, 'error');
                    }
                } catch (errParse) {
                    console.warn("Lỗi parse dòng SSE:", errParse, cleanLine);
                }
            }
        }
    } catch(e) { 
        removeWorkingStatus(workingStatusElement);
        if (e.name === 'AbortError') {
            appendLogEntry('[Request stopped by user]', 'thinking');
        } else {
            appendLogEntry('❌ Connection error: ' + e.message, 'error');
        }
    } finally {
        isGenerating = false;
        updateSendButton();
        abortController = null;
    }
}

// Tải toàn bộ tài nguyên khởi đầu
async function loadAll() {
    await Promise.all([
        loadTelemetry(),
        loadMemories(),
        loadSessions(),
        loadCommands(),
        loadTraces()
    ]);
    if (isFirstLoad) {
        isFirstLoad = false;
        await loadActiveSession();
    }
}

loadAll();
setInterval(loadAll, 15000);
// // Health Check Monitor
// async function checkHealth() {
//   try {
//     const r = await fetch(API + '/health').then(r => r.json());
//     const statusEl = document.getElementById('status');
    
//     if (r.status === 'ok') {
//       statusEl.textContent = 'Online';
//       statusEl.style.color = 'var(--success)';
//     } else {
//       statusEl.textContent = 'Degraded';
//       statusEl.style.color = 'var(--warn)';
//     }
    
//     // Update every 30 seconds
//     setTimeout(checkHealth, 30000);
//   } catch (e) {
//     const statusEl = document.getElementById('status');
//     statusEl.textContent = 'Offline';
//     statusEl.style.color = 'var(--danger)';
//     setTimeout(checkHealth, 5000); // Retry faster if offline
//   }
// }

// // Start health monitoring
// checkHealth();