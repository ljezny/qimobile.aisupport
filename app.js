/**
 * QI Mobile AI Support - Application
 */

const OLLAMA_URL = "http://localhost:11434";
const PROXY_URL = "/api/soap";  // Use same-origin proxy endpoint
let currentModel = null;

// Knowledge Base Configuration
const KB_TOKEN_KEY = 'qimobile_kb_token';

// Connection credentials (constants)
const KB_CONFIG = {
    url: 'https://qi.adaptica.cz/mobile',
    username: 'honza',
    password: 'abcdefg',
    get soapUrl() {
        return this.url.replace(/\/$/, '') + '/cgi-bin/icdisp.exe?act=soap';
    }
};

// Current session token
let kbToken = null;

const SYSTEM_PROMPT = `Jsi support agent pro QI Mobile aplikaci. Pomáháš uživatelům s dotazy a problémy týkajícími se QI Mobile.

Tvé schopnosti:
- Odpovídáš na dotazy ohledně použití QI Mobile aplikace
- Pomáháš řešit technické problémy
- Poskytneš návody a tipy pro efektivní práci
- Pokud nenajdeš odpověď v knowledge base, přiznej to

Pokud potřebuješ vyhledat informace v knowledge base, vrať POUZE tento JSON objekt (bez dalšího textu):
{"action": "kb_search", "query": "HLEDANÉ_KLÍČOVÉ_SLOVO"}
HLEDANÉ_KLÍČOVÉ_SLOVO musí být jedno klíčové slovo, nesmí to být fráze. Např. QIMobile nebo faktura.

Knowledge base vrátí články s obsahem. Použij tyto informace k odpovědi uživateli.

Buď přátelský, stručný a užitečný. Odpovídej vždy česky.`;

// State
let conversationHistory = [
    { role: "system", content: SYSTEM_PROMPT }
];

// DOM Elements
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const submitBtn = document.getElementById('submitBtn');

// Config Modal Elements
const configBtn = document.getElementById('configBtn');
const configModal = document.getElementById('configModal');
const configForm = document.getElementById('configForm');
const configCancel = document.getElementById('configCancel');
const modalClose = document.getElementById('modalClose');
const configStatus = document.getElementById('configStatus');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    setupConfigModal();
    loadKbToken();
    userInput.focus();
    await detectModel();
    await autoLoginIfNeeded();
});

/**
 * Auto-login if not already logged in
 */
async function autoLoginIfNeeded() {
    if (kbToken) {
        console.log('✅ Already logged in to KB, ticket:', kbToken.substring(0, 20) + '...');
        updateKbStatus(true);
        return;
    }
    
    console.log('🔄 Auto-login to KB...');
    
    try {
        kbToken = await kbLogin();
        saveKbToken();
        
        console.log('✅ Auto-login successful, ticket:', kbToken.substring(0, 20) + '...');
        updateKbStatus(true);
    } catch (error) {
        console.warn('⚠️ Auto-login failed:', error.message);
        updateKbStatus(false, error.message);
    }
}

/**
 * Update KB connection status in UI
 */
function updateKbStatus(connected, errorMessage = null) {
    const statusText = connected 
        ? `<span style="color: #2e7d32">✅ KB připojeno (${KB_CONFIG.username}@${new URL(KB_CONFIG.url).hostname})</span>`
        : `<span style="color: #c62828">❌ KB nepřipojeno${errorMessage ? ': ' + errorMessage : ''}</span>`;
    
    const firstMessage = chatMessages.querySelector('.message.assistant .message-content p');
    if (firstMessage) {
        const modelStatus = firstMessage.innerHTML.includes('Model:') 
            ? firstMessage.innerHTML.match(/<small[^>]*>Model:[^<]*<\/small>/)?.[0] || ''
            : '';
        firstMessage.innerHTML = `Dobrý den! Jsem váš AI asistent pro QI Mobile podporu.<br><small>${modelStatus ? modelStatus + ' | ' : ''}${statusText}</small>`;
    }
}

/**
 * Auto-detect available model from Ollama
 */
