/**
 * QI Mobile AI Support Server
 * Serves static files and proxies SOAP requests to avoid CORS
 * 
 * Run with: node server.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8080;

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// QIMobile.Maui source code path
const CODE_BASE_PATH = path.join(__dirname, 'QIMobile.Maui');

// Symbol index for semantic search
let symbolIndex = {
    classes: [],      // { name, file, line, namespace, baseClass }
    interfaces: [],   // { name, file, line, namespace }
    methods: [],      // { name, file, line, className, returnType, params }
    properties: [],   // { name, file, line, className, type }
    enums: [],        // { name, file, line, values }
    fields: [],       // { name, file, line, className, type }
    localizations: [], // { key, value, language, file }
    lastIndexed: null
};

// Build symbol index on startup
buildSymbolIndex();

const OLLAMA_URL = 'http://localhost:11434';

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    // Ollama Proxy endpoint
    if (parsedUrl.pathname.startsWith('/api/ollama')) {
        handleOllamaProxy(req, res, parsedUrl.pathname);
        return;
    }
    
    // SOAP Proxy endpoint
    if (parsedUrl.pathname === '/api/soap') {
        handleSoapProxy(req, res);
        return;
    }
    
    // Code Search endpoint
    if (parsedUrl.pathname === '/api/code-search') {
        handleCodeSearch(req, res);
        return;
    }
    
    // Symbol Search endpoint (semantic)
    if (parsedUrl.pathname === '/api/symbol-search') {
        handleSymbolSearch(req, res);
        return;
    }
    
    // Reindex endpoint
    if (parsedUrl.pathname === '/api/reindex') {
        buildSymbolIndex();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', indexed: new Date().toISOString() }));
        return;
    }
    
    // Static file serving
    handleStaticFile(req, res, parsedUrl.pathname);
});

/**
 * Handle SOAP proxy requests
 */
function handleSoapProxy(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Target-URL');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    // Get target URL from header
    const targetUrl = req.headers['x-target-url'];
    if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing X-Target-URL header' }));
        return;
    }
    
    console.log(`📡 SOAP Proxy: ${req.method} -> ${targetUrl}`);
    
    // Collect request body
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        const parsed = new URL(targetUrl);
        const client = parsed.protocol === 'https:' ? https : http;
        
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: req.method,
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        
        const proxyReq = client.request(options, (proxyRes) => {
            let responseBody = '';
            proxyRes.on('data', chunk => responseBody += chunk);
            proxyRes.on('end', () => {
                res.writeHead(proxyRes.statusCode, {
                    'Content-Type': proxyRes.headers['content-type'] || 'text/xml',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(responseBody);
            });
        });
        
        proxyReq.on('error', (err) => {
            console.error('Proxy error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        });
        
        proxyReq.write(body);
        proxyReq.end();
    });
}

/**
 * Handle Ollama API proxy requests
 * Forwards requests to local Ollama instance
 */
function handleOllamaProxy(req, res, pathname) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    // Remove /api/ollama prefix to get actual Ollama path
    const ollamaPath = pathname.replace('/api/ollama', '') || '/';
    const targetUrl = `${OLLAMA_URL}${ollamaPath}`;
    
    console.log(`🤖 Ollama Proxy: ${req.method} ${ollamaPath}`);
    
    // Collect request body
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        const parsed = new URL(targetUrl);
        
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 11434,
            path: parsed.pathname + parsed.search,
            method: req.method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        
        const proxyReq = http.request(options, (proxyRes) => {
            // For streaming responses
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': proxyRes.headers['content-type'] || 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Transfer-Encoding': proxyRes.headers['transfer-encoding'] || 'chunked'
            });
            
            proxyRes.on('data', chunk => res.write(chunk));
            proxyRes.on('end', () => res.end());
        });
        
        proxyReq.on('error', (err) => {
            console.error('Ollama proxy error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        });
        
        if (body) {
            proxyReq.write(body);
        }
        proxyReq.end();
    });
}

/**
 * Serve static files
 */
function handleStaticFile(req, res, pathname) {
    // Default to index.html
    if (pathname === '/') {
        pathname = '/index.html';
    }
    
    const filePath = path.join(__dirname, pathname);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
            return;
        }
        
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

