import { AsyncLocalStorage, DeviceManager, RemoteCDMManager, SettingsManager, Util } from "../lib/util.js";

const key_container = document.getElementById('key-container');

const sendRuntimeMessage = (message) => new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
});

const getStoredLogKeys = (storage) => Object.entries(storage)
    .filter(([, value]) => value?.pssh_data)
    .map(([key]) => key);

export function normalizeLogForExport(log) {
    const exportedLog = { ...log };

    if (exportedLog.class_title === "AI Guru" && exportedLog.video_title) {
        exportedLog.class_title = exportedLog.video_title;
    }

    if (exportedLog.video_title == null && exportedLog.class_title) {
        exportedLog.video_title = exportedLog.class_title;
    }

    return exportedLog;
}

async function clearStoredLogs() {
    const storage = await AsyncLocalStorage.getStorage(null);
    const logKeys = getStoredLogKeys(storage);
    if (logKeys.length > 0) {
        await chrome.storage.local.remove(logKeys);
    }
}

// ================ Main ================
const enabled = document.getElementById('enabled');
enabled.addEventListener('change', async function (){
    await SettingsManager.setEnabled(enabled.checked);
});

const toggle = document.getElementById('darkModeToggle');
toggle.addEventListener('change', async () => {
    SettingsManager.setDarkMode(toggle.checked);
    await SettingsManager.saveDarkMode(toggle.checked);
});

const alt_layout_toggle = document.getElementById('altClassLayoutToggle');
if (alt_layout_toggle) {
    alt_layout_toggle.addEventListener('change', async () => {
        await SettingsManager.saveUseAltClassLayout(alt_layout_toggle.checked);
        chrome.runtime.sendMessage({ type: "ALT_LAYOUT_CHANGED", enabled: alt_layout_toggle.checked });
    });
}

const wvd_select = document.getElementById('wvd_select');
wvd_select.addEventListener('change', async function (){
    if (wvd_select.checked) {
        await SettingsManager.saveSelectedDeviceType("WVD");
    }
});

const remote_select = document.getElementById('remote_select');
remote_select.addEventListener('change', async function (){
    if (remote_select.checked) {
        await SettingsManager.saveSelectedDeviceType("REMOTE");
    }
});

const export_button = document.getElementById('exportLogs');
export_button.addEventListener('click', async function() {
    const logs = await AsyncLocalStorage.getStorage(null);
    const exportedLogs = Object.values(logs)
        .filter(log => log?.pssh_data)
        .map(normalizeLogForExport);
    const name = log_export_name.value.trim();
    const filename = name === "" ? "logs.json" : `logs (${name}).json`;
    SettingsManager.downloadFile(JSON.stringify(exportedLogs, null, 2), filename);
});

const debug_mode = document.getElementById('debugMode');
debug_mode.addEventListener('change', async function() {
    debug_mode.checked = await sendRuntimeMessage({
        type: "SET_DEBUG_MODE",
        enabled: debug_mode.checked,
    });
});

const export_debug = document.getElementById('exportDebug');
export_debug.addEventListener('click', async function() {
    const debugExport = await sendRuntimeMessage({ type: "GET_DEBUG_EXPORT" });
    SettingsManager.downloadFile(JSON.stringify(debugExport, null, 2), "wvp2-debug.json");
});

const clear_debug = document.getElementById('clearDebug');
clear_debug.addEventListener('click', async function() {
    await sendRuntimeMessage({ type: "CLEAR_DEBUG" });
});

const set_home_url_trigger = document.getElementById('setHomeUrlTrigger');
set_home_url_trigger.addEventListener('click', async function() {
    chrome.runtime.sendMessage({ type: "SET_HOME_URL_TRIGGER" });
});

const clear_logs = document.getElementById('clearLogs');
clear_logs.addEventListener('click', async function() {
    await clearStoredLogs();
    chrome.runtime.sendMessage({ type: "CLEAR" });
    key_container.innerHTML = "";
});

