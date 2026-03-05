/**
 * QI Mobile AI Support - Application
 * Supports OpenAI's gpt-oss models via Ollama with native tool calling
 */

const OLLAMA_URL = "/api/ollama";
let currentModel = null;
let supportsNativeTools = false;

// QI Configuration - loaded from server
let qiConfig = null;
let SYSTEM_PROMPT = '';
let TOOLS = [];
const QI_MAX_RESULT_LENGTH = 8000;

/**
 * Load QI configuration from server
 */
async function loadQiConfig() {
    try {
        const response = await fetch('/api/qi-config');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        qiConfig = await response.json();
        console.log('QI Config loaded:', qiConfig);
        
        // Generate dynamic SYSTEM_PROMPT and TOOLS
        SYSTEM_PROMPT = generateSystemPrompt(qiConfig);
        TOOLS = generateTools(qiConfig);
        
        return true;
    } catch (error) {
        console.error('Failed to load QI config:', error);
        return false;
    }
}

/**
 * Generate system prompt from QI configuration
 */
function generateSystemPrompt(config) {
    const areasList = config.areas.map(a => {
        const fieldNames = Object.values(a.fields || {});
        const fieldList = fieldNames.slice(0, 15).join(', ');
        const moreFields = fieldNames.length > 15 ? ` ... a ${fieldNames.length - 15} dalších` : '';
        return `  * ${a.name} (functionId: ${a.functionId}): ${a.description}\n    Dostupná pole: ${fieldList}${moreFields}`;
    }).join('\n');
    
    return `Jsi support agent pro QI Mobile aplikaci. Pomáháš uživatelům s dotazy a problémy týkajícími se QI Mobile.

Tvé schopnosti:
- Odpovídáš na dotazy ohledně použití QI Mobile aplikace
- Pomáháš řešit technické problémy
- Poskytneš návody a tipy pro efektivní práci
- Máš přístup k QI systému (qi_search) pro vyhledávání v různých oblastech

DŮLEŽITÉ pro qi_search:
- Do query zadávej POUZE klíčová slova: názvy, jména, specifické termíny
- NEZADÁVEJ obecné výrazy jako "faktury", "nezaplacené", "problémy", "informace"
- Kontext urči výběrem správné area (název oblasti), ne obecnými slovy v query
- VŽDY specifikuj pole (fields) která potřebuješ - vyber z dostupných polí pro danou oblast
- Vyber POUZE pole relevantní pro dotaz uživatele (minimální set)

Dostupné oblasti a jejich pole:
${areasList}

GENEROVÁNÍ ODKAZŮ NA ZÁZNAMY:
Když v datech najdeš "(MasterId: XXXXXXX,XX)" (např. "(MasterId: 2006855,11241)"), vygeneruj odkaz na záznam:
https://qimobile.adaptica.cz/form?functionId=<functionId>&masterId=<masterId>&pfpfid=

DŮLEŽITÉ pro odkazy:
- functionId je z oblasti kterou jsi použil (viz seznam výše)
- masterId je hodnota z dat
- Čárky v URL musí být escapované jako %2C
- Příklad: functionId "1705522,11241" a masterId "2006855,11241" → 
  https://qimobile.adaptica.cz/form?functionId=1705522%2C11241&masterId=2006855%2C11241&pfpfid=
- Vlož odkaz jako markdown: [Otevřít záznam](url) nebo [Název záznamu](url)

DŮLEŽITÉ: 
- Když voláš nástroj (tool), NIKDY nevypisuj své myšlenky ani uvažování. Prostě zavolej nástroj.
- Když máš dostatek informací pro odpověď, IHNED odpověz uživateli textovou zprávou.

Buď přátelský, stručný a užitečný. Odpovídej vždy česky.`;
}

/**
 * Generate tools from QI configuration
 */
function generateTools(config) {
    // Use area names as enum values (more human-readable)
    const areaEnums = config.areas.map(a => a.name);
    
    // Collect all unique field names across all areas for description
    const allFieldNames = new Set();
    config.areas.forEach(a => {
        Object.values(a.fields || {}).forEach(name => allFieldNames.add(name));
    });
    
    return [
        {
            type: "function",
            function: {
                name: "qi_search",
                description: "Vyhledá informace v QI systému. VŽDY specifikuj pole (fields) která potřebuješ.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "Klíčová slova pro vyhledání (může být více slov oddělených mezerou)"
                        },
                        area: {
                            type: "string",
                            enum: areaEnums,
                            description: "Oblast vyhledávání: " + config.areas.map(a => a.name).join(', ')
                        },
                        fields: {
                            type: "array",
                            items: { type: "string" },
                            description: "Názvy polí která chceš získat (vyber z dostupných polí pro danou oblast). Příklad: ['Stav zpracování', 'Název', 'Datum']"
                        }
                    },
                    required: ["query", "area", "fields"]
                }
            }
        }
    ];
}

// State
let conversationHistory = [];

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
    
    // Load QI configuration first
    const configLoaded = await loadQiConfig();
    if (!configLoaded) {
        updateStatus('Nelze načíst konfiguraci QI systému', 'error');
        return;
    }
    
    // Initialize conversation with system prompt
    conversationHistory = [
        { role: "system", content: SYSTEM_PROMPT }
    ];
    
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

