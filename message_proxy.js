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

    const observeDataset = () => {
        const ipcEventName = document.documentElement.dataset.wvp2IpcEvent;
        if (ipcEventName) {
            document.addEventListener(ipcEventName, async (event) => {
                const { detail } = event;
                const responseData = await processMessage(detail);
                const responseEvent = new CustomEvent(ipcEventName + '_response', {
                    detail: detail.requestId.concat(responseData)
                });
                document.dispatchEvent(responseEvent);
            });
        } else {
            // Wait for content_script.js to set it
            const observer = new MutationObserver(() => {
                if (document.documentElement.dataset.wvp2IpcEvent) {
                    observer.disconnect();
                    observeDataset();
                }
            });
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-wvp2-ipc-event'] });
        }
    };
    observeDataset();

    chrome.runtime.onMessage.addListener((message) => {
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