async function detectModel() {
    try {
        const response = await fetch(`${OLLAMA_URL}/api/tags`);
        if (!response.ok) {
            throw new Error('Nelze načíst modely');
        }
        
        const data = await response.json();
        const models = data.models || [];
        
        if (models.length === 0) {
            updateStatus('Žádný model není nainstalován. Spusťte: ollama pull llama3.2', 'error');
            return;
        }

        // Prefer instruction-tuned models
        const preferredPatterns = ['instruct', 'chat', 'llama', 'qwen', 'mistral', 'gemma'];
        let selectedModel = models[0].name;
        
        for (const pattern of preferredPatterns) {
            const match = models.find(m => m.name.toLowerCase().includes(pattern));
            if (match) {
                selectedModel = match.name;
                break;
            }
        }

        currentModel = selectedModel;
        updateStatus(`Model: ${currentModel}`, 'success');
        console.log('Detected model:', currentModel);
        console.log('Available models:', models.map(m => m.name));
        
    } catch (error) {
        updateStatus('Nelze se připojit k Ollama. Ujistěte se, že běží.', 'error');
        console.error('Model detection failed:', error);
    }
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

    const maxSteps = 6;
    for (let i = 0; i < maxSteps; i++) {
        const content = await ollamaChat(conversationHistory);
        const action = tryParseAction(content);

        if (!action) {
            // Final response - add to history and return
            conversationHistory.push({ role: "assistant", content: content });
            return content;
        }

        // Handle tool calls
        let result;
        if (action.action === "kb_search") {
            result = await kbSearch(action.query);
        } else {
            // Unknown action, treat as final response
            conversationHistory.push({ role: "assistant", content: content });
            return content;
        }

        // Add tool interaction to history
        conversationHistory.push({ role: "assistant", content: content });
        conversationHistory.push({ role: "user", content: `[Tool result]: ${result}` });
    }

    return "Nedokončeno: příliš mnoho kroků.";
}

/**
 * Call Ollama API
 */
