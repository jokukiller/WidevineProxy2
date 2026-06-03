import "./lib/protobuf.min.js";
import "./lib/license_protocol.min.js";
const { LicenseType, SignedMessage, LicenseRequest, License } = protobuf.roots.default.license_protocol;

import "./lib/forge.min.js";

import { Session } from "./lib/cdm.js";
import { DeviceManager, SettingsManager, AsyncLocalStorage, RemoteCDMManager, IconManager, Util } from "./lib/util.js";
import { WidevineDevice } from "./lib/device.js";
import { RemoteCdm } from "./lib/remote_cdm.js";


let manifests = new Map();
let requests = new Map();
let sessions = new Map();
let logs = [];
let debugModeEnabled = false;
let debugEvents = [];
let lastServiceCertificate = null;

chrome.webRequest.onBeforeSendHeaders.addListener(
    function(details) {
        if (details.method === "GET") {
            if (!requests.has(details.url)) {
                const headers = details.requestHeaders
                    .filter(item => !(
                        item.name.startsWith('sec-ch-ua') ||
                        item.name.startsWith('Sec-Fetch') ||
                        item.name.startsWith('Accept-') ||
                        item.name.startsWith('Host') ||
                        item.name === "Connection"
                    )).reduce((acc, item) => {
                        acc[item.name] = item.value;
                        return acc;
                    }, {});
                requests.set(details.url, headers);
            }
        } else if (details.method === "POST" && details.url.includes("drm-license-manager")) {
            const headers = details.requestHeaders
                .filter(item => !(
                    item.name.startsWith('sec-ch-ua') ||
                    item.name.startsWith('Sec-Fetch') ||
                    item.name.startsWith('Accept-') ||
                    item.name.startsWith('Host') ||
                    item.name === "Connection" ||
                    item.name.toLowerCase() === "content-length"
                )).reduce((acc, item) => {
                    acc[item.name] = item.value;
                    return acc;
                }, {});
            requests.set("license_post_headers", headers);
            requests.set("license_post_url", details.url);
        }
    },
    {urls: ["<all_urls>"]},
    ['requestHeaders', chrome.webRequest.OnSendHeadersOptions.EXTRA_HEADERS].filter(Boolean)
);

chrome.webRequest.onBeforeRequest.addListener(
    function(details) {
        if (details.method === "POST" && details.requestBody && details.requestBody.raw) {
            const rawBytes = details.requestBody.raw[0]?.bytes;
            if (rawBytes) {
                const byteLength = rawBytes.byteLength;
                if (byteLength > 100) {
                    debugEvents.push({
                        hook: "webRequest_post_outgoing",
                        url: details.url,
                        byteLength: byteLength
                    });
                }
            }
        }
    },
    {urls: ["<all_urls>"]},
    ['requestBody']
);

async function parseClearKey(body, sendResponse, tab_url, video_title, class_title, tab_id) {
    const clearkey = JSON.parse(atob(body));

    const formatted_keys = clearkey["keys"].map(key => ({
        ...key,
        kid: Util.bytesToHex(Util.b64.decode(key.kid.replace(/-/g, "+").replace(/_/g, "/") + "==")),
        k: Util.bytesToHex(Util.b64.decode(key.k.replace(/-/g, "+").replace(/_/g, "/") + "=="))
    }));
    const pssh_data = btoa(JSON.stringify({kids: clearkey["keys"].map(key => key.k)}));

    if (logs.filter(log => log.pssh_data === pssh_data).length > 0) {
        console.log("[WidevineProxy2]", `KEYS_ALREADY_RETRIEVED: ${pssh_data}`);
        sendResponse();
        return;
    }

    console.log("[WidevineProxy2]", "CLEARKEY KEYS", formatted_keys, tab_url);
    const log = {
        type: "CLEARKEY",
        pssh_data: pssh_data,
        keys: formatted_keys,
        url: tab_url,
        videoTitle: video_title,
        classTitle: class_title,
        tabId: tab_id,
        timestamp: Math.floor(Date.now() / 1000),
        manifests: manifests.has(tab_url) ? manifests.get(tab_url) : []
    }
    logs.push(log);

    await AsyncLocalStorage.setStorage({[pssh_data]: log});
    sendResponse();
}

