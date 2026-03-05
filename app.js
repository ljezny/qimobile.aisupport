/**
 * QI Mobile AI Support - Application
 * Supports OpenAI's gpt-oss models via Ollama with native tool calling
 */

const OLLAMA_URL = "/api/ollama";
let currentModel = null;
let supportsNativeTools = false;

// System prompt - tools will be provided via native API
const SYSTEM_PROMPT = `Jsi support agent pro QI Mobile aplikaci. Pomáháš uživatelům s dotazy a problémy týkajícími se QI Mobile.

Tvé schopnosti:
- Odpovídáš na dotazy ohledně použití QI Mobile aplikace
- Pomáháš řešit technické problémy
- Poskytneš návody a tipy pro efektivní práci
- Máš přístup k knowledge base (kb_search) pro vyhledávání informací

DŮLEŽITÉ: Když voláš nástroj (tool), NIKDY nevypisuj své myšlenky ani uvažování. Prostě zavolej nástroj.

Buď přátelský, stručný a užitečný. Odpovídej vždy česky.`;

// Tool definitions in OpenAI/Ollama format
const TOOLS = [
    {
        type: "function",
        function: {
            name: "kb_search",
            description: "Vyhledá informace na Wikipedii. Použij pro hledání faktů a informací.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Hledaný text nebo klíčová slova"
                    }
                },
                required: ["query"]
            }
        }
    }
];

// State
let conversationHistory = [
    { role: "system", content: SYSTEM_PROMPT }
];

// Log state
let logCount = 0;

// DOM Elements
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const submitBtn = document.getElementById('submitBtn');

// Log Panel Elements
const logPanel = document.getElementById('logPanel');
const logContent = document.getElementById('logContent');
const logToggleBtn = document.getElementById('logToggleBtn');
const logBadge = document.getElementById('logBadge');
const logClearBtn = document.getElementById('logClearBtn');
const logCloseBtn = document.getElementById('logCloseBtn');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    setupLogPanel();
    userInput.focus();
    await detectModel();
});

// ============================================
// Debug Log Panel Functions
// ============================================

function setupLogPanel() {
    logToggleBtn.addEventListener('click', toggleLogPanel);
    logCloseBtn.addEventListener('click', closeLogPanel);
    logClearBtn.addEventListener('click', clearLog);
}

function toggleLogPanel() {
    logPanel.classList.toggle('active');
    document.body.classList.toggle('log-open');
}

function closeLogPanel() {
    logPanel.classList.remove('active');
    document.body.classList.remove('log-open');
}

function clearLog() {
    logContent.innerHTML = '';
    logCount = 0;
    updateLogBadge();
    addLogEntry('info', 'Log vymazán');
}

function updateLogBadge() {
    logBadge.textContent = logCount > 99 ? '99+' : logCount;
    logBadge.setAttribute('data-count', logCount);
}

