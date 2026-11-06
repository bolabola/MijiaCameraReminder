'use strict';

const {createServer} = require('node:http');
const {createHash, randomBytes, timingSafeEqual} = require('node:crypto');
const {spawn} = require('node:child_process');
const {mkdirSync, readFileSync, writeFileSync, renameSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {connect} = require('mqtt');
const {dpapi, flashRed, listScreens, clearRed} = require('./windows-native');
const {defaultLocalMotion, validSourceName, validLocalMotion, createLocalMotion} = require('./local-motion');
const {bridgePreview} = require('./preview-transport');
const {createVideoAddressLookup} = require('./video-address');

const host = '127.0.0.1';
const port = 18733;
const origin = `http://${host}:${port}`;
const videoOrigin = 'http://127.0.0.1:1984';
const root = resolve(__dirname, '..');
const dataDir = join(root, 'data');
const sessionFile = join(dataDir, 'session.dat');
const settingsFile = join(dataDir, 'preferences.json');
const formKey = randomBytes(24).toString('hex');
const clientId = '2882303761520251711';
const redirect = 'http://homeassistant.local:8123';
const tokenEndpoint = 'https://ha.api.io.mi.com/app/v2/ha/oauth/get_token';
const broker = 'mqtts://cn-ha.mqtt.io.mi.com:8883';
let legacyDid;
try {
    const {cameraDid} = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (validDid(cameraDid)) legacyDid = cameraDid;
} catch {}
mkdirSync(dataDir, {recursive: true});

let preferences = {person: true, motion: true, seconds: 5, screenIds: null, localMotion: defaultLocalMotion};
const lookupVideoAddress = createVideoAddressLookup(videoOrigin);
const localMotionDetector = createLocalMotion(videoOrigin, () => showRed(), lookupVideoAddress);
let cameras = new Map();
let cameraStatus = '请先完成小米授权';
let cameraRequest;
let activeCamera;
let activePairs;
const events = {};
const lastPayload = new Map();
let status = '请先完成小米授权';
let redStatus = '';
let previewStatus = '';
let attempt;
let session;
let mqtt;
let refreshTimer;
let authBusy = false;

function validDid(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(value);
}

function validPreferences(value) {
    return value && typeof value.person === 'boolean' && typeof value.motion === 'boolean'
        && Number.isInteger(value.seconds) && value.seconds >= 1 && value.seconds <= 60;
}

function validScreenIds(ids) {
    return ids === null || (Array.isArray(ids) && ids.length > 0 && ids.length <= 64
        && ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 32));
}

function savePreferences(next) {
    atomicWrite(settingsFile, JSON.stringify(next));
    preferences = next;
}

function atomicWrite(file, value) {
    const temporary = file + '.tmp';
    writeFileSync(temporary, value, {encoding: 'utf8', mode: 0o600});
    renameSync(temporary, file);
}

function loadSettings() {
    try {
        const value = JSON.parse(readFileSync(settingsFile, 'utf8'));
        if (validPreferences(value)) {
            preferences = {
                person: value.person, motion: value.motion, seconds: value.seconds,
                screenIds: validScreenIds(value.screenIds) ? value.screenIds : null,
                cameraDid: validDid(value.cameraDid) ? value.cameraDid : undefined,
                localMotion: validLocalMotion(value.localMotion) ? value.localMotion : defaultLocalMotion
            };
        }
    } catch (error) {
        if (error.code !== 'ENOENT') redStatus = '设置文件无法读取，暂用默认值。';
    }
    try {
        const encrypted = readFileSync(sessionFile, 'utf8');
        const value = JSON.parse(dpapi('--unprotect', encrypted));
        if (!/^ha\.[a-f0-9]{32}$/.test(value.deviceId) || !value.accessToken
                || !value.refreshToken || !Number.isFinite(value.expiresAt)) {
            throw new Error('Invalid saved session');
        }
        session = value;
    } catch (error) {
        if (error.code !== 'ENOENT') status = '无法读取已保存的小米授权，请重新授权。';
    }
}

