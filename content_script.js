(async () => {
    if (globalThis.__widevineProxy2ContentScriptLoaded) {
        return;
    }
    globalThis.__widevineProxy2ContentScriptLoaded = true;

    const proxy = (object, method, handler) => {
        const original = object[method];
        if (typeof original !== "function" || original.__widevineProxy2Proxy)
            return;

        const proxied = new Proxy(original, { apply: handler });
        Object.defineProperty(proxied, "__widevineProxy2Proxy", {
            value: true,
        });

        Object.defineProperty(object, method, {
            value: proxied,
            configurable: true,
            writable: true
        });
    };

    const b64 = {
        decode: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
        encode: b => btoa(String.fromCharCode(...new Uint8Array(b)))
    };

    // === PW API CRAWLER: State & Helpers ===
    const __pwApiCrawler = {
        enabled: true,
        captured: new Map(),
    };

    function shouldCaptureApi(url) {
        return __pwApiCrawler.enabled && url && url.includes('penpencil.co');
    }

    function emitApiCaptured(data) {
        // Diagnostic: prove MAIN-world interception is alive and show whether the
        // intercepted request carried an Authorization header. Visible in the PAGE
        // console (DevTools on the pw.live tab).
        try {
            const hdrs = data && data.requestHeaders ? Object.keys(data.requestHeaders) : [];
            const hasAuth = hdrs.some(k => k.toLowerCase() === 'authorization');
            console.debug('[WVP2-Capture]', data.method, data.url, '| auth=' + hasAuth, '| headerKeys=', hdrs);
        } catch { /* ignore */ }
        document.dispatchEvent(new CustomEvent('response', {
            detail: {
                type: "API_CAPTURED",
                body: JSON.stringify(data),
            }
        }));
    }
    // === END PW API CRAWLER: Helpers ===

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
    }

    const hasClassTokens = (element, classNames) => {
        return classNames.every(className => element.classList.contains(className));
    };

    const findTitleNearMarker = (marker) => {
        let current = marker;

        for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
            const image = current.querySelector('img[alt]');
            const title = image?.getAttribute('alt')?.trim();
            if (title) {
                return title;
            }

            current = current.parentElement;
        }

        return null;
    };

    const getActiveVideoTitle = () => {
        const markers = Array.from(document.querySelectorAll('div.absolute.bottom-2.right-2'))
            .filter(element => hasClassTokens(element, [
                'absolute',
                'bottom-2',
                'right-2',
                'bg-[#1b2124]',
                'flex',
                'items-center',
                'justify-center',
            ]));

        for (const marker of markers) {
            const title = findTitleNearMarker(marker);
            if (title) {
                return title;
            }
        }

        return null;
    };

    const classTitleStorageKey = "wvp2_class_title_v2";
    const homeUrlTriggerStorageKey = "wvp2_home_url_trigger_v1";

    const getStoredClassTitle = () => {
        try {
            const state = JSON.parse(sessionStorage.getItem(classTitleStorageKey) || "null");
            const title = state?.title;
            return typeof title === "string" && title.trim() ? title.trim() : null;
        } catch {
            return null;
        }
    };

    const setStoredClassTitle = (title) => {
        try {
            sessionStorage.setItem(classTitleStorageKey, JSON.stringify({
                title,
                href: location.href,
                timestamp: Date.now(),
            }));
        } catch {
            // Some pages may block storage access.
        }
    };

    const clearStoredClassTitle = () => {
        try {
            sessionStorage.removeItem(classTitleStorageKey);
        } catch {
            // Some pages may block storage access.
        }
    };

    const getUrlSignature = (urlValue = location.href) => {
        try {
            const url = new URL(urlValue, location.href);
            return {
                origin: url.origin,
                pathname: url.pathname,
                categoryId: url.searchParams.get("categoryId"),
            };
        } catch {
            return null;
        }
    };

    const isSameUrlSignature = (left, right) => {
        return Boolean(left && right &&
            left.origin === right.origin &&
            left.pathname === right.pathname &&
            (left.categoryId ?? null) === (right.categoryId ?? null));
    };

    const getStoredHomeUrlTrigger = () => {
        try {
            const state = JSON.parse(sessionStorage.getItem(homeUrlTriggerStorageKey) || "null");
            return state?.signature ? state : null;
        } catch {
            return null;
        }
    };

    const setStoredHomeUrlTrigger = (state) => {
        try {
            sessionStorage.setItem(homeUrlTriggerStorageKey, JSON.stringify(state));
        } catch {
            // Some pages may block storage access.
        }
    };

    const altClassLayoutStorageKey = "wvp2_alt_class_layout";
    const getStoredAltClassLayout = () => {
        try {
            return sessionStorage.getItem(altClassLayoutStorageKey) === "true";
        } catch {
            return false;
        }
    };
    const setStoredAltClassLayout = (enabled) => {
        try {
            sessionStorage.setItem(altClassLayoutStorageKey, enabled ? "true" : "false");
        } catch {}
    };

    let currentClassTitle = getStoredClassTitle();
    let waitingForClass = !currentClassTitle;
    let lastSentClassTitle = currentClassTitle;

    const getActiveClassTitle = () => {
        if (waitingForClass) {
            return null;
        }

        const title = currentClassTitle;
        return typeof title === "string" && title.trim() ? title.trim() : null;
    };

    const getPageMetadata = () => ({
        video_title: getActiveVideoTitle(),
        class_title: getActiveClassTitle(),
    });

    let lastSentVideoTitle = null;

    function emitAndWaitForResponse(type, data, metadata = null, extra = {}) {
        return new Promise((resolve) => {
            const requestId = Math.random().toString(16).substring(2, 9);
            const responseHandler = (event) => {
                const { detail } = event;
                if (detail.substring(0, 7) === requestId) {
                    document.removeEventListener('responseReceived', responseHandler);
                    resolve(detail.substring(7));
                }
            };
            document.addEventListener('responseReceived', responseHandler);
            const requestEvent = new CustomEvent('response', {
                detail: {
                    type: type,
                    body: data,
                    requestId: requestId,
                    metadata: metadata,
                    ...extra,
                }
            });
            document.dispatchEvent(requestEvent);
        });
    }

    const showToast = (message) => {
        const existingToast = document.getElementById("wvp2-toast");
        existingToast?.remove();

        const toast = document.createElement("div");
        toast.id = "wvp2-toast";
        toast.textContent = message;
        Object.assign(toast.style, {
            position: "fixed",
            right: "16px",
            bottom: "16px",
            zIndex: "2147483647",
            maxWidth: "360px",
            padding: "12px 14px",
            borderRadius: "8px",
            background: "#1b2124",
            color: "#ffffff",
            fontFamily: "Arial, sans-serif",
            fontSize: "13px",
            lineHeight: "1.4",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
            whiteSpace: "pre-line",
        });

        document.documentElement.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
    };

    let debugModeEnabled = false;

    const parseBooleanResponse = (value) => value === true || value === "true";

    const refreshDebugMode = async () => {
        try {
            debugModeEnabled = parseBooleanResponse(await emitAndWaitForResponse("GET_DEBUG_MODE", ""));
        } catch {
            debugModeEnabled = false;
        }
        return debugModeEnabled;
    };

    const debugToast = (message) => {
        if (debugModeEnabled) {
            showToast(message);
        }
    };

    const getElementDebugInfo = (element) => {
        if (!(element instanceof Element)) {
            return null;
        }

        return {
            tag: element.tagName,
            id: element.id || null,
            class: typeof element.className === "string" ? element.className : null,
            title: element.getAttribute("title"),
            alt: element.getAttribute("alt"),
            text: (element.textContent ?? "").trim().slice(0, 160),
        };
    };

    const getNearestHeadingDebugInfo = (element) => {
        return getElementDebugInfo(element?.closest?.("h3[title]"));
    };

    const getNearestImageDebugInfo = (element) => {
        return getElementDebugInfo(element?.closest?.("img[alt]"));
    };

    const getClassStateDebugInfo = () => ({
        page_url: location.href,
        home_url_trigger: getStoredHomeUrlTrigger(),
        waitingForClass,
        currentClassTitle,
        activeClassTitle: getActiveClassTitle(),
    });

    const recordDebug = async (type, detail = {}) => {
        try {
            const enabled = await emitAndWaitForResponse("DEBUG_EVENT", "", null, {
                event_type: type,
                detail: {
                    ...getClassStateDebugInfo(),
                    ...detail,
                },
            });
            debugModeEnabled = parseBooleanResponse(enabled);
        } catch (err) {
            console.debug("WVP2 debug event failed:", err);
        }
    };

    void refreshDebugMode();

    document.addEventListener("wvp2DebugModeChanged", (event) => {
        debugModeEnabled = event.detail?.enabled === true;
        if (debugModeEnabled) {
            showToast("Debug Mode enabled.");
        }
    });

    document.addEventListener("wvp2Notification", (event) => {
        const classTitle = event.detail?.class_title || "Unknown class";
        const videoTitle = event.detail?.video_title || "Unknown lecture";
        showToast(`Duplicate skipped.\nLast unique: ${classTitle} / ${videoTitle}`);
    });

    const clearClassContext = () => {
        currentClassTitle = null;
        lastSentClassTitle = null;
        waitingForClass = true;
        clearStoredClassTitle();
    };

    const notifyClassContextReset = async () => {
        try {
            await emitAndWaitForResponse("CLASS_CONTEXT_RESET", "");
        } catch (err) {
            console.debug("WVP2 class context reset update failed:", err);
        }
    };

    const checkHomeUrlTrigger = () => {
        const state = getStoredHomeUrlTrigger();
        if (!state?.signature) {
            return;
        }

        const matchesHome = isSameUrlSignature(state.signature, getUrlSignature()) && hasVisibleClassCards();
        void recordDebug("home_url_check", {
            current_signature: getUrlSignature(),
            matches_home: matchesHome,
            has_visible_class_cards: hasVisibleClassCards(),
            armed: state.armed === true,
        });
        if (!matchesHome) {
            if (!state.armed && currentClassTitle && !waitingForClass) {
                setStoredHomeUrlTrigger({
                    ...state,
                    armed: true,
                });
            }
            return;
        }

        if (!state.armed) {
            return;
        }

        clearClassContext();
        setStoredHomeUrlTrigger({
            ...state,
            armed: false,
        });
        void recordDebug("class_context_reset", {
            reason: "home_url_detected",
        });
        void notifyClassContextReset();
        debugToast("Waiting for class");
        showToast("Home URL detected.\nClick the next class card.");
    };

    document.addEventListener("wvp2SetHomeUrlTrigger", (event) => {
        const signature = event.detail?.signature ?? getUrlSignature();
        if (!signature) {
            showToast("Could not save home URL.");
            return;
        }

        setStoredHomeUrlTrigger({
            signature,
            armed: false,
            savedAt: Date.now(),
        });
        void recordDebug("home_url_set", {
            signature,
        });
        void emitAndWaitForResponse("HOME_URL_TRIGGER_SET", "");
        showToast("Home URL saved.\nClass context will reset when you return here.");
    });

    document.addEventListener("wvp2AltLayoutChanged", (event) => {
        setStoredAltClassLayout(event.detail);
    });

    void emitAndWaitForResponse("GET_ALT_LAYOUT_SETTING", "").then((res) => {
        if (res != null) {
            setStoredAltClassLayout(res);
        }
    });

    const scheduleHomeUrlTriggerCheck = () => {
        setTimeout(checkHomeUrlTrigger, 0);
    };

    proxy(history, "pushState", (target, thisArg, args) => {
        const result = target.apply(thisArg, args);
        scheduleHomeUrlTriggerCheck();
        return result;
    });

    proxy(history, "replaceState", (target, thisArg, args) => {
        const result = target.apply(thisArg, args);
        scheduleHomeUrlTriggerCheck();
        return result;
    });

    window.addEventListener("popstate", scheduleHomeUrlTriggerCheck);
    window.addEventListener("hashchange", scheduleHomeUrlTriggerCheck);
    scheduleHomeUrlTriggerCheck();

    const sendActiveVideoTitleUpdate = async () => {
        const videoTitle = getActiveVideoTitle();
        if (!videoTitle || videoTitle === lastSentVideoTitle) {
            return;
        }

        lastSentVideoTitle = videoTitle;

        try {
            await emitAndWaitForResponse("VIDEO_TITLE", "", {
                video_title: videoTitle,
            });
        } catch (err) {
            console.debug("WVP2 video title update failed:", err);
        }
    };

    const isClassCardElement = (element) => {
        if (!element || !element.querySelector) {
            return false;
        }

        const titles = Array.from(element.querySelectorAll("h3[title]"));
        const images = Array.from(element.querySelectorAll("img[alt]"));

        if (getStoredAltClassLayout()) {
            return images.length === 1 && titles.length === 0;
        }

        return titles.length === 1 && images.length >= 1;
    };

    const isVisibleElement = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none";
    };

    const hasVisibleClassCards = () => {
        const selector = getStoredAltClassLayout() ? "img[alt]" : "h3[title]";
        return Array.from(document.querySelectorAll(selector))
            .map(node => {
                let current = node;
                for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
                    if (isClassCardElement(current)) {
                        return current;
                    }
                    current = current.parentElement;
                }
                return null;
            })
            .some(card => card && isVisibleElement(card));
    };

    const getNearestClassCard = (element) => {
        let current = element;
        for (let depth = 0; current && current !== document.body && depth < 8; depth += 1) {
            if (isClassCardElement(current)) {
                return current;
            }

            current = current.parentElement;
        }

        return null;
    };

    const getClassSelectionFromEvent = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) {
            return { rejected: true, reason: "target_not_element" };
        }

        const useAltLayout = getStoredAltClassLayout();

        if (!useAltLayout) {
            const heading = target.closest("h3[title]");
            const headingCard = heading ? getNearestClassCard(heading) : null;
            if (heading && headingCard) {
                const title = heading.getAttribute("title")?.trim() || heading.textContent?.trim();
                return title ? { title, source: "h3", card: headingCard } : null;
            }
        }

        const image = target.closest("img[alt]");
        const imageCard = image ? getNearestClassCard(image) : null;
        if (image && imageCard) {
            const title = image.getAttribute("alt")?.trim();
            return title ? { title, source: "img", card: imageCard } : null;
        }

        const card = getNearestClassCard(target);
        const title = useAltLayout 
            ? card?.querySelector("img[alt]")?.getAttribute("alt")?.trim()
            : (card?.querySelector("h3[title]")?.getAttribute("title")?.trim() || card?.querySelector("img[alt]")?.getAttribute("alt")?.trim());
            
        return title
            ? { title, source: "nearest-card", card }
            : { rejected: true, reason: "no_valid_nearest_class_card" };
    };

    const sendClassTitleUpdate = async (classTitle) => {
        if (!classTitle || classTitle === lastSentClassTitle) {
            return;
        }

        lastSentClassTitle = classTitle;

        try {
            await emitAndWaitForResponse("CLASS_TITLE", "", {
                class_title: classTitle,
            });
        } catch (err) {
            console.debug("WVP2 class title update failed:", err);
        }
    };

    const handleClassTitleEvent = (event) => {
        const state = getStoredHomeUrlTrigger();
        if (state?.signature && !isSameUrlSignature(state.signature, getUrlSignature())) {
            return;
        }

        const target = event.target instanceof Element ? event.target : null;
        void recordDebug("class_click_seen", {
            event_type: event.type,
            target: getElementDebugInfo(target),
            nearest_h3: getNearestHeadingDebugInfo(target),
            nearest_img: getNearestImageDebugInfo(target),
        });

        const selection = getClassSelectionFromEvent(event);
        if (!selection || selection.rejected) {
            void recordDebug("class_click_rejected", {
                event_type: event.type,
                reason: selection?.reason ?? "no_selection",
                target: getElementDebugInfo(target),
                nearest_h3: getNearestHeadingDebugInfo(target),
                nearest_img: getNearestImageDebugInfo(target),
            });
            return;
        }

        const classTitle = selection.title;
        if (!classTitle) {
            return;
        }

        console.debug("[WidevineProxy2]", "CLASS_CARD_CLICK", {
            clicked_tag: event.target instanceof Element ? event.target.tagName : null,
            class_title: classTitle,
            source: selection.source,
        });
        void recordDebug("class_click_selected", {
            event_type: event.type,
            selected_class_title: classTitle,
            source: selection.source,
            target: getElementDebugInfo(target),
            nearest_h3: getNearestHeadingDebugInfo(target),
            nearest_img: getNearestImageDebugInfo(target),
            card: getElementDebugInfo(selection.card),
        });
        debugToast(`Class selected: ${classTitle}`);

        currentClassTitle = classTitle;
        waitingForClass = false;
        setStoredClassTitle(classTitle);
        void sendClassTitleUpdate(classTitle);
        scheduleHomeUrlTriggerCheck();
    };

    ["pointerdown", "mousedown", "touchstart", "click"].forEach(eventName => {
        document.addEventListener(eventName, handleClassTitleEvent, true);
    });

    const startHomeUrlTriggerObserver = () => {
        let scheduled = false;
        const scheduleUpdate = () => {
            if (scheduled) {
                return;
            }

            scheduled = true;
            setTimeout(() => {
                scheduled = false;
                checkHomeUrlTrigger();
            }, 250);
        };

        const startObserver = () => {
            if (!document.documentElement) {
                return;
            }

            const observer = new MutationObserver(scheduleUpdate);
            observer.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ["class", "style"],
                childList: true,
                subtree: true,
            });
            scheduleUpdate();
        };

        if (document.documentElement) {
            startObserver();
        } else {
            document.addEventListener("DOMContentLoaded", startObserver, { once: true });
        }

        document.addEventListener("DOMContentLoaded", scheduleUpdate, { once: true });
    };

    startHomeUrlTriggerObserver();

    const startActiveVideoTitleObserver = () => {
        let scheduled = false;
        const scheduleUpdate = () => {
            if (scheduled) {
                return;
            }

            scheduled = true;
            setTimeout(async () => {
                scheduled = false;
                await sendActiveVideoTitleUpdate();
            }, 250);
        };

        const startObserver = () => {
            if (!document.documentElement) {
                return;
            }

            const observer = new MutationObserver(scheduleUpdate);
            observer.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ["alt", "class"],
                childList: true,
                subtree: true,
            });
            scheduleUpdate();
        };

        if (document.documentElement) {
            startObserver();
        } else {
            document.addEventListener("DOMContentLoaded", startObserver, { once: true });
        }

        document.addEventListener("DOMContentLoaded", scheduleUpdate, { once: true });
    };

    startActiveVideoTitleObserver();

    if (typeof EventTarget !== 'undefined') {
        proxy(EventTarget.prototype, 'addEventListener', (target, thisArg, args) => {
            const [type, listener] = args;

            if (thisArg == null || typeof MediaKeySession === 'undefined' || !(thisArg instanceof MediaKeySession) || typeof MediaKeyMessageEvent === 'undefined' || type !== "message" || !listener) {
                return target.apply(thisArg, args);
            }

            args[1] = async function(event) {
                if (event instanceof MediaKeyMessageEvent && event.isTrusted && event.message.byteLength > 2) {
                    const oldChallenge = b64.encode(event.message);
                    const metadata = getPageMetadata();
                    void recordDebug("metadata_sent", {
                        message_type: "REQUEST",
                        metadata,
                    });
                    debugToast(`Capture metadata: ${metadata.class_title ?? "null"} / ${metadata.video_title ?? "null"}`);
                    const newChallenge = await emitAndWaitForResponse("REQUEST", oldChallenge, metadata);

                    const clonedEvent = new MediaKeyMessageEvent("message", {
                        messageType: event.messageType,
                        message: b64.decode(newChallenge).buffer
                    });

                    event.stopImmediatePropagation();
                    event.preventDefault();

                    thisArg.dispatchEvent(clonedEvent);
                    return;
                }

                if (listener.handleEvent) {
                    listener.handleEvent.call(listener, event);
                } else {
                    listener.call(this, event);
                }
            };

            return target.apply(thisArg, args);
        });
    }

    if (typeof MediaKeySession !== 'undefined') {
        proxy(MediaKeySession.prototype, 'update', async (target, thisArg, args) => {
            if (thisArg == null || !(thisArg instanceof MediaKeySession)) {
                return target.apply(thisArg, args);
            }

            const metadata = getPageMetadata();
            void recordDebug("metadata_sent", {
                message_type: "RESPONSE",
                metadata,
            });
            debugToast(`Capture metadata: ${metadata.class_title ?? "null"} / ${metadata.video_title ?? "null"}`);
            await emitAndWaitForResponse("RESPONSE", b64.encode(args[0]), metadata)

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
        // === PW API CRAWLER: init header storage ===
        thisArg.__pwCrawlerHeaders = {};
        // === END ===

        return target.apply(thisArg, args);
    });

    // === PW API CRAWLER: Capture request headers ===
    proxy(XMLHttpRequest.prototype, "setRequestHeader", (target, thisArg, args) => {
        const [name, value] = args;
        if (thisArg.__pwCrawlerHeaders) {
            thisArg.__pwCrawlerHeaders[name] = value;
        }
        return target.apply(thisArg, args);
    });
    // === END PW API CRAWLER ===

    proxy(XMLHttpRequest.prototype, "send", (target, thisArg, args) => {
        thisArg.addEventListener("readystatechange", async () => {
            if (thisArg.readyState !== 4) {
                return;
            }

            // === PW API CRAWLER: Capture penpencil.co XHR responses ===
            if (shouldCaptureApi(thisArg.requestURL)) {
                try {
                    let responseBody = null;
                    switch (thisArg.responseType) {
                        case "":
                        case "text":
                            responseBody = thisArg.responseText ?? thisArg.response;
                            break;
                        case "json":
                            responseBody = typeof thisArg.response === 'string' ? thisArg.response : JSON.stringify(thisArg.response);
                            break;
                    }
                    let parsedResponse = null;
                    if (responseBody) {
                        try { parsedResponse = JSON.parse(responseBody); } catch { parsedResponse = responseBody; }
                    }
                    // Capture response headers
                    const respHeaders = {};
                    try {
                        const rawHeaders = thisArg.getAllResponseHeaders();
                        if (rawHeaders) {
                            rawHeaders.split('\r\n').forEach(line => {
                                const idx = line.indexOf(': ');
                                if (idx > 0) respHeaders[line.slice(0, idx)] = line.slice(idx + 2);
                            });
                        }
                    } catch {}
                    emitApiCaptured({
                        url: thisArg.responseURL || thisArg.requestURL,
                        originalUrl: thisArg.requestURL,
                        method: thisArg.requestMethod,
                        requestHeaders: thisArg.__pwCrawlerHeaders || {},
                        responseHeaders: respHeaders,
                        responseBody: parsedResponse,
                        timestamp: Date.now(),
                        statusCode: thisArg.status,
                        source: 'xhr',
                    });
                } catch (e) { /* silent */ }
            }
            // === END PW API CRAWLER ===

            if (thisArg.requestMethod !== "GET") {
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
        // === PW API CRAWLER: extract headers from fetch call ===
        let outgoingUrl = null;
        let outgoingMethod = 'GET';
        let outgoingHeaders = {};

        if (args[0] instanceof Request) {
            outgoingUrl = args[0].url;
            outgoingMethod = args[0].method.toUpperCase();
            try {
                args[0].headers.forEach((value, key) => { outgoingHeaders[key] = value; });
            } catch { /* silent */ }
        } else {
            outgoingUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
            outgoingMethod = (args[1]?.method || 'GET').toUpperCase();
            if (args[1]?.headers) {
                try {
                    if (args[1].headers instanceof Headers) {
                        args[1].headers.forEach((value, key) => { outgoingHeaders[key] = value; });
                    } else if (typeof args[1].headers === 'object') {
                        Object.assign(outgoingHeaders, args[1].headers);
                    }
                } catch { /* silent */ }
            }
        }
        // === END PW API CRAWLER ===

        const response = await target.apply(thisArg, args);

        try {
            if (response) {
                const cloned = response.clone();
                const text = await cloned.text();

                // === PW API CRAWLER: Capture penpencil.co fetch responses ===
                if (shouldCaptureApi(outgoingUrl)) {
                    try {
                        let parsedResponse = null;
                        try { parsedResponse = JSON.parse(text); } catch { parsedResponse = text; }
                        // Capture response headers
                        const fetchRespHeaders = {};
                        try {
                            response.headers.forEach((value, key) => { fetchRespHeaders[key] = value; });
                        } catch {}
                        emitApiCaptured({
                            url: response.url || outgoingUrl,
                            originalUrl: outgoingUrl,
                            method: outgoingMethod,
                            requestHeaders: outgoingHeaders,
                            responseHeaders: fetchRespHeaders,
                            responseBody: parsedResponse,
                            timestamp: Date.now(),
                            statusCode: response.status,
                            source: 'fetch',
                        });
                    } catch { /* silent */ }
                }
                // === END PW API CRAWLER ===

                const manifest_type = getManifestType(text);

                if (manifest_type) {
                    const url = response.url || outgoingUrl;

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

    // ─── Watched_Lecture_Overlay ──────────────────────────────────────────
    // Additive module for marking lecture cards the user has clicked.
    // Self-contained: shares no state with Active_Title_Logic above.
    // Subsequent tasks (6.x–8.x) extend this block by adding overlayObserver,
    // handleClearWatchedMessage, and initWatchedLectureOverlay, all keyed
    // onto the same globalThis.__wvp2WatchedOverlayInternals test handle.
    // The capture-phase document click listener and the chrome.runtime.onMessage
    // listener are registered by initWatchedLectureOverlay() (task 8.1), not at
    // module-load time; this file only defines the handlers themselves.

    const WATCHED_STORAGE_KEY = "wvp2_watched_lectures_v1";
    const WATCHED_OVERLAY_CLASS = "wvp2-watched";
    const WATCHED_STYLE_ELEMENT_ID = "wvp2-watched-overlay-style";
    const CLEAR_WATCHED_MESSAGE_TYPE = "wvp2_clear_watched_lectures";
    const THUMBNAIL_WRAPPER_STYLE_NEEDLE = "padding-bottom: 56.25%";
    const ANCESTOR_WALK_DEPTH = 8;

    const watchedSet = new Set();

    const watchedStore = {
        load() {
            try {
                const raw = sessionStorage.getItem(WATCHED_STORAGE_KEY);
                if (raw == null) {
                    return new Set();
                }
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) {
                    return new Set();
                }
                return new Set(parsed.filter(v => typeof v === "string"));
            } catch {
                return new Set();
            }
        },
        save(set) {
            try {
                sessionStorage.setItem(
                    WATCHED_STORAGE_KEY,
                    JSON.stringify(Array.from(set))
                );
            } catch {
                // Swallow: opaque-origin iframe, quota exceeded,
                // storage disabled, etc. Req 3.6 / 8.4.
            }
        },
        remove() {
            try {
                sessionStorage.removeItem(WATCHED_STORAGE_KEY);
            } catch {
                // Swallow per Req 3.6 / 7.5.
            }
        },
    };

    // Pure DOM-walking helpers used by the click handler and the mutation
    // observer to recognize Lecture_Cards. Anchors on the structural
    // padding-bottom: 56.25% sentinel rather than on rotating class tokens
    // (Req 1.4, 1.5). The historical class token "image-WqX7WC" is not
    // required and not consulted here.
    const cardFinder = {
        // Req 1.4: case-sensitive substring match against the value of the
        // inline style attribute. Null-safe so non-Element targets (text
        // nodes, etc.) just return false without throwing.
        isThumbnailWrapper(el) {
            const style = el?.getAttribute?.("style");
            return typeof style === "string"
                && style.includes(THUMBNAIL_WRAPPER_STYLE_NEEDLE);
        },

        // Walks up to ANCESTOR_WALK_DEPTH levels starting at `target` itself
        // and returns the first node that is a Thumbnail_Wrapper. Performs
        // only ancestor-walk DOM reads (parentElement + getAttribute("style")
        // via isThumbnailWrapper), satisfying Req 9.2 / Property 14: when
        // no card is matched, no descendant scans run.
        findThumbnailWrapperFromTarget(target) {
            let current = target;
            for (let depth = 0; current && depth < ANCESTOR_WALK_DEPTH; depth += 1) {
                if (cardFinder.isThumbnailWrapper(current)) {
                    return current;
                }
                current = current.parentElement;
            }
            return null;
        },

        // Req 1.6: prefer a descendant img[alt] inside the wrapper; else
        // climb up to 8 ancestors and pick the img[alt] (with non-empty
        // trimmed alt) whose pre-order DOM distance to the wrapper is
        // smallest. Only invoked after a wrapper has already been matched,
        // so descendant queries are allowed by Req 9.2.
        findLectureImageNear(wrapper) {
            if (!wrapper) {
                return null;
            }

            const altIsNonEmpty = (img) => {
                const a = img?.getAttribute?.("alt");
                return typeof a === "string" && a.trim().length > 0;
            };

            const direct = wrapper.querySelector?.("img[alt]");
            if (direct && altIsNonEmpty(direct)) {
                return direct;
            }

            let ancestor = wrapper.parentElement;
            for (let depth = 0; ancestor && depth < ANCESTOR_WALK_DEPTH; depth += 1) {
                const candidates = ancestor.querySelectorAll?.("img[alt]") ?? [];
                if (candidates.length === 0) {
                    ancestor = ancestor.parentElement;
                    continue;
                }

                // getElementsByTagName('*') is a live HTMLCollection in
                // document (pre-order) order; we use it to compute a
                // positional index for each candidate and the wrapper.
                const ordered = ancestor.getElementsByTagName?.("*") ?? [];
                let wrapperIdx = -1;
                const candidateIdx = new Map();
                for (let i = 0; i < ordered.length; i += 1) {
                    const node = ordered[i];
                    if (node === wrapper) {
                        wrapperIdx = i;
                    }
                    if (node.tagName === "IMG" && node.hasAttribute("alt")) {
                        candidateIdx.set(node, i);
                    }
                }

                let best = null;
                let bestDistance = Infinity;
                for (const img of candidates) {
                    if (!altIsNonEmpty(img)) {
                        continue;
                    }
                    const idx = candidateIdx.get(img);
                    if (idx == null || wrapperIdx < 0) {
                        continue;
                    }
                    const distance = Math.abs(idx - wrapperIdx);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = img;
                    }
                }

                if (best) {
                    return best;
                }

                ancestor = ancestor.parentElement;
            }

            return null;
        },

        // Req 1.2 / 1.3: trim once; never return the empty string.
        resolveLectureId(img) {
            const a = img?.getAttribute?.("alt");
            if (typeof a !== "string") {
                return null;
            }
            const trimmed = a.trim();
            return trimmed.length > 0 ? trimmed : null;
        },

        // Req 1.1 / 9.2: returns { wrapper, image, id } or null. The early
        // return when no wrapper is found ensures non-card clicks perform
        // only the ancestor walk and never a descendant scan.
        findCardFromTarget(target) {
            const wrapper = cardFinder.findThumbnailWrapperFromTarget(target);
            if (!wrapper) {
                return null;
            }
            const image = cardFinder.findLectureImageNear(wrapper);
            if (!image) {
                return null;
            }
            const id = cardFinder.resolveLectureId(image);
            if (!id) {
                return null;
            }
            return { wrapper, image, id };
        },
    };

    // Stylesheet injector. Idempotent per Req 4.1 via a getElementById
    // guard on WATCHED_STYLE_ELEMENT_ID. The injected rules tint the
    // Thumbnail_Wrapper with a translucent green and stamp a centered
    // checkmark glyph via the ::after pseudo-element. The pseudo-element
    // sets pointer-events: none so the overlay never intercepts clicks
    // bound for the underlying Lecture_Card (Req 4.4).
    const overlayStyle = {
        inject() {
            if (document.getElementById(WATCHED_STYLE_ELEMENT_ID)) {
                return;
            }
            const style = document.createElement("style");
            style.id = WATCHED_STYLE_ELEMENT_ID;
            style.textContent = `
.${WATCHED_OVERLAY_CLASS} {
    position: relative;
}
.${WATCHED_OVERLAY_CLASS}::after {
    content: "\u2713";
    position: absolute;
    inset: 0;
    background: rgba(40, 200, 80, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    color: #ffffff;
    font-size: 48px;
    font-weight: 700;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    z-index: 1;
}
`;
            const parent = document.head || document.documentElement;
            parent?.appendChild(style);
        },
    };

    // Overlay applier. applyTo / removeFrom touch only the class attribute
    // (Req 4.6); classList.add of an already-present token is a no-op, so
    // applyTo is naturally idempotent (Req 5.4 / Property 8).
    const overlayApplier = {
        // Req 4.6: only the class attribute is mutated. No setAttribute,
        // no inline style, no other attribute touched.
        applyTo(wrapper) {
            wrapper?.classList?.add(WATCHED_OVERLAY_CLASS);
        },

        removeFrom(wrapper) {
            wrapper?.classList?.remove(WATCHED_OVERLAY_CLASS);
        },

        // Req 5.1 / 5.3 / Property 9: enumerate every Thumbnail_Wrapper at
        // or under `root`, resolve the nearest Lecture_Image, and apply
        // the overlay class only when the resolved id is in `watchedSet`.
        // Cards whose id is absent are left untouched.
        scanAndApply(root, watchedSetArg) {
            if (!root || !watchedSetArg) {
                return;
            }

            const wrappers = [];
            if (cardFinder.isThumbnailWrapper(root)) {
                wrappers.push(root);
            }
            // querySelectorAll is supported on Element and Document but
            // not on DocumentFragment-less roots; guard defensively.
            const found = root.querySelectorAll?.(
                `[style*="${THUMBNAIL_WRAPPER_STYLE_NEEDLE}"]`
            ) ?? [];
            for (const wrapper of found) {
                wrappers.push(wrapper);
            }

            for (const wrapper of wrappers) {
                const image = cardFinder.findLectureImageNear(wrapper);
                if (!image) {
                    continue;
                }
                const id = cardFinder.resolveLectureId(image);
                if (id && watchedSetArg.has(id)) {
                    overlayApplier.applyTo(wrapper);
                }
            }
        },

        // Req 7.4(d): used by the clear-watched flow to wipe overlays
        // from every currently-rendered card. Reads only the class
        // selector, no per-card id resolution required.
        removeAllFromDocument() {
            const marked = document.querySelectorAll?.(`.${WATCHED_OVERLAY_CLASS}`) ?? [];
            for (const el of marked) {
                el.classList.remove(WATCHED_OVERLAY_CLASS);
            }
        },
    };

    // Capture-phase click handler. Registration on `document` is performed
    // later by initWatchedLectureOverlay() (task 8.1), after Active_Title_Logic
    // listeners have been registered, so the relative order of pre-existing
    // handlers among themselves is preserved (Req 9.3). The handler itself:
    //   - skips non-primary buttons (Req 2.6)
    //   - performs only an ancestor walk to recognize a Lecture_Card and
    //     returns immediately when no card is matched, doing zero DOM read
    //     or write outside that walk (Req 9.2)
    //   - on a match with non-empty Lecture_Id, adds the id to watchedSet
    //     (Req 2.4) and persists to sessionStorage in the same synchronous
    //     turn (Req 3.4); skips the redundant write when already present
    //     (Req 6.3)
    //   - always applies the overlay class to the matched wrapper (Req 2.5),
    //     which is idempotent on a wrapper that already carries it (Req 6.1)
    //   - never calls preventDefault, stopPropagation, or
    //     stopImmediatePropagation (Req 2.2 / 9.3)
    //   - swallows any thrown error via console.debug so navigation is
    //     never disrupted by the watched-overlay code path
    function handleWatchedClick(event) {
        try {
            if (!event || event.button !== 0) {
                return;
            }
            const card = cardFinder.findCardFromTarget(event.target);
            if (!card) {
                return;
            }
            if (!card.id) {
                return;
            }
            if (!watchedSet.has(card.id)) {
                watchedSet.add(card.id);
                watchedStore.save(watchedSet);
            }
            overlayApplier.applyTo(card.wrapper);
        } catch (err) {
            try {
                console.debug("[WidevineProxy2] watched-overlay:", err);
            } catch {
                // Swallow: console may be missing or replaced by host page.
            }
        }
    }

    // Mutation observer. start() attaches a single MutationObserver on
    // document.body with { childList: true, subtree: true } and runs the
    // initial scan over document.body in the same call. When document.body
    // is null at call time (typical at document_start injection), it
    // attaches a readystatechange listener plus a one-shot DOMContentLoaded
    // listener; whichever fires first with a non-null document.body wins,
    // and the readystatechange listener is removed once it fires so it
    // never runs begin() twice (Req 5.2 / 5.4 / Property 8). The observer
    // callback iterates record.addedNodes, filters by Node.ELEMENT_NODE,
    // and delegates to overlayApplier.scanAndApply per added node so
    // virtualized / lazy-loaded cards pick up the overlay as they appear
    // (Req 5.3). The callback body is wrapped in try/catch that logs via
    // console.debug and swallows so a thrown observer never breaks page
    // mutations.
    const overlayObserver = {
        start() {
            const begin = () => {
                const observer = new MutationObserver(records => {
                    try {
                        for (const record of records) {
                            for (const node of record.addedNodes) {
                                if (node && node.nodeType === Node.ELEMENT_NODE) {
                                    overlayApplier.scanAndApply(node, watchedSet);
                                }
                            }
                        }
                    } catch (err) {
                        try {
                            console.debug("[WidevineProxy2] watched-overlay observer:", err);
                        } catch {
                            // Swallow: console may be missing or replaced.
                        }
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
                // Initial scan after observer is attached so concurrent
                // mutations between the two are not missed (Req 5.1).
                overlayApplier.scanAndApply(document.body, watchedSet);
            };

            if (document.body) {
                begin();
                return;
            }

            const onReady = () => {
                if (document.body) {
                    document.removeEventListener("readystatechange", onReady);
                    begin();
                }
            };
            document.addEventListener("readystatechange", onReady);
            document.addEventListener("DOMContentLoaded", onReady, { once: true });
        },
    };

    // Runtime message listener for the Clear Watched broadcast. Registration
    // on chrome.runtime.onMessage is performed later by initWatchedLectureOverlay()
    // (task 8.1); this file only defines the handler. The handler:
    //   - ignores anything that is not a non-null object whose `type` strictly
    //     equals CLEAR_WATCHED_MESSAGE_TYPE (Req 7.6 / Property 12)
    //   - takes a defensive snapshot of watchedSet *before* mutating anything
    //     (Req 7.4(a)) so a partial failure can roll back to a coherent state
    //   - performs the cleanup in the order required by Req 7.4: clear the
    //     in-memory set (b), drop the sessionStorage key (c), strip the
    //     overlay class from every currently-marked Thumbnail_Wrapper (d)
    //   - on any thrown error, restores watchedSet from the snapshot, re-runs
    //     scanAndApply over the page so the visual state matches the restored
    //     set, re-persists the restored set to sessionStorage, logs via
    //     console.debug, and swallows the exception (Req 7.5 / Property 11)
    function handleClearWatchedMessage(message) {
        if (!message || typeof message !== "object" || message.type !== CLEAR_WATCHED_MESSAGE_TYPE) {
            return; // Req 7.6: ignore unrelated messages.
        }
        const snapshot = new Set(watchedSet); // Req 7.4(a): rollback snapshot.
        try {
            watchedSet.clear();                       // Req 7.4(b)
            watchedStore.remove();                    // Req 7.4(c)
            overlayApplier.removeAllFromDocument();   // Req 7.4(d)
        } catch (err) {
            // Req 7.5: rollback to the snapshot so the user is never left
            // with a half-cleared state. Each rollback step is itself best-
            // effort; any thrown error here is logged-and-swallowed.
            try {
                for (const id of snapshot) {
                    watchedSet.add(id);
                }
                const reapplyRoot = document.body || document.documentElement;
                if (reapplyRoot) {
                    overlayApplier.scanAndApply(reapplyRoot, watchedSet);
                }
                watchedStore.save(watchedSet);
            } catch {
                // Swallow rollback failures; surfacing them would defeat
                // the purpose of the catch block (Req 7.5).
            }
            try {
                console.debug("[WidevineProxy2] watched-overlay clear:", err);
            } catch {
                // Swallow: console may be missing or replaced by host page.
            }
        }
    }

    // Module entry point. Wires the watched-overlay units onto the page in the
    // order required by the design: stylesheet first (so the overlay class has
    // visual effect even if it is applied synchronously by a still-rendering
    // initial scan), then seed the in-memory watchedSet from sessionStorage,
    // then register the capture-phase document click listener, then the
    // chrome.runtime.onMessage listener for the Clear Watched broadcast, then
    // start the MutationObserver (which performs the initial scan as part of
    // begin()). The whole body is wrapped in a try/catch that logs via
    // console.debug and swallows so a thrown init step never breaks page
    // navigation or the Active_Title_Logic listeners registered above.
    //
    // Double-registration on accidental re-injection is prevented by the
    // pre-existing globalThis.__widevineProxy2ContentScriptLoaded one-shot
    // flag at the top of this IIFE — the entire IIFE returns early on the
    // second injection, so this function never runs twice in the same realm
    // (Req 5.6).
    function initWatchedLectureOverlay() {
        try {
            overlayStyle.inject();
            for (const id of watchedStore.load()) {
                watchedSet.add(id);
            }
            document.addEventListener("click", handleWatchedClick, true);
            if (typeof chrome !== "undefined"
                && chrome.runtime
                && typeof chrome.runtime.onMessage === "object"
                && chrome.runtime.onMessage !== null
                && typeof chrome.runtime.onMessage.addListener === "function") {
                chrome.runtime.onMessage.addListener(handleClearWatchedMessage);
            }
            overlayObserver.start();
        } catch (err) {
            try {
                console.debug("[WidevineProxy2] watched-overlay init:", err);
            } catch {
                // Swallow: console may be missing or replaced by host page.
            }
        }
    }

    // Test-only handle. Production code must not read this; it exists so the
    // Vitest + jsdom harness can reach IIFE-scoped bindings. Object.assign'd
    // (rather than overwritten) so later tasks can append their own keys.
    globalThis.__wvp2WatchedOverlayInternals = Object.assign(
        globalThis.__wvp2WatchedOverlayInternals || {},
        {
            watchedStore,
            watchedSet,
            cardFinder,
            overlayStyle,
            overlayApplier,
            handleWatchedClick,
            overlayObserver,
            handleClearWatchedMessage,
            initWatchedLectureOverlay,
        }
    );

    // Invoke once at the end of the IIFE, after Active_Title_Logic listener
    // registrations earlier in this file and after the test handle has been
    // published so any harness reading the handle on load can observe the
    // post-init state. The call sits inside the IIFE's existing one-shot
    // guard, so accidental re-injection of the content script does not
    // re-run init (Req 5.6 / 9.3).
    initWatchedLectureOverlay();
})();
