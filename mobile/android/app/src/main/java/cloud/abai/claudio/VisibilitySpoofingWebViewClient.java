package cloud.abai.claudio;

import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

// Extends (not replaces) Capacitor's own BridgeWebViewClient so its URL routing / JS-bridge
// plumbing stays intact — this only adds one extra step after the page loads.
//
// Root cause this targets: the YouTube IFrame Player pauses itself when it observes the
// hosting page's Page Visibility API report hidden/backgrounded — independent of whether our
// own JS timers keep running (which the MainActivity onPause override already ensures). This
// makes the outer page's document always report itself as visible and swallows
// visibilitychange before any listener (ours or a library's) sees it.
//
// Known limitation: this only reaches the top-level document's JS realm. Android's public
// WebViewClient API calls onPageFinished for the main frame only (not cross-origin iframes),
// and the YouTube player iframe (youtube.com) is cross-origin from this app's own page, so this
// script cannot be injected directly into it. It is included because this is a widely used,
// previously-validated technique (e.g. cordova-plugin-background-mode) for this exact scenario,
// combined with the foreground service + wake lock + audio focus handling — real-device testing
// is required to confirm the combination is sufficient (not verifiable via adb in this session).
public class VisibilitySpoofingWebViewClient extends BridgeWebViewClient {

    private static final String VISIBILITY_SPOOF_JS =
        "(function() {" +
        "  try {" +
        "    Object.defineProperty(document, 'hidden', { configurable: true, get: function() { return false; } });" +
        "    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function() { return 'visible'; } });" +
        "    var swallow = function(e) { e.stopImmediatePropagation(); };" +
        "    window.addEventListener('visibilitychange', swallow, true);" +
        "    document.addEventListener('visibilitychange', swallow, true);" +
        "  } catch (e) {}" +
        "})();";

    public VisibilitySpoofingWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        view.evaluateJavascript(VISIBILITY_SPOOF_JS, null);
    }
}