function newOAuthUrl() {
    const deviceId = 'ha.' + randomBytes(16).toString('hex');
    const state = createHash('sha1').update(`d=${deviceId}`).digest('hex');
    attempt = {deviceId, state, expiresAt: Date.now() + 10 * 60 * 1000};
    const url = new URL('https://account.xiaomi.com/oauth2/authorize');
    url.search = new URLSearchParams({
        redirect_uri: redirect, client_id: clientId, response_type: 'code',
        device_id: deviceId, state, skip_confirm: 'false'
    });
    return url.href;
}

function readCode(address, expectedState) {
    let url;
    try {
        url = new URL(address);
        if (url.origin === redirect && url.pathname === '/auth/authorize') {
            const nested = url.searchParams.getAll('redirect_uri');
            if (nested.length !== 1) throw new Error('Missing redirect');
            url = new URL(nested[0]);
        }
    } catch { throw new Error('请粘贴小米回跳后的完整地址。'); }
    const codes = url.searchParams.getAll('code');
    const states = url.searchParams.getAll('state');
    if (url.origin !== redirect || url.pathname !== '/' || states.length !== 1
            || states[0] !== expectedState || codes.length !== 1 || !codes[0]) {
        throw new Error('授权地址与本次授权不匹配，请从本页重新开始。');
    }
    return codes[0];
}

