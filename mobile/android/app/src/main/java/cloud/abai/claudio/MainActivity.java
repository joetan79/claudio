package cloud.abai.claudio;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            // Some Android/OEM WebView builds require an explicit user gesture before starting
            // media playback; the queue/auto-advance flow triggers playback programmatically
            // (not from a direct tap), so this must be disabled. Harmless on its own — kept
            // from the background-playback experiment while everything else was rolled back.
            webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
    }
}
