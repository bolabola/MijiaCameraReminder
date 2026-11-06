'use strict';

const byId = id => document.getElementById(id);
const formKey = document.querySelector('meta[name="mijia-key"]').content;
let initialized = false;
let cameraBusy = false;
let camerasAuthorized = false;
let selectedCamera = '';
let cameraOptions = '';
let screenOptions = [];
let checkedScreens = new Set();
let screensLoaded = false;

async function post(path, body = {}) {
    const response = await fetch(path, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Mijia-Key': formKey},
        body: JSON.stringify(body)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
}

async function action(button, work) {
    button.disabled = true;
    byId('notice').textContent = '';
    try { await work(); }
    catch (error) { byId('notice').textContent = error.message; }
    finally { button.disabled = false; }
}

byId('oauth').addEventListener('click', event => {
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    action(event.currentTarget, async () => {
        try {
            const value = await post('/oauth');
            if (!popup) throw new Error('请允许本页打开小米授权窗口，再点一次。');
            byId('redirect').focus();
            popup.location = value.url;
        } catch (error) { popup?.close(); throw error; }
    });
});

const authorizeForm = byId('authorize');
const redirectField = byId('redirect');
const authorizeButton = authorizeForm.querySelector('button[type="submit"]');

redirectField.addEventListener('paste', event => {
    const address = event.clipboardData?.getData('text/plain').trim();
    if (!address || authorizeButton.disabled) return;
    try {
        if (new URL(address).origin !== 'http://homeassistant.local:8123') return;
    } catch { return; }
    event.preventDefault();
    redirectField.value = address;
    authorizeForm.requestSubmit(authorizeButton);
});

authorizeForm.addEventListener('submit', event => {
    event.preventDefault();
    if (authorizeButton.disabled) return;
    action(authorizeButton, async () => {
        const redirect = redirectField.value.trim();
        redirectField.value = '';
        const result = await post('/authorize', {redirect});
        byId('notice').textContent = result.saved ? '小米授权已保存，正在加载摄像头列表。'
            : '本次授权有效，但未能保存，下次需要重新授权。';
    });
});

const cameraSelect = byId('camera');
const allScreens = byId('all-screens');
const watchLocal = byId('watch-local');
const localSourceSelect = byId('local-source');
const threshold = byId('local-threshold');
const thresholdSlider = byId('local-threshold-slider');
let savedLocalSource = '';

function renderDetectionMode() {
    byId('local-options').hidden = !watchLocal.checked;
    byId('local-options').disabled = !watchLocal.checked;
}
watchLocal.addEventListener('change', () => {
    renderDetectionMode();
    if (watchLocal.checked) void refreshVideoSources();
});
thresholdSlider.addEventListener('input', () => { threshold.value = thresholdSlider.value; });
threshold.addEventListener('input', () => { if (threshold.validity.valid) thresholdSlider.value = threshold.value; });

async function refreshVideoSources() {
    const button = byId('refresh-video-sources');
    const status = byId('video-sources-status');
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = '正在读取视频流…';
    try {
        const {sources} = await post('/video-sources');
        const selected = localSourceSelect.value;
        const options = [new Option('请选择视频流', '')];
        if (selected && !sources.includes(selected)) options.push(new Option(`${selected}（暂不可用）`, selected));
        options.push(...sources.map(name => new Option(name, name)));
        localSourceSelect.replaceChildren(...options);
        localSourceSelect.value = selected || (sources.length === 1 ? sources[0] : '');
        status.textContent = sources.length ? '' : 'go2rtc 还没有可选视频流。';
    } catch (error) {
        status.textContent = error.message;
    } finally { button.disabled = false; }
}
byId('refresh-video-sources').addEventListener('click', refreshVideoSources);
localSourceSelect.addEventListener('change', () => { byId('video-address-status').textContent = ''; });
byId('find-video-address').addEventListener('click', event => action(event.currentTarget, async () => {
    const source = localSourceSelect.value;
    const status = byId('video-address-status');
    status.textContent = '正在查找摄像头地址…';
    try {
        const {address, changed} = await post('/video-address', {source});
        if (localSourceSelect.value === source) {
            status.textContent = changed ? `已更新摄像头地址为 ${address}，请重新打开预览。`
                : `摄像头地址为 ${address}。跨网段时，电脑需要有到该地址的局域网路由。`;
        }
    } catch (error) {
        if (localSourceSelect.value === source) status.textContent = error.message;
    }
}));

cameraSelect.addEventListener('change', async () => {
    if (!cameraSelect.value) { cameraSelect.value = selectedCamera; return; }
    cameraBusy = true;
    await action(cameraSelect, async () => {
        const target = cameraSelect.value;
        await post('/camera', {did: target});
        if (selectedCamera !== target) closePreview();
        selectedCamera = target;
        byId('notice').textContent = '已保存摄像头选择。';
    });
    cameraSelect.value = selectedCamera;
    cameraBusy = false;
});
byId('refresh-cameras').addEventListener('click', event =>
    action(event.currentTarget, () => post('/cameras')));

function renderScreens() {
    const list = byId('screen-list');
    if (!screensLoaded) return;
    const rows = [];
    const connected = new Set(screenOptions.map(screen => screen.id));
    const items = [...screenOptions, ...[...checkedScreens].filter(id => !connected.has(id))
        .map(id => ({id}))];
    for (const {id, width, height, primary} of items) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = allScreens.checked ? connected.has(id) : checkedScreens.has(id);
        input.disabled = allScreens.checked;
        input.addEventListener('change', () => {
            if (input.checked) checkedScreens.add(id);
            else checkedScreens.delete(id);
        });
        const name = id.split('\\').at(-1);
        label.append(input, width ? ` ${name} · ${width} × ${height}${primary ? ' · 主屏幕' : ''}`
            : ` ${name} · 已断开`);
        rows.push(label);
    }
    list.replaceChildren(...rows);
}

