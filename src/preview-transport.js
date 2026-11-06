'use strict';

const {request} = require('node:http');
const {validSourceName} = require('./local-motion');

function bridgePreview(req, browser, pending, origin, videoOrigin) {
    const url = new URL(req.url, origin);
    const source = url.searchParams.get('src');
    if (url.pathname !== '/preview-ws' || req.headers.origin !== origin
            || req.headers.host !== new URL(origin).host || !validSourceName(source)
            || req.headers.upgrade?.toLowerCase() !== 'websocket') {
        browser.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
    }
    const endpoint = new URL('/api/ws', videoOrigin);
    endpoint.searchParams.set('src', source);
    const upstream = request(endpoint, {headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', Origin: videoOrigin,
        'Sec-WebSocket-Key': req.headers['sec-websocket-key'],
        'Sec-WebSocket-Version': req.headers['sec-websocket-version']
    }});
    upstream.setTimeout(5000, () => upstream.destroy());
    upstream.once('response', res => { res.resume(); browser.destroy(); });
    upstream.once('error', () => browser.destroy());
    browser.once('error', () => browser.destroy());
    browser.once('close', () => upstream.destroy());
    upstream.once('upgrade', (response, stream, firstData) => {
        if (browser.destroyed) { stream.destroy(); return; }
        stream.setTimeout(0);
        stream.once('error', () => stream.destroy());
        stream.once('close', () => browser.destroy());
        browser.once('close', () => stream.destroy());
        browser.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
            + `Sec-WebSocket-Accept: ${response.headers['sec-websocket-accept']}\r\n\r\n`);
        if (firstData.length) browser.write(firstData);
        if (pending.length) stream.write(pending);
        browser.pipe(stream).pipe(browser);
    });
    upstream.end();
}

module.exports = {bridgePreview};