async function generateChallenge(body, sendResponse) {
    const signed_message =  SignedMessage.decode(Util.b64.decode(body));
    const license_request = LicenseRequest.decode(signed_message.msg);
    const pssh_data = license_request.contentId.widevinePsshData.psshData[0];
    const original_request_id = Util.b64.encode(license_request.contentId.widevinePsshData.requestId);

    debugEvents.push({ hook: "generateChallenge_start", original_request_id });

    if (!pssh_data) {
        debugEvents.push({ hook: "generateChallenge_no_pssh" });
        console.log("[WidevineProxy2]", "NO_PSSH_DATA_IN_CHALLENGE");
        sendResponse(body);
        return;
    }

    if (logs.filter(log => log.pssh_data === Session.psshDataToPsshBoxB64(pssh_data)).length > 0) {
        debugEvents.push({ hook: "generateChallenge_already_retrieved" });
        console.log("[WidevineProxy2]", `KEYS_ALREADY_RETRIEVED: ${Util.b64.encode(pssh_data)}`);
        sendResponse(body);
        return;
    }

    const selected_device_name = await DeviceManager.getSelectedWidevineDevice();
    if (!selected_device_name) {
        debugEvents.push({ hook: "generateChallenge_no_device" });
        sendResponse(body);
        return;
    }

    const device_b64 = await DeviceManager.loadWidevineDevice(selected_device_name);
    const widevine_device = new WidevineDevice(Util.b64.decode(device_b64).buffer);

    const private_key = `-----BEGIN RSA PRIVATE KEY-----${Util.b64.encode(widevine_device.private_key)}-----END RSA PRIVATE KEY-----`;
    const session = new Session(
        {
            privateKey: private_key,
            identifierBlob: widevine_device.client_id_bytes
        },
        pssh_data
    );

    // Apply the service certificate for privacy mode if we captured one
    if (lastServiceCertificate) {
        try {
            await session.setServiceCertificateFromMessage(lastServiceCertificate);
            debugEvents.push({ hook: "generateChallenge_service_cert_applied" });
        } catch (certErr) {
            debugEvents.push({ hook: "generateChallenge_service_cert_error", error: certErr?.message });
        }
    } else {
        debugEvents.push({ hook: "generateChallenge_no_service_cert" });
    }

    const [challenge, request_id] = session.createLicenseRequest(LicenseType.STREAMING, widevine_device.type === 2);
    debugEvents.push({ hook: "generateChallenge_success", proxy_request_id: Util.b64.encode(request_id) });
    sessions.set(Util.b64.encode(request_id), session);
    sessions.set(original_request_id, session);

    // Auto-fetch the license ourselves using the captured headers!
    const licenseUrl = requests.get("license_post_url");
    const licenseHeaders = requests.get("license_post_headers");
    if (licenseUrl && licenseHeaders) {
        debugEvents.push({ hook: "background_fetch_start", url: licenseUrl });
        try {
            const fetchResponse = await fetch(licenseUrl, {
                method: "POST",
                headers: licenseHeaders,
                body: challenge
            });
            const licenseBuffer = await fetchResponse.arrayBuffer();
            const licenseBytes = new Uint8Array(licenseBuffer);
            
            debugEvents.push({ hook: "background_fetch_success", byteLength: licenseBytes.length });
            
            // Parse the license immediately!
            try {
                const keys = await session.parseLicense(licenseBytes);
                debugEvents.push({ hook: "background_fetch_parsed", keys_count: keys ? keys.length : 0 });
                
                // Add to logs
                if (keys && keys.length > 0) {
                    logs.push({
                        type: "WIDEVINE",
                        pssh_data: Session.psshDataToPsshBoxB64(pssh_data),
                        keys: keys,
                        url: "background_fetch",
                        videoTitle: "Auto-Fetched",
                        classTitle: "",
                        tabId: -1,
                        timestamp: Math.floor(Date.now() / 1000),
                        manifests: []
                    });
                }
            } catch (parseErr) {
                debugEvents.push({ hook: "background_fetch_parse_error", error: parseErr?.message });
            }
        } catch (fetchErr) {
            debugEvents.push({ hook: "background_fetch_error", error: fetchErr?.message });
        }
    } else {
        debugEvents.push({ hook: "background_fetch_skipped_no_headers" });
    }

    sendResponse(Util.b64.encode(challenge));
}