async function ollamaChat(messages) {
    if (!currentModel) {
        throw new Error('Žádný model není k dispozici. Zkontrolujte připojení k Ollama.');
    }

    const payload = {
        model: currentModel,
        messages: messages,
        stream: false
    };

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
        throw new Error(
            `Nelze se připojit k Ollama. Ujistěte se, že:\n` +
            `1. Ollama běží (ollama serve)\n` +
            `2. Je povolen CORS: OLLAMA_ORIGINS=* ollama serve`
        );
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}. ${errorText}`);
    }

    const data = await response.json();
    return data.message.content;
}

/**
 * Try to parse action from response
 * Looks for JSON action anywhere in the text (not just if entire response is JSON)
 */
function tryParseAction(text) {
    text = text.trim();
    
    // First try: entire response is JSON
    if (text.startsWith('{') && text.endsWith('}')) {
        try {
            const obj = JSON.parse(text);
            if (obj.action === 'kb_search') {
                console.log('🔧 Tool call detected (full JSON):', obj);
                return obj;
            }
        } catch (e) {
            // Not valid JSON, continue
        }
    }
    
    // Second try: find JSON object anywhere in text
    const jsonMatch = text.match(/\{[\s\S]*?"action"\s*:\s*"kb_search"[\s\S]*?\}/);
    if (jsonMatch) {
        try {
            const obj = JSON.parse(jsonMatch[0]);
            if (obj.action === 'kb_search') {
                console.log('🔧 Tool call detected (embedded JSON):', obj);
                return obj;
            }
        } catch (e) {
            // Not valid JSON
            console.log('⚠️ Found potential tool call but JSON parse failed:', jsonMatch[0]);
        }
    }

    return null;
}

/**
 * Knowledge base search via SOAP MCLGetFunction
 */
async function kbSearch(query) {
    console.group('🔍 KB Search');
    console.log('Query:', query);
    console.log('Token:', kbToken ? '✅ Present' : '❌ Missing');
    console.log('SOAP URL:', KB_CONFIG.soapUrl || 'Not set');
    
    if (!kbToken) {
        console.warn('KB not configured!');
        console.groupEnd();
        return JSON.stringify({
            status: "error",
            message: "Knowledge base není nakonfigurována. Klikněte na ikonu nastavení."
        });
    }
    
    try {
        const xmlResult = await soapGetFunctionData(
            kbToken,
            "1358186,11241",  // FunctionID for KB search
            "",               // MasterID
            `1274788,11241=${query}`,  // Filter field with search query
            ""                // ActiveFilters
        );
        
        // Parse XML to extract KB articles
        const articles = parseKbArticles(xmlResult);
        console.log('Parsed articles:', articles);
        console.groupEnd();
        
        if (articles.length === 0) {
            return JSON.stringify({
                status: "ok",
                message: `Nenalezeny žádné články pro dotaz: "${query}"`,
                articles: []
            });
        }
        
        return JSON.stringify({
            status: "ok",
            query: query,
            count: articles.length,
            articles: articles
        });
    } catch (error) {
        console.error('KB Search error:', error);
        
        // Check if ticket expired - try to re-login
        if (error.message && error.message.includes('expired')) {
            console.log('🔄 Ticket expired, attempting re-login...');
            const reloginSuccess = await attemptRelogin();
            
            if (reloginSuccess) {
                console.log('✅ Re-login successful, retrying search...');
                console.groupEnd();
                // Retry the search with new ticket
                return await kbSearch(query);
            }
        }
        
        console.groupEnd();
        return JSON.stringify({
            status: "error",
            message: error.message
        });
    }
}

/**
 * Attempt to re-login with stored credentials
 */
async function attemptRelogin() {
    console.group('🔐 Re-login attempt');
    
    try {
        // Clear old token
        kbToken = null;
        
        console.log('URL:', KB_CONFIG.url);
        console.log('Username:', KB_CONFIG.username);
        
        kbToken = await kbLogin();
        saveKbToken();
        
        console.log('✅ Re-login successful, new ticket:', kbToken.substring(0, 20) + '...');
        updateKbStatus(true);
        console.groupEnd();
        return true;
    } catch (error) {
        console.error('❌ Re-login failed:', error.message);
        updateKbStatus(false, 'Session expired, re-login failed');
        console.groupEnd();
        return false;
    }
}

/**
 * Parse KB articles from XML response
 */
function parseKbArticles(xml) {
    const articles = [];
    
    // Find all Record elements
    const recordRegex = /<Record[^>]*>([\s\S]*?)<\/Record>/g;
    let match;
    
    while ((match = recordRegex.exec(xml)) !== null) {
        const recordXml = match[1];
        const article = {};
        
        // Extract field values
        const fieldRegex = /<FieldValue\s+Name="([^"]+)"[^>]*>([^<]*)<\/FieldValue>/g;
        let fieldMatch;
        
        while ((fieldMatch = fieldRegex.exec(recordXml)) !== null) {
            const fieldName = fieldMatch[1];
            const fieldValue = fieldMatch[2].trim();
            
            // Map known field IDs to readable names
            if (fieldName === '1274702,11241') {
                article.articleNumber = fieldValue;
            } else if (fieldName === '1274711,11241') {
                article.category = fieldValue;
            } else if (fieldName === '2946317,11241') {
                article.content = fieldValue;
            } else if (fieldName === '2946318,11241') {
                article.description = fieldValue;
            } else if (fieldName === '1274696,11241') {
                article.library = fieldValue;
            } else if (fieldName === '1274701,11241') {
                article.author = fieldValue;
            } else if (fieldName === '1274704,11241') {
                article.date = fieldValue;
            }
        }
        
        // Only add if we have content
        if (article.content || article.description) {
            articles.push(article);
        }
    }
    
    return articles;
}

/**
 * SOAP call to MCLGetFunction
 */
async function soapGetFunctionData(ticket, functionId, masterId, filter, activeFilters) {
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" 
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" 
               xmlns:q1="urn:AppServer">
    <soap:Body>
        <q1:MCLGetFunction>
            <Ticket>${escapeXml(ticket)}</Ticket>
            <FunctionID>${escapeXml(functionId)}</FunctionID>
            <MasterID>${escapeXml(masterId)}</MasterID>
            <GetDefinition>false</GetDefinition>
            <GetData>true</GetData>
            <Filter>${escapeXml(filter)}</Filter>
            <ActiveFilters>${escapeXml(activeFilters)}</ActiveFilters>
            <RecNoStart>0</RecNoStart>
            <RecNoCount>50</RecNoCount>
        </q1:MCLGetFunction>
    </soap:Body>
</soap:Envelope>`;

    console.group('📡 SOAP MCLGetFunction');
    console.log('URL:', KB_CONFIG.soapUrl);
    console.log('FunctionID:', functionId);
    console.log('Filter:', filter);
    console.log('Request:', soapEnvelope);

    const response = await fetch(PROXY_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'X-Target-URL': KB_CONFIG.soapUrl
        },
        body: soapEnvelope
    });
    
    const responseText = await response.text();
    console.log('Response Status:', response.status, response.statusText);
    console.log('Response:', responseText);
    console.groupEnd();

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText || response.statusText}`);
    }
    
    // Check for SOAP fault
    if (responseText.includes('<faultstring>')) {
        const faultMatch = responseText.match(/<faultstring>([^<]*)<\/faultstring>/);
        const faultMessage = faultMatch ? faultMatch[1] : 'Unknown SOAP error';
        throw new Error(faultMessage);
    }
    
    // Parse MCLGetFunctionResult
    const resultMatch = responseText.match(/<MCLGetFunctionResult[^>]*>([\s\S]*?)<\/MCLGetFunctionResult>/);
    if (!resultMatch || !resultMatch[1]) {
        throw new Error('Žádná data nebyla vrácena');
    }
    
    // The result is XML-encoded, decode it
    const xmlResult = decodeXmlEntities(resultMatch[1]);
    return xmlResult;
}

/**
 * Decode XML entities
 */
function decodeXmlEntities(text) {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

// ============================================
// Configuration Modal Functions
// ============================================

function setupConfigModal() {
    configBtn.addEventListener('click', openConfigModal);
    modalClose.addEventListener('click', closeConfigModal);
    configCancel.addEventListener('click', closeConfigModal);
    configModal.addEventListener('click', (e) => {
        if (e.target === configModal) closeConfigModal();
    });
    configForm.addEventListener('submit', handleConfigSubmit);
}

function openConfigModal() {
    // Pre-fill form with constants (read-only display)
    document.getElementById('kbUrl').value = KB_CONFIG.url;
    document.getElementById('kbUsername').value = KB_CONFIG.username;
    document.getElementById('kbPassword').value = kbToken ? '********' : KB_CONFIG.password;
    setConfigStatus('', '');
    configModal.classList.add('active');
}

function closeConfigModal() {
    configModal.classList.remove('active');
}

function loadKbToken() {
    try {
        kbToken = localStorage.getItem(KB_TOKEN_KEY) || null;
        if (kbToken) {
            console.log('📦 KB Token loaded from localStorage:', kbToken.substring(0, 20) + '...');
        }
    } catch (e) {
        console.error('Failed to load KB token:', e);
    }
}

function saveKbToken() {
    try {
        if (kbToken) {
            localStorage.setItem(KB_TOKEN_KEY, kbToken);
            console.log('💾 KB Token saved:', kbToken.substring(0, 20) + '...');
        } else {
            localStorage.removeItem(KB_TOKEN_KEY);
        }
    } catch (e) {
        console.error('Failed to save KB token:', e);
    }
}

async function handleConfigSubmit(e) {
    e.preventDefault();
    
    const saveBtn = document.getElementById('configSave');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Přihlašování...';
    setConfigStatus('', '');
    
    try {
        kbToken = await kbLogin();
        saveKbToken();
        
        setConfigStatus('Přihlášení úspěšné!', 'success');
        console.log('KB Login successful, ticket:', kbToken);
        updateKbStatus(true);
        
        setTimeout(() => {
            closeConfigModal();
        }, 1000);
        
    } catch (error) {
        setConfigStatus(`Chyba přihlášení: ${error.message}`, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Přihlásit se';
    }
}

/**
 * Login to Knowledge Base API via SOAP (uses KB_CONFIG constants)
 */
async function kbLogin() {
    // Build SOAP envelope for LoginMobile using constants
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" 
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" 
               xmlns:q1="urn:AppServer">
    <soap:Body>
        <q1:LoginMobile>
            <q1:User>${escapeXml(KB_CONFIG.username)}</q1:User>
            <q1:Password>${escapeXml(KB_CONFIG.password)}</q1:Password>
        </q1:LoginMobile>
    </soap:Body>
</soap:Envelope>`;

    console.group('🔐 SOAP LoginMobile');
    console.log('URL:', KB_CONFIG.soapUrl);
    console.log('Request:', soapEnvelope);

    // Use proxy to avoid CORS
    const response = await fetch(PROXY_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'X-Target-URL': KB_CONFIG.soapUrl
        },
        body: soapEnvelope
    });
    
    const responseText = await response.text();
    console.log('Response Status:', response.status, response.statusText);
    console.log('Response:', responseText);
    console.groupEnd();

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText || response.statusText}`);
    }
    
    // Check for SOAP fault
    if (responseText.includes('<faultstring>')) {
        const faultMatch = responseText.match(/<faultstring>([^<]*)<\/faultstring>/);
        const faultMessage = faultMatch ? faultMatch[1] : 'Unknown SOAP error';
        throw new Error(faultMessage);
    }
    
    // Parse LoginMobileResult (the ticket)
    const ticketMatch = responseText.match(/<LoginMobileResult[^>]*>([^<]*)<\/LoginMobileResult>/);
    if (!ticketMatch || !ticketMatch[1]) {
        throw new Error('Token nebyl vrácen ze serveru');
    }
    
    return ticketMatch[1];
}

/**
 * Escape special XML characters
 */
function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function setConfigStatus(message, type) {
    configStatus.textContent = message;
    configStatus.className = 'form-status';
    if (type) {
        configStatus.classList.add(type);
    }
}

// UI Helper Functions

function addMessage(type, text) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}`;

    const avatarText = type === 'user' ? 'Vy' : (type === 'error' ? '!' : 'AI');
    
    // Use markdown for assistant messages, plain text for user
    const formattedText = (type === 'assistant') ? parseMarkdown(text) : escapeHtml(text);
    
    messageEl.innerHTML = `
        <div class="message-avatar">
            <span>${avatarText}</span>
        </div>
        <div class="message-content">
            ${formattedText}
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

/**
 * Simple Markdown parser
 */
function parseMarkdown(text) {
    // Escape HTML first
    let html = escapeHtml(text);
    
    // Code blocks (```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
    
    // Inline code (`)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    
    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    
    // Unordered lists
    html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)\n(?=<li>)/g, '$1');
    html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\n<li>)/g, '<ul>$1</ul>');
    
    // Ordered lists
    html = html.replace(/^\s*\d+\.\s+(.+)$/gm, '<oli>$1</oli>');
    html = html.replace(/(<oli>.*<\/oli>)\n(?=<oli>)/g, '$1');
    html = html.replace(/(<oli>[\s\S]*?<\/oli>)(?!\n<oli>)/g, '<ol>$1</ol>');
    html = html.replace(/<\/?oli>/g, (m) => m === '<oli>' ? '<li>' : '</li>');
    
    // Line breaks - convert double newlines to paragraphs
    html = html.replace(/\n\n+/g, '</p><p>');
    
    // Single line breaks
    html = html.replace(/\n/g, '<br>');
    
    // Wrap in paragraph if not already structured
    if (!html.startsWith('<')) {
        html = '<p>' + html + '</p>';
    } else if (!html.startsWith('<p>') && !html.startsWith('<h') && !html.startsWith('<ul>') && !html.startsWith('<ol>') && !html.startsWith('<pre>')) {
        html = '<p>' + html + '</p>';
    }
    
    // Clean up empty paragraphs
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p>(<[huo])/g, '$1');
    html = html.replace(/(<\/[huo][l234]?>)<\/p>/g, '$1');
    
    return html;
}