async function requestToken(deviceId, grant, previousRefresh) {
    const endpoint = new URL(tokenEndpoint);
    endpoint.searchParams.set('data', JSON.stringify({
        client_id: JSON.rawJSON(clientId), redirect_uri: redirect, ...grant
    }));
    let result;
    try {
        const response = await fetch(endpoint, {
            headers: {'User-Agent': `ha_xiaomi_home/event-web client/${deviceId}`},
            redirect: 'error', signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error('Token endpoint error');
        const envelope = await response.json();
        if (envelope.code !== 0) throw new Error('OAuth was refused');
        result = envelope.result;
    } catch { throw new Error('小米未完成授权，请重新打开授权页后再试。'); }
    if (!result?.access_token || !(result.refresh_token || previousRefresh)) {
        throw new Error('小米返回的授权资料不完整。');
    }
    const lifetime = Number(result.expires_in);
    if (!Number.isFinite(lifetime) || lifetime <= 0) throw new Error('小米返回的授权有效期无效。');
    return {
        deviceId, accessToken: result.access_token,
        refreshToken: result.refresh_token || previousRefresh,
        expiresAt: Date.now() + lifetime * 1000,
        refreshAt: Date.now() + Math.max(5, lifetime - Math.min(600, lifetime / 4)) * 1000
    };
}

function activate(value) {
    const newAuthorization = session?.deviceId !== value.deviceId;
    session = value;
    let saved = true;
    try { atomicWrite(sessionFile, dpapi('--protect', JSON.stringify(value))); }
    catch { saved = false; }
    if (newAuthorization) {
        cameras = new Map();
        cameraRequest = undefined;
        stopCamera('正在读取小米摄像头列表');
    }
    if (activeCamera) startMqtt(value);
    else if (!cameraRequest) discoverCameras().catch(() => {});
    scheduleRefresh();
    return saved;
}

async function fetchCameras(value) {
    const found = new Map();
    const cursors = new Set();
    let cursor;
    do {
        const response = await fetch('https://ha.api.io.mi.com/app/v2/home/device_list_page', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
            headers: {'Content-Type': 'application/json', 'X-Client-BizId': 'haapi',
                'X-Client-AppId': clientId, 'Authorization': 'Bearer' + value.accessToken,
                'User-Agent': `ha_xiaomi_home/event-web client/${value.deviceId}`},
            body: JSON.stringify({limit: 200, get_split_device: true, get_third_device: true,
                dids: [], ...(cursor ? {start_did: cursor} : {})})
        });
        if (!response.ok) throw new Error('Device list unavailable');
        const {code, result} = await response.json();
        if (code !== 0 || !Array.isArray(result?.list)) throw new Error('Device list unavailable');
        for (const {did, name, model, spec_type: spec} of result.list) {
            if (!validDid(did) || typeof model !== 'string'
                || !(model.includes('.camera.') || spec?.startsWith('urn:miot-spec-v2:device:camera:'))) continue;
            found.set(did, {did, name: typeof name === 'string' && name ? name : model, model, spec});
        }
        cursor = result.has_more ? result.next_start_did : undefined;
        if (cursor) {
            if (cursors.has(cursor)) throw new Error('Repeated device list cursor');
            cursors.add(cursor);
        }
    } while (cursor);
    return found;
}

async function cameraPairs(camera) {
    if (camera.model === 'chuangmi.camera.039c01') return [['8/2', 'person'], ['8/10', 'motion']];
    if (!camera.spec) return [];
    const endpoint = new URL('https://miot-spec.org/miot-spec-v2/instance');
    endpoint.searchParams.set('type', camera.spec);
    const response = await fetch(endpoint, {signal: AbortSignal.timeout(8000), redirect: 'error'});
    if (!response.ok) throw new Error('暂时无法读取这个型号的事件定义，请重试。');
    const {services} = await response.json();
    const names = new Map([['someone-appeared', 'person'], ['person-detected', 'person'],
        ['object-motion', 'motion'], ['motion-detected', 'motion'], ['motion-detection', 'motion']]);
    const pairs = [];
    for (const service of services || []) {
        for (const event of service.events || []) {
            const name = names.get(event.type?.split(':')[3]);
            if (name && Number.isInteger(service.iid) && Number.isInteger(event.iid)) {
                pairs.push([`${service.iid}/${event.iid}`, name]);
            }
        }
    }
    return pairs;
}

function stopCamera(message) {
    const previous = mqtt;
    mqtt = undefined;
    previous?.end(true);
    activeCamera = activePairs = undefined;
    delete events.person;
    delete events.motion;
    lastPayload.clear();
    previewStatus = '';
    status = message;
}

function discoverCameras() {
    if (!session) throw new Error('请先完成小米授权。');
    if (cameraRequest) return cameraRequest;
    const value = session;
    cameraStatus = '正在读取摄像头列表…';
    const task = (async () => {
        try {
            const found = await fetchCameras(value);
            if (session.deviceId !== value.deviceId) return;
            cameras = found;
            cameraStatus = found.size ? '' : '小米账号未返回摄像头。';
            if (activeCamera && !found.has(activeCamera.did)) stopCamera('当前摄像头已不在小米列表中');
            if (activeCamera) return;
            const target = found.get(preferences.cameraDid || legacyDid);
            if (target) {
                const pairs = await cameraPairs(target);
                if (session.deviceId !== value.deviceId || activeCamera) return;
                activeCamera = target;
                activePairs = pairs;
                startMqtt(session);
                return;
            }
            status = found.size ? '请选择要监听的摄像头' : '未找到可选择的摄像头';
        } catch {
            if (session.deviceId === value.deviceId) {
                cameraStatus = '无法加载摄像头列表或事件定义，请刷新摄像头列表。';
                if (!activeCamera) status = '等待选择摄像头';
                throw new Error(cameraStatus);
            }
        }
    })().finally(() => { if (cameraRequest === task) cameraRequest = undefined; });
    cameraRequest = task;
    return task;
}

function scheduleRefresh(delay = Math.max(5000, (session.refreshAt || session.expiresAt) - Date.now())) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, Math.min(delay, 2147483647));
}

async function refresh() {
    if (!session) return;
    if (authBusy) { scheduleRefresh(30000); return; }
    authBusy = true;
    try {
        const value = await requestToken(session.deviceId,
            {refresh_token: session.refreshToken}, session.refreshToken);
        activate(value);
    } catch {
        if (session.expiresAt <= Date.now()) status = '小米授权续期失败，可以重新授权。';
        scheduleRefresh(60000);
    } finally { authBusy = false; }
}