const clear_watched = document.getElementById('clearWatched');
clear_watched.addEventListener('click', function () {
    const message = { type: "wvp2_clear_watched_lectures" };
    // Req 7.2: fire-and-forget runtime broadcast (no await, no result handling)
    chrome.runtime.sendMessage(message);
    // Req 7.3: per-tab broadcast, errors swallowed
    chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
        for (const tab of tabs) {
            if (typeof tab.id === "number") {
                try {
                    chrome.tabs.sendMessage(tab.id, message, () => {
                        void chrome.runtime.lastError; // swallow per-tab errors
                    });
                } catch {
                    // ignored — swallow synchronous throws
                }
            }
        }
    });
    // Req 7.7: handler is non-async and returns before the next microtask flush
});
// ======================================

// ================ Widevine Device ================
const fileInput = document.getElementById('fileInput');
fileInput.addEventListener('click', () => {
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
        chrome.runtime.sendMessage({ type: "OPEN_PICKER_WVD_MOBILE" });
    } else {
        chrome.runtime.sendMessage({ type: "OPEN_PICKER_WVD" });
    }
    window.close();
});

const remove = document.getElementById('remove');
remove.addEventListener('click', async function() {
    await DeviceManager.removeSelectedWidevineDevice();
    wvd_combobox.innerHTML = '';
    await DeviceManager.loadSetAllWidevineDevices();
    const selected_option = wvd_combobox.options[wvd_combobox.selectedIndex];
    if (selected_option) {
        await DeviceManager.saveSelectedWidevineDevice(selected_option.text);
    } else {
        await DeviceManager.removeSelectedWidevineDeviceKey();
    }
});

const download = document.getElementById('download');
download.addEventListener('click', async function() {
    const widevine_device = await DeviceManager.getSelectedWidevineDevice();
    SettingsManager.downloadFile(
        Util.b64.decode(await DeviceManager.loadWidevineDevice(widevine_device)),
        widevine_device + ".wvd"
    )
});

const wvd_combobox = document.getElementById('wvd-combobox');
wvd_combobox.addEventListener('change', async function() {
    await DeviceManager.saveSelectedWidevineDevice(wvd_combobox.options[wvd_combobox.selectedIndex].text);
});
// =================================================

// ================ Remote CDM ================
document.getElementById('remoteInput').addEventListener('click', () => {
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
        chrome.runtime.sendMessage({ type: "OPEN_PICKER_REMOTE_MOBILE" });
    } else {
        chrome.runtime.sendMessage({ type: "OPEN_PICKER_REMOTE" });
    }
    window.close();
});

const remote_remove = document.getElementById('remoteRemove');
remote_remove.addEventListener('click', async function() {
    await RemoteCDMManager.removeSelectedRemoteCDM();
    remote_combobox.innerHTML = '';
    await RemoteCDMManager.loadSetAllRemoteCDMs();
    const selected_option = remote_combobox.options[remote_combobox.selectedIndex];
    if (selected_option) {
        await RemoteCDMManager.saveSelectedRemoteCDM(selected_option.text);
    } else {
        await RemoteCDMManager.removeSelectedRemoteCDMKey();
    }
});

const remote_download = document.getElementById('remoteDownload');
remote_download.addEventListener('click', async function() {
    const remote_cdm = await RemoteCDMManager.getSelectedRemoteCDM();
    SettingsManager.downloadFile(
        await RemoteCDMManager.loadRemoteCDM(remote_cdm),
        remote_cdm + ".json"
    )
});

const remote_combobox = document.getElementById('remote-combobox');
remote_combobox.addEventListener('change', async function() {
    await RemoteCDMManager.saveSelectedRemoteCDM(remote_combobox.options[remote_combobox.selectedIndex].text);
});
// ============================================

// ================ Command Options ================
const use_shaka = document.getElementById('use-shaka');
use_shaka.addEventListener('change', async function (){
    await SettingsManager.saveUseShakaPackager(use_shaka.checked);
});

const use_single_quotes = document.getElementById('use-single-quotes');
use_single_quotes.addEventListener('change', async function (){
    await SettingsManager.saveUseSingleQuotes(use_single_quotes.checked);
});

const downloader_name = document.getElementById('downloader-name');
downloader_name.addEventListener('input', async function (){
    await SettingsManager.saveExecutableName(downloader_name.value);
});

