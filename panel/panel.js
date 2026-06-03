import { AsyncLocalStorage, DeviceManager, RemoteCDMManager, SettingsManager, Util } from "../lib/util.js";

const key_container = document.getElementById('key-container');

const sendRuntimeMessage = (message) => new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
});

const getStoredLogKeys = (storage) => Object.entries(storage)
    .filter(([, value]) => value?.pssh_data)
    .map(([key]) => key);

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
    const exportedLogs = Object.values(logs).filter(log => log?.pssh_data);
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
    try {
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
    } catch (e) {
        document.body.innerHTML = `<div style="color:red; font-family: monospace; font-size:12px; padding: 10px;">
            <b>GUI Crash:</b><br/>${e?.message}<br/>${e?.stack}
        </div>`;
    }
});
// ======================================