function getTimeString() {
    const now = new Date();
    return now.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatJson(obj, maxLength = 500) {
    try {
        const str = JSON.stringify(obj, null, 2);
        if (str.length > maxLength) {
            return str.substring(0, maxLength) + '\n... (zkráceno)';
        }
        return str;
    } catch (e) {
        return String(obj);
    }
}

function addLogEntry(type, message, data = null) {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    
    const typeLabels = {
        'info': 'INFO',
        'request': 'REQUEST',
        'response': 'RESPONSE',
        'tool': 'TOOL',
        'error': 'ERROR'
    };
    
    let html = `
        <span class="log-time">${getTimeString()}</span>
        <span class="log-type">${typeLabels[type] || type.toUpperCase()}</span>
        <span class="log-message">${escapeHtml(message)}`;
    
    if (data !== null) {
        html += `<pre>${escapeHtml(formatJson(data, 2000))}</pre>`;
    }
    
    html += '</span>';
    entry.innerHTML = html;
    
    logContent.appendChild(entry);
    logContent.scrollTop = logContent.scrollHeight;
    
    logCount++;
    updateLogBadge();
}

/**
 * Auto-detect available model from Ollama
 * Prefers gpt-oss models for native tool calling support
 */
async function detectModel() {
    addLogEntry('info', 'Detecting available models...');
    
    try {
        const response = await fetch(`${OLLAMA_URL}/api/tags`);
        if (!response.ok) {
            throw new Error('Nelze načíst modely');
        }
        
        const data = await response.json();
        const models = data.models || [];
        
        addLogEntry('info', `Found ${models.length} model(s)`, { models: models.map(m => m.name) });
        
        if (models.length === 0) {
            updateStatus('Žádný model není nainstalován. Spusťte: ollama pull gpt-oss:20b', 'error');
            addLogEntry('error', 'No models installed');
            return;
        }

        // Prefer gpt-oss models first (native tool calling), then other capable models
        const preferredPatterns = ['gpt-oss', 'llama3.1', 'llama3.2', 'mistral-nemo', 'qwen', 'mistral'];
        let selectedModel = models[0].name;
        
        for (const pattern of preferredPatterns) {
            const match = models.find(m => m.name.toLowerCase().includes(pattern));
            if (match) {
                selectedModel = match.name;
                break;
            }
        }

        currentModel = selectedModel;
        
        // Check if model supports native tools
        supportsNativeTools = await checkToolSupport(selectedModel);
        
        const toolInfo = supportsNativeTools ? ' (tools ✓)' : '';
        updateStatus(`Model: ${currentModel}${toolInfo}`, 'success');
        
        addLogEntry('info', `Selected model: ${currentModel}`, {
            supports_native_tools: supportsNativeTools,
            tools_available: TOOLS.map(t => t.function.name)
        });
        
        // Log system configuration
        addLogEntry('info', 'System configuration', {
            system_prompt: SYSTEM_PROMPT,
            tools: TOOLS
        });
        
        console.log('Detected model:', currentModel);
        console.log('Supports native tools:', supportsNativeTools);
        console.log('Available models:', models.map(m => m.name));
        
    } catch (error) {
        updateStatus('Nelze se připojit k Ollama. Ujistěte se, že běží.', 'error');
        addLogEntry('error', 'Model detection failed', { error: error.message });
        console.error('Model detection failed:', error);
    }
}

/**
 * Check if model supports native tool calling
 */
async function checkToolSupport(modelName) {
    // gpt-oss models always support tools
    if (modelName.toLowerCase().includes('gpt-oss')) {
        return true;
    }
    
    // Check model capabilities via show endpoint
    try {
        const response = await fetch(`${OLLAMA_URL}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelName })
        });
        
        if (response.ok) {
            const data = await response.json();
            // Check if model has tool capabilities
            if (data.capabilities && Array.isArray(data.capabilities)) {
                return data.capabilities.includes('tools');
            }
            // Fallback: check model family
            const family = data.details?.family?.toLowerCase() || '';
            return ['llama', 'qwen', 'mistral'].some(f => family.includes(f));
        }
    } catch (e) {
        console.warn('Could not check tool support:', e);
    }
    
    return false;
}

function updateStatus(message, type) {
    // Update the initial AI message with status
    const firstMessage = chatMessages.querySelector('.message.assistant .message-content p');
    if (firstMessage) {
        const statusClass = type === 'error' ? 'color: #c62828' : 'color: #2e7d32';
        firstMessage.innerHTML = `Dobrý den! Jsem váš AI asistent pro QI Mobile podporu.<br><small style="${statusClass}">${message}</small>`;
    }
}

function setupEventListeners() {
    chatForm.addEventListener('submit', handleSubmit);
    
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
        }
    });

    // Auto-resize textarea
    userInput.addEventListener('input', () => {
        userInput.style.height = 'auto';
        userInput.style.height = Math.min(userInput.scrollHeight, 150) + 'px';
    });
}

async function handleSubmit(e) {
    e.preventDefault();
    
    const text = userInput.value.trim();
    if (!text) return;

    // Add user message to UI
    addMessage('user', text);
    userInput.value = '';
    userInput.style.height = 'auto';
    
    // Disable input while processing
    setInputEnabled(false);
    
    // Show loading indicator
    const loadingEl = addLoadingMessage();

    try {
        const response = await ask(text);
        removeElement(loadingEl);
        addMessage('assistant', response);
    } catch (error) {
        removeElement(loadingEl);
        addMessage('error', `Chyba: ${error.message}`);
        console.error('Error:', error);
    }

    setInputEnabled(true);
    userInput.focus();
}

/**
 * Main chat function - handles tool calls in a loop
 */
async function ask(userText) {
    conversationHistory.push({ role: "user", content: userText });
    addLogEntry('info', `User message: "${userText.substring(0, 100)}${userText.length > 100 ? '...' : ''}"`);

    const maxSteps = 60;
    for (let i = 0; i < maxSteps; i++) {
        addLogEntry('info', `Step ${i + 1}/${maxSteps} - Calling Ollama...`);
        const response = await ollamaChat(conversationHistory);
        
        // Check for native tool calls
        if (response.tool_calls && response.tool_calls.length > 0) {
            // Add assistant message with tool calls to history
            conversationHistory.push({
                role: "assistant",
                content: response.content || "",
                tool_calls: response.tool_calls
            });
            
            // Process each tool call
            for (const toolCall of response.tool_calls) {
                const funcName = toolCall.function.name;
                const args = toolCall.function.arguments;
                
                addLogEntry('tool', `Executing: ${funcName}()`, { arguments: args });
                
                let result;
                if (funcName === "kb_search") {
                    result = await kbSearch(args.query);
                } else {
                    result = JSON.stringify({ error: `Unknown tool: ${funcName}` });
                }
                
                addLogEntry('tool', `Result from ${funcName}()`, JSON.parse(result));
                
                // Add tool result to history
                conversationHistory.push({
                    role: "tool",
                    content: result,
                    tool_name: funcName
                });
            }
            
            continue; // Get next response after tool execution
        }
        
        // No tool calls - check for legacy JSON action format (fallback)
        const content = response.content || "";
        const action = tryParseAction(content);

        if (!action) {
            // Final response - add to history and return
            conversationHistory.push({ role: "assistant", content: content });
            addLogEntry('info', 'Final response received (no more tool calls)');
            return content;
        }

        // Handle legacy tool calls via JSON
        addLogEntry('tool', `Legacy JSON action detected: ${action.action}`, action);
        
        let result;
        if (action.action === "kb_search") {
            result = await kbSearch(action.query);
        } else {
            // Unknown action, treat as final response
            conversationHistory.push({ role: "assistant", content: content });
            return content;
        }

        addLogEntry('tool', `Legacy tool result`, JSON.parse(result));

        // Add tool interaction to history (legacy format)
        conversationHistory.push({ role: "assistant", content: content });
        conversationHistory.push({ role: "user", content: `[Tool result]: ${result}` });
    }

    addLogEntry('error', 'Max steps reached');
    return "Nedokončeno: příliš mnoho kroků.";
}

/**
 * Call Ollama API with native tool support
 */
async function ollamaChat(messages) {
    if (!currentModel) {
        throw new Error('Žádný model není k dispozici. Zkontrolujte připojení k Ollama.');
    }

    const payload = {
        model: currentModel,
        messages: messages,
        stream: false,
        options: {
            temperature: 0  // Reduce randomness to prevent "thinking out loud"
        }
    };
    
    // Add tools if model supports them
    if (supportsNativeTools) {
        payload.tools = TOOLS;
    }

    // Log the request
    addLogEntry('request', `POST /api/chat → ${currentModel}`, {
        model: payload.model,
        messages_count: messages.length,
        system_prompt: messages.find(m => m.role === 'system')?.content.substring(0, 200) + '...',
        last_message: messages[messages.length - 1],
        tools_enabled: supportsNativeTools,
        tools: supportsNativeTools ? TOOLS : []
    });

    let response;
    try {
        response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
    } catch (networkError) {
        addLogEntry('error', 'Network error', { error: networkError.message });
        throw new Error(
            `Nelze se připojit k Ollama. Ujistěte se, že:\n` +
            `1. Ollama běží (ollama serve)\n` +
            `2. Je povolen CORS: OLLAMA_ORIGINS=* ollama serve`
        );
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        addLogEntry('error', `HTTP ${response.status}`, { error: errorText });
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}. ${errorText}`);
    }

    const data = await response.json();
    
    // Log the response
    const hasToolCalls = data.message.tool_calls && data.message.tool_calls.length > 0;
    addLogEntry('response', hasToolCalls ? '← Tool call requested' : '← Response received', {
        content: data.message.content ? data.message.content.substring(0, 300) + (data.message.content.length > 300 ? '...' : '') : '(empty)',
        tool_calls: data.message.tool_calls || null,
        eval_count: data.eval_count,
        eval_duration_ms: data.eval_duration ? Math.round(data.eval_duration / 1_000_000) : null,
        total_duration_ms: data.total_duration ? Math.round(data.total_duration / 1_000_000) : null
    });
    
    // Return full message object to preserve tool_calls
    return {
        content: data.message.content,
        tool_calls: data.message.tool_calls || null
    };
}

/**
 * Try to parse action from response
 */
function tryParseAction(text) {
    text = text.trim();
    
    if (!text.startsWith('{') || !text.endsWith('}')) {
        return null;
    }

    try {
        const obj = JSON.parse(text);
        if (obj.action === 'kb_search') {
            return obj;
        }
    } catch (e) {
        // Not valid JSON
    }

    return null;
}

/**
 * Knowledge base search - calls Wikipedia API
 */
async function kbSearch(query) {
    addLogEntry('request', `Wikipedia search`, { query });
    
    try {
        // Call Czech Wikipedia API
        const url = `https://cs.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=5`;
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        addLogEntry('response', 'Wikipedia response', data);
        
        if (data.query && data.query.search && data.query.search.length > 0) {
            const results = data.query.search.map(item => ({
                title: item.title,
                snippet: item.snippet.replace(/<[^>]*>/g, ''),  // Remove HTML tags
                pageid: item.pageid
            }));
            
            return JSON.stringify({
                status: "success",
                query: query,
                results: results
            });
        }
        
        return JSON.stringify({
            status: "success",
            query: query,
            results: [],
            message: "Žádné výsledky"
        });
        
    } catch (error) {
        addLogEntry('error', 'Wikipedia search exception', { error: error.message });
        return JSON.stringify({
            status: "error",
            message: `Chyba při vyhledávání: ${error.message}`
        });
    }
}

// UI Helper Functions

function addMessage(type, text) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}`;

    const avatarText = type === 'user' ? 'Vy' : (type === 'error' ? '!' : 'AI');
    
    // Render markdown for assistant messages, escape HTML for user messages
    const contentHtml = type === 'assistant' 
        ? marked.parse(text) 
        : `<p>${escapeHtml(text)}</p>`;
    
    messageEl.innerHTML = `
        <div class="message-avatar">
            <span>${avatarText}</span>
        </div>
        <div class="message-content">
            ${contentHtml}
        </div>
    `;

    chatMessages.appendChild(messageEl);
    scrollToBottom();
    return messageEl;
}

function addLoadingMessage() {
    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant loading';
    
    messageEl.innerHTML = `
        <div class="message-avatar">
            <span>AI</span>
        </div>
        <div class="message-content">
            <div class="loading-dots">
                <span></span>
                <span></span>
                <span></span>
            </div>
        </div>
    `;

    chatMessages.appendChild(messageEl);
    scrollToBottom();
    return messageEl;
}

function removeElement(el) {
    if (el && el.parentNode) {
        el.parentNode.removeChild(el);
    }
}

function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setInputEnabled(enabled) {
    userInput.disabled = !enabled;
    submitBtn.disabled = !enabled;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