function formatJson(obj) {
    try {
        return JSON.stringify(obj, null, 2);
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
    addLogEntry('info', `User message: "${userText}"`);

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
                
                addLogEntry('tool', `🛠️ AI volá tool: ${funcName}`, { 
                    function: funcName,
                    arguments: args 
                });
                
                let result;
                if (funcName === "qi_search") {
                    result = await qiSearch(args.query, args.area, args.fields || []);
                } else {
                    result = JSON.stringify({ error: `Unknown tool: ${funcName}` });
                }
                
                // Add tool result to history
                conversationHistory.push({
                    role: "tool",
                    content: result,
                    tool_name: funcName
                });
            }
            
            continue; // Get next response after tool execution
        }
        
        // No tool calls - final response
        const content = response.content || "";
        conversationHistory.push({ role: "assistant", content: content });
        addLogEntry('info', 'Final response received (no more tool calls)');
        return content;
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
            temperature: 0,  // Reduce randomness to prevent "thinking out loud"
            num_ctx: 131072  // Maximum context window size (128K tokens)
        }
    };
    
    // Calculate approximate token count (rough estimate: ~4 chars per token)
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    
    // Add tools if model supports them
    if (supportsNativeTools) {
        payload.tools = TOOLS;
    }

    // Log the request
    addLogEntry('request', `POST /api/chat → ${currentModel}`, {
        model: payload.model,
        messages_count: messages.length,
        estimated_input_tokens: estimatedTokens,
        context_window: payload.options.num_ctx,
        system_prompt: messages.find(m => m.role === 'system')?.content,
        last_message: messages[messages.length - 1],
        tools_enabled: supportsNativeTools,
        tools: supportsNativeTools ? TOOLS : []
    });

    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
        addLogEntry('error', 'Request timeout after 120s');
    }, 120000); // 120 second timeout
    
    try {
        addLogEntry('info', 'Sending request to Ollama...');
        const startTime = Date.now();
        
        response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        addLogEntry('info', `Response received in ${Date.now() - startTime}ms`);
    } catch (networkError) {
        clearTimeout(timeoutId);
        if (networkError.name === 'AbortError') {
            addLogEntry('error', 'Request aborted (timeout)');
            throw new Error('Ollama neodpověděla včas (timeout 120s). Model může být přetížený.');
        }
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
    
    // Log the response with token counts
    const hasToolCalls = data.message.tool_calls && data.message.tool_calls.length > 0;
    const toolNames = hasToolCalls ? data.message.tool_calls.map(tc => tc.function.name).join(', ') : null;
    
    addLogEntry('response', hasToolCalls ? `🛠️ AI chce volat: ${toolNames}` : '← Response received', {
        content: data.message.content || '(empty)',
        tool_calls: data.message.tool_calls || null,
        prompt_tokens: data.prompt_eval_count,    // Input tokens
        output_tokens: data.eval_count,           // Generated tokens
        total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        prompt_eval_ms: data.prompt_eval_duration ? Math.round(data.prompt_eval_duration / 1_000_000) : null,
        eval_ms: data.eval_duration ? Math.round(data.eval_duration / 1_000_000) : null,
        total_ms: data.total_duration ? Math.round(data.total_duration / 1_000_000) : null
    });
    
    // Return full message object to preserve tool_calls
    return {
        content: data.message.content,
        tool_calls: data.message.tool_calls || null
    };
}

/**
 * QI System search - calls QI API for different areas
 * Returns truncated results to fit in context window
 * @param {string} query - Search keywords
 * @param {string} area - Area name (e.g. "Požadavek")
 * @param {string[]} fields - Array of field names to request
 */
async function qiSearch(query, area, fields = []) {
    // Find area config by name to get field ID mapping
    const areaConfig = qiConfig?.areas?.find(a => a.name === area);
    
    // Convert field names to IDs
    let fieldIds = [];
    if (areaConfig && fields.length > 0) {
        const fieldsMap = areaConfig.fields || {};
        // Reverse map: name -> id
        const nameToId = {};
        Object.entries(fieldsMap).forEach(([id, name]) => {
            nameToId[name] = id;
        });
        
        fieldIds = fields
            .map(name => nameToId[name])
            .filter(id => id); // Remove undefined (fields not found)
    }
    
    const fieldsParam = fieldIds.length > 0 ? fieldIds.join(';') : '';
    
    let url = `/api/qi-kb?query=${encodeURIComponent(query)}&area=${encodeURIComponent(area)}`;
    if (fieldsParam) {
        url += `&fields=${encodeURIComponent(fieldsParam)}`;
    }
    
    addLogEntry('tool', `🔍 QI Search: "${query}" v oblasti "${area}"`, { 
        query, 
        area,
        requestedFields: fields,
        fieldIds: fieldIds,
        url: url
    });
    
    try {
        const startTime = Date.now();
        const response = await fetch(url);
        const elapsed = Date.now() - startTime;
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        let content = data.content || "Žádné výsledky";
        const originalLength = content.length;
        let truncated = false;
        
        // Truncate if too long
        if (content.length > QI_MAX_RESULT_LENGTH) {
            content = content.substring(0, QI_MAX_RESULT_LENGTH);
            truncated = true;
        }
        
        // Preview first 200 chars for log
        const preview = content.substring(0, 200).replace(/\n/g, ' ') + (content.length > 200 ? '...' : '');
        
        addLogEntry('tool', `✅ QI Result (${elapsed}ms)`, { 
            query, 
            area,
            fields: fields,
            requestHeaders: data.requestHeaders || null,
            original_length: originalLength,
            returned_length: content.length,
            truncated: truncated,
            preview: preview
        });
        
        return JSON.stringify({
            status: "success",
            query: query,
            area: area,
            fields: fields,
            content: content,
            truncated: truncated,
            original_length: originalLength,
            message: truncated ? `Výsledky zkráceny z ${originalLength} na ${QI_MAX_RESULT_LENGTH} znaků.` : null
        });
        
    } catch (error) {
        addLogEntry('error', `❌ QI Search failed: ${error.message}`, { query, area, fields, error: error.message });
        return JSON.stringify({
            status: "error",
            message: `Chyba při vyhledávání v QI: ${error.message}`
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