function startMqtt(value) {
    const previous = mqtt;
    mqtt = undefined;
    previous?.end(true);
    if (!activePairs.length) {
        status = '已选择摄像头；这个型号未公开可订阅的人形或画面变动事件';
        return;
    }
    const topics = new Map(activePairs.map(([pair, name]) =>
        [`device/${activeCamera.did}/up/event_occured/${pair}`, name]));
    status = '正在连接小米事件服务';
    const client = connect(broker, {
        protocolVersion: 5, clientId: value.deviceId, username: clientId,
        password: value.accessToken, keepalive: 60, reconnectPeriod: 5000,
        connectTimeout: 15000, resubscribe: false, clean: true
    });
    mqtt = client;
    client.on('connect', async () => {
        if (mqtt !== client) return;
        try {
            const granted = await client.subscribeAsync([...topics.keys()], {qos: 1});
            if (mqtt !== client) return;
            status = granted.length === topics.size && granted.every(item => item.qos <= 2)
                ? '正在监听小米原生事件' : '小米未确认全部事件订阅';
        } catch {
            if (mqtt === client) status = '事件订阅失败，等待重连';
        }
    });
    client.on('error', error => {
        if (mqtt !== client) return;
        status = [134, 135].includes(error.code)
            ? '小米拒绝了授权，可从本页重新授权' : '小米连接暂时不可用，正在重试';
    });
    client.on('reconnect', () => {
        if (mqtt === client) status = '正在重新连接小米';
    });
    client.on('message', (topic, payload, packet) => {
        const event = topics.get(topic);
        if (mqtt !== client || !event || packet.retain) return;
        const now = Date.now();
        const hash = createHash('sha256').update(payload).digest('hex');
        const previous = lastPayload.get(topic);
        if (packet.dup && previous?.hash === hash && now - previous.time < 30000) return;
        lastPayload.set(topic, {hash, time: now});
        events[event] = {time: new Date(now).toLocaleTimeString('zh-CN', {hour12: false}),
            count: (events[event]?.count || 0) + 1};
        if (preferences[event]) showRed();
    });
}

function showRed(settings = preferences) {
    try {
        flashRed(settings.seconds, settings.screenIds);
        redStatus = '';
        return true;
    } catch (error) {
        redStatus = error.message.startsWith('所选屏幕') ? error.message
            : '无法显示 Windows 红屏，请在交互式桌面会话中运行。';
        return false;
    }
}

async function fetchVideoStreams() {
    try {
        const response = await fetch(videoOrigin + '/api/streams', {
            redirect: 'error', signal: AbortSignal.timeout(2000)
        });
        if (!response.ok) throw new Error('Stream list unavailable');
        const streams = await response.json();
        if (!streams || typeof streams !== 'object' || Array.isArray(streams)) {
            throw new Error('Invalid stream list');
        }
        return streams;
    } catch {
        throw new Error('无法读取视频流列表，请确认 go2rtc 已在 127.0.0.1:1984 启动。');
    }
}

async function previewSource(did) {
    const streams = await fetchVideoStreams();
    for (const [name, stream] of Object.entries(streams)) {
        if (!Array.isArray(stream?.producers)) continue;
        for (const producer of stream.producers) {
            try {
                const source = new URL(producer?.url);
                if (source.protocol === 'xiaomi:' && source.searchParams.get('did') === did) return name;
            } catch {}
        }
    }
    throw new Error('当前摄像头没有预览来源，请先在 go2rtc 中添加这台摄像头。');
}

function reply(response, code, value, type = 'application/json; charset=utf-8') {
    response.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store'});
    response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

async function readJson(request) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > 8192) throw new Error('提交内容太长。');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('提交格式无效。'); }
}