server.listen(PORT, () => {
    console.log(`
🚀 QI Mobile AI Support Server
   
   Local:  http://localhost:${PORT}
   
   Endpoints:
   - Static files: http://localhost:${PORT}/
   - SOAP Proxy:   http://localhost:${PORT}/api/soap
   - Code Search:  http://localhost:${PORT}/api/code-search
   
   Press Ctrl+C to stop
`);
});

/**
 * Handle code search requests
 * Searches through QIMobile.Maui codebase for relevant code snippets
 */
function handleCodeSearch(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            const { query, filePattern } = JSON.parse(body);
            
            if (!query) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing query parameter' }));
                return;
            }
            
            console.log(`🔍 Code Search: "${query}" (pattern: ${filePattern || '*.cs'})`);
            
            const results = searchCodebase(query, filePattern || '*.cs');
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                query,
                count: results.length,
                results
            }));
            
        } catch (err) {
            console.error('Code search error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    });
}

/**
 * Search codebase for query
 */
function searchCodebase(query, filePattern) {
    const results = [];
    const searchTerms = query.toLowerCase().split(/\s+/);
    const extensions = getExtensionsFromPattern(filePattern);
    
    function searchDir(dir) {
        if (!fs.existsSync(dir)) return;
        
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            // Skip common non-source directories
            if (entry.isDirectory()) {
                if (['bin', 'obj', 'node_modules', '.git', 'packages'].includes(entry.name)) {
                    continue;
                }
                searchDir(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (extensions.includes(ext)) {
                    searchFile(fullPath, searchTerms, results);
                }
            }
        }
    }
    
    searchDir(CODE_BASE_PATH);
    
    // Sort by relevance (number of matches)
    results.sort((a, b) => b.relevance - a.relevance);
    
    // Return top 10 results
    return results.slice(0, 10);
}

/**
 * Search a single file for query terms
 */
function searchFile(filePath, searchTerms, results) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const contentLower = content.toLowerCase();
        
        // Check if file contains any search terms
        const matchingTerms = searchTerms.filter(term => contentLower.includes(term));
        if (matchingTerms.length === 0) return;
        
        const relativePath = path.relative(CODE_BASE_PATH, filePath);
        const lines = content.split('\n');
        const snippets = [];
        
        // Find matching lines with context
        for (let i = 0; i < lines.length; i++) {
            const lineLower = lines[i].toLowerCase();
            if (searchTerms.some(term => lineLower.includes(term))) {
                // Get surrounding context (3 lines before and after)
                const start = Math.max(0, i - 3);
                const end = Math.min(lines.length, i + 4);
                const snippet = {
                    lineNumber: i + 1,
                    code: lines.slice(start, end).join('\n'),
                    matchLine: lines[i].trim()
                };
                snippets.push(snippet);
                
                // Skip ahead to avoid overlapping snippets
                i = end;
                
                // Limit snippets per file
                if (snippets.length >= 3) break;
            }
        }
        
        if (snippets.length > 0) {
            results.push({
                file: relativePath,
                relevance: matchingTerms.length * snippets.length,
                matchingTerms,
                snippets
            });
        }
        
    } catch (err) {
        // Skip files that can't be read
    }
}

/**
 * Get file extensions from pattern
 */
function getExtensionsFromPattern(pattern) {
    // Support patterns like *.cs, *.xaml, *.cs,*.xaml
    const patterns = pattern.split(',').map(p => p.trim());
    const extensions = [];
    
    for (const p of patterns) {
        const match = p.match(/\*(\.\w+)$/);
        if (match) {
            extensions.push(match[1].toLowerCase());
        }
    }
    
    // Default to common source files if no valid pattern
    if (extensions.length === 0) {
        return ['.cs', '.xaml', '.json', '.csv'];
        return ['.cs', '.xaml', '.json'];
    }
    
    return extensions;
}

// ============================================
// SYMBOL INDEX & SEMANTIC SEARCH
// ============================================

/**
 * Build symbol index from C# codebase
 */
