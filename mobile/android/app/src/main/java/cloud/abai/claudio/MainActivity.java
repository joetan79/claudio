package cloud.abai.claudio;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Capacitor's default onPause already skips WebView.onPause()/pauseTimers() as long as the
    // "KeepRunning" preference stays at its default (true) — see Bridge.onPause() ->
    // CordovaWebViewImpl.handlePause(keepRunning), which only calls engine.setPaused(true) when
    // keepRunning is false. We keep super.onPause() (it still notifies other plugins and the
    // bridge, which is necessary) and additionally force-resume WebView timers, since Chromium's
    // WebView can independently throttle background-tab timers regardless of Cordova's own pause
    // flag — this is what keeps the YouTube IFrame player / media session JS running while the
    // app is backgrounded or the screen is locked.
    @Override
    public void onPause() {
        super.onPause();
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().resumeTimers();
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().resumeTimers();
        }
    }
}