async function parseLicense(body, sendResponse, tab_url, video_title, class_title, tab_id) {
    debugEvents.push({ hook: "parseLicense_start", body_length: body.length });
    const license = Util.b64.decode(body);
    const signed_license_message = SignedMessage.decode(license);

    if (signed_license_message.type !== SignedMessage.MessageType.LICENSE) {
        // Capture service certificates (type 5) for use in privacy mode challenges
        if (signed_license_message.type === 5) {
            lastServiceCertificate = license;
            debugEvents.push({ hook: "parseLicense_service_cert_captured", type: signed_license_message.type });
        } else {
            debugEvents.push({ hook: "parseLicense_not_license", type: signed_license_message.type });
        }
        sendResponse();
        return;
    }

    const license_obj = License.decode(signed_license_message.msg);
    const loaded_request_id = Util.b64.encode(license_obj.id.requestId);
    debugEvents.push({ hook: "parseLicense_request_id", loaded_request_id, has_session: sessions.has(loaded_request_id) });

    if (!sessions.has(loaded_request_id)) {
        debugEvents.push({ hook: "parseLicense_session_not_found" });
        sendResponse();
        return;
    }

    const loadedSession = sessions.get(loaded_request_id);
    const keys = await loadedSession.parseLicense(license);
    const pssh = loadedSession.getPSSH();

    debugEvents.push({ hook: "parseLicense_success", keys_extracted: keys.length });

    console.log("[WidevineProxy2]", "KEYS", JSON.stringify(keys), tab_url);
    const log = {
        type: "WIDEVINE",
        pssh_data: pssh,
        keys: keys,
        url: tab_url,
        videoTitle: video_title,
        classTitle: class_title,
        tabId: tab_id,
        timestamp: Math.floor(Date.now() / 1000),
        manifests: manifests.has(tab_url) ? manifests.get(tab_url) : []
    }
    logs.push(log);
    await AsyncLocalStorage.setStorage({[pssh]: log});

    sessions.delete(loaded_request_id);
    sendResponse();
}

async function generateChallengeRemote(body, sendResponse) {
    const signed_message =  SignedMessage.decode(Util.b64.decode(body));
    const license_request = LicenseRequest.decode(signed_message.msg);
    const pssh_data = license_request.contentId.widevinePsshData.psshData[0];

    if (!pssh_data) {
        console.log("[WidevineProxy2]", "NO_PSSH_DATA_IN_CHALLENGE");
        sendResponse(body);
        return;
    }

    const pssh = Session.psshDataToPsshBoxB64(pssh_data);

    if (logs.filter(log => log.pssh_data === pssh).length > 0) {
        console.log("[WidevineProxy2]", `KEYS_ALREADY_RETRIEVED: ${Util.b64.encode(pssh_data)}`);
        sendResponse(body);
        return;
    }

    const selected_remote_cdm_name = await RemoteCDMManager.getSelectedRemoteCDM();
    if (!selected_remote_cdm_name) {
        sendResponse(body);
        return;
    }

    const selected_remote_cdm = JSON.parse(await RemoteCDMManager.loadRemoteCDM(selected_remote_cdm_name));
    const remote_cdm = RemoteCdm.from_object(selected_remote_cdm);

    const session_id = await remote_cdm.open();
    const challenge_b64 = await remote_cdm.get_license_challenge(session_id, pssh, true);

    const signed_challenge_message = SignedMessage.decode(Util.b64.decode(challenge_b64));
    const challenge_message = LicenseRequest.decode(signed_challenge_message.msg);

    sessions.set(Util.b64.encode(challenge_message.contentId.widevinePsshData.requestId), {
        id: session_id,
        pssh: pssh
    });
    sendResponse(challenge_b64);
}

