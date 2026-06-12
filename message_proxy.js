if (!globalThis.__widevineProxy2MessageProxyLoaded) {
    globalThis.__widevineProxy2MessageProxyLoaded = true;

    async function processMessage(detail) {
        return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            type: detail.type,
            body: detail.body,
            metadata: detail.metadata ?? null,
            event_type: detail.event_type,
            detail: detail.detail,
            enabled: detail.enabled,
        }, (response) => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(response);
            });
        })
    }

    document.addEventListener('response', async (event) => {
        const { detail } = event;
        try {
            const responseData = await processMessage(detail);
            // Fire-and-forget messages (e.g. API_CAPTURED) carry no requestId and
            // expect no reply — don't try to build a responseReceived event.
            if (detail.requestId === undefined || detail.requestId === null) return;
            const responseEvent = new CustomEvent('responseReceived', {
                detail: detail.requestId.concat(responseData)
            });
            document.dispatchEvent(responseEvent);
        } catch {
            // No responder for fire-and-forget messages; ignore.
        }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Page-context API fetch bridge for the PW crawler. Running the request
        // from the tab (page origin pw.live) — rather than the service worker —
        // is what lets it authenticate the same way PW's own app does, avoiding
        // the cross-origin / token-binding 401s the previous crawler hit.
        if (message.type === "PW_PAGE_FETCH") {
            (async () => {
                try {
                    const { url, method, headers } = message.payload || {};
                    const resp = await fetch(url, {
                        method: method || "GET",
                        headers: headers || {},
                        credentials: "include",
                    });
                    const text = await resp.text();
                    let body;
                    try { body = JSON.parse(text); } catch { body = text; }
                    sendResponse({ status: resp.status, ok: resp.ok, body });
                } catch (e) {
                    sendResponse({ status: 0, error: e?.message || String(e) });
                }
            })();
            return true; // keep the message channel open for the async response
        }

        if (message.type === "DUPLICATE_NOTIFICATION") {
            document.dispatchEvent(new CustomEvent("wvp2Notification", {
                detail: message.payload,
            }));
            return;
        }

        if (message.type === "SET_HOME_URL_TRIGGER") {
            document.dispatchEvent(new CustomEvent("wvp2SetHomeUrlTrigger", {
                detail: message.payload,
            }));
            return;
        }

        if (message.type === "HOME_URL_TRIGGER_SET") {
            document.dispatchEvent(new CustomEvent("wvp2HomeUrlTriggerSet", {
                detail: message.payload,
            }));
            return;
        }

        if (message.type === "DEBUG_MODE_CHANGED") {
            document.dispatchEvent(new CustomEvent("wvp2DebugModeChanged", {
                detail: message.payload,
            }));
            return;
        }

        if (message.type === "ALT_LAYOUT_CHANGED") {
            document.dispatchEvent(new CustomEvent("wvp2AltLayoutChanged", {
                detail: message.enabled,
            }));
        }
    });
}
