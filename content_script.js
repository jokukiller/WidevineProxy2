(async () => {
    const proxy = (object, method, handler) => {
        const original = object[method];
        if (typeof original !== "function")
            return;

        Object.defineProperty(object, method, {
            value: new Proxy(original, { apply: handler }),
            configurable: true,
            writable: true
        });
    };

    const b64 = {
        decode: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
        encode: b => btoa(String.fromCharCode(...new Uint8Array(b)))
    };

    const getManifestType = (text) => {
        const lower = text.toLowerCase();
        if (lower.includes('<mpd') && lower.includes('</mpd>')) {
            return "DASH";
        } else if (lower.includes('#extm3u')) {
            if (lower.includes('#ext-x-stream-inf')) {
                return "HLS_MASTER";
            } else {
                return "HLS_PLAYLIST";
            }
        } else if (lower.includes('<smoothstreamingmedia') && lower.includes('</smoothstreamingmedia>')) {
            return "MSS";
        }
    };

    const getPageMetadata = () => {
        let videoTitle = document.title || "";
        let classTitle = "";
        
        try {
            const h1 = document.querySelector("h1");
            if (h1 && h1.innerText) {
                classTitle = h1.innerText.trim();
            }
        } catch (e) {}

        return JSON.stringify({ videoTitle, classTitle });
    };

    const cleanDispatchEvent = document.createElement('div').dispatchEvent;
    const ipcEventName = 'wvp2_ipc_' + Math.random().toString(36).substring(7);

    // Communicate the random event name to message_proxy.js (which runs in isolated world)
    // message_proxy.js can't see variables in MAIN world, but it can read a data attribute on the document element!
    document.documentElement.dataset.wvp2IpcEvent = ipcEventName;

    function emitAndWaitForResponse(type, data, metadata = null) {
        return new Promise((resolve) => {
            const requestId = Math.random().toString(16).substring(2, 9);
            const responseHandler = (event) => {
                const { detail } = event;
                if (detail.substring(0, 7) === requestId) {
                    document.removeEventListener(ipcEventName + '_response', responseHandler);
                    resolve(detail.substring(7));
                }
            };
            document.addEventListener(ipcEventName + '_response', responseHandler);
            const requestEvent = new CustomEvent(ipcEventName, {
                detail: {
                    type: type,
                    body: data,
                    metadata: metadata,
                    requestId: requestId,
                }
            });
            cleanDispatchEvent.call(document, requestEvent);
        });
    }

    function emitDebugEvent(eventDetails) {
        cleanDispatchEvent.call(document, new CustomEvent(ipcEventName, {
            detail: {
                type: "DEBUG_EVENT",
                detail: eventDetails
            }
        }));
    }

    const wrapEventListener = (target, thisArg, args) => {
        const [type, listener] = args;

        if (thisArg == null || typeof MediaKeyMessageEvent === 'undefined' || type !== "message" || !listener) {
            return target.apply(thisArg, args);
        }

        args[1] = async function(event) {
            if (event.__wvp2_handled) {
                if (listener.handleEvent) {
                    listener.handleEvent.call(listener, event);
                } else {
                    listener.call(this, event);
                }
                return;
            }

            if (event.type === "message" && event.message) {
                if (event.message.byteLength !== undefined && event.message.byteLength > 2) {
                    emitDebugEvent({
                        hook: "addEventListener_passive_intercept",
                        messageType: event.messageType,
                        byteLength: event.message.byteLength
                    });

                    const oldChallenge = b64.encode(event.message);
                    const metadata = getPageMetadata();
                    emitAndWaitForResponse("REQUEST", oldChallenge, metadata).catch(e => console.error(e));

                    if (listener.handleEvent) {
                        listener.handleEvent.call(listener, event);
                    } else {
                        listener.call(this, event);
                    }
                    return;
                } else {
                    emitDebugEvent({
                        hook: "addEventListener_bypassed",
                        byteLength: event.message ? event.message.byteLength : 0,
                        isTrusted: event.isTrusted
                    });
                }
            }

            if (listener.handleEvent) {
                listener.handleEvent.call(listener, event);
            } else {
                listener.call(this, event);
            }
        };

        return target.apply(thisArg, args);
    };

    if (typeof EventTarget !== 'undefined') {
        proxy(EventTarget.prototype, 'addEventListener', wrapEventListener);
    }
    if (typeof MediaKeySession !== 'undefined') {
        if (MediaKeySession.prototype.hasOwnProperty('addEventListener')) {
            proxy(MediaKeySession.prototype, 'addEventListener', wrapEventListener);
        }
    }

    if (typeof MediaKeySession !== 'undefined') {
        const originalOnMessage = Object.getOwnPropertyDescriptor(MediaKeySession.prototype, 'onmessage');
        if (originalOnMessage) {
            Object.defineProperty(MediaKeySession.prototype, 'onmessage', {
                configurable: true,
                enumerable: true,
                get() {
                    return originalOnMessage.get ? originalOnMessage.get.call(this) : this.__wvp2_onmessage;
                },
                set(value) {
                    this.__wvp2_onmessage = value;
                    if (typeof value !== 'function') {
                        originalOnMessage.set.call(this, value);
                        return;
                    }

                    const wrapped = async function(event) {
                        if (event.__wvp2_handled) {
                            return value.call(this, event);
                        }

                        if (event.type === "message" && event.message && event.message.byteLength !== undefined && event.message.byteLength > 2) {
                            emitDebugEvent({
                                hook: "onmessage_passive_intercept",
                                messageType: event.messageType,
                                byteLength: event.message.byteLength
                            });

                            const oldChallenge = b64.encode(event.message);
                            const metadata = getPageMetadata();
                            emitAndWaitForResponse("REQUEST", oldChallenge, metadata).catch(e => console.error(e));
                        }

                        return value.call(this, event);
                    };
                    
                    originalOnMessage.set.call(this, wrapped);
                }
            });
        }

        proxy(MediaKeySession.prototype, 'update', async (target, thisArg, args) => {
            if (thisArg == null || !(thisArg instanceof MediaKeySession)) {
                return target.apply(thisArg, args);
            }

            emitDebugEvent({
                hook: "MediaKeySession.update",
                byteLength: args[0]?.byteLength
            });

            const metadata = getPageMetadata();
            await emitAndWaitForResponse("RESPONSE", b64.encode(args[0]), metadata);

            try {
                return await target.apply(thisArg, args);
            } catch (e) {
                // ignored, since this will always fail
            }
        });
    }

    proxy(XMLHttpRequest.prototype,  "open", (target, thisArg, args) => {
        const [method, url] = args;

        thisArg.requestMethod = method.toUpperCase();
        thisArg.requestURL = url;

        return target.apply(thisArg, args);
    });

    proxy(XMLHttpRequest.prototype, "send", (target, thisArg, args) => {
        if (args[0] && (args[0] instanceof ArrayBuffer || args[0] instanceof Uint8Array || args[0] instanceof Blob)) {
            const size = args[0] instanceof Blob ? args[0].size : args[0].byteLength;
            if (size > 100) {
                emitDebugEvent({
                    hook: "xhr_outgoing",
                    url: thisArg.requestURL,
                    bodyLength: size
                });
            }
        }
        
        // Removed broken challengeMap logic

        thisArg.addEventListener("readystatechange", async () => {
            if (thisArg.requestMethod !== "GET" || thisArg.readyState !== 4) {
                return;
            }

            let body = null;
            switch (thisArg.responseType) {
                case "":
                case "text":
                    body = thisArg.responseText ?? thisArg.response;
                    break;

                case "json":
                    body = typeof thisArg.response === 'string' ? thisArg.response : JSON.stringify(thisArg.response);
                    break;

                case "arraybuffer":
                    if (thisArg.response && thisArg.response.byteLength > 0 && thisArg.response.byteLength < 1_000_000) {
                        const arr = new Uint8Array(thisArg.response);
                        const decoder = new TextDecoder('utf-8', { fatal: false });
                        body = arr.length <= 2000
                            ? decoder.decode(arr)
                            : decoder.decode(arr.slice(0, 1000)) + decoder.decode(arr.slice(-1000));
                    }
                    break;

                case "blob":
                    if (thisArg.response.type.startsWith('text/') || thisArg.response.type.includes('xml') || thisArg.response.type.includes('json') || thisArg.response.size < 100_000) {
                        body = await thisArg.response.text();
                    }
                    break;

                case "document":
                    if (thisArg.response?.documentElement) {
                        body = new XMLSerializer().serializeToString(thisArg.response);
                    }
                    break;
            }

            if (body) {
                const manifest_type = getManifestType(body);
                if (manifest_type) {
                    console.log("WVP2 FOUND MANIFEST", manifest_type, thisArg.responseURL);
                    await emitAndWaitForResponse("MANIFEST", JSON.stringify({
                        url: thisArg.responseURL,
                        type: manifest_type,
                    }));
                }
            }
        });

        return target.apply(thisArg, args);
    });

    proxy(window, "fetch", async (target, thisArg, args) => {
        // Removed broken challengeMap logic

        let outgoingUrl = null;
        let outgoingBody = null;
        
        if (args[0] instanceof Request) {
            outgoingUrl = args[0].url;
            outgoingBody = "Request Object (cant easily read body without cloning)";
        } else {
            outgoingUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
            if (args[1] && args[1].body) {
                if (typeof args[1].body === 'string') {
                    outgoingBody = "String length " + args[1].body.length;
                } else if (args[1].body instanceof Blob) {
                    outgoingBody = "Blob size " + args[1].body.size;
                } else if (args[1].body instanceof ArrayBuffer || args[1].body instanceof Uint8Array) {
                    outgoingBody = "Binary size " + (args[1].body.byteLength || args[1].body.length);
                } else {
                    outgoingBody = "Unknown body type";
                }
            }
        }
        
        if (outgoingBody && args[1]?.method?.toUpperCase() === 'POST' || args[0] instanceof Request && args[0].method.toUpperCase() === 'POST') {
            emitDebugEvent({
                hook: "fetch_outgoing_post",
                url: outgoingUrl,
                bodyInfo: outgoingBody
            });
        }
        
        const response = await target.apply(thisArg, args);

        try {
            if (response) {
                const text = await response.clone().text();
                const manifest_type = getManifestType(text);

                if (manifest_type) {
                    if (url) {
                        await emitAndWaitForResponse("MANIFEST", JSON.stringify({
                            url,
                            type: manifest_type
                        }));
                    }
                }
            }
        } catch (err) {
            console.debug("Manifest intercept failed:", err);
        }

        return response;
    });
})();