async function parseLicenseRemote(body, sendResponse, tab_url, video_title, class_title, tab_id) {
    const license = Util.b64.decode(body);
    const signed_license_message = SignedMessage.decode(license);

    if (signed_license_message.type !== SignedMessage.MessageType.LICENSE) {
        sendResponse();
        return;
    }

    const license_obj = License.decode(signed_license_message.msg);
    const loaded_request_id = Util.b64.encode(license_obj.id.requestId);

    if (!sessions.has(loaded_request_id)) {
        sendResponse();
        return;
    }

    const session_id = sessions.get(loaded_request_id);

    const selected_remote_cdm_name = await RemoteCDMManager.getSelectedRemoteCDM();
    if (!selected_remote_cdm_name) {
        sendResponse();
        return;
    }

    const selected_remote_cdm = JSON.parse(await RemoteCDMManager.loadRemoteCDM(selected_remote_cdm_name));
    const remote_cdm = RemoteCdm.from_object(selected_remote_cdm);

    await remote_cdm.parse_license(session_id.id, body);
    const returned_keys = await remote_cdm.get_keys(session_id.id, "CONTENT");
    await remote_cdm.close(session_id.id);

    if (returned_keys.length === 0) {
        sendResponse();
        return;
    }

    const keys = returned_keys.map(({ key, key_id }) => ({ k: key, kid: key_id }));

    console.log("[WidevineProxy2]", "KEYS", JSON.stringify(keys), tab_url);
    const log = {
        type: "WIDEVINE",
        pssh_data: session_id.pssh,
        keys: keys,
        url: tab_url,
        videoTitle: video_title,
        classTitle: class_title,
        tabId: tab_id,
        timestamp: Math.floor(Date.now() / 1000),
        manifests: manifests.has(tab_url) ? manifests.get(tab_url) : []
    }
    logs.push(log);
    await AsyncLocalStorage.setStorage({[session_id.pssh]: log});

    sessions.delete(loaded_request_id);
    sendResponse();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        const tab_url = sender.tab ? sender.tab.url : null;

        switch (message.type) {
            case "REQUEST":
                if (!await SettingsManager.getEnabled()) {
                    sendResponse(message.body);
                    manifests.clear();
                    return;
                }

                try {
                    JSON.parse(atob(message.body));
                    sendResponse(message.body);
                    return;
                } catch {
                    if (message.body) {
                        try {
                            const device_type = await SettingsManager.getSelectedDeviceType();
                            switch (device_type) {
                                case "WVD":
                                    await generateChallenge(message.body, sendResponse);
                                    break;
                                case "REMOTE":
                                    await generateChallengeRemote(message.body, sendResponse);
                                    break;
                            }
                        } catch (e) {
                            const errLog = {
                                type: "cdm_challenge_error",
                                timestamp: new Date().toISOString(),
                                detail: {
                                    error: e?.message || e?.toString(),
                                    stack: e?.stack
                                }
                            };
                            logs.push(errLog);
                            debugEvents.push(errLog);
                            sendResponse(message.body);
                        }
                    }
                }
                break;

            case "RESPONSE":
                if (!await SettingsManager.getEnabled()) {
                    sendResponse(message.body);
                    manifests.clear();
                    return;
                }

                let video_title = "Unknown";
                let class_title = "Unknown";
                let tab_id = sender.tab ? sender.tab.id : null;
                
                if (message.metadata) {
                    try {
                        const parsedMeta = JSON.parse(message.metadata);
                        if (parsedMeta.videoTitle) video_title = parsedMeta.videoTitle;
                        if (parsedMeta.classTitle) class_title = parsedMeta.classTitle;
                    } catch (e) {}
                }

                try {
                    await parseClearKey(message.body, sendResponse, tab_url, video_title, class_title, tab_id);
                    return;
                } catch (e) {
                    try {
                        const device_type = await SettingsManager.getSelectedDeviceType();
                        switch (device_type) {
                            case "WVD":
                                await parseLicense(message.body, sendResponse, tab_url, video_title, class_title, tab_id);
                                break;
                            case "REMOTE":
                                await parseLicenseRemote(message.body, sendResponse, tab_url, video_title, class_title, tab_id);
                                break;
                        }
                    } catch (innerErr) {
                        const errLog = {
                            type: "cdm_response_error",
                            timestamp: new Date().toISOString(),
                            detail: {
                                error: innerErr?.message || innerErr?.toString(),
                                stack: innerErr?.stack
                            }
                        };
                        logs.push(errLog);
                        debugEvents.push(errLog);
                        sendResponse(message.body);
                    }
                }
                break;
            case "DEBUG_EVENT":
                debugEvents.push(message.detail);
                sendResponse();
                break;
            case "SET_DEBUG_MODE":
                debugModeEnabled = message.enabled;
                sendResponse(debugModeEnabled);
                break;
            case "GET_DEBUG_MODE":
                sendResponse(debugModeEnabled);
                break;
            case "GET_DEBUG_EXPORT":
                sendResponse(debugEvents);
                break;
            case "CLEAR_DEBUG":
                debugEvents = [];
                sendResponse();
                break;
            case "GET_LOGS":
                sendResponse(logs);
                break;
            case "OPEN_PICKER_WVD":
                chrome.windows.create({
                    url: 'picker/wvd/filePicker.html',
                    type: 'popup',
                    width: 300,
                    height: 200,
                });
                break;
            case "OPEN_PICKER_WVD_MOBILE":
                chrome.tabs.create({
                    url: chrome.runtime.getURL("picker/wvd/filePicker.html")
                });
                break;
            case "OPEN_PICKER_REMOTE":
                chrome.windows.create({
                    url: 'picker/remote/filePicker.html',
                    type: 'popup',
                    width: 300,
                    height: 200,
                });
                break;
            case "OPEN_PICKER_REMOTE_MOBILE":
                chrome.tabs.create({
                    url: chrome.runtime.getURL("picker/remote/filePicker.html")
                });
                break;
            case "CLEAR":
                logs = [];
                manifests.clear();
                IconManager.setDefaultIcon();
                break;
            case "MANIFEST":
                const parsed = JSON.parse(message.body);
                const element = {
                    type: parsed.type,
                    url: parsed.url,
                    headers: requests.has(parsed.url) ? requests.get(parsed.url) : [],
                };

                if (!manifests.has(tab_url)) {
                    manifests.set(tab_url, [element]);
                } else {
                    let elements = manifests.get(tab_url);
                    if (!elements.some(e => e.url === parsed.url)) {
                        elements.push(element);
                        manifests.set(tab_url, elements);
                    }
                }
                sendResponse();
        }
    })();
    return true;
});

chrome.runtime.onSuspend.addListener(() => {
    IconManager.setDefaultIcon();
});