const downloader_args = document.getElementById('downloader-args');
downloader_args.addEventListener('input', async function (){
    await SettingsManager.saveAdditionalArguments(downloader_args.value);
});

const log_export_name = document.getElementById('log-export-name');
log_export_name.addEventListener('input', async function (){
    await SettingsManager.saveLogExportName(log_export_name.value);
});
// =================================================

// ================ Keys ================
const clear = document.getElementById('clear');
clear.addEventListener('click', async function() {
    await clearStoredLogs();
    chrome.runtime.sendMessage({ type: "CLEAR" });
    key_container.innerHTML = "";
});

async function createCommand(json, key_string) {
    const metadata = JSON.parse(json);

    // Based on user choice in the panel, we have the quote character that should be used in the command,
    // and a safe quote character that can be used to format the header values.
    const useSingleQuotes = await SettingsManager.getUseSingleQuotes();
    const quoteChar = useSingleQuotes ? "'" : '"';
    const safeQuoteChar = useSingleQuotes ? '"' : "'";
    const headerString = Object.entries(metadata.headers).map(
        ([key, value]) => `-H ${quoteChar}${key}: ${value.replaceAll(quoteChar, safeQuoteChar)}${quoteChar}`
    ).join(' ');

    const executableName = await SettingsManager.getExecutableName();
    const useShaka = await SettingsManager.getUseShakaPackager();
    const additionalArgs = await SettingsManager.getAdditionalArguments();
    return `${executableName} ${quoteChar}${metadata.url}${quoteChar} ${headerString} ${key_string} ${useShaka ? "--use-shaka-packager " : ""}${additionalArgs}`;
}

async function appendLog(result) {
    if (!result?.pssh_data) {
        return;
    }

    const existingLog = Array.from(key_container.querySelectorAll('.log-container'))
        .find(element => element.dataset.logId === result.pssh_data);
    existingLog?.remove();

    const key_string = result.keys.map(key => `--key ${key.kid}:${key.k}`).join(' ');
    const date = new Date(result.timestamp * 1000);
    const date_string = date.toLocaleString();
    const class_title = result.class_title ?? "";

    const logContainer = document.createElement('div');
    logContainer.classList.add('log-container');
    logContainer.dataset.logId = result.pssh_data;
    logContainer.innerHTML = `
        <button class="toggleButton">+</button>
        <div class="expandableDiv collapsed">
            <label class="always-visible right-bound">
                URL:<input type="text" class="text-box" value="${result.url}">
            </label>
            <label class="expanded-only right-bound">
            <label class="expanded-only right-bound">
                PSSH:<input type="text" class="text-box" value="${result.pssh_data}">
            </label>
            <label class="expanded-only right-bound key-copy">
                <a href="#" title="Click to copy">Keys:</a><input type="text" class="text-box" value="${key_string}">
            </label>
            <label class="expanded-only right-bound">
                Date:<input type="text" class="text-box" value="${date_string}">
            </label>
            <label class="expanded-only right-bound">
                Class:<input type="text" class="text-box" value="${class_title}">
            </label>
            ${result.manifests.length > 0 ? `<label class="expanded-only right-bound manifest-copy">
                <a href="#" title="Click to copy">Manifest:</a><select id="manifest" class="text-box"></select>
            </label>
            <label class="expanded-only right-bound command-copy">
                <a href="#" title="Click to copy">Cmd:</a><input type="text" id="command" class="text-box">
            </label>` : ''}
        </div>`;

    const keysInput = logContainer.querySelector('.key-copy');
    keysInput.addEventListener('click', () => {
        navigator.clipboard.writeText(key_string);
    });

    if (result.manifests.length > 0) {
        const command = logContainer.querySelector('#command');

        const select = logContainer.querySelector("#manifest");
        select.addEventListener('change', async () => {
            command.value = await createCommand(select.value, key_string);
        });
        result.manifests.forEach((manifest) => {
            const option = new Option(`[${manifest.type}] ${manifest.url}`, JSON.stringify(manifest));
            select.add(option);
        });
        command.value = await createCommand(select.value, key_string);

        const manifest_copy = logContainer.querySelector('.manifest-copy');
        manifest_copy.addEventListener('click', () => {
            navigator.clipboard.writeText(JSON.parse(select.value).url);
        });

        const command_copy = logContainer.querySelector('.command-copy');
        command_copy.addEventListener('click', () => {
            navigator.clipboard.writeText(command.value);
        });
    }

    const toggleButtons = logContainer.querySelector('.toggleButton');
    toggleButtons.addEventListener('click', function () {
        const expandableDiv = this.nextElementSibling;
        if (expandableDiv.classList.contains('collapsed')) {
            toggleButtons.innerHTML = "-";
            expandableDiv.classList.remove('collapsed');
            expandableDiv.classList.add('expanded');
        } else {
            toggleButtons.innerHTML = "+";
            expandableDiv.classList.remove('expanded');
            expandableDiv.classList.add('collapsed');
        }
    });

    key_container.appendChild(logContainer);
}

chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === 'local') {
        for (const [key, values] of Object.entries(changes)) {
            if (values.newValue) {
                await appendLog(values.newValue);
            } else if (values.oldValue?.pssh_data) {
                key_container
                    .querySelector(`.log-container[data-log-id="${CSS.escape(values.oldValue.pssh_data)}"]`)
                    ?.remove();
            }
        }
    }
});

function checkLogs() {
    chrome.runtime.sendMessage({ type: "GET_LOGS" }, (response) => {
        if (response) {
            response.forEach(async (result) => {
                await appendLog(result);
            });
        }
    });
}

document.addEventListener('DOMContentLoaded', async function () {
    enabled.checked = await SettingsManager.getEnabled();
    debug_mode.checked = await sendRuntimeMessage({ type: "GET_DEBUG_MODE" });
    SettingsManager.setDarkMode(await SettingsManager.getDarkMode());
    
    const alt_layout_toggle_init = document.getElementById('altClassLayoutToggle');
    if (alt_layout_toggle_init) {
        alt_layout_toggle_init.checked = await SettingsManager.getUseAltClassLayout();
    }

    use_shaka.checked = await SettingsManager.getUseShakaPackager();
    use_single_quotes.checked = await SettingsManager.getUseSingleQuotes();
    downloader_name.value = await SettingsManager.getExecutableName();
    downloader_args.value = await SettingsManager.getAdditionalArguments();
    log_export_name.value = await SettingsManager.getLogExportName();
    SettingsManager.setSelectedDeviceType(await SettingsManager.getSelectedDeviceType());
    await DeviceManager.loadSetAllWidevineDevices();
    await DeviceManager.selectWidevineDevice(await DeviceManager.getSelectedWidevineDevice());
    await RemoteCDMManager.loadSetAllRemoteCDMs();
    await RemoteCDMManager.selectRemoteCDM(await RemoteCDMManager.getSelectedRemoteCDM());
    checkLogs();

        // === PW API CRAWLER: Init Crawler UI ===
        initCrawlerUI();
        // === END ===
});
// ======================================

// === PW API CRAWLER: Crawler Panel Logic ===
let crawlPollInterval = null;

