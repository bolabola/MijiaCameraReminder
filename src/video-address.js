'use strict';

const {isIPv4} = require('node:net');
const {parse} = require('yaml');

function privateAddress(ip) {
    if (!isIPv4(ip)) return false;
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function call(videoOrigin, path, params, method = 'GET') {
    const url = new URL(path, videoOrigin);
    url.search = new URLSearchParams(params);
    const response = await fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error('go2rtc request failed');
    }
    return response;
}

async function configuredSource(videoOrigin, name) {
    const response = await call(videoOrigin, '/api/config');
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 256 * 1024) throw new Error('go2rtc configuration is too large');
        chunks.push(chunk);
    }
    const {streams} = parse(Buffer.concat(chunks, length).toString('utf8'), {maxAliasCount: 0, logLevel: 'silent'}) || {};
    if (!streams || !Object.hasOwn(streams, name)) return;
    const value = streams[name];
    return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function createVideoAddressLookup(videoOrigin) {
    const pending = new Map();

    async function lookup(name) {
        const stream = await (await call(videoOrigin, '/api/streams', {src: name})).json();
        if (stream.producers?.length !== 1) return null;
        const raw = await configuredSource(videoOrigin, name).catch(() => null)
            || stream.producers[0]?.url;
        if (typeof raw !== 'string' || !raw.startsWith('xiaomi://')) return null;
        const source = new URL(raw);
        const did = source.searchParams.get('did');
        if (!did || !source.username || !source.password) return null;

        const data = await (await call(videoOrigin, '/api/xiaomi', {
            id: decodeURIComponent(source.username), region: decodeURIComponent(source.password)
        })).json();
        for (const entry of data.sources || []) {
            let found;
            try { found = new URL(entry.url); } catch { continue; }
            if (found.protocol !== 'xiaomi:' || found.searchParams.get('did') !== did
                    || !privateAddress(found.hostname)) continue;
            if (source.hostname === found.hostname) return {address: source.hostname, changed: false};
            source.hostname = found.hostname;
            const response = await call(videoOrigin, '/api/streams', {name, src: source.href}, 'PATCH');
            await response.body?.cancel();
            return {address: found.hostname, changed: true};
        }
        return null;
    }

    return name => {
        if (pending.has(name)) return pending.get(name);
        const task = lookup(name).finally(() => pending.delete(name));
        pending.set(name, task);
        return task;
    };
}

module.exports = {createVideoAddressLookup};
