'use strict';

const {dlopen, getRawPointer, toBuffer} = require('node:ffi');

if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The desktop overlay requires 64-bit Windows.');
}

const p = 'pointer';
const i = 'int32';
const u = 'uint32';
const zero = 0n;
const signature = (returns, ...args) => ({return: returns, arguments: args});
const {functions: kernel} = dlopen('kernel32.dll', {
    GetModuleHandleW: signature(p, p),
    LocalFree: signature(p, p)
});
const {functions: crypt} = dlopen('crypt32.dll', {
    CryptProtectData: signature(i, p, p, p, p, p, u, p),
    CryptUnprotectData: signature(i, p, p, p, p, p, u, p)
});
const entropy = Buffer.from('Mijia.EventWeb.OAuth.v1', 'utf8');

// On Win64, DATA_BLOB has a four-byte length and an eight-byte aligned pointer.
function dataBlob(bytes) {
    const blob = Buffer.alloc(16);
    blob.writeUInt32LE(bytes.length);
    blob.writeBigUInt64LE(getRawPointer(bytes), 8);
    return blob;
}

function dpapi(action, value) {
    const decrypt = action === '--unprotect';
    const input = Buffer.from(value, decrypt ? 'base64' : 'utf8');
    const outputBlob = Buffer.alloc(16);
    const operation = decrypt ? crypt.CryptUnprotectData : crypt.CryptProtectData;
    if (!operation(dataBlob(input), zero, dataBlob(entropy), zero, zero, 1, outputBlob)) {
        throw new Error('Windows DPAPI could not read or save the session.');
    }
    const output = outputBlob.readBigUInt64LE(8);
    try {
        return toBuffer(output, outputBlob.readUInt32LE()).toString(decrypt ? 'utf8' : 'base64');
    } finally {
        kernel.LocalFree(output);
    }
}

const {lib: user32, functions: user} = dlopen('user32.dll', {
    RegisterClassExW: signature('uint16', p),
    DefWindowProcW: signature('int64', p, u, 'uint64', 'int64'),
    CreateWindowExW: signature(p, u, p, p, u, i, i, i, i, p, p, p, p),
    DestroyWindow: signature(i, p),
    EnumDisplayMonitors: signature(i, p, p, p, 'int64'),
    GetMonitorInfoW: signature(i, p, p),
    LoadCursorW: signature(p, p, p),
    SetThreadDpiAwarenessContext: signature(p, p),
    SetWindowPos: signature(i, p, p, i, i, i, i, u),
    ShowWindow: signature(i, p, i),
    PeekMessageW: signature(i, p, p, u, u, u),
    DispatchMessageW: signature('int64', p)
});
const {functions: gdi} = dlopen('gdi32.dll', {
    CreateSolidBrush: signature(p, u),
    DeleteObject: signature(i, p)
});

const className = Buffer.from('MijiaEventWebOverlay\0', 'utf16le');
const title = Buffer.from('米家提醒 · 全屏红色\0', 'utf16le');
const moduleHandle = kernel.GetModuleHandleW(zero);
const hwndTopmost = BigInt.asUintN(64, -1n);
const perMonitorV2 = BigInt.asUintN(64, -4n);
const wsPopup = 0x80000000;
const wsExTopmost = 0x00000008;
const wsExToolWindow = 0x00000080;
const wsExNoActivate = 0x08000000;
const swpNoActivateAndShow = 0x0010 | 0x0040;
const showWithoutActivation = 4;
const wmClose = 0x0010;
const wmMouseActivate = 0x0021;
const wmLeftButtonDown = 0x0201;
const message = Buffer.alloc(48); // MSG on Win64

let registered = false;
let timer;
let redUntil = 0;
let phaseStarted = 0;
let visible = false;
let dismiss = false;
let windows = [];

function clearRed() {
    clearInterval(timer);
    timer = undefined;
    for (const window of windows) user.DestroyWindow(window);
    windows = [];
    visible = false;
    dismiss = false;
}