function initCrawlerUI() {
    // --- Debug Dump Button ---
    const btnExportDebugDump = document.getElementById('btnExportDebugDump');
    btnExportDebugDump.addEventListener('click', async () => {
        btnExportDebugDump.disabled = true;
        btnExportDebugDump.textContent = 'Generating dump...';
        try {
            const dump = await sendRuntimeMessage({ type: "CRAWL_EXPORT_DEBUG" });
            if (dump) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
                downloadBlob(blob, `crawler-debug-${timestamp}.json`);
            }
        } catch (e) {
            console.error('Debug dump failed:', e);
        }
        btnExportDebugDump.disabled = false;
        btnExportDebugDump.textContent = 'Export Debug Dump';
    });

    const tokenIndicator = document.getElementById('token-indicator');
    const tokenStatusText = document.getElementById('token-status-text');
    const tokenDetails = document.getElementById('token-details');
    const tokenPreview = document.getElementById('token-preview');
    const tokenCapturedAt = document.getElementById('token-captured-at');
    const apiRecordToggle = document.getElementById('apiRecordToggle');
    const clearCapturedApis = document.getElementById('clearCapturedApis');
    const apiCount = document.getElementById('api-count');
    const capturedApisContainer = document.getElementById('captured-apis-container');
    const btnCrawlStart = document.getElementById('btnCrawlStart');
    const crawlDepthSelect = document.getElementById('crawlDepthSelect');
    const crawlDelaySlider = document.getElementById('crawlDelaySlider');
    const crawlDelayValue = document.getElementById('crawlDelayValue');
    const crawlActionButtons = document.getElementById('crawl-action-buttons');
    const btnCrawlPause = document.getElementById('btnCrawlPause');
    const btnCrawlResume = document.getElementById('btnCrawlResume');
    const btnCrawlStop = document.getElementById('btnCrawlStop');
    const progressSection = document.getElementById('crawl-progress-section');
    const crawlStateLabel = document.getElementById('crawlStateLabel');
    const crawlCurrentPath = document.getElementById('crawl-current-path');
    const crawlProgressBar = document.getElementById('crawlProgressBar');
    const statCategories = document.getElementById('statCategories');
    const statWidgets = document.getElementById('statWidgets');
    const statPlaylists = document.getElementById('statPlaylists');
    const statLectures = document.getElementById('statLectures');
    const crawlErrorsSection = document.getElementById('crawl-errors-section');
    const crawlErrorCount = document.getElementById('crawlErrorCount');
    const crawlErrorList = document.getElementById('crawlErrorList');
    const resultsSection = document.getElementById('crawl-results-section');
    const resultsSummary = document.getElementById('crawl-results-summary');
    const resultsTree = document.getElementById('crawl-results-tree');
    const btnExportJson = document.getElementById('btnExportJson');
    const btnExportUrls = document.getElementById('btnExportUrls');
    const btnCopyUrls = document.getElementById('btnCopyUrls');
    const clearHistoryBtn = document.getElementById('clearCrawlHistory');
    const historyContainer = document.getElementById('crawl-history-container');
    const historyEmpty = document.getElementById('crawl-history-empty');

    crawlDelaySlider.addEventListener('input', () => {
        crawlDelayValue.textContent = crawlDelaySlider.value;
    });

    async function refreshTokenStatus() {
        const tokenData = await sendRuntimeMessage({ type: "GET_AUTH_TOKEN" });
        if (tokenData && tokenData.token) {
            tokenIndicator.className = 'indicator indicator-green';
            tokenStatusText.textContent = 'Token captured';
            tokenDetails.style.display = 'block';
            tokenPreview.textContent = tokenData.token.substring(0, 20) + '...';
            const headerInfo = tokenData.capturedHeaders
                ? Object.keys(tokenData.capturedHeaders).join(', ')
                : 'none';
            tokenCapturedAt.textContent = 'Captured: ' + new Date(tokenData.capturedAt).toLocaleString()
                + '\nHeaders (' + (tokenData.capturedHeaders ? Object.keys(tokenData.capturedHeaders).length : 0) + '): ' + headerInfo;
        } else {
            tokenIndicator.className = 'indicator indicator-red';
            tokenStatusText.textContent = 'No token \u2014 navigate to PW Pi';
            tokenDetails.style.display = 'none';
        }
    }

    async function refreshCapturedApis() {
        const apis = await sendRuntimeMessage({ type: "GET_CAPTURED_APIS" });
        if (!apis) return;
        apiCount.textContent = apis.length + ' captured';
        capturedApisContainer.innerHTML = '';
        apis.forEach((api) => {
            const entry = document.createElement('div');
            entry.className = 'api-entry';
            const path = api.url ? api.url.replace(/\?.*$/, '') : '';
            const preview = typeof api.responseBody === 'string'
                ? api.responseBody.substring(0, 200)
                : JSON.stringify(api.responseBody || '').substring(0, 200);
            entry.innerHTML = `
                <span class="api-method">${api.method || 'GET'}</span>
                <span class="api-path">${escapeHtml(path)}</span>
                <div class="api-preview">${escapeHtml(preview)}</div>
            `;
            entry.addEventListener('click', () => entry.classList.toggle('expanded'));
            capturedApisContainer.appendChild(entry);
        });
    }

    apiRecordToggle.addEventListener('change', async () => {
        await sendRuntimeMessage({ type: "TOGGLE_API_RECORDING", enabled: apiRecordToggle.checked });
    });
    clearCapturedApis.addEventListener('click', async () => {
        await sendRuntimeMessage({ type: "CLEAR_CAPTURED_APIS" });
        refreshCapturedApis();
    });

    function updateProgressUI(state, progress) {
        if (!state || state === 'idle') {
            progressSection.style.display = 'none';
            crawlActionButtons.style.display = 'none';
            btnCrawlStart.disabled = false;
            return;
        }
        progressSection.style.display = 'block';
        crawlStateLabel.className = 'state-label';
        switch (state) {
            case 'crawling':
                crawlStateLabel.textContent = 'Crawling...';
                crawlStateLabel.classList.add('state-crawling');
                crawlActionButtons.style.display = 'flex';
                btnCrawlPause.style.display = '';
                btnCrawlResume.style.display = 'none';
                btnCrawlStart.disabled = true;
                break;
            case 'paused':
                crawlStateLabel.textContent = 'Paused';
                crawlStateLabel.classList.add('state-paused');
                crawlActionButtons.style.display = 'flex';
                btnCrawlPause.style.display = 'none';
                btnCrawlResume.style.display = '';
                btnCrawlStart.disabled = true;
                break;
            case 'completed':
                crawlStateLabel.textContent = 'Completed';
                crawlStateLabel.classList.add('state-completed');
                crawlActionButtons.style.display = 'none';
                btnCrawlStart.disabled = false;
                stopPolling();
                fetchAndDisplayResults();
                break;
            case 'error':
                crawlStateLabel.textContent = 'Error';
                crawlStateLabel.classList.add('state-error');
                crawlActionButtons.style.display = 'none';
                btnCrawlStart.disabled = false;
                stopPolling();
                break;
            case 'stopped':
                crawlStateLabel.textContent = 'Stopped';
                crawlStateLabel.classList.add('state-stopped');
                crawlActionButtons.style.display = 'none';
                btnCrawlStart.disabled = false;
                stopPolling();
                fetchAndDisplayResults();
                break;
        }
        if (progress) {
            crawlCurrentPath.textContent = progress.currentPath || '';
            statCategories.textContent = `${progress.crawledCategories ?? 0} / ${progress.totalCategories ?? 0}`;
            statWidgets.textContent = `${progress.crawledWidgets ?? 0} / ${progress.totalWidgets ?? 0}`;
            statPlaylists.textContent = `${progress.expandedPlaylists ?? 0} / ${progress.totalPlaylists ?? 0}`;
            statLectures.textContent = `${progress.totalLectures ?? 0}`;
            let pct = 0;
            if (progress.totalPlaylists > 0) {
                pct = Math.round((progress.expandedPlaylists / progress.totalPlaylists) * 100);
            } else if (progress.totalCategories > 0) {
                pct = Math.round((progress.crawledCategories / progress.totalCategories) * 100);
            }
            crawlProgressBar.style.width = pct + '%';
            if (progress.errors && progress.errors.length > 0) {
                crawlErrorsSection.style.display = 'block';
                crawlErrorCount.textContent = progress.errors.length;
                crawlErrorList.innerHTML = progress.errors.map(err => `
                    <div class="crawl-error-item">
                        <span class="error-time">${new Date(err.timestamp).toLocaleTimeString()}</span>
                        <span class="error-url">${escapeHtml(err.url || err.scope || '')}</span>
                        <span>${escapeHtml(err.message || 'Unknown error')}${err.statusCode ? ' (' + err.statusCode + ')' : ''}</span>
                    </div>
                `).join('');
            } else {
                crawlErrorsSection.style.display = 'none';
            }
        }
    }

    function startPolling() {
        stopPolling();
        crawlPollInterval = setInterval(async () => {
            const stateObj = await sendRuntimeMessage({ type: "CRAWL_GET_STATE" });
            if (stateObj) updateProgressUI(stateObj.state, stateObj.progress);
        }, 2000);
    }
    function stopPolling() {
        if (crawlPollInterval) { clearInterval(crawlPollInterval); crawlPollInterval = null; }
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'CRAWL_PROGRESS') {
            const { type, ...progressData } = message;
            updateProgressUI(progressData.state, progressData.progress || progressData);
        }
    });

    btnCrawlStart.addEventListener('click', async () => {
        btnCrawlStart.disabled = true;
        btnCrawlStart.textContent = 'Starting...';
        const depth = crawlDepthSelect.value;
        const delayMs = parseInt(crawlDelaySlider.value, 10);
        const response = await sendRuntimeMessage({ type: "CRAWL_START", depth, delayMs });
        btnCrawlStart.textContent = 'Crawl PW Pi';
        if (response && response.status === 'started') {
            progressSection.style.display = 'block';
            resultsSection.style.display = 'none';
            updateProgressUI('crawling', null);
            startPolling();
        } else if (response && response.status === 'already_running') {
            updateProgressUI('crawling', response.progress);
            startPolling();
        } else {
            btnCrawlStart.disabled = false;
        }
    });

    btnCrawlPause.addEventListener('click', async () => {
        btnCrawlPause.disabled = true;
        await sendRuntimeMessage({ type: "CRAWL_PAUSE" });
        btnCrawlPause.disabled = false;
        btnCrawlPause.style.display = 'none';
        btnCrawlResume.style.display = '';
        crawlStateLabel.textContent = 'Paused';
        crawlStateLabel.className = 'state-label state-paused';
    });

    btnCrawlResume.addEventListener('click', async () => {
        btnCrawlResume.disabled = true;
        await sendRuntimeMessage({ type: "CRAWL_RESUME" });
        btnCrawlResume.disabled = false;
        btnCrawlResume.style.display = 'none';
        btnCrawlPause.style.display = '';
        crawlStateLabel.textContent = 'Crawling...';
        crawlStateLabel.className = 'state-label state-crawling';
    });

    btnCrawlStop.addEventListener('click', async () => {
        btnCrawlStop.disabled = true;
        await sendRuntimeMessage({ type: "CRAWL_STOP" });
        btnCrawlStop.disabled = false;
        crawlActionButtons.style.display = 'none';
        btnCrawlStart.disabled = false;
        crawlStateLabel.textContent = 'Stopped';
        crawlStateLabel.className = 'state-label state-stopped';
        stopPolling();
        fetchAndDisplayResults();
    });

    async function fetchAndDisplayResults() {
        const summary = await sendRuntimeMessage({ type: "CRAWL_GET_SUMMARY" });
        if (!summary || !summary.categoryCount) {
            resultsSection.style.display = 'none';
            return;
        }
        resultsSection.style.display = 'block';
        displaySummary(summary);
    }

    // Render a compact summary (counts only). The full lecture tree can be tens
    // of thousands of entries / >64MB, so it is never sent over messaging — the
    // background returns a small summary and a de-duplicated flat catalog.
    function displaySummary(s) {
        resultsSummary.textContent =
            `${s.uniqueLectureCount} unique lectures \u00b7 ${s.categoryCount} categories, ${s.widgetCount} widgets, ${s.playlistCount} playlists`;
        resultsTree.innerHTML = '';
        for (const c of (s.categories || [])) {
            const d = document.createElement('details');
            d.innerHTML = `<summary>\ud83d\udcda ${escapeHtml(c.categoryName || c.categoryId || 'Category')} \u2014 ${c.widgets} widgets, ${c.items} items</summary>`;
            resultsTree.appendChild(d);
        }
    }

    async function getFlatCatalog() {
        return (await sendRuntimeMessage({ type: "CRAWL_GET_FLAT" })) || [];
    }

    async function getAllWatchUrls() {
        const flat = await getFlatCatalog();
        return flat.map(l => l.watchUrl).filter(Boolean);
    }

    btnExportJson.addEventListener('click', async () => {
        btnExportJson.disabled = true;
        btnExportJson.textContent = 'Exporting...';
        const flat = await getFlatCatalog();
        if (flat && flat.length) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const blob = new Blob([JSON.stringify(flat, null, 2)], { type: 'application/json' });
            downloadBlob(blob, `pw-pi-catalog-${timestamp}.json`);
        }
        btnExportJson.disabled = false;
        btnExportJson.textContent = 'Export JSON';
    });

    btnExportUrls.addEventListener('click', async () => {
        btnExportUrls.disabled = true;
        btnExportUrls.textContent = 'Exporting...';
        const urls = await getAllWatchUrls();
        if (urls.length > 0) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const blob = new Blob([urls.join('\n')], { type: 'text/plain' });
            downloadBlob(blob, `pw-pi-urls-${timestamp}.txt`);
        }
        btnExportUrls.disabled = false;
        btnExportUrls.textContent = 'Export URLs';
    });

    btnCopyUrls.addEventListener('click', async () => {
        btnCopyUrls.disabled = true;
        btnCopyUrls.textContent = 'Copying...';
        const urls = await getAllWatchUrls();
        if (urls.length > 0) {
            await navigator.clipboard.writeText(urls.join('\n'));
            btnCopyUrls.textContent = 'Copied!';
            setTimeout(() => { btnCopyUrls.textContent = 'Copy URLs'; }, 1500);
        } else {
            btnCopyUrls.textContent = 'No URLs';
            setTimeout(() => { btnCopyUrls.textContent = 'Copy URLs'; }, 1500);
        }
        btnCopyUrls.disabled = false;
    });

    clearHistoryBtn.addEventListener('click', async () => {
        await sendRuntimeMessage({ type: "CRAWL_CLEAR_HISTORY" });
        refreshCrawlHistory();
    });

    async function refreshCrawlHistory() {
        const history = await sendRuntimeMessage({ type: "CRAWL_GET_HISTORY" });
        if (!history || history.length === 0) {
            historyContainer.innerHTML = '';
            historyContainer.appendChild(historyEmpty);
            historyEmpty.style.display = 'block';
            return;
        }
        historyEmpty.style.display = 'none';
        historyContainer.innerHTML = '';
        for (const entry of history) {
            const div = document.createElement('div');
            div.className = 'history-entry';
            const date = new Date(entry.completedAt || entry.startedAt).toLocaleString();
            const statusClass = entry.status === 'completed' ? 'status-completed'
                : entry.status === 'stopped' ? 'status-stopped' : 'status-unknown';
            const keysInfo = entry.keysMatched > 0
                ? `<span class="history-keys-match">${entry.keysMatched} keys matched</span>`
                : '<span class="history-keys-none">no keys yet</span>';
            div.innerHTML = `
                <div class="history-entry-header">
                    <span class="history-status ${statusClass}">${entry.status || '?'}</span>
                    <span class="history-date">${date}</span>
                </div>
                <div class="history-entry-stats">
                    ${entry.categoryCount ?? 0} categories, ${entry.lectureCount} lectures &middot; ${keysInfo}
                </div>
            `;
            const loadBtn = document.createElement('button');
            loadBtn.className = 'history-load-btn';
            loadBtn.textContent = 'Load';
            loadBtn.addEventListener('click', async () => {
                loadBtn.disabled = true;
                loadBtn.textContent = 'Loading...';
                const resp = await sendRuntimeMessage({ type: "CRAWL_RESTORE_HISTORY", crawlId: entry.crawlId });
                if (resp && resp.status === 'restored') {
                    updateProgressUI('stopped', resp.progress);
                    fetchAndDisplayResults();
                }
                loadBtn.disabled = false;
                loadBtn.textContent = 'Load';
            });
            div.appendChild(loadBtn);
            historyContainer.appendChild(div);
        }
    }

    refreshTokenStatus();
    refreshCapturedApis();
    refreshCrawlHistory();

    (async () => {
        const stateObj = await sendRuntimeMessage({ type: "CRAWL_GET_STATE" });
        if (stateObj && stateObj.state && stateObj.state !== 'idle') {
            updateProgressUI(stateObj.state, stateObj.progress);
            if (stateObj.state === 'crawling' || stateObj.state === 'paused') startPolling();
            if (stateObj.state === 'completed' || stateObj.state === 'stopped') fetchAndDisplayResults();
        }
    })();

    setInterval(() => { refreshTokenStatus(); refreshCapturedApis(); }, 3000);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// === END PW API CRAWLER ===
