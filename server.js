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

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    // SOAP Proxy endpoint
    if (parsedUrl.pathname === '/api/soap') {
        handleSoapProxy(req, res);
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
   
   Press Ctrl+C to stop
`);
});
