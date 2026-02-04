/**
 * Simple CORS Proxy for SOAP requests
 * Run with: node proxy.js
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 8081;

const server = http.createServer((req, res) => {
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
    
    console.log(`\n📨 Proxying ${req.method} to: ${targetUrl}`);
    
    // Collect request body
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        if (body) {
            console.log('Request body:', body.substring(0, 200) + (body.length > 200 ? '...' : ''));
        }
        
        const parsedUrl = url.parse(targetUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.path,
            method: req.method,
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        
        const proxyReq = client.request(options, (proxyRes) => {
            console.log('Response status:', proxyRes.statusCode);
            
            let responseBody = '';
            proxyRes.on('data', chunk => responseBody += chunk);
            proxyRes.on('end', () => {
                console.log('Response body:', responseBody.substring(0, 200) + (responseBody.length > 200 ? '...' : ''));
                
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
});

server.listen(PORT, () => {
    console.log(`🚀 CORS Proxy running on http://localhost:${PORT}`);
    console.log('Use X-Target-URL header to specify destination');
});