async function handle(request, response) {
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ws://${host}:${port}; media-src blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`);
    if (request.headers.host !== `${host}:${port}`) return reply(response, 403, {error: '仅允许本机访问。'});

    if (request.method === 'GET') {
        switch (new URL(request.url, origin).pathname) {
            case '/':
                return reply(response, 200, readFileSync(join(__dirname, 'index.html'), 'utf8')
                    .replace('FORM_KEY_PLACEHOLDER', formKey), 'text/html; charset=utf-8');
            case '/app.js':
                return reply(response, 200, readFileSync(join(__dirname, 'app.js')), 'text/javascript; charset=utf-8');
            case '/preview-client.js': {
                const script = await fetch(videoOrigin + '/video-rtc.js', {
                    redirect: 'error', signal: AbortSignal.timeout(3000)
                });
                if (!script.ok) throw new Error('无法加载 go2rtc 播放器。');
                return reply(response, 200, await script.text(), 'text/javascript; charset=utf-8');
            }
            case '/status':
                return reply(response, 200, {app: 'mijia-event-web',
                    status: preferences.localMotion.enabled
                        ? (preferences.person || preferences.motion ? `本地检测已开启 · ${status}` : '本地检测已开启')
                        : status,
                    events, preferences, redStatus,
                    previewStatus, localMotion: localMotionDetector.state,
                    authorized: Boolean(session), cameraStatus, cameraDid: activeCamera?.did,
                    eventTypes: [...new Set(activePairs?.map(([, name]) => name))],
                    cameras: [...cameras.values()].map(({did, name, model}) => ({did, name, model}))});
            case '/screens':
                return reply(response, 200, {screens: listScreens()});
            default: return reply(response, 404, {error: '页面不存在。'});
        }
    }
    const supplied = Buffer.from(request.headers['x-mijia-key'] || '');
    if (request.method !== 'POST' || request.headers.origin !== origin
            || supplied.length !== formKey.length || !timingSafeEqual(supplied, Buffer.from(formKey))) {
        return reply(response, 403, {error: '请从本机页面提交。'});
    }
    const body = await readJson(request);
    switch (request.url) {
        case '/oauth':
            if (authBusy) throw new Error('另一个授权请求正在处理。');
            return reply(response, 200, {url: newOAuthUrl()});
        case '/authorize': {
            if (authBusy || !attempt || attempt.expiresAt < Date.now()) throw new Error('请重新打开小米授权页。');
            const code = readCode(body?.redirect, attempt.state);
            const {deviceId} = attempt;
            authBusy = true;
            try {
                const value = await requestToken(deviceId, {code, device_id: deviceId});
                attempt = undefined;
                const saved = activate(value);
                return reply(response, 200, {ok: true, saved});
            } finally { authBusy = false; }
        }
        case '/cameras':
            await discoverCameras();
            return reply(response, 200, {ok: true});
        case '/camera': {
            const target = cameras.get(body?.did);
            if (!session || !target) throw new Error('请从小米摄像头列表中选择。');
            const {deviceId} = session;
            if (activeCamera?.did !== target.did) {
                const pairs = await cameraPairs(target);
                if (session.deviceId !== deviceId || cameras.get(target.did) !== target) {
                    throw new Error('摄像头列表已更新，请重新选择。');
                }
                savePreferences({...preferences, cameraDid: target.did});
                stopCamera('');
                activeCamera = target;
                activePairs = pairs;
                startMqtt(session);
            }
            return reply(response, 200, {ok: true});
        }
        case '/preferences': {
            if (!validPreferences(body)) throw new Error('红屏时间须为 1 到 60 秒。');
            const localMotion = Object.hasOwn(body, 'localMotion') ? body.localMotion : preferences.localMotion;
            if (!validLocalMotion(localMotion)) throw new Error('请选择 go2rtc 视频流，变化阈值须为 0.1% 到 100%。');
            const screenIds = Object.hasOwn(body, 'screenIds') ? body.screenIds : preferences.screenIds;
            if (!validScreenIds(screenIds)) throw new Error('请至少勾选一个屏幕。');
            const next = screenIds === null ? null : [...new Set(screenIds)].sort();
            if (next?.some(id => !preferences.screenIds?.includes(id))) {
                const connected = new Set(listScreens().map(screen => screen.id));
                if (next.some(id => !connected.has(id) && !preferences.screenIds?.includes(id))) {
                    throw new Error('显示器已更改，请刷新屏幕列表。');
                }
            }
            const modeChanged = localMotion.enabled !== preferences.localMotion.enabled;
            const changed = JSON.stringify(next) !== JSON.stringify(preferences.screenIds) || modeChanged
                || (localMotion.enabled && localMotion.source !== preferences.localMotion.source);
            savePreferences({...preferences, person: body.person, motion: body.motion,
                seconds: body.seconds, screenIds: next,
                localMotion: {enabled: localMotion.enabled, source: localMotion.source, threshold: localMotion.threshold}});
            if (changed) clearRed();
            localMotionDetector.configure(preferences.localMotion);
            return reply(response, 200, {ok: true});
        }
        case '/test-red': {
            const testSettings = Object.hasOwn(body, 'screenIds') ? body : preferences;
            if (!validPreferences(testSettings)) throw new Error('红屏时间须为 1 到 60 秒。');
            if (!validScreenIds(testSettings.screenIds)) throw new Error('请至少勾选一个屏幕。');
            clearRed();
            if (!showRed(testSettings)) throw new Error(redStatus);
            return reply(response, 200, {ok: true});
        }
        case '/video-sources': {
            const streams = await fetchVideoStreams();
            const sources = Object.keys(streams).filter(validSourceName)
                .sort((a, b) => a.localeCompare(b, 'zh-CN'));
            return reply(response, 200, {sources});
        }
        case '/video-address': {
            const source = body?.source;
            if (!validSourceName(source)) throw new Error('请选择 go2rtc 视频流。');
            const found = await lookupVideoAddress(source).catch(() => null);
            if (!found) throw new Error('暂时无法从 go2rtc 查到这台小米摄像头的地址。请确认摄像头已接入 go2rtc。');
            return reply(response, 200, found);
        }
        case '/local-frames':
            return reply(response, 200, {comparison: localMotionDetector.comparison});
        case '/preview': {
            if (preferences.localMotion.enabled) {
                previewStatus = '';
                return reply(response, 200, {ok: true, source: preferences.localMotion.source});
            }
            const did = activeCamera?.did;
            if (!did) throw new Error('请先选择摄像头。');
            let source;
            try { source = await previewSource(did); }
            catch (error) {
                if (activeCamera?.did === did) previewStatus = error.message;
                throw error;
            }
            if (activeCamera?.did !== did) throw new Error('摄像头已切换，请重新打开预览。');
            previewStatus = '';
            return reply(response, 200, {ok: true, source});
        }
        default: return reply(response, 404, {error: '页面不存在。'});
    }
}