async function loadScreens() {
    const response = await fetch('/screens', {cache: 'no-store'});
    if (!response.ok) throw new Error('无法读取屏幕列表，请在 Windows 桌面中启动程序。');
    ({screens: screenOptions} = await response.json());
    screensLoaded = true;
    renderScreens();
}

allScreens.addEventListener('change', () => {
    if (!allScreens.checked && !checkedScreens.size) {
        checkedScreens = new Set(screenOptions.map(screen => screen.id));
    }
    renderScreens();
});
byId('refresh-screens').addEventListener('click', event => action(event.currentTarget, loadScreens));

function alertPreferences() {
    return {
        person: byId('watch-person').checked,
        motion: byId('watch-motion').checked,
        seconds: Number(byId('seconds').value),
        screenIds: allScreens.checked ? null : [...checkedScreens],
        localMotion: {
            enabled: watchLocal.checked,
            source: byId('local-source').value.trim(),
            threshold: Number(byId('local-threshold').value)
        }
    };
}

byId('settings').addEventListener('submit', event => {
    event.preventDefault();
    action(event.submitter, async () => {
        const settings = alertPreferences();
        await post('/preferences', settings);
        const source = settings.localMotion.enabled ? settings.localMotion.source : '';
        if (savedLocalSource !== source) closePreview();
        savedLocalSource = source;
        byId('notice').textContent = '红屏设置已保存。';
    });
});
byId('test').addEventListener('click', event => action(event.currentTarget, async () => {
    if (byId('seconds').reportValidity()) await post('/test-red', alertPreferences());
}));

let playerAttempts = 0;
let previewPlaybackStatus = '';
async function preparePreviewPlayer() {
    if (customElements.get('mijia-preview')) return;
    const moduleUrl = '/preview-client.js' + (playerAttempts ? `?retry=${playerAttempts}` : '');
    playerAttempts++;
    const {VideoRTC} = await import(moduleUrl);
    customElements.define('mijia-preview', class extends VideoRTC {
        oninit() {
            super.oninit();
            this.video.defaultMuted = true;
            this.video.muted = true;
            const showResolution = () => {
                if (!this.isConnected || !this.video.videoWidth) return;
                byId('preview-resolution').textContent = `${this.video.videoWidth} × ${this.video.videoHeight} · 原流`;
            };
            this.video.addEventListener('loadedmetadata', showResolution);
            this.video.addEventListener('resize', showResolution);
            this.video.addEventListener('playing', () => {
                if (this.isConnected) previewPlaybackStatus = '';
            });
            this.video.addEventListener('waiting', () => {
                if (this.isConnected && !previewPlaybackStatus) previewPlaybackStatus = '正在等待摄像头画面…';
            });
        }
        onopen() {
            const result = super.onopen();
            this.onmessage.preview = message => {
                if (message.type === 'error' && this.isConnected) {
                    previewPlaybackStatus = 'go2rtc 暂时取不到视频。请检查摄像头是否在线、电脑是否能访问摄像头所在的局域网。';
                }
            };
            return result;
        }
    });
}

byId('preview').addEventListener('click', event => action(event.currentTarget, async () => {
    const camera = selectedCamera;
    const localSource = savedLocalSource;
    const {source} = await post('/preview');
    try { await preparePreviewPlayer(); }
    catch { throw new Error('无法加载预览播放器，请确认 go2rtc 已启动。'); }
    if (savedLocalSource !== localSource || (!localSource && selectedCamera !== camera)) return;
    closePreview();
    const container = byId('video');
    const player = document.createElement('mijia-preview');
    player.mode = 'mse';
    player.src = new URL(`/preview-ws?src=${encodeURIComponent(source)}`, location.href);
    container.hidden = false;
    container.replaceChildren(player);
    previewPlaybackStatus = '正在等待摄像头画面…';
    byId('hide-preview').hidden = false;
}));
function closePreview() {
    const container = byId('video');
    container.firstElementChild?.video?.pause();
    container.hidden = true;
    container.replaceChildren();
    byId('hide-preview').hidden = true;
    byId('preview-resolution').textContent = '';
    previewPlaybackStatus = '';
}
byId('hide-preview').addEventListener('click', closePreview);