function buildSymbolIndex() {
    console.log('📚 Building symbol index...');
    const startTime = Date.now();
    
    // Reset index
    symbolIndex = {
        classes: [],
        interfaces: [],
        methods: [],
        properties: [],
        enums: [],
        fields: [],
        localizations: [],
        lastIndexed: null
    };
    
    indexDirectory(CODE_BASE_PATH);
    
    // Index localization files
    indexLocalizationFiles();
    
    symbolIndex.lastIndexed = new Date().toISOString();
    const elapsed = Date.now() - startTime;
    
    console.log(`✅ Symbol index built in ${elapsed}ms:`);
    console.log(`   - Classes: ${symbolIndex.classes.length}`);
    console.log(`   - Interfaces: ${symbolIndex.interfaces.length}`);
    console.log(`   - Methods: ${symbolIndex.methods.length}`);
    console.log(`   - Properties: ${symbolIndex.properties.length}`);
    console.log(`   - Enums: ${symbolIndex.enums.length}`);
    console.log(`   - Fields: ${symbolIndex.fields.length}`);
    console.log(`   - Localizations: ${symbolIndex.localizations.length}`);
}

/**
 * Index localization CSV files
 */
function indexLocalizationFiles() {
    const localizationDir = path.join(CODE_BASE_PATH, 'QI.Core', 'Localization');
    if (!fs.existsSync(localizationDir)) return;
    
    const files = fs.readdirSync(localizationDir);
    
    for (const file of files) {
        if (!file.endsWith('.csv')) continue;
        
        const filePath = path.join(localizationDir, file);
        const relativePath = path.relative(CODE_BASE_PATH, filePath);
        
        // Determine language from filename
        let language = 'en';
        if (file.includes('_cs')) language = 'cs';
        else if (file.includes('_sk')) language = 'sk';
        else if (file.includes('_de')) language = 'de';
        
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            
            for (let i = 1; i < lines.length; i++) { // Skip header
                const line = lines[i].trim();
                if (!line) continue;
                
                // Parse CSV line (simple parser for Key,Value format)
                const match = line.match(/^([^,]+),(.*)$/);
                if (match) {
                    const key = match[1].trim();
                    let value = match[2].trim();
                    // Remove quotes if present
                    if (value.startsWith('"') && value.endsWith('"')) {
                        value = value.slice(1, -1);
                    }
                    
                    if (key && value) {
                        symbolIndex.localizations.push({
                            key,
                            value,
                            language,
                            file: relativePath,
                            line: i + 1
                        });
                    }
                }
            }
        } catch (err) {
            console.error(`Error indexing ${file}:`, err.message);
        }
    }
}

/**
 * Index a directory recursively
 */
function indexDirectory(dir) {
    if (!fs.existsSync(dir)) return;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
            if (['bin', 'obj', 'node_modules', '.git', 'packages', 'Resources'].includes(entry.name)) {
                continue;
            }
            indexDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.cs')) {
            indexCSharpFile(fullPath);
        }
    }
}

/**
 * Index a single C# file for symbols
 */
function indexCSharpFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const relativePath = path.relative(CODE_BASE_PATH, filePath);
        const lines = content.split('\n');
        
        let currentNamespace = '';
        let currentClass = '';
        let braceDepth = 0;
        let classStartDepth = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;
            
            // Track brace depth
            braceDepth += (line.match(/{/g) || []).length;
            braceDepth -= (line.match(/}/g) || []).length;
            
            // Reset class context when we exit class scope
            if (currentClass && braceDepth < classStartDepth) {
                currentClass = '';
            }
            
            // Namespace
            const namespaceMatch = line.match(/^\s*namespace\s+([\w.]+)/);
            if (namespaceMatch) {
                currentNamespace = namespaceMatch[1];
            }
            
            // Class
            const classMatch = line.match(/^\s*(?:public|private|protected|internal)?\s*(?:partial|abstract|sealed|static)?\s*class\s+(\w+)(?:\s*<[^>]+>)?(?:\s*:\s*([^{]+))?/);
            if (classMatch) {
                currentClass = classMatch[1];
                classStartDepth = braceDepth;
                symbolIndex.classes.push({
                    name: classMatch[1],
                    file: relativePath,
                    line: lineNum,
                    namespace: currentNamespace,
                    baseClass: classMatch[2]?.trim() || null,
                    fullName: currentNamespace ? `${currentNamespace}.${classMatch[1]}` : classMatch[1]
                });
            }
            
            // Interface
            const interfaceMatch = line.match(/^\s*(?:public|private|protected|internal)?\s*interface\s+(I\w+)(?:\s*<[^>]+>)?(?:\s*:\s*([^{]+))?/);
            if (interfaceMatch) {
                currentClass = interfaceMatch[1];
                classStartDepth = braceDepth;
                symbolIndex.interfaces.push({
                    name: interfaceMatch[1],
                    file: relativePath,
                    line: lineNum,
                    namespace: currentNamespace,
                    extends: interfaceMatch[2]?.trim() || null
                });
            }
            
            // Enum
            const enumMatch = line.match(/^\s*(?:public|private|protected|internal)?\s*enum\s+(\w+)/);
            if (enumMatch) {
                symbolIndex.enums.push({
                    name: enumMatch[1],
                    file: relativePath,
                    line: lineNum,
                    namespace: currentNamespace
                });
            }
            
            // Method (inside a class) - improved regex to catch Task<T?>, generics, etc.
            if (currentClass) {
                // Match: [modifiers] ReturnType MethodName(params)
                const methodMatch = line.match(/^\s*(?:public|private|protected|internal)?\s*(?:static|virtual|override|async|abstract|sealed|new)?\s*(?:static|virtual|override|async|abstract|sealed|new)?\s*([\w<>,\s\[\]\?]+?)\s+(\w+)\s*\(([^)]*)\)/);
                if (methodMatch && !line.includes(' class ') && !line.includes(' interface ') && !line.includes(' enum ')) {
                    const returnType = methodMatch[1].trim();
                    const methodName = methodMatch[2];
                    // Skip constructors, property accessors, and common false positives
                    const skipNames = ['get', 'set', 'add', 'remove', 'if', 'while', 'for', 'foreach', 'switch', 'catch', 'using', 'lock'];
                    if (methodName !== currentClass && !skipNames.includes(methodName) && returnType !== 'new') {
                        symbolIndex.methods.push({
                            name: methodName,
                            file: relativePath,
                            line: lineNum,
                            className: currentClass,
                            returnType: returnType,
                            params: methodMatch[3].trim(),
                            fullName: `${currentClass}.${methodName}`
                        });
                    }
                }
                
                // Property - match both inline { get; set; } and multiline { \n get
                const propertyMatch = line.match(/^\s*(?:public|private|protected|internal)?\s*(?:static|virtual|override|abstract|new)?\s*(?:static|virtual|override|abstract)?\s*([\w<>,\[\]?\s]+?)\s+(\w+)\s*$/);
                // Check if next line or same line has { get/set
                if (propertyMatch && i + 1 < lines.length) {
                    const nextLine = lines[i + 1];
                    if (nextLine.trim().startsWith('{') || line.includes('{')) {
                        // Check for get/set in next few lines
                        const checkLines = lines.slice(i, Math.min(i + 4, lines.length)).join(' ');
                        if (checkLines.includes('get') || checkLines.includes('set')) {
                            const propType = propertyMatch[1].trim();
                            const propName = propertyMatch[2];
                            if (!['class', 'interface', 'enum', 'namespace', 'if', 'else', 'for', 'foreach', 'while', 'return'].includes(propType)) {
                                symbolIndex.properties.push({
                                    name: propName,
                                    file: relativePath,
                                    line: lineNum,
                                    className: currentClass,
                                    type: propType,
                                    fullName: `${currentClass}.${propName}`
                                });
                            }
                        }
                    }
                }
                // Also check inline property syntax: Type Name { get; set; }
                const inlinePropertyMatch = line.match(/^\s*(?:public|private|protected|internal)?\s*(?:static|virtual|override|abstract|new)?\s*([\w<>,\[\]?]+)\s+(\w+)\s*{\s*(?:get|set)/);
                if (inlinePropertyMatch) {
                    // Avoid duplicates
                    const exists = symbolIndex.properties.some(p => p.file === relativePath && p.line === lineNum);
                    if (!exists) {
                        symbolIndex.properties.push({
                            name: inlinePropertyMatch[2],
                            file: relativePath,
                            line: lineNum,
                            className: currentClass,
                            type: inlinePropertyMatch[1].trim(),
                            fullName: `${currentClass}.${inlinePropertyMatch[2]}`
                        });
                    }
                }
                
                // Field
                const fieldMatch = line.match(/^\s*(?:public|private|protected|internal)?\s*(?:static|readonly|const)?\s*(?:readonly|const)?\s*([\w<>,\[\]?]+)\s+(\w+)\s*[;=]/);
                if (fieldMatch && !line.includes('(') && !line.includes('{')) {
                    const fieldType = fieldMatch[1].trim();
                    const fieldName = fieldMatch[2];
                    // Skip common false positives
                    if (!['return', 'throw', 'new', 'var', 'if', 'else', 'for', 'foreach', 'while', 'using', 'namespace', 'class', 'interface'].includes(fieldType)) {
                        symbolIndex.fields.push({
                            name: fieldName,
                            file: relativePath,
                            line: lineNum,
                            className: currentClass,
                            type: fieldType,
                            fullName: `${currentClass}.${fieldName}`
                        });
                    }
                }
            }
        }
    } catch (err) {
        // Skip files that can't be read
    }
}

