'use strict';

const {decode} = require('jpeg-js');
const {setTimeout: delay} = require('node:timers/promises');

const defaultLocalMotion = {enabled: false, source: '', threshold: 10};
const width = 160;
const height = 90;
const maxJpegBytes = 512 * 1024;

function validSourceName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 128
        && name === name.trim() && !/[:/\\\x00-\x1f\x7f]/.test(name);
}

function validLocalMotion(value) {
    return value && typeof value.enabled === 'boolean'
        && (validSourceName(value.source) || (!value.enabled && value.source === ''))
        && Number.isFinite(value.threshold) && value.threshold >= 0.1 && value.threshold <= 100;
}

async function readFrame(url, signal) {
    const response = await fetch(url, {redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)])});
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') {
        await response.body?.cancel();
        throw new Error('JPEG unavailable');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxJpegBytes) throw new Error('JPEG too large');
        chunks.push(chunk);
    }
    const image = decode(Buffer.concat(chunks, size), {
        useTArray: true, formatAsRGBA: false, maxResolutionInMP: 8, maxMemoryUsageInMB: 48
    });
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (Math.floor(y * image.height / height) * image.width + Math.floor(x * image.width / width)) * 3;
            gray[y * width + x] = (77 * image.data[offset] + 150 * image.data[offset + 1] + 29 * image.data[offset + 2]) >> 8;
        }
    }
    return gray;
}

function createLocalMotion(videoOrigin, onMotion, lookupVideoAddress) {
    let settings = defaultLocalMotion;
    let controller;
    let state = {status: '本地检测已关闭', change: null, count: 0, frameId: null};
    let frameId = 0;
    let frames;

    async function watch(options, signal) {
        const url = new URL('/api/frame.jpeg', videoOrigin);
        url.search = new URLSearchParams({src: options.source, width: String(width), height: String(height)});
        let previous;
        let retryDelay = 0;
        let nextLookup = 0;
        while (!signal.aborted) {
            const start = performance.now();
            try {
                const current = await readFrame(url, signal);
                if (signal.aborted) return;
                state.status = '正在检测本地画面';
                retryDelay = 0;
                if (previous) {
                    let changed = 0;
                    for (let i = 0; i < current.length; i++) {
                        if (Math.abs(current[i] - previous[i]) >= 18) changed++;
                    }
                    state.change = 100 * changed / current.length;
                    frames = {previous, current};
                    state.frameId = ++frameId;
                    if (state.change >= options.threshold) {
                        state.count++;
                        onMotion();
                    }
                }
                previous = current;
            } catch {
                if (signal.aborted) return;
                previous = undefined;
                frames = undefined;
                state.frameId = null;
                state.change = null;
                retryDelay = retryDelay ? Math.min(30000, retryDelay * 2) : 4000;
                state.status = `暂时取不到画面，${retryDelay / 1000} 秒后重试。请检查 go2rtc 和摄像头连接。`;
                if (lookupVideoAddress && Date.now() >= nextLookup) {
                    nextLookup = Date.now() + 60000;
                    const found = await lookupVideoAddress(options.source).catch(() => null);
                    if (signal.aborted) return;
                    if (found?.changed) {
                        state.status = '已找到摄像头的新地址，正在重新连接…';
                        retryDelay = 4000;
                    } else if (found) {
                        state.status = `摄像头地址为 ${found.address}。暂时取不到画面，请检查电脑到摄像头的局域网路由。`;
                    }
                }
            }
            await delay(retryDelay || Math.max(0, 2000 - (performance.now() - start)), undefined, {signal}).catch(() => {});
        }
    }

    return {
        get state() { return state; },
        get comparison() {
            if (!frames) return null;
            return {
                id: state.frameId, width, height, change: state.change,
                previous: Buffer.from(frames.previous).toString('base64'),
                current: Buffer.from(frames.current).toString('base64')
            };
        },
        configure(options) {
            if (options.enabled === settings.enabled && options.source === settings.source
                    && options.threshold === settings.threshold) return;
            controller?.abort();
            settings = options;
            frames = undefined;
            state = {
                status: options.enabled ? '正在读取第一张画面…' : '本地检测已关闭',
                change: null, count: 0, frameId: null
            };
            if (!options.enabled) return;
            controller = new AbortController();
            void watch(options, controller.signal);
        }
    };
}

module.exports = {defaultLocalMotion, validSourceName, validLocalMotion, createLocalMotion};