function openPage() {
    const child = spawn('explorer.exe', [origin + '/'], {detached: true, stdio: 'ignore'});
    child.on('error', () => {});
    child.unref();
}

const server = createServer((request, response) => {
    handle(request, response).catch(error => {
        if (response.headersSent || response.destroyed) return;
        reply(response, 400, {error: error.code ? '本机操作失败，请检查程序目录权限。' : error.message});
    });
});
server.on('upgrade', (request, socket, head) => {
    try { bridgePreview(request, socket, head, origin, videoOrigin); }
    catch { socket.destroy(); }
});
server.on('error', async error => {
    if (error.code === 'EADDRINUSE' && process.argv.includes('--open')) {
        try {
            const response = await fetch(origin + '/status', {signal: AbortSignal.timeout(2000)});
            if ((await response.json()).app === 'mijia-event-web') { openPage(); return; }
        } catch {}
    }
    console.error('Unable to start the local event server.');
    process.exitCode = 1;
});
server.listen(port, host, () => {
    loadSettings();
    localMotionDetector.configure(preferences.localMotion);
    if (session) {
        if (session.expiresAt > Date.now()) {
            status = '正在读取小米摄像头列表';
            discoverCameras().catch(() => {});
        }
        scheduleRefresh();
    }
    if (process.argv.includes('--open')) openPage();
    console.log(`Mijia Event Web running at ${origin}/`);
});