/**
 * Handle symbol search requests
 */
function handleSymbolSearch(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try {
            // Check if index is ready
            if (!symbolIndex.lastIndexed) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Index is still building, please try again in a few seconds' }));
                return;
            }
            
            const { query, type, className } = JSON.parse(body);
            
            if (!query) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing query parameter' }));
                return;
            }
            
            console.log(`🔎 Symbol Search: "${query}" (type: ${type || 'all'}, class: ${className || 'any'})`);
            
            const results = searchSymbols(query, type, className);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                query,
                type: type || 'all',
                count: results.length,
                results,
                indexedAt: symbolIndex.lastIndexed
            }));
            
        } catch (err) {
            console.error('Symbol search error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    });
}

/**
 * Search symbols by name
 */
function searchSymbols(query, type, className) {
    const queryLower = query.toLowerCase();
    const results = [];
    
    // Helper to check if symbol matches
    const matches = (symbol) => {
        const nameMatch = symbol.name.toLowerCase().includes(queryLower) ||
                         (symbol.fullName && symbol.fullName.toLowerCase().includes(queryLower));
        const classMatch = !className || (symbol.className && symbol.className.toLowerCase().includes(className.toLowerCase()));
        return nameMatch && classMatch;
    };
    
    // Helper to check if localization matches
    const matchesLocalization = (loc) => {
        return loc.key.toLowerCase().includes(queryLower) ||
               loc.value.toLowerCase().includes(queryLower);
    };
    
    // Search based on type
    const searchTypes = type ? [type] : ['classes', 'interfaces', 'methods', 'properties', 'enums', 'fields'];
    
    for (const t of searchTypes) {
        if (symbolIndex[t]) {
            for (const symbol of symbolIndex[t]) {
                if (matches(symbol)) {
                    results.push({
                        ...symbol,
                        symbolType: t.slice(0, -1) // Remove 's' (classes -> class)
                    });
                }
            }
        }
    }
    
    // Also search localizations if no specific type or type is 'localizations'
    if (!type || type === 'localizations') {
        for (const loc of symbolIndex.localizations) {
            if (matchesLocalization(loc)) {
                results.push({
                    ...loc,
                    name: loc.key,
                    symbolType: 'localization'
                });
            }
        }
    }
    
    // Sort by exact match first, then by name length
    results.sort((a, b) => {
        const aExact = a.name.toLowerCase() === queryLower ? 0 : 1;
        const bExact = b.name.toLowerCase() === queryLower ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        return a.name.length - b.name.length;
    });
    
    // Get code snippets for top results (skip for localizations)
    return results.slice(0, 15).map(symbol => {
        if (symbol.symbolType === 'localization') {
            return symbol; // No code snippet for localizations
        }
        const snippet = getCodeSnippet(symbol.file, symbol.line);
        return { ...symbol, code: snippet };
    });
}

/**
 * Get code snippet around a line
 */
function getCodeSnippet(file, line) {
    try {
        const filePath = path.join(CODE_BASE_PATH, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        
        // For classes, show more context (up to 50 lines) to capture important details
        const start = Math.max(0, line - 3);
        const end = Math.min(lines.length, line + 50);
        
        return lines.slice(start, end).join('\n');
    } catch (err) {
        return null;
    }
}