function registerOverlayClass() {
    if (registered) return;
    const brush = gdi.CreateSolidBrush(0x000000ff); // COLORREF is BGR.
    if (!brush) throw new Error('Unable to create the red brush.');
    const windowProc = user32.registerCallback(signature('int64', p, u, 'uint64', 'int64'),
        (window, kind, wParam, lParam) => {
            if (kind === wmMouseActivate) return 3n; // MA_NOACTIVATE
            if (kind === wmLeftButtonDown || kind === wmClose) {
                dismiss = true;
                return 0n;
            }
            return user.DefWindowProcW(window, kind, wParam, lParam);
        });

    // WNDCLASSEXW on Win64. The system owns the background brush once registered.
    const spec = Buffer.alloc(80);
    spec.writeUInt32LE(spec.length);
    spec.writeBigUInt64LE(windowProc, 8);
    spec.writeBigUInt64LE(moduleHandle, 24);
    spec.writeBigUInt64LE(user.LoadCursorW(zero, 32512n), 40);
    spec.writeBigUInt64LE(brush, 48);
    spec.writeBigUInt64LE(getRawPointer(className), 64);
    if (!user.RegisterClassExW(spec)) {
        user32.unregisterCallback(windowProc);
        gdi.DeleteObject(brush);
        throw new Error('Unable to register the Windows overlay.');
    }
    registered = true;
}

function monitorBounds() {
    const bounds = [];
    const callback = user32.registerCallback(signature(i, p, p, p, 'int64'),
        monitor => {
            const info = Buffer.alloc(104); // MONITORINFOEXW
            info.writeUInt32LE(info.length);
            if (!user.GetMonitorInfoW(monitor, info)) return 0;
            const x = info.readInt32LE(4);
            const y = info.readInt32LE(8);
            bounds.push({
                id: info.toString('utf16le', 40).split('\0', 1)[0],
                x, y, width: info.readInt32LE(12) - x, height: info.readInt32LE(16) - y,
                primary: Boolean(info.readUInt32LE(36) & 1)
            });
            return 1;
        });
    try {
        if (!user.EnumDisplayMonitors(zero, zero, callback, 0n) || !bounds.length) {
            throw new Error('Unable to enumerate Windows displays.');
        }
        return bounds;
    } finally {
        user32.unregisterCallback(callback);
    }
}

function listScreens() {
    const previousDpi = user.SetThreadDpiAwarenessContext(perMonitorV2);
    try { return monitorBounds(); }
    finally { if (previousDpi) user.SetThreadDpiAwarenessContext(previousDpi); }
}

function tick() {
    for (let count = 0; count < 64 && user.PeekMessageW(message, zero, 0, 0, 1); count++) {
        user.DispatchMessageW(message);
    }
    const now = performance.now();
    if (dismiss || now >= redUntil) { clearRed(); return; }
    const nextVisible = Math.floor((now - phaseStarted) / 500) % 2 === 0;
    if (visible === nextVisible) return;
    visible = nextVisible;
    for (const window of windows) user.ShowWindow(window, visible ? showWithoutActivation : 0);
}

function flashRed(seconds, screenIds = null) {
    if (windows.length) {
        redUntil = performance.now() + seconds * 1000;
        return;
    }
    registerOverlayClass();
    const previousDpi = user.SetThreadDpiAwarenessContext(perMonitorV2);
    try {
        const screens = monitorBounds().filter(screen => screenIds === null || screenIds.includes(screen.id));
        if (!screens.length) throw new Error('所选屏幕未连接，请刷新屏幕列表并重新选择。');
        for (const {x, y, width, height} of screens) {
            const bounds = [x, y, width, height];
            const window = user.CreateWindowExW(wsExTopmost | wsExToolWindow | wsExNoActivate, className, title,
                wsPopup, ...bounds, zero, zero, moduleHandle, zero);
            if (!window) throw new Error('Unable to create a red window.');
            windows.push(window);
            if (!user.SetWindowPos(window, hwndTopmost, ...bounds, swpNoActivateAndShow)) {
                throw new Error('Unable to show the red window.');
            }
        }
        visible = true;
        phaseStarted = performance.now();
        redUntil = phaseStarted + seconds * 1000;
        timer = setInterval(tick, 20);
    } catch (error) {
        clearRed();
        throw error;
    } finally {
        if (previousDpi) user.SetThreadDpiAwarenessContext(previousDpi);
    }
}

module.exports = {dpapi, flashRed, listScreens, clearRed};