let displayedFrameId = null;

function drawGrayFrame(canvas, width, height, encoded) {
    const gray = atob(encoded);
    if (gray.length !== width * height) throw new Error('Invalid grayscale frame');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(width, height);
    for (let i = 0, offset = 0; i < gray.length; i++, offset += 4) {
        const level = gray.charCodeAt(i);
        image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = level;
        image.data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
}

async function updateComparison(enabled, frameId) {
    byId('local-comparison').hidden = !enabled;
    const images = byId('comparison-images');
    const status = byId('comparison-status');
    if (!enabled || frameId === null) {
        images.hidden = true;
        displayedFrameId = null;
        status.textContent = '等待两张检测画面…';
        return;
    }
    if (frameId === displayedFrameId) return;
    try {
        const {comparison} = await post('/local-frames');
        if (!comparison) {
            images.hidden = true;
            displayedFrameId = null;
            status.textContent = '等待两张检测画面…';
            return;
        }
        const {id, width, height, change, previous, current} = comparison;
        drawGrayFrame(byId('previous-frame'), width, height, previous);
        drawGrayFrame(byId('current-frame'), width, height, current);
        images.hidden = false;
        displayedFrameId = id;
        status.textContent = `这两帧的变化比例为 ${change.toFixed(1)}%`;
    } catch {
        images.hidden = true;
        displayedFrameId = null;
        status.textContent = '暂时无法显示对比画面。';
    }
}

async function poll() {
    try {
        const data = await (await fetch('/status', {cache: 'no-store'})).json();
        byId('status').textContent = data.status;
        byId('red-status').textContent = data.redStatus;
        byId('preview-status').textContent = previewPlaybackStatus || data.previewStatus;
        byId('camera-status').textContent = data.cameraStatus;
        const {status: localStatus, change, count, frameId} = data.localMotion;
        byId('local-status').textContent = localStatus;
        byId('local-count').textContent = change === null ? `累计触发 ${count} 次`
            : `当前变化 ${change.toFixed(1)}% · 累计触发 ${count} 次`;
        if (!cameraBusy) {
            const key = JSON.stringify([data.authorized, data.cameras]);
            if (key !== cameraOptions) {
                cameraOptions = key;
                const placeholder = new Option(data.authorized ? '选择摄像头' : '请先完成小米授权', '');
                placeholder.disabled = true;
                cameraSelect.replaceChildren(placeholder, ...data.cameras.map(({did, name, model}) =>
                    new Option(name === model ? model : `${name} · ${model}`, did)));
            }
            cameraSelect.disabled = data.cameras.length === 0;
            if (selectedCamera !== (data.cameraDid || '')) closePreview();
            selectedCamera = cameraSelect.value = data.cameraDid || '';
        }
        if (camerasAuthorized !== data.authorized) {
            camerasAuthorized = data.authorized;
            byId('refresh-cameras').disabled = !camerasAuthorized;
        }
        if (data.cameraDid && !data.cameraStatus && data.eventTypes.length === 1) {
            const supported = data.eventTypes.includes('person') ? '有人出现' : '画面变动';
            byId('camera-status').textContent = `当前型号支持监听：${supported}`;
        }
        for (const name of ['person', 'motion']) {
            const item = data.events[name];
            byId(name).textContent = item ? `${item.time} · 累计 ${item.count} 次` : '尚未收到';
        }
        if (!initialized) {
            const {enabled, source, threshold: savedThreshold} = data.preferences.localMotion;
            watchLocal.checked = enabled;
            if (source) localSourceSelect.add(new Option(source, source));
            localSourceSelect.value = source;
            threshold.value = thresholdSlider.value = savedThreshold;
            savedLocalSource = enabled ? source : '';
            renderDetectionMode();
            if (enabled) void refreshVideoSources();
            byId('watch-person').checked = data.preferences.person;
            byId('watch-motion').checked = data.preferences.motion;
            byId('seconds').value = data.preferences.seconds;
            allScreens.checked = data.preferences.screenIds === null;
            checkedScreens = new Set(data.preferences.screenIds || []);
            renderScreens();
            byId('auth').open = !data.authorized && !enabled;
            initialized = true;
        }
        await updateComparison(data.preferences.localMotion.enabled, frameId);
    } catch { byId('status').textContent = '本机提醒服务暂不可用'; }
    setTimeout(poll, 1000);
}
poll();
loadScreens().catch(error => { byId('screen-list').textContent = error.message; });